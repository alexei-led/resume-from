// T-DIS-1 to T-DIS-9 — the search list, the ordering and the repository filter.

import { rm, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { HomeEntry, SearchScope } from "./contract.js";
import { createSessionFinder } from "./finder.js";
import {
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
const homeEnv = process.env.HOME;

beforeAll(() => {
  stubNetwork();
});

beforeEach(async () => {
  root = await makeFixtureRoot();
  repoA = await makeDir(root, "repo-a");
  repoB = await makeDir(root, "repo-b");
});

afterEach(async () => {
  if (homeEnv === undefined) delete process.env.HOME;
  else process.env.HOME = homeEnv;
  await rm(root, { recursive: true, force: true });
});

function scopeFor(repoRoot: string, over: Partial<SearchScope> = {}): SearchScope {
  return { repoRoot, onlyAgent: null, onlyHome: null, ...over };
}

function finderOf(adapters: StubAdapter[], extraHomes: HomeEntry[] = []) {
  return createSessionFinder({ adapters, repo: unresolvedRepo, config: { extraHomes } });
}

it("T-DIS-1 — the search list is the defaults plus the extras", async () => {
  const defaults = await Promise.all([
    makeDir(root, "pi-home"),
    makeDir(root, "codex-home"),
    makeDir(root, "cc-home"),
  ]);
  const extras = await Promise.all([makeDir(root, "pi-extra"), makeDir(root, "codex-extra")]);
  const adapters = [
    makeStubAdapter({ agent: "pi", defaultHome: defaults[0] as string }),
    makeStubAdapter({ agent: "codex", defaultHome: defaults[1] as string }),
    makeStubAdapter({
      agent: "claude-code",
      defaultHome: defaults[2] as string,
    }),
  ];

  await finderOf(adapters, [
    { agent: "pi", home: extras[0] as string },
    { agent: "codex", home: extras[1] as string },
  ]).list(scopeFor(repoA));

  const searched = adapters.flatMap((a) => a.calls);
  expect(searched.length).toBe(5);
  expect([...searched].sort()).toEqual([...defaults, ...extras].sort());
});

const duplicateCases = [
  { name: "the same absolute path", spell: (home: string) => home },
  {
    name: "a path through ..",
    spell: (home: string) => path.join(home, "..", path.basename(home)),
  },
  { name: "a ~ path", spell: (home: string) => `~/${path.basename(home)}` },
  { name: "a symlink", spell: (_home: string) => "" }, // filled in by the test body
] as const;

it.each(duplicateCases)(
  "T-DIS-2 — a duplicate home is searched once ($name)",
  async ({ name, spell }) => {
    process.env.HOME = root;
    const home = await makeDir(root, "shared-home");
    let extra = spell(home);
    if (name === "a symlink") {
      extra = path.join(root, "linked-home");
      await symlink(home, extra, "dir");
    }
    const adapter = makeStubAdapter({ agent: "pi", defaultHome: home });

    await finderOf([adapter], [{ agent: "pi", home: extra }]).list(scopeFor(repoA));

    expect(adapter.calls).toEqual([home]);
  },
);

it("T-DIS-3 — only source adapters are searched", async () => {
  const sourceHome = await makeDir(root, "pi-home");
  const targetHome = await makeDir(root, "codex-home");
  await writeSession(sourceHome, {
    id: "s1",
    updatedAt: "2026-01-01T10:00:00.000Z",
    repoPath: repoA,
  });
  await writeSession(targetHome, {
    id: "t1",
    updatedAt: "2026-01-01T11:00:00.000Z",
    repoPath: repoA,
  });
  const source = makeStubAdapter({ agent: "pi", defaultHome: sourceHome });
  const target = makeStubAdapter({
    agent: "codex",
    defaultHome: targetHome,
    roles: ["target"],
  });

  const listing = await finderOf([source, target]).list(scopeFor(repoA));

  expect(target.calls).toEqual([]);
  expect(listing.rows.map((r) => r.ref.id)).toEqual(["s1"]);
});

it("T-DIS-4 — the listing is newest first", async () => {
  const homes = await Promise.all([
    makeDir(root, "pi-a"),
    makeDir(root, "pi-b"),
    makeDir(root, "codex-a"),
    makeDir(root, "cc-a"),
  ]);
  const minute = (n: number) => `2026-03-0${n}T09:00:00.000Z`;
  const plan: Array<[number, string, number]> = [
    [0, "pi-1", 1],
    [0, "pi-2", 5],
    [1, "pi-3", 9],
    [1, "pi-4", 3],
    [2, "cx-1", 8],
    [2, "cx-2", 2],
    [2, "cx-3", 6],
    [3, "cc-1", 7],
    [3, "cc-2", 4],
  ];
  for (const [homeIndex, id, day] of plan) {
    await writeSession(homes[homeIndex] as string, {
      id,
      updatedAt: minute(day),
      repoPath: repoA,
    });
  }
  const adapters = [
    makeStubAdapter({ agent: "pi", defaultHome: homes[0] as string }),
    makeStubAdapter({ agent: "codex", defaultHome: homes[2] as string }),
    makeStubAdapter({ agent: "claude-code", defaultHome: homes[3] as string }),
  ];

  const listing = await finderOf(adapters, [{ agent: "pi", home: homes[1] as string }]).list(
    scopeFor(repoA),
  );

  expect(listing.rows.map((r) => r.ref.id)).toEqual([
    "pi-3",
    "cx-1",
    "cc-1",
    "cx-3",
    "pi-2",
    "cc-2",
    "pi-4",
    "cx-2",
    "pi-1",
  ]);
  const times = listing.rows.map((r) => Date.parse(r.updatedAt));
  expect(times).toEqual([...times].sort((a, b) => b - a));
  expect(new Set(listing.rows.slice(0, 3).map((r) => r.ref.agent)).size).toBe(3);
});

it("T-DIS-5 — the ordering is deterministic on a tie", async () => {
  const home = await makeDir(root, "pi-home");
  const other = await makeDir(root, "codex-home");
  const tie = "2026-04-01T12:00:00.000Z";
  await writeSession(home, {
    id: "b-session",
    updatedAt: tie,
    repoPath: repoA,
  });
  await writeSession(home, {
    id: "a-session",
    updatedAt: tie,
    repoPath: repoA,
  });
  await writeSession(other, {
    id: "c-session",
    updatedAt: tie,
    repoPath: repoA,
  });

  const permutations = [
    (rows: unknown[]) => rows,
    (rows: unknown[]) => [...rows].reverse(),
  ] as const;
  const seen = new Set<string>();
  for (const permute of permutations) {
    const adapters = [
      makeStubAdapter({
        agent: "pi",
        defaultHome: home,
        permute: permute as never,
      }),
      makeStubAdapter({
        agent: "codex",
        defaultHome: other,
        permute: permute as never,
      }),
    ];
    const finder = finderOf(adapters);
    for (let run = 0; run < 50; run++) {
      const listing = await finder.list(scopeFor(repoA));
      seen.add(listing.rows.map((r) => `${r.ref.agent}/${r.ref.id}`).join(","));
    }
  }

  // Tie broken by SessionRef: agent, then home, then id.
  expect(seen.size).toBe(1);
  expect([...seen][0]).toBe("codex/c-session,pi/a-session,pi/b-session");
});

it("T-DIS-6 — only sessions of this repository are listed", async () => {
  const home = await makeDir(root, "pi-home");
  await writeSession(home, {
    id: "in-a",
    updatedAt: "2026-01-02T10:00:00.000Z",
    repoPath: repoA,
  });
  await writeSession(home, {
    id: "in-b",
    updatedAt: "2026-01-03T10:00:00.000Z",
    repoPath: repoB,
  });
  const adapter = makeStubAdapter({ agent: "pi", defaultHome: home });

  const listing = await finderOf([adapter]).list(scopeFor(repoA));

  expect(listing.rows.map((r) => r.ref.id)).toEqual(["in-a"]);
  // The session of repository B is the normal FR-13 exclusion: counted, not narrated.
  expect(listing.failures).toEqual([]);
  expect(listing.excluded).toBe(1);
});

it("T-DIS-7 — a session with no repository is out of scope", async () => {
  const home = await makeDir(root, "pi-home");
  await writeSession(home, {
    id: "homeless",
    updatedAt: "2026-01-02T10:00:00.000Z",
    repoPath: null,
  });
  await writeSession(home, {
    id: "in-a",
    updatedAt: "2026-01-01T10:00:00.000Z",
    repoPath: repoA,
  });
  const adapter = makeStubAdapter({ agent: "pi", defaultHome: home });

  const listing = await finderOf([adapter]).list(scopeFor(repoA));

  expect(listing.rows.map((r) => r.ref.id)).toEqual(["in-a"]);
  expect(listing.failures).toHaveLength(1);
  expect(listing.failures[0]).toMatchObject({ home, agent: "pi" });
  expect(listing.failures[0]?.message).toContain("homeless");
});

it("T-DIS-8 — naming one agent narrows the search", async () => {
  const piHome = await makeDir(root, "pi-home");
  const codexHome = await makeDir(root, "codex-home");
  const codexExtra = await makeDir(root, "codex-extra");
  await writeSession(piHome, {
    id: "pi-1",
    updatedAt: "2026-01-05T10:00:00.000Z",
    repoPath: repoA,
  });
  await writeSession(codexHome, {
    id: "cx-1",
    updatedAt: "2026-01-04T10:00:00.000Z",
    repoPath: repoA,
  });
  await writeSession(codexExtra, {
    id: "cx-2",
    updatedAt: "2026-01-03T10:00:00.000Z",
    repoPath: repoA,
  });
  const pi = makeStubAdapter({ agent: "pi", defaultHome: piHome });
  const codex = makeStubAdapter({ agent: "codex", defaultHome: codexHome });

  const listing = await finderOf([pi, codex], [{ agent: "codex", home: codexExtra }]).list(
    scopeFor(repoA, { onlyAgent: "codex" }),
  );

  expect(pi.calls).toEqual([]);
  expect([...codex.calls].sort()).toEqual([codexExtra, codexHome].sort());
  expect(listing.rows.map((r) => r.ref.id)).toEqual(["cx-1", "cx-2"]);
});

it("T-DIS-9 — naming one home narrows the search", async () => {
  process.env.HOME = root;
  const main = await makeDir(root, ".claude");
  const team = await makeDir(root, ".claude-team");
  await writeSession(main, {
    id: "main-1",
    updatedAt: "2026-01-05T10:00:00.000Z",
    repoPath: repoA,
  });
  await writeSession(team, {
    id: "team-1",
    updatedAt: "2026-01-04T10:00:00.000Z",
    repoPath: repoA,
  });
  const adapter = makeStubAdapter({ agent: "claude-code", defaultHome: main });

  const listing = await finderOf(
    [adapter],
    [{ agent: "claude-code", home: "~/.claude-team" }],
  ).list(scopeFor(repoA, { onlyHome: "~/.claude-team" }));

  expect(adapter.calls).toEqual([team]);
  expect(listing.rows.map((r) => r.ref.id)).toEqual(["team-1"]);
});

it("T-DIS-25 — a named home outside every default and extra home is still searched (FR-2)", async () => {
  process.env.HOME = root;
  const main = await makeDir(root, ".claude");
  const team = await makeDir(root, ".claude-team");
  await writeSession(team, {
    id: "team-1",
    updatedAt: "2026-01-04T10:00:00.000Z",
    repoPath: repoA,
  });
  const adapter = makeStubAdapter({ agent: "claude-code", defaultHome: main });

  // No extraHomes entry: the named home is known to no configuration.
  const listing = await finderOf([adapter]).list(scopeFor(repoA, { onlyHome: "~/.claude-team" }));

  expect(adapter.calls).toEqual([team]);
  expect(listing.rows.map((r) => r.ref.id)).toEqual(["team-1"]);
});

it("T-DIS-26 — an unlisted named home narrowed by agent searches only that agent", async () => {
  process.env.HOME = root;
  const team = await makeDir(root, ".claude-team");
  await writeSession(team, {
    id: "team-1",
    updatedAt: "2026-01-04T10:00:00.000Z",
    repoPath: repoA,
  });
  const claude = makeStubAdapter({
    agent: "claude-code",
    defaultHome: await makeDir(root, ".claude"),
  });
  const codex = makeStubAdapter({
    agent: "codex",
    defaultHome: await makeDir(root, ".codex"),
  });

  const listing = await finderOf([claude, codex]).list(
    scopeFor(repoA, { onlyHome: "~/.claude-team", onlyAgent: "claude-code" }),
  );

  expect(claude.calls).toEqual([team]);
  expect(codex.calls).toEqual([]);
  expect(listing.rows.map((r) => r.ref.id)).toEqual(["team-1"]);
});

it("T-DIS-27 — a named home that does not exist is reported, never silently empty (FR-2)", async () => {
  process.env.HOME = root;
  const adapter = makeStubAdapter({
    agent: "claude-code",
    defaultHome: await makeDir(root, ".claude"),
  });

  // A typo'd --home: nothing at that path. Adapters swallow a missing directory,
  // so the finder must say why the listing is empty.
  const listing = await finderOf([adapter]).list(scopeFor(repoA, { onlyHome: "~/.claude-tem" }));

  expect(listing.rows).toEqual([]);
  expect(listing.failures.length).toBeGreaterThan(0);
  expect(listing.failures[0]?.message).toContain("no such directory");
  expect(adapter.calls).toEqual([]);
});
