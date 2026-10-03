// T-DIS-14 to T-DIS-20 — bad input, bad homes, and the two things that must never happen.

import { chmod, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { SearchScope, SelectionInput } from "./contract.js";
import { createSessionFinder } from "./finder.js";
import {
  checksumTree,
  makeDir,
  makeFixtureRoot,
  makeStubAdapter,
  type StubAdapter,
  stubNetwork,
  unresolvedRepo,
  writeSession,
} from "./test-support.js";

let root: string;
let repoA: string;
let repoB: string;
let network: ReturnType<typeof stubNetwork>;

beforeAll(() => {
  network = stubNetwork();
});

beforeEach(async () => {
  root = await makeFixtureRoot();
  repoA = await makeDir(root, "repo-a");
  repoB = await makeDir(root, "repo-b");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function scopeFor(repoRoot: string): SearchScope {
  return { repoRoot, onlyAgent: null, onlyHome: null };
}

function finderOf(adapters: StubAdapter[]) {
  return createSessionFinder({ adapters, repo: unresolvedRepo, config: { extraHomes: [] } });
}

it.each([
  { name: "row 0", make: (): SelectionInput => ({ by: "row", row: 0 }) },
  { name: "row 999", make: (): SelectionInput => ({ by: "row", row: 999 }) },
  {
    name: "an unknown session ID",
    make: (): SelectionInput => ({ by: "session-id", id: "never-existed" }),
  },
  {
    name: "a path that does not exist",
    make: (): SelectionInput => ({ by: "file-path", path: path.join(root, "gone.json") }),
  },
  {
    name: "a path that is not a session",
    make: (): SelectionInput => ({ by: "file-path", path: path.join(root, "notes.txt") }),
  },
])("T-DIS-14 — $name fails with a message", async ({ make }) => {
  const home = await makeDir(root, "pi-home");
  await writeFile(path.join(root, "notes.txt"), "not a session", "utf8");
  await writeSession(home, { id: "pi-1", updatedAt: "2026-06-01T10:00:00.000Z", repoPath: repoA });
  const finder = finderOf([makeStubAdapter({ agent: "pi", defaultHome: home })]);
  const input = make();

  const error = await finder.resolve(scopeFor(repoA), input).then(
    () => null,
    (reason: unknown) => reason as { input: string; message: string },
  );

  expect(error).not.toBeNull();
  const expectedInput =
    input.by === "row" ? String(input.row) : input.by === "session-id" ? input.id : input.path;
  expect(error?.input).toBe(expectedInput);
  // FR-56: name what the user gave, and what to do next.
  expect(error?.message).toContain(expectedInput);
  expect(error?.message).toMatch(/list/i);
});

it("T-DIS-15 — a session from another repository cannot be reached by ID or path", async () => {
  const home = await makeDir(root, "pi-home");
  await writeSession(home, { id: "here", updatedAt: "2026-06-02T10:00:00.000Z", repoPath: repoA });
  const strangerPath = await writeSession(home, {
    id: "elsewhere",
    updatedAt: "2026-06-03T10:00:00.000Z",
    repoPath: repoB,
  });
  const adapter = makeStubAdapter({ agent: "pi", defaultHome: home });

  // The adapter really does offer it; the filter is what makes it unreachable.
  const raw = await adapter.listSessions(home);
  expect(raw.map((r) => r.ref.id).sort()).toEqual(["elsewhere", "here"]);

  const finder = finderOf([adapter]);
  await expect(
    finder.resolve(scopeFor(repoA), { by: "session-id", id: "elsewhere" }),
  ).rejects.toMatchObject({ input: "elsewhere" });
  await expect(
    finder.resolve(scopeFor(repoA), { by: "file-path", path: strangerPath }),
  ).rejects.toMatchObject({ input: strangerPath });
});

const rootUser = typeof process.getuid === "function" && process.getuid() === 0;

/** Lists one good home beside the bad one, and asserts the good one survived. */
async function expectBadHomeTolerated(bad: string): Promise<void> {
  const good = await makeDir(root, "pi-home");
  await writeSession(good, {
    id: "good-1",
    updatedAt: "2026-06-04T10:00:00.000Z",
    repoPath: repoA,
  });

  const listing = await finderOf([
    makeStubAdapter({ agent: "pi", defaultHome: good }),
    makeStubAdapter({ agent: "codex", defaultHome: bad }),
  ]).list(scopeFor(repoA));

  expect(listing.rows.map((r) => r.ref.id)).toEqual(["good-1"]);
  expect(listing.failures).toHaveLength(1);
  expect(listing.failures[0]).toMatchObject({ home: bad, agent: "codex" });
  expect(listing.failures[0]?.message.length).toBeGreaterThan(0);
  expect(listing.failures[0]?.message).not.toContain("\n"); // one line
}

it.each([
  {
    name: "a home that does not exist",
    stage: async (): Promise<string> => path.join(root, "codex-missing"),
  },
  {
    name: "a home with a corrupt session file",
    stage: async (): Promise<string> => {
      const bad = await makeDir(root, "codex-corrupt");
      await writeFile(path.join(bad, "broken.json"), "{ not json", "utf8");
      return bad;
    },
  },
])("T-DIS-16 — one bad home does not empty the listing ($name)", async ({ stage }) => {
  await expectBadHomeTolerated(await stage());
});

// Skipped rather than silently vacuous: root can read a 0o000 directory.
it.skipIf(rootUser)(
  "T-DIS-16 — one bad home does not empty the listing (a home with no read permission)",
  async () => {
    const bad = await makeDir(root, "codex-locked");
    await chmod(bad, 0o000);
    try {
      await expectBadHomeTolerated(bad);
    } finally {
      await chmod(bad, 0o700);
    }
  },
);

it("T-DIS-17 — every home failing still returns a listing", async () => {
  const listing = await finderOf([
    makeStubAdapter({ agent: "pi", defaultHome: path.join(root, "nope-pi") }),
    makeStubAdapter({ agent: "codex", defaultHome: path.join(root, "nope-codex") }),
  ]).list(scopeFor(repoA));

  expect(listing.rows).toEqual([]);
  expect(listing.failures.map((f) => f.agent)).toEqual(["pi", "codex"]);
});

it("T-DIS-18 — an empty listing is not an error", async () => {
  const empty = await makeDir(root, "pi-home");
  const elsewhere = await makeDir(root, "codex-home");
  await writeSession(elsewhere, {
    id: "other-repo",
    updatedAt: "2026-06-05T10:00:00.000Z",
    repoPath: repoB,
  });

  const listing = await finderOf([
    makeStubAdapter({ agent: "pi", defaultHome: empty }),
    makeStubAdapter({ agent: "codex", defaultHome: elsewhere }),
  ]).list(scopeFor(repoA));

  expect(listing.rows).toEqual([]);
  // A session that resolved in another repository is the normal FR-13 exclusion: counted.
  expect(listing.failures).toEqual([]);
  expect(listing.excluded).toBe(1);
});

it("T-DIS-19 — nothing is written", async () => {
  const piHome = await makeDir(root, "pi-home");
  const codexHome = await makeDir(root, "codex-home");
  await writeSession(piHome, {
    id: "pi-1",
    updatedAt: "2026-06-06T10:00:00.000Z",
    repoPath: repoA,
  });
  await writeSession(codexHome, {
    id: "cx-1",
    updatedAt: "2026-06-07T10:00:00.000Z",
    repoPath: repoA,
    turns: [
      { index: 0, role: "user", kind: "message", text: "hi", toolCall: null, timestamp: null },
    ],
  });
  await writeFile(path.join(repoA, "file.txt"), "repository content", "utf8");
  const finder = finderOf([
    makeStubAdapter({ agent: "pi", defaultHome: piHome }),
    makeStubAdapter({ agent: "codex", defaultHome: codexHome }),
  ]);
  // The whole fixture tree: both homes, the repository, and anything written beside them.
  const before = await checksumTree(root);

  const listing = await finder.list(scopeFor(repoA));
  const chosen = await finder.resolve(scopeFor(repoA), { by: "row", row: 1 });
  await finder.load(chosen);
  await expect(finder.resolve(scopeFor(repoA), { by: "row", row: 99 })).rejects.toBeDefined();

  expect(listing.rows).toHaveLength(2);
  expect(await checksumTree(root)).toBe(before);
});

it("T-DIS-20 — no model is called", async () => {
  const home = await makeDir(root, "pi-home");
  await writeSession(home, { id: "pi-1", updatedAt: "2026-06-08T10:00:00.000Z", repoPath: repoA });
  const finder = finderOf([makeStubAdapter({ agent: "pi", defaultHome: home })]);

  const listing = await finder.list(scopeFor(repoA));
  const chosen = await finder.resolve(scopeFor(repoA), { by: "row", row: 1 });
  await finder.load(chosen);

  expect(listing.rows).toHaveLength(1);
  expect(network).not.toHaveBeenCalled();
  expect(() => (globalThis.fetch as unknown as () => void)()).toThrow(/network is disabled/);
});
