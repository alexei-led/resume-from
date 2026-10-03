import { execFileSync } from "node:child_process";
import { rm, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRepoReader } from "../../platform/repo/index.js";
import type { RepoReader, SearchScope } from "./contract.js";
import { createSessionFinder } from "./finder.js";
import { makeDir, makeFixtureRoot, makeStubAdapter, writeSession } from "./test-support.js";

let root: string;
let main: string;
let home: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" });
const scope = (repoRoot: string): SearchScope => ({ repoRoot, onlyAgent: null, onlyHome: null });

beforeEach(async () => {
  root = await makeFixtureRoot();
  main = await makeDir(root, "main checkout");
  home = await makeDir(root, "home");
  git(main, "init");
  git(
    main,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function finder(
  repo: Pick<RepoReader, "identify" | "checkCancellation"> = createRepoReader(),
  extraHomes: string[] = [],
) {
  return createSessionFinder({
    adapters: [makeStubAdapter({ agent: "claude-code", defaultHome: home })],
    config: { extraHomes: extraHomes.map((home) => ({ agent: "claude-code", home })) },
    repo,
  });
}
async function session(id: string, repoPaths: string[], sourceHome = home) {
  return writeSession(sourceHome, {
    id,
    repoPath: repoPaths[0] ?? null,
    repoPaths,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}
function worktree(location: string) {
  git(main, "worktree", "add", "--detach", location);
  return location;
}

it.each(
  ["nested", "sibling", "external"].flatMap((placement) =>
    ["main-to-linked", "linked-to-main"].map((direction) => ({ placement, direction })),
  ),
)(
  "discovers $placement worktrees $direction through every selector",
  async ({ placement, direction }) => {
    const linked = worktree(
      placement === "nested"
        ? path.join(main, ".worktrees", "feature")
        : placement === "sibling"
          ? path.join(root, "sibling")
          : path.join(root, "arbitrary", "external tree"),
    );
    const source = direction === "main-to-linked" ? main : linked;
    const destination = direction === "main-to-linked" ? linked : main;
    const file = await session("source", [source]);
    const discovery = finder();
    const listing = await discovery.list(scope(destination));
    expect(listing.rows.map((row) => row.ref.id)).toEqual(["source"]);
    for (const selection of [
      { by: "row", row: 1 },
      { by: "session-id", id: "source" },
      { by: "file-path", path: file },
    ] as const) {
      expect(await discovery.resolve(scope(destination), selection)).toEqual(listing.rows[0]);
    }
  },
);

it.each(["unfiltered", "configured", "named"])(
  "matches sibling worktrees, subdirectories and symlink aliases across %s alternate homes",
  async (mode) => {
    const first = worktree(path.join(root, "first"));
    const second = worktree(path.join(root, "elsewhere", "second"));
    const source = await makeDir(first, "src");
    const destination = await makeDir(second, "lib");
    const alias = path.join(root, "alias");
    await symlink(source, alias);
    const alternate = await makeDir(root, "alternate");
    const file = await session("duplicate", [alias], alternate);
    await session("duplicate", [main]);
    if (mode === "unfiltered") {
      const discovery = finder(createRepoReader(), [alternate]);
      const listing = await discovery.list(scope(destination));
      expect(listing.rows).toHaveLength(2);
      expect(listing.failures).toEqual([]);
      await expect(
        discovery.resolve(scope(destination), { by: "session-id", id: "duplicate" }),
      ).rejects.toThrow("matches 2 sessions");
      for (const [index, row] of listing.rows.entries()) {
        expect(await discovery.resolve(scope(destination), { by: "row", row: index + 1 })).toEqual(
          row,
        );
        expect(
          await discovery.resolve(scope(destination), { by: "file-path", path: row.filePath }),
        ).toEqual(row);
      }
    } else {
      const narrowed = {
        ...scope(destination),
        onlyAgent: "claude-code" as const,
        onlyHome: alternate,
      };
      const selected = finder(createRepoReader(), mode === "configured" ? [alternate] : []);
      expect((await selected.list(narrowed)).rows.map((row) => row.filePath)).toEqual([file]);
      for (const selection of [
        { by: "row", row: 1 },
        { by: "session-id", id: "duplicate" },
        { by: "file-path", path: file },
      ] as const) {
        expect((await selected.resolve(narrowed, selection)).filePath).toBe(file);
      }
    }
  },
);

it("uses surviving later evidence and treats missing and unresolved candidates as neutral in either order", async () => {
  const linked = worktree(path.join(root, "linked"));
  const missing = path.join(main, ".worktrees", "removed");
  const unresolved = await makeDir(root, "not git");
  await session("missing-first", [missing, main]);
  await session("neutral-first", [unresolved, linked]);
  await session("neutral-last", [main, unresolved, missing]);
  await session("main-to-linked", [main, linked]);
  await session("linked-to-main", [linked, main]);
  const listing = await finder().list(scope(linked));
  expect(listing.rows.map((row) => row.ref.id).sort()).toEqual([
    "linked-to-main",
    "main-to-linked",
    "missing-first",
    "neutral-first",
    "neutral-last",
  ]);
  expect(listing.rows.find((row) => row.ref.id === "missing-first")?.repoPath).toBe(missing);
  expect(listing.failures).toEqual([]);
});

it.each(["exact-first", "linked-first", "unrelated-first"])(
  "excludes conflicting evidence (%s), including every selector",
  async (order) => {
    const unrelated = await makeDir(main, "independent");
    git(unrelated, "init");
    const linked = worktree(path.join(root, "linked"));
    const candidates =
      order === "exact-first"
        ? [main, unrelated]
        : order === "linked-first"
          ? [linked, unrelated]
          : [unrelated, main];
    const file = await session("ambiguous", candidates);
    const discovery = finder();
    const listing = await discovery.list(scope(main));
    expect(listing.rows).toEqual([]);
    expect(listing.failures[0]?.message).toMatch(/ambiguous.*conflicting.*unambiguously/);
    for (const selection of [
      { by: "row", row: 1 },
      { by: "session-id", id: "ambiguous" },
      { by: "file-path", path: file },
    ] as const) {
      await expect(discovery.resolve(scope(main), selection)).rejects.toThrow(
        "conflicting repository identity",
      );
    }
  },
);

it("allows unresolved exact fallback only without resolved conflicting evidence; missing exact paths never match", async () => {
  const plain = await makeDir(root, "plain");
  const otherPlain = await makeDir(root, "other plain");
  const missing = path.join(main, "removed-worktree");
  await session("exact", [plain, otherPlain, missing]);
  await session("conflict", [plain, main]);
  await session("missing", [missing]);
  const listing = await finder().list(scope(plain));
  expect(listing.rows.map((row) => row.ref.id)).toEqual(["exact"]);
  // The contradictory session stays diagnostic; the session whose only recorded directory is
  // gone is a non-member like any other: it cannot be imported either way, so it is counted.
  expect(listing.failures).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ message: expect.stringMatching(/conflict.*conflicting/) }),
    ]),
  );
  expect(listing.excluded).toBe(1);
  expect((await finder().list(scope(missing))).rows).toEqual([]);
});

it("does not guess from missing ancestors or admit unrelated repositories, independent clones or shared objects", async () => {
  const linked = worktree(path.join(main, ".worktrees", "removed"));
  git(main, "worktree", "remove", linked);
  await session("removed", [linked, path.join(root, "also missing")]);
  const clone = path.join(root, "clone");
  git(root, "clone", "--shared", main, clone);
  await session("clone", [clone]);
  const nested = await makeDir(main, "nested");
  git(nested, "init");
  await session("nested", [nested]);
  const listing = await finder().list(scope(main));
  expect(listing.rows).toEqual([]);
  // Every recorded directory is gone: unresolvable sessions are counted, not narrated, and
  // foreign repositories never match by inference.
  expect(listing.failures).toEqual([]);
  expect(listing.excluded).toBe(3);
});

it.each(["timed out", "spawn ENOENT", "EACCES I/O"])(
  "isolates candidate %s errors and shares rejected lookups without losing sessions or homes",
  async (message) => {
    const bad = worktree(path.join(root, "bad"));
    const good = worktree(path.join(root, "good"));
    const alternate = await makeDir(root, "alternate");
    await session("a-bad", [main, bad]);
    await session("b-bad", [bad]);
    await session("c-good", [good]);
    await session("d-good", [main], alternate);
    await session("e-bad", [bad], alternate);
    const real = createRepoReader();
    const identify = vi.fn(async (directory: string) => {
      if (directory === bad) throw new Error(message);
      return real.identify(directory);
    });
    const discovery = finder({ ...real, identify }, [alternate]);
    const listing = await discovery.list(scope(main));
    expect(listing.rows.map((row) => row.ref.id)).toEqual(["d-good", "c-good"]);
    expect(listing.failures).toHaveLength(3);
    expect(listing.failures.every((failure) => failure.message.includes(message))).toBe(true);
    expect(identify.mock.calls.filter(([directory]) => directory === bad)).toHaveLength(1);
  },
);

it("shares canonical lookups within a listing across homes and aliases and refreshes on later listings", async () => {
  const linked = worktree(path.join(root, "linked"));
  const alias = path.join(root, "alias");
  await symlink(linked, alias);
  const alternate = await makeDir(root, "alternate");
  await session("one", [main, linked, alias]);
  await session("two", [alias, main], alternate);
  const real = createRepoReader();
  const identify = vi.fn((directory: string) => real.identify(directory));
  const discovery = finder({ ...real, identify }, [alternate]);
  expect((await discovery.list(scope(main))).rows).toHaveLength(2);
  expect(identify.mock.calls.map(([directory]) => directory).sort()).toEqual([main, linked].sort());
  git(main, "worktree", "remove", linked);
  await makeDir(linked);
  git(linked, "init");
  expect((await discovery.list(scope(main))).rows).toHaveLength(0);
  expect(identify).toHaveBeenCalledTimes(4);
});

it.each(["list", "row", "session-id", "file-path"])(
  "propagates source cancellation for %s even with matching sessions",
  async (selection) => {
    const linked = worktree(path.join(root, "linked"));
    const file = await session("a-good", [main]);
    await session("b-abort", [linked]);
    const abort = new Error("cancelled", { cause: "custom reason" });
    abort.name = "AbortError";
    const real = createRepoReader();
    const discovery = finder({
      ...real,
      identify: async (directory) => {
        if (directory === linked) throw abort;
        return real.identify(directory);
      },
    });
    const result =
      selection === "list"
        ? discovery.list(scope(main))
        : discovery.resolve(
            scope(main),
            selection === "row"
              ? { by: "row", row: 1 }
              : selection === "session-id"
                ? { by: "session-id", id: "a-good" }
                : { by: "file-path", path: file },
          );
    await expect(result).rejects.toBe(abort);
  },
);

it.each(["timed out", "spawn failure", "I/O failure"])(
  "rejects destination %s with a diagnostic",
  async (message) => {
    await session("good", [main]);
    await expect(
      finder({
        checkCancellation() {},
        identify: async () => {
          throw new Error(message);
        },
      }).list(scope(main)),
    ).rejects.toThrow(`Destination repository lookup failed: ${message}`);
  },
);
