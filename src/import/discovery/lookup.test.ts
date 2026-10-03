import { realpath, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RepoIdentity } from "../../platform/repo/contract.js";
import { createRepoReader } from "../../platform/repo/index.js";
import { createSessionFinder } from "./finder.js";
import { makeDir, makeFixtureRoot, makeStubAdapter, writeSession } from "./test-support.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, realpath: vi.fn(fs.realpath) };
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: string;
let destination: string;
let home: string;
beforeEach(async () => {
  root = await makeFixtureRoot();
  destination = await makeDir(root, "destination");
  home = await makeDir(root, "home");
});
afterEach(async () => {
  vi.mocked(realpath).mockRestore();
  await rm(root, { recursive: true, force: true });
});
const unresolved = { root: null, commonDir: null, isBare: false, head: null, branch: null };

it.each(["EACCES", "EIO"])(
  "shares filesystem %s failures at the session boundary, refreshing on the next listing",
  async (code) => {
    const candidate = await makeDir(root, "candidate");
    for (const id of ["bad-one", "bad-two", "good"]) {
      await writeSession(home, {
        id,
        repoPath: id === "good" ? destination : candidate,
        updatedAt: "2026-01-01",
      });
    }
    const identify = vi.fn(async () => unresolved);
    const discovery = createSessionFinder({
      adapters: [makeStubAdapter({ agent: "pi", defaultHome: home })],
      config: { extraHomes: [] },
      repo: { checkCancellation() {}, identify },
    });
    const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const failure = Object.assign(new Error("cannot resolve candidate"), { code });
    vi.mocked(realpath).mockImplementation(async (directory) => {
      if (directory === candidate) throw failure;
      return real.realpath(directory);
    });
    const scope = { repoRoot: destination, onlyAgent: null, onlyHome: null };
    const listing = await discovery.list(scope);
    expect(listing.rows.map((row) => row.ref.id)).toEqual(["good"]);
    expect(listing.failures).toHaveLength(2);
    expect(
      listing.failures.every((entry) => entry.message.includes("cannot resolve candidate")),
    ).toBe(true);
    expect(
      vi.mocked(realpath).mock.calls.filter(([directory]) => directory === candidate),
    ).toHaveLength(1);
    expect(identify).toHaveBeenCalledTimes(1);
    vi.mocked(realpath).mockImplementation(real.realpath);
    expect(
      (await discovery.list(scope)).failures.every((entry) => entry.message.includes("unresolved")),
    ).toBe(true);
    expect(identify).toHaveBeenCalledTimes(3);
    vi.mocked(realpath).mockImplementation(async () => {
      throw failure;
    });
    await expect(discovery.list(scope)).rejects.toThrow(
      "Destination repository lookup failed: cannot resolve candidate",
    );
  },
);

it("shares missing and unresolved candidates, without making missing exact paths positive evidence", async () => {
  const missing = path.join(destination, "missing");
  for (const id of ["one", "two"]) {
    await writeSession(home, {
      id,
      repoPath: missing,
      repoPaths: [missing, destination],
      updatedAt: "2026-01-01",
    });
  }
  const identify = vi.fn(async () => unresolved);
  const discovery = createSessionFinder({
    adapters: [makeStubAdapter({ agent: "pi", defaultHome: home })],
    config: { extraHomes: [] },
    repo: { checkCancellation() {}, identify },
  });
  const scope = { repoRoot: destination, onlyAgent: null, onlyHome: null };
  expect((await discovery.list(scope)).rows).toHaveLength(2);
  expect(identify.mock.calls).toHaveLength(2);
  expect((await discovery.list({ ...scope, repoRoot: missing })).rows).toHaveLength(0);
  expect(identify.mock.calls).toHaveLength(4);
});

it.each(["list", "resolve", "empty"] as const)(
  "rejects cancellation during adapter enumeration before returning cached evidence (%s)",
  async (operation) => {
    await writeSession(home, { id: "same-path", repoPath: destination, updatedAt: "2026-01-01" });
    const controller = new AbortController();
    const adapter = makeStubAdapter({ agent: "pi", defaultHome: home });
    const found = await adapter.listSessions(home);
    const entered = deferred<void>();
    const pending = deferred<typeof found>();
    adapter.listSessions = () => {
      entered.resolve();
      return pending.promise;
    };
    const repo = createRepoReader({ signal: controller.signal });
    const identify = vi.spyOn(repo, "identify");
    const discovery = createSessionFinder({
      adapters: [adapter],
      config: { extraHomes: [] },
      repo,
    });
    const scope = { repoRoot: destination, onlyAgent: null, onlyHome: null };
    const result =
      operation === "resolve"
        ? discovery.resolve(scope, { by: "row", row: 1 })
        : discovery.list(scope);
    await entered.promise;
    expect(identify).toHaveBeenCalledTimes(1);
    controller.abort("stop enumeration");
    pending.resolve(operation === "empty" ? [] : found);
    await expect(result).rejects.toMatchObject({ name: "AbortError", cause: "stop enumeration" });
  },
);

it("checks cancellation before using supplied destination evidence", async () => {
  const controller = new AbortController();
  const repo = createRepoReader({ signal: controller.signal });
  const identify = vi.spyOn(repo, "identify");
  const discovery = createSessionFinder({ adapters: [], config: { extraHomes: [] }, repo });
  controller.abort("already stopped");
  await expect(
    discovery.list(
      { repoRoot: destination, onlyAgent: null, onlyHome: null },
      { canonicalCwd: destination, identity: unresolved },
    ),
  ).rejects.toMatchObject({ name: "AbortError", cause: "already stopped" });
  expect(identify).not.toHaveBeenCalled();
});

it("rejects supplied evidence for a different destination", async () => {
  const discovery = createSessionFinder({
    adapters: [],
    config: { extraHomes: [] },
    repo: createRepoReader(),
  });
  await expect(
    discovery.list(
      { repoRoot: destination, onlyAgent: null, onlyHome: null },
      { canonicalCwd: home, identity: unresolved },
    ),
  ).rejects.toThrow("Destination evidence does not match the requested directory");
});

it("checks cancellation after loading a source session", async () => {
  await writeSession(home, { id: "same-path", repoPath: destination, updatedAt: "2026-01-01" });
  const controller = new AbortController();
  const adapter = makeStubAdapter({ agent: "pi", defaultHome: home });
  const discovery = createSessionFinder({
    adapters: [adapter],
    config: { extraHomes: [] },
    repo: createRepoReader({ signal: controller.signal }),
  });
  const descriptor = await discovery.resolve(
    { repoRoot: destination, onlyAgent: null, onlyHome: null },
    { by: "row", row: 1 },
  );
  const session = await adapter.loadSession(descriptor);
  const entered = deferred<void>();
  const pending = deferred<typeof session>();
  adapter.loadSession = () => {
    entered.resolve();
    return pending.promise;
  };
  const result = discovery.load(descriptor);
  await entered.promise;
  controller.abort("stop loading");
  pending.resolve(session);
  await expect(result).rejects.toMatchObject({ name: "AbortError", cause: "stop loading" });
});

it.each([undefined, new Error("custom stop"), "stop"])(
  "propagates normalized cancellation even for a missing destination (%s)",
  async (reason) => {
    const controller = new AbortController();
    controller.abort(reason);
    const discovery = createSessionFinder({
      adapters: [],
      config: { extraHomes: [] },
      repo: createRepoReader({ signal: controller.signal }),
    });
    await expect(
      discovery.list({
        repoRoot: path.join(destination, "missing"),
        onlyAgent: null,
        onlyHome: null,
      }),
    ).rejects.toMatchObject({ name: "AbortError", cause: controller.signal.reason });
  },
);

const scope = () => ({ repoRoot: destination, onlyAgent: null, onlyHome: null });

function discoveryOf(identify: (directory: string) => Promise<RepoIdentity>) {
  return createSessionFinder({
    adapters: [makeStubAdapter({ agent: "pi", defaultHome: home })],
    config: { extraHomes: [] },
    repo: { checkCancellation() {}, identify },
  });
}

it("lists a session whose start directory is this one when no candidate matches (T-DIS-30)", async () => {
  const subdirectory = await makeDir(destination, "backend");
  const elsewhere = await makeDir(root, "elsewhere");
  await writeSession(home, {
    id: "started-here",
    repoPath: subdirectory,
    repoPaths: [subdirectory],
    startDirectory: destination,
    updatedAt: "2026-01-02",
  });
  await writeSession(home, {
    id: "started-elsewhere",
    repoPath: subdirectory,
    repoPaths: [subdirectory],
    startDirectory: elsewhere,
    updatedAt: "2026-01-01",
  });

  const listing = await discoveryOf(async () => unresolved).list(scope());

  expect(listing.rows.map((row) => row.ref.id)).toEqual(["started-here"]);
  // Its candidate resolved elsewhere and its start directory is not here: the normal
  // FR-13 exclusion, counted rather than narrated.
  expect(listing.failures).toEqual([]);
  expect(listing.excluded).toBe(1);
});

it("does not let a start directory rescue a foreign candidate without a match (T-DIS-30)", async () => {
  const otherRepo = await makeDir(root, "other-repo");
  const active = await makeDir(otherRepo, "src");
  await writeSession(home, {
    id: "ambiguous",
    repoPath: active,
    repoPaths: [active],
    startDirectory: destination,
    updatedAt: "2026-01-01",
  });

  const listing = await discoveryOf(async (directory) => ({
    ...unresolved,
    commonDir: directory.startsWith(otherRepo) ? `${otherRepo}/.git` : `${destination}/.git`,
  })).list(scope());

  expect(listing.rows).toEqual([]);
  // Without a positively matching candidate there is no contradiction to report: the session
  // belongs to another repository, and a start directory of this one does not change that.
  expect(listing.failures).toEqual([]);
  expect(listing.excluded).toBe(1);
});
