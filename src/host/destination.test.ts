import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  createFixtureAgentAdapter,
  FIXTURE_AGENT_ID,
} from "../../test/fixtures/fixture-agent/index.js";
import { REFERENCE_SESSION } from "../../test/fixtures/reference-session.js";
import { AGENTS } from "./agents.js";
import type { AgentId, ImportRequest } from "./contract.js";
import { seedSession, testConfig } from "./test-support.js";
import { createHost } from "./wiring.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"])
    delete env[key as keyof typeof env];
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

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

async function bench(agent: AgentId = "codex") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "resume-destination-")));
  roots.push(root);
  const hostCwd = join(root, "host checkout");
  await mkdir(hostCwd);
  git(hostCwd, "init", "-b", "main");
  git(
    hostCwd,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  );
  const initial = git(hostCwd, "rev-parse", "HEAD");
  const worktree = join(root, "request checkout");
  git(hostCwd, "worktree", "add", "--detach", worktree, initial);
  const destinationCwd = join(worktree, "sub directory");
  await mkdir(destinationCwd);
  const home = join(root, "target profile");
  const sourceHome = join(root, "source profile");
  const source = createFixtureAgentAdapter({ defaultHome: sourceHome });
  const host = await createHost({
    cwd: hostCwd,
    configLoader: { load: async () => testConfig() },
    agents: [...AGENTS, { create: () => source, family: "generic" }],
    now: () => "2026-08-05T00:00:00.000Z",
  });
  const target = host.profiles().build(agent, home, host.config());
  const pipeline = await host.pipelineFor(target);
  async function request(cwd: string, sourceCwd = cwd): Promise<ImportRequest> {
    const id = await seedSession(
      source,
      sourceHome,
      {
        ...REFERENCE_SESSION,
        provenance: {
          ...REFERENCE_SESSION.provenance,
          repo: { commit: initial, branch: "main", changedPaths: [] },
        },
      },
      { cwd: sourceCwd },
    );
    return {
      destinationCwd: cwd,
      target,
      selection: { by: "session-id", id },
      onlyAgent: FIXTURE_AGENT_ID,
      onlyHome: sourceHome,
    };
  }
  return {
    root,
    hostCwd,
    worktree,
    destinationCwd,
    home,
    sourceHome,
    host,
    pipeline,
    request,
    initial,
  };
}

const runtime = { switchSession: async () => ({ cancelled: true }) };

test.each(["claude-code", "codex", "pi"])(
  "%s writes request cwd and native placement, not process or host cwd",
  async (agent) => {
    const scene = await bench(agent as AgentId);
    expect(process.cwd()).not.toBe(scene.hostCwd);
    expect(process.cwd()).not.toBe(scene.destinationCwd);
    // Host checkout is one commit ahead; the request checkout is two ahead of the source.
    git(
      scene.hostCwd,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "host only",
    );
    for (const message of ["request one", "request two"]) {
      git(
        scene.worktree,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        message,
      );
    }
    // A symlink and subdirectory spelling must reach the writer unchanged.
    const alias = join(scene.root, "native alias");
    await symlink(scene.worktree, alias);
    const nativeCwd = join(alias, "sub directory");
    const request = await scene.request(nativeCwd);
    const before = await snapshot(scene.sourceHome);
    const repositoryBefore = await snapshot(scene.worktree);
    const report = await scene.pipeline.preview(request);
    // The shared header's directory line carries the canonical destination cwd.
    expect(report.headerLines[1]).toBe(`  ${scene.destinationCwd} · no branch`);
    expect(report.warnings.map((w) => w.line).join("\n")).toContain("2 commits ahead");
    const landed = await scene.pipeline.commit(request, runtime, report.confirmationToken);
    const adapter = scene.host.registry().get(agent as AgentId);
    const descriptor = (await adapter.listSessions(scene.home)).find(
      (item) => item.ref.id === landed.ref.id,
    );
    expect(descriptor?.repoPath).toBe(nativeCwd);
    expect(await adapter.readBack(scene.home, landed.ref.id)).toMatchObject({
      openable: true,
      itemCount: landed.itemsSent,
    });
    const file = descriptor?.filePath;
    if (!file) throw new Error("native session was not listed");
    const entries = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (agent === "codex") {
      expect(entries[0].payload.cwd).toBe(nativeCwd);
      expect(relative(scene.home, file)).toMatch(/^sessions\/2026\/08\/05\/rollout-.*\.jsonl$/);
    } else if (agent === "pi") {
      expect(entries[0].cwd).toBe(nativeCwd);
      const encoded = `--${nativeCwd.replace(/^\//, "").replace(/[\\/]/g, "-")}--`;
      expect(dirname(file)).toBe(join(scene.home, "sessions", encoded));
    } else {
      expect(
        entries
          .filter((entry) => entry.cwd !== undefined)
          .every((entry) => entry.cwd === nativeCwd),
      ).toBe(true);
      expect(dirname(file)).toBe(
        join(scene.home, "projects", nativeCwd.replace(/[^a-zA-Z0-9]/g, "-")),
      );
    }
    expect(await snapshot(scene.sourceHome)).toEqual(before);
    expect(await snapshot(scene.worktree)).toEqual(repositoryBefore);
  },
);

test("a canonical destination and its symlink alias have the same token; confirmation retains native spelling", async () => {
  const scene = await bench();
  const request = await scene.request(scene.destinationCwd);
  const alias = join(scene.root, "alias");
  await symlink(scene.worktree, alias);
  const nativeRequest = { ...request, destinationCwd: join(alias, "sub directory") };
  const preview = await scene.pipeline.preview(request);
  expect((await scene.pipeline.preview(nativeRequest)).confirmationToken).toBe(
    preview.confirmationToken,
  );
  const result = await scene.pipeline.commit(nativeRequest, runtime, preview.confirmationToken);
  const stored = await scene.host.registry().get("codex").listSessions(scene.home);
  expect(stored.find((item) => item.ref.id === result.ref.id)?.repoPath).toBe(
    nativeRequest.destinationCwd,
  );
});

test("a token cannot cross identical-HEAD detached worktrees and creates no files", async () => {
  const scene = await bench();
  const other = join(scene.root, "other checkout");
  git(scene.hostCwd, "worktree", "add", "--detach", other, scene.initial);
  expect(git(scene.worktree, "rev-parse", "HEAD")).toBe(git(other, "rev-parse", "HEAD"));
  // Keep source descriptor/content identical and eligible under exact-directory discovery.
  // Only this recorded alias is retargeted; cross-directory discovery is still disabled.
  const sourceLocation = join(scene.root, "recorded location");
  await symlink(scene.worktree, sourceLocation);
  const request = await scene.request(scene.worktree, sourceLocation);
  const preview = await scene.pipeline.preview(request);
  await unlink(sourceLocation);
  await symlink(other, sourceLocation);
  await expect(
    scene.pipeline.commit(
      { ...request, destinationCwd: other },
      runtime,
      preview.confirmationToken,
    ),
  ).rejects.toMatchObject({ stage: "confirmation" });
  expect(await snapshot(scene.home)).toEqual({});
});

test("fresh common-directory identity binds confirmation even when cwd, HEAD, branch and preview text stay unchanged", async () => {
  const scene = await bench();
  const request = await scene.request(scene.hostCwd);
  const preview = await scene.pipeline.preview(request);
  const metadata = join(scene.root, "relocated metadata");
  await rename(join(scene.hostCwd, ".git"), metadata);
  await writeFile(join(scene.hostCwd, ".git"), `gitdir: ${metadata}\n`);
  const fresh = await scene.pipeline.preview(request);
  expect(fresh.lines).toEqual(preview.lines);
  expect(fresh.confirmationToken).not.toBe(preview.confirmationToken);
  await expect(
    scene.pipeline.commit(request, runtime, preview.confirmationToken),
  ).rejects.toMatchObject({ stage: "confirmation" });
  expect(await snapshot(scene.home)).toEqual({});
  await expect(
    scene.pipeline.commit(request, runtime, fresh.confirmationToken),
  ).resolves.toMatchObject({ itemsSent: expect.any(Number) });
});

test("bare repositories are refused by list, preview and commit; their linked checkout imports successfully", async () => {
  const scene = await bench();
  const bare = join(scene.root, "bare.git");
  git(scene.root, "clone", "--bare", scene.hostCwd, bare);
  const request = await scene.request(bare);
  await expect(scene.pipeline.list(request)).rejects.toThrow(/bare.*linked worktree/i);
  await expect(scene.pipeline.preview(request)).rejects.toThrow(/bare.*linked worktree/i);
  await expect(scene.pipeline.commit(request, runtime, "unused")).rejects.toThrow(
    /bare.*linked worktree/i,
  );
  expect(await snapshot(scene.home)).toEqual({});
  const linked = join(scene.root, "bare linked");
  git(bare, "worktree", "add", "--detach", linked, "HEAD");
  const valid = await scene.request(linked);
  const preview = await scene.pipeline.preview(valid);
  await expect(
    scene.pipeline.commit(valid, runtime, preview.confirmationToken),
  ).resolves.toMatchObject({ itemsSent: expect.any(Number) });
});
