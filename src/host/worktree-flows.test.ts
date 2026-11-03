import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createCliRunner } from "./cli/index.js";
import type { AgentId } from "./contract.js";
import { runCommandBinary } from "./index.js";
import { createResumeFromCommand } from "./pi-extension/command.js";
import type { PiCommandContext } from "./pi-extension/contract.js";
import { type EnvGuard, testConfig, withHomes } from "./test-support.js";
import { createHost } from "./wiring.js";

const roots: string[] = [];
const guards: EnvGuard[] = [];
afterEach(async () => {
  for (const guard of guards.splice(0).reverse()) guard.restore();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"])
    delete env[name];
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function temporaryRoot(label: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `resume-${label}-`)));
  roots.push(root);
  return root;
}

/** Include metadata and uncommitted files: restoring a session must not modify a checkout. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return [];
        throw cause;
      },
    );
    for (const entry of entries) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else files[relative(root, file)] = (await readFile(file)).toString("base64");
    }
  }
  await walk(root);
  return files;
}

type Direction = "main-to-nested" | "sibling-to-main" | "sibling-to-external";

async function bench(direction: Direction, agent: AgentId = "claude-code") {
  const root = await temporaryRoot("host-worktrees");
  const main = join(root, "main checkout");
  await mkdir(main);
  git(main, "init", "-b", "main");
  await writeFile(join(main, "tracked.txt"), "committed content\n");
  git(main, "add", "tracked.txt");
  git(
    main,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  );
  const linked =
    direction === "main-to-nested"
      ? join(main, ".worktrees", "nested")
      : join(root, "sibling checkout");
  git(main, "worktree", "add", "--detach", linked, "HEAD");
  let destination = direction === "main-to-nested" ? linked : main;
  if (direction === "sibling-to-external") {
    const external = await temporaryRoot("arbitrary-external");
    destination = join(external, "unrelated placement", "destination checkout");
    git(main, "worktree", "add", "--detach", destination, "HEAD");
  }
  const sourceCwd = direction === "main-to-nested" ? main : linked;
  const destinationCwd = join(destination, "sub directory");
  await mkdir(destinationCwd);
  await writeFile(join(sourceCwd, "tracked.txt"), "source uncommitted change\n");
  await writeFile(join(destinationCwd, "untracked.txt"), "destination uncommitted file\n");
  const sourceHome = join(root, "claude profile");
  const targetHome = join(root, "target profile");
  // Every default root, including the `~/.claude*` glob, stays inside the throwaway root.
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  guards.push({
    restore() {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    },
  });
  guards.push(
    withHomes({
      "claude-code": sourceHome,
      codex: join(root, "empty Codex profile"),
      pi: join(root, "empty Pi profile"),
    }),
  );
  const hostCwd = join(root, "host creation cwd");
  await mkdir(hostCwd);
  const host = await createHost({
    cwd: hostCwd,
    configLoader: {
      load: async () => testConfig({ extraHomes: [{ agent: "claude-code", home: sourceHome }] }),
    },
    now: () => "2026-09-19T12:00:00.000Z",
  });
  const target = host.profiles().build(agent, targetHome, host.config());
  const pipeline = await host.pipelineFor(target);
  const id = randomUUID();
  const file = join(sourceHome, "projects", sourceCwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
  // Native Claude JSONL, not a fixture adapter or an import-generated transcript.
  async function transcript(cwds: [string, string] = [sourceCwd, sourceCwd]): Promise<void> {
    const userId = randomUUID();
    const envelope = {
      sessionId: id,
      isSidechain: false,
      userType: "external",
      version: "2.1.220",
      gitBranch: "main",
    };
    const entries = [
      {
        ...envelope,
        type: "user",
        uuid: userId,
        parentUuid: null,
        cwd: cwds[0],
        timestamp: "2026-09-19T09:00:00.000Z",
        message: { role: "user", content: "Inspect the tracked file without changing it." },
      },
      {
        ...envelope,
        type: "assistant",
        uuid: randomUUID(),
        parentUuid: userId,
        cwd: cwds[1],
        timestamp: "2026-09-19T09:00:01.000Z",
        message: {
          id: "msg-worktree",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "The tracked file is ready for inspection." }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 10 },
        },
      },
    ];
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  }
  await transcript();
  const runner = createCliRunner(target);
  const run = (args: string[], cwd = destinationCwd) =>
    runner.run(
      {
        cwd,
        argv: ["claude", "--home", sourceHome, ...args],
        targetAgent: agent,
        targetHome,
      },
      pipeline,
    );
  const runInSource = (args: string[]) =>
    createCliRunner({ ...target, home: sourceHome }).run(
      { cwd: destinationCwd, argv: args, targetAgent: agent, targetHome: sourceHome },
      pipeline,
    );
  return {
    root,
    main,
    linked,
    destination,
    destinationCwd,
    sourceCwd,
    sourceHome,
    targetHome,
    host,
    target,
    pipeline,
    id,
    file,
    transcript,
    run,
    runInSource,
  };
}

type Scene = Awaited<ReturnType<typeof bench>>;

async function unchangedAfter(scene: Scene): Promise<() => Promise<void>> {
  const paths = [scene.sourceHome, scene.main, scene.linked, scene.destination];
  const before = await Promise.all(paths.map(snapshot));
  return async () => expect(await Promise.all(paths.map(snapshot))).toEqual(before);
}

/** Preview with the selector and return the confirmation token the CLI printed. */
async function previewToken(scene: Scene, args: string[]): Promise<string> {
  const preview = await scene.run(args);
  expect(preview.stderr).toEqual([]);
  expect(preview.exitCode).toBe(0);
  expect(preview.stdout.join("\n")).toContain("Confirm:");
  const token = preview.stdout.join("\n").match(/v1-sha256-[0-9a-f]{64}/)?.[0];
  expect(token).toBeDefined();
  if (!token) throw new Error("CLI preview did not print a confirmation token");
  expect(await snapshot(scene.targetHome)).toEqual({});
  return token;
}

async function readNativeImport(scene: Scene, agent: AgentId, directory: string): Promise<string> {
  const adapter = scene.host.registry().get(agent);
  const descriptors = await adapter.listSessions(scene.targetHome);
  expect(descriptors).toHaveLength(1);
  const descriptor = descriptors[0];
  if (!descriptor) throw new Error("native import missing");
  expect(descriptor.ref.home).toBe(scene.targetHome);
  expect(descriptor.repoPaths).toEqual([directory]);
  const facts = await adapter.readBack(scene.targetHome, descriptor.ref.id);
  expect(facts.openable).toBe(true);
  expect(facts.itemCount).toBeGreaterThan(0);
  const session = await adapter.loadSession(descriptor);
  expect(JSON.stringify(session.turns)).toContain("Inspect the tracked file without changing it.");
  expect(JSON.stringify(session.turns)).toContain("The tracked file is ready for inspection.");
  return descriptor.filePath;
}

test.each([["main-to-nested"], ["sibling-to-main"], ["sibling-to-external"]] as const)(
  "CLI %s: the numbered row flow still previews and imports into the invocation directory",
  async (direction) => {
    const scene = await bench(direction);
    const unchanged = await unchangedAfter(scene);
    const listed = await scene.run([]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.join("\n")).toContain("Inspect the tracked file");
    // A row keeps the existing flow: preview, confirm, land, and print a Resume command.
    const token = await previewToken(scene, ["1"]);
    const imported = await scene.run(["1", "--confirm", token]);
    expect(imported.stdout.join("\n")).toContain("Resume:");
    await readNativeImport(scene, "claude-code", scene.destinationCwd);
    await unchanged();
  },
);

test("the bare-shell entry point restores a session natively and writes nothing", async () => {
  const scene = await bench("sibling-to-external");
  const outcome = await runCommandBinary(
    { argv: [scene.id], cwd: scene.destinationCwd, targetAgent: null, targetHome: null },
    {
      cwd: scene.destinationCwd,
      configLoader: {
        load: async () =>
          testConfig({ extraHomes: [{ agent: "claude-code", home: scene.sourceHome }] }),
      },
    },
  );

  expect(outcome.exitCode).toBe(0);
  expect(outcome.stderr).toEqual([]);
  const shown = outcome.stdout.join("\n");
  expect(shown).toContain("↻ claude-code");
  expect(shown).toContain("Resume: cd ");
  expect(shown).toContain(
    ` && CLAUDE_CONFIG_DIR='${scene.sourceHome}' claude --resume ${scene.id}`,
  );
  expect(await snapshot(scene.targetHome)).toEqual({});
});

test("CLI restores a same-profile session natively and writes nothing", async () => {
  const scene = await bench("sibling-to-external");
  const unchanged = await unchangedAfter(scene);
  const outcome = await scene.runInSource([scene.id]);
  expect(outcome.exitCode).toBe(0);
  expect(outcome.stderr).toEqual([]);
  const shown = outcome.stdout.join("\n");
  expect(shown).toContain("Resume: cd ");
  expect(shown).toContain(
    ` && CLAUDE_CONFIG_DIR='${scene.sourceHome}' claude --resume ${scene.id}`,
  );
  expect(shown).toContain("↻ claude-code");
  expect(await snapshot(scene.targetHome)).toEqual({});
  await unchanged();
});

test("CLI imports an ID from another Claude profile into the active profile", async () => {
  const scene = await bench("sibling-to-external");
  const unchanged = await unchangedAfter(scene);
  process.env.CLAUDE_CONFIG_DIR = scene.targetHome;

  const invoke = (argv: string[]) =>
    runCommandBinary(
      { argv, cwd: scene.destinationCwd, targetAgent: "claude-code", targetHome: null },
      {
        configLoader: {
          load: async () =>
            testConfig({ extraHomes: [{ agent: "claude-code", home: scene.sourceHome }] }),
        },
      },
    );

  const preview = await invoke([scene.id]);
  expect(preview.exitCode).toBe(0);
  expect(preview.stderr).toEqual([]);
  expect(preview.stdout.join("\n")).toContain(`Target: claude-code (${scene.targetHome})`);
  expect(await snapshot(scene.targetHome)).toEqual({});
  const token = preview.stdout.join("\n").match(/v1-sha256-[0-9a-f]{64}/)?.[0];
  expect(token).toBeDefined();
  if (token === undefined) throw new Error("CLI did not offer an import confirmation");

  const imported = await invoke([scene.id, "--confirm", token]);
  expect(imported.exitCode).toBe(0);
  expect(imported.stderr).toEqual([]);
  await readNativeImport(scene, "claude-code", scene.sourceCwd);
  const [landed] = await scene.host.registry().get("claude-code").listSessions(scene.targetHome);
  expect(landed?.ref.id).not.toBe(scene.id);
  expect(imported.stdout.join("\n")).toContain(
    `CLAUDE_CONFIG_DIR='${scene.targetHome}' claude --resume ${landed?.ref.id}`,
  );
  await unchanged();
});

test("CLI imports a cross-agent session into the session directory, not the invocation directory", async () => {
  const scene = await bench("sibling-to-external", "codex");
  const unchanged = await unchangedAfter(scene);
  const token = await previewToken(scene, [scene.file]);
  const imported = await scene.run([scene.file, "--confirm", token]);
  expect(imported.stderr).toEqual([]);
  expect(imported.exitCode).toBe(0);
  expect(imported.stdout.join("\n")).toContain("Resume:");
  await readNativeImport(scene, "codex", scene.sourceCwd);
  await unchanged();
});

test("CLI --context prints the conversation and its directory, and writes nothing", async () => {
  const scene = await bench("sibling-to-external", "codex");
  const unchanged = await unchangedAfter(scene);

  const outcome = await scene.run([scene.id, "--context"]);

  expect(outcome.exitCode).toBe(0);
  expect(outcome.stderr).toEqual([]);
  const shown = outcome.stdout.join("\n");
  expect(shown).toContain("User: Inspect the tracked file without changing it.");
  expect(shown).toContain("Agent: The tracked file is ready for inspection.");
  expect(shown).toContain(`Directory: ${scene.sourceCwd}`);
  expect(await snapshot(scene.targetHome)).toEqual({});
  await unchanged();
});

test("CLI --to imports into another checkout of the same repository", async () => {
  const scene = await bench("sibling-to-external", "codex");
  const token = await previewToken(scene, [scene.id, "--to", scene.destinationCwd]);
  const imported = await scene.run([scene.id, "--to", scene.destinationCwd, "--confirm", token]);
  expect(imported.exitCode).toBe(0);
  await readNativeImport(scene, "codex", scene.destinationCwd);
});

test("CLI refuses --to into a different repository and writes nothing", async () => {
  const scene = await bench("sibling-to-external", "codex");
  const other = await temporaryRoot("other-repository");
  git(other, "init", "-b", "main");
  const refused = await scene.run([scene.id, "--to", other]);
  expect(refused.exitCode).toBe(2);
  expect(refused.stderr.join("\n")).toContain("different repository");
  expect(await snapshot(scene.targetHome)).toEqual({});
});

test("CLI refuses --to into a different repository before recreating a worktree", async () => {
  const scene = await bench("main-to-nested", "codex");
  await scene.transcript([scene.linked, scene.linked]);
  git(scene.main, "worktree", "remove", "--force", scene.linked);
  const other = await temporaryRoot("other-repository");
  git(other, "init", "-b", "main");

  const refused = await scene.run([scene.id, "--to", other]);

  expect(refused.exitCode).toBe(2);
  expect(refused.stderr.join("\n")).toContain("different repository");
  // The recovery was never offered or run: the removed worktree is still absent.
  expect(await snapshot(scene.linked)).toEqual({});
  expect(await snapshot(scene.targetHome)).toEqual({});
});

test("CLI --to imports into the named checkout without recreating the recorded directory", async () => {
  const scene = await bench("main-to-nested", "codex");
  await scene.transcript([scene.linked, scene.linked]);
  git(scene.main, "worktree", "remove", "--force", scene.linked);

  // The main checkout is an existing checkout of the same repository; the recorded linked
  // worktree is gone.
  const preview = await scene.run([scene.id, "--to", scene.main]);

  expect(preview.exitCode).toBe(0);
  expect(preview.stderr).toEqual([]);
  const shown = preview.stdout.join("\n");
  expect(shown).not.toContain("Recover:");
  expect(shown).toContain("Confirm:");
  // The recorded worktree the user did not ask for stays absent.
  expect(await snapshot(scene.linked)).toEqual({});
});

/** Cut the last line in half, as a crashed agent leaves it. */
async function cutLastLine(file: string): Promise<void> {
  const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
  const last = lines[lines.length - 1] ?? "";
  lines[lines.length - 1] = last.slice(0, Math.floor(last.length / 2));
  await writeFile(file, `${lines.join("\n")}\n`);
}

test("CLI resumes natively from a session whose last line was cut mid-write", async () => {
  const scene = await bench("sibling-to-external");
  // A crashed agent leaves a complete conversation with an incomplete trailing entry.
  await cutLastLine(scene.file);

  const outcome = await scene.runInSource([scene.id]);

  expect(outcome.exitCode).toBe(0);
  expect(outcome.stderr).toEqual([]);
  const shown = outcome.stdout.join("\n");
  expect(shown).toContain("Resume: cd ");
  expect(shown).toContain(
    ` && CLAUDE_CONFIG_DIR='${scene.sourceHome}' claude --resume ${scene.id}`,
  );
});

test("CLI plans the removal recovery of a session whose last line was cut mid-write", async () => {
  const scene = await bench("main-to-nested");
  await scene.transcript([scene.linked, scene.linked]);
  git(scene.main, "worktree", "remove", "--force", scene.linked);
  await cutLastLine(scene.file);

  const outcome = await scene.run([scene.id]);

  expect(outcome.exitCode).toBe(0);
  expect(outcome.stderr).toEqual([]);
  const shown = outcome.stdout.join("\n");
  // The complete entries before the cut still place the session: the removed worktree is
  // offered for recovery instead of being reported as a session with no directory.
  expect(shown).not.toContain("records no directory");
  expect(shown).toContain("Recover:");
  expect(shown).toContain("Confirm:");
});

test("CLI refuses to import a session whose last line was cut mid-write", async () => {
  const scene = await bench("sibling-to-external", "codex");
  await cutLastLine(scene.file);

  const outcome = await scene.run([scene.id]);

  expect(outcome.exitCode).toBe(2);
  expect(outcome.stderr.join("\n")).toContain("unreadable Claude Code session file");
  expect(await snapshot(scene.targetHome)).toEqual({});
});

test("CLI names an unrecoverable directory and exits 1", async () => {
  const scene = await bench("sibling-to-external");
  await scene.transcript([scene.linked, scene.linked]);
  git(scene.main, "worktree", "remove", "--force", scene.linked);
  const outcome = await scene.run([scene.id]);
  expect(outcome.exitCode).toBe(1);
  expect(outcome.stdout.join("\n")).toContain("cannot be recovered");
  // The documented escape hatch must be named, not only "recreate the old path".
  expect(outcome.stderr.join("\n")).toContain("--to <dir>");
  expect(await snapshot(scene.targetHome)).toEqual({});
});

test("CLI refuses --to into a directory that is not a git checkout", async () => {
  const scene = await bench("sibling-to-external", "codex");
  await scene.transcript([scene.linked, scene.linked]);
  git(scene.main, "worktree", "remove", "--force", scene.linked);
  const plain = await temporaryRoot("plain-directory");

  const refused = await scene.run([scene.id, "--to", plain]);

  expect(refused.exitCode).toBe(2);
  expect(refused.stderr.join("\n")).toContain("not a git checkout");
  expect(await snapshot(scene.targetHome)).toEqual({});
});

test("CLI recovers a removed worktree behind a token, then resumes natively", async () => {
  const scene = await bench("main-to-nested");
  await scene.transcript([scene.linked, scene.linked]);
  git(scene.main, "worktree", "remove", "--force", scene.linked);

  const preview = await scene.runInSource([scene.id]);
  expect(preview.exitCode).toBe(0);
  const shown = preview.stdout.join("\n");
  expect(shown).toContain("Recover:");
  expect(shown).toContain("Confirm:");
  const token = shown.match(/v1-sha256-[0-9a-f]{64}/)?.[0];
  if (!token) throw new Error("recovery preview did not print a token");

  // A wrong token runs nothing and leaves the directory missing.
  const wrong = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  const refused = await scene.runInSource([scene.id, "--confirm", wrong]);
  expect(refused.exitCode).toBe(2);
  expect(await snapshot(scene.linked)).toEqual({});

  const recovered = await scene.runInSource([scene.id, "--confirm", token]);
  expect(recovered.exitCode).toBe(0);
  expect(recovered.stderr).toEqual([]);
  expect(recovered.stdout.join("\n")).toContain("Resume: cd ");
  expect(recovered.stdout.join("\n")).toContain(
    ` && CLAUDE_CONFIG_DIR='${scene.sourceHome}' claude --resume ${scene.id}`,
  );
  expect(await snapshot(scene.linked)).not.toEqual({});
});

test("CLI recovers a removed worktree, then continues into an import preview", async () => {
  const scene = await bench("main-to-nested", "codex");
  await scene.transcript([scene.linked, scene.linked]);
  git(scene.main, "worktree", "remove", "--force", scene.linked);

  const recovery = await scene.run([scene.id]);
  expect(recovery.exitCode).toBe(0);
  const shown = recovery.stdout.join("\n");
  expect(shown).toContain("Recover:");
  const recoveryToken = shown.match(/v1-sha256-[0-9a-f]{64}/)?.[0];
  if (!recoveryToken) throw new Error("recovery preview did not print a token");

  const recovered = await scene.run([scene.id, "--confirm", recoveryToken]);
  expect(recovered.exitCode).toBe(0);
  expect(recovered.stderr).toEqual([]);
  // The recovery token does not confirm the preview that follows it (FR-61).
  expect(recovered.stdout.join("\n")).toContain("Confirm:");
  const importToken = recovered.stdout.join("\n").match(/v1-sha256-[0-9a-f]{64}/)?.[0];
  if (!importToken) throw new Error("import preview did not print a token");

  const imported = await scene.run([scene.id, "--confirm", importToken]);
  expect(imported.stderr).toEqual([]);
  expect(imported.exitCode).toBe(0);
  expect(imported.stdout.join("\n")).toContain("Resume:");
  await readNativeImport(scene, "codex", scene.linked);
});

test("Pi command context drives real discovery, preview and native writer instead of process/host cwd", async () => {
  const scene = await bench("sibling-to-external", "pi");
  expect(process.cwd()).not.toBe(scene.destinationCwd);
  const unchanged = await unchangedAfter(scene);
  const shown: string[] = [];
  const switched: string[] = [];
  let confirmed = false;
  const command = createResumeFromCommand({
    windowTokens: scene.target.windowTokens,
    picker: {
      async pick(listing) {
        expect(listing.failures).toEqual([]);
        expect(listing.rows.map((row) => row.ref.id)).toEqual([scene.id]);
        return { choice: "selected", selected: listing.rows[0] ?? null };
      },
    },
    ui: {
      show(lines) {
        shown.push(...lines);
      },
      async confirm() {
        expect(shown).toContain(`  ${scene.destinationCwd} · no branch`);
        expect(await snapshot(scene.targetHome)).toEqual({});
        confirmed = true;
        return "selected";
      },
    },
  });
  const ctx: PiCommandContext = {
    cwd: scene.destinationCwd,
    home: scene.targetHome,
    async switchSession(path, options) {
      expect(confirmed).toBe(true);
      expect(await readFile(path, "utf8")).toContain(scene.destinationCwd);
      switched.push(path);
      options.withSession();
      return { cancelled: false };
    },
  };
  await command.run(ctx, [], scene.pipeline);
  expect(switched).toEqual([await readNativeImport(scene, "pi", scene.destinationCwd)]);
  await unchanged();
});
