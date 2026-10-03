import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createCliRunner } from "./cli/index.js";
import type { AgentId } from "./contract.js";
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

/** Include metadata and uncommitted files: importing must not modify either checkout. */
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
  const sourceHome = join(root, "alternate Claude profile");
  const targetHome = join(root, "target profile");
  guards.push(
    withHomes({
      "claude-code": join(root, "default Claude profile"),
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
      { cwd, argv: ["claude", "--home", sourceHome, ...args], targetAgent: agent, targetHome },
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
  };
}

type Scene = Awaited<ReturnType<typeof bench>>;

async function unchangedAfter(scene: Scene): Promise<() => Promise<void>> {
  const paths = [scene.sourceHome, scene.main, scene.linked, scene.destination];
  const before = await Promise.all(paths.map(snapshot));
  return async () => expect(await Promise.all(paths.map(snapshot))).toEqual(before);
}

async function previewToken(scene: Scene, selector: string = scene.id): Promise<string> {
  const preview = await scene.run([selector]);
  expect(preview.stderr).toEqual([]);
  expect(preview.exitCode).toBe(0);
  expect(preview.stdout).toContain(`Destination: ${scene.destinationCwd}`);
  expect(preview.stdout.join("\n")).toContain(
    "The source session records a different directory. Conversation import does not transfer uncommitted work, switch branches, or recreate removed worktrees.",
  );
  const token = preview.stdout.join("\n").match(/v1-sha256-[0-9a-f]{64}/)?.[0];
  expect(token).toBeDefined();
  if (!token) throw new Error("CLI preview did not print a confirmation token");
  expect(await snapshot(scene.targetHome)).toEqual({});
  return token;
}

async function readNativeImport(scene: Scene, agent: AgentId): Promise<string> {
  const adapter = scene.host.registry().get(agent);
  const descriptors = await adapter.listSessions(scene.targetHome);
  expect(descriptors).toHaveLength(1);
  const descriptor = descriptors[0];
  if (!descriptor) throw new Error("native import missing");
  expect(descriptor.ref.home).toBe(scene.targetHome);
  expect(descriptor.repoPaths).toEqual([scene.destinationCwd]);
  const facts = await adapter.readBack(scene.targetHome, descriptor.ref.id);
  expect(facts.openable).toBe(true);
  expect(facts.itemCount).toBeGreaterThan(0);
  const session = await adapter.loadSession(descriptor);
  expect(JSON.stringify(session.turns)).toContain("Inspect the tracked file without changing it.");
  expect(JSON.stringify(session.turns)).toContain("The tracked file is ready for inspection.");
  const entries = (await readFile(descriptor.filePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (agent === "claude-code") {
    expect(dirname(descriptor.filePath)).toBe(
      join(scene.targetHome, "projects", scene.destinationCwd.replace(/[^a-zA-Z0-9]/g, "-")),
    );
    const recorded = entries.filter((entry) => entry.cwd !== undefined);
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((entry) => entry.cwd === scene.destinationCwd)).toBe(true);
  } else {
    expect(entries[0].cwd).toBe(scene.destinationCwd);
    expect(dirname(descriptor.filePath)).toBe(
      join(
        scene.targetHome,
        "sessions",
        `--${scene.destinationCwd.replace(/^\//, "").replace(/[\\/]/g, "-")}--`,
      ),
    );
  }
  return descriptor.filePath;
}

test.each([
  ["main-to-nested", "row"],
  ["sibling-to-main", "id"],
  ["sibling-to-external", "path"],
] as const)(
  "CLI %s: list, %s preview, confirmation and native Claude readback",
  async (direction, selection) => {
    const scene = await bench(direction);
    expect(git(scene.sourceCwd, "rev-parse", "HEAD")).toBe(
      git(scene.destination, "rev-parse", "HEAD"),
    );
    expect(process.cwd()).not.toBe(scene.destinationCwd);
    const unchanged = await unchangedAfter(scene);
    const listed = await scene.run([]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stderr).toEqual([]);
    expect(listed.stdout.join("\n")).toContain("Inspect the tracked file");
    const selector = selection === "row" ? "1" : selection === "id" ? scene.id : scene.file;
    const token = await previewToken(scene, selector);
    const imported = await scene.run([selector, "--confirm", token]);
    expect(imported.stderr).toEqual([]);
    expect(imported.exitCode).toBe(0);
    expect(imported.stdout.join("\n")).toContain("Open it with:");
    await readNativeImport(scene, "claude-code");
    await unchanged();
  },
);

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
        expect(shown).toContain(`Destination: ${scene.destinationCwd}`);
        expect(shown.join("\n")).toContain("The source session records a different directory");
        expect(shown.join("\n")).toContain("does not transfer uncommitted work, switch branches");
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
  expect(switched).toEqual([await readNativeImport(scene, "pi")]);
  await unchanged();
});

test("CLI rejects a token in another detached worktree at the same HEAD without writing", async () => {
  const scene = await bench("main-to-nested");
  const other = join(scene.root, "other worktree");
  git(scene.main, "worktree", "add", "--detach", other, "HEAD");
  expect(git(other, "rev-parse", "HEAD")).toBe(git(scene.destination, "rev-parse", "HEAD"));
  expect(git(other, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
    git(scene.destination, "rev-parse", "--abbrev-ref", "HEAD"),
  );
  const unchanged = await unchangedAfter(scene);
  const token = await previewToken(scene);
  const rejected = await scene.run([scene.id, "--confirm", token], other);
  expect(rejected.exitCode).toBe(2);
  expect(rejected.stderr.join("\n")).toContain(
    "The source session, destination, or preview changed after confirmation. Nothing was written",
  );
  expect(await snapshot(scene.targetHome)).toEqual({});
  await unchanged();
});

test.each(["source", "destination"] as const)(
  "CLI refreshes changed %s repository identity before confirming, without writing",
  async (changed) => {
    const scene = await bench("sibling-to-external");
    const token = await previewToken(scene);
    const replaced = changed === "source" ? scene.sourceCwd : scene.destination;
    await rename(join(replaced, ".git"), join(replaced, ".git-original"));
    git(replaced, "init", "-b", "replacement");
    const unchanged = await unchangedAfter(scene);
    const rejected = await scene.run([scene.id, "--confirm", token]);
    expect(rejected.exitCode).toBe(2);
    expect(rejected.stderr.join("\n")).toContain("The session could not be chosen:");
    expect(await snapshot(scene.targetHome)).toEqual({});
    await unchanged();
  },
);

test("CLI previews and imports a removed worktree using surviving active-conversation metadata", async () => {
  const scene = await bench("sibling-to-external");
  await scene.transcript([scene.linked, scene.main]);
  git(scene.main, "worktree", "remove", "--force", scene.linked);
  const descriptors = await scene.host.registry().get("claude-code").listSessions(scene.sourceHome);
  expect(descriptors[0]?.repoPath).toBe(scene.linked);
  expect(descriptors[0]?.repoPaths).toEqual([scene.linked, scene.main]);
  const unchanged = await unchangedAfter(scene);
  const token = await previewToken(scene);
  const imported = await scene.run([scene.id, "--confirm", token]);
  expect(imported.stderr).toEqual([]);
  expect(imported.exitCode).toBe(0);
  await readNativeImport(scene, "claude-code");
  await unchanged();
});

test.each(["missing", "conflicting"] as const)(
  "CLI and Pi expose %s recorded-directory evidence without importing",
  async (evidence) => {
    const scene = await bench("sibling-to-external", "pi");
    if (evidence === "missing") {
      git(scene.main, "worktree", "remove", "--force", scene.linked);
    } else {
      const unrelated = join(scene.root, "unrelated repository");
      await mkdir(unrelated);
      git(unrelated, "init", "-b", "main");
      await scene.transcript([scene.main, unrelated]);
    }
    const diagnostic =
      evidence === "missing"
        ? "does not belong to this repository and was not listed"
        : "has conflicting repository identity evidence";
    const listed = await scene.run([]);
    expect(listed.stdout.join("\n")).toContain(diagnostic);
    const preview = await scene.run([scene.id]);
    expect(preview.exitCode).toBe(2);
    if (evidence === "conflicting") {
      // Only a contradiction is narrated in a selection error; a session whose directories
      // are all gone is a counted non-member like any other.
      expect(preview.stderr.join("\n")).toContain(diagnostic);
    }
    const shown: string[] = [];
    const command = createResumeFromCommand({
      windowTokens: scene.target.windowTokens,
      picker: {
        async pick() {
          throw new Error("must not offer excluded sessions");
        },
      },
      ui: {
        show(lines) {
          shown.push(...lines);
        },
        async confirm() {
          throw new Error("must not confirm a rejected selection");
        },
      },
    });
    const ctx: PiCommandContext = {
      cwd: scene.destinationCwd,
      home: scene.targetHome,
      async switchSession() {
        throw new Error("must not switch after rejection");
      },
    };
    await command.run(ctx, [], scene.pipeline);
    expect(shown.join("\n")).toContain(diagnostic);
    shown.length = 0;
    await command.run(ctx, [scene.id], scene.pipeline);
    expect(shown).toHaveLength(1);
    if (evidence === "conflicting") {
      expect(shown[0]).toContain(diagnostic);
    } else {
      // A counted non-member is not a selection diagnostic: the error names the repository.
      expect(shown[0]).toContain("belongs to this repository");
    }
    expect(await snapshot(scene.targetHome)).toEqual({});
  },
);
