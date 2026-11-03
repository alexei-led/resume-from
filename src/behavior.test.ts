/**
 * T-ROO-14 to T-ROO-23 — the acceptance criteria, run against the composed system.
 *
 * Everything here goes through the root's own entry point: `createHost()` builds the real agent
 * list, the real pipeline and the real adapters, and the only thing replaced is where the homes
 * are. Every home is a throwaway directory created for the test and removed afterwards, and
 * `HOME` moves with them, so no test reads the user's own sessions or settings (C-3).
 *
 * The nine directions land into homes of their own, so the seeded source homes are never written
 * to by an import. That is what lets T-ROO-17 compare them byte for byte afterwards.
 */

import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FIXTURE_AGENT_ID,
  FIXTURE_DOC_KIND,
  type FixtureThread,
  fixtureThreadPath,
} from "../test/fixtures/fixture-agent/index.js";
import type {
  AgentAdapter,
  AgentId,
  CanonicalSession,
  CanonicalTurn,
  HomePath,
  ImportConfig,
  LandingResult,
  PendingFile,
  PreviewReport,
  TargetProfile,
} from "./host/contract.js";
import { runCommandBinary } from "./index.js";
import {
  agentOf,
  type Bench,
  bench,
  checksumTree,
  cleanupTempDirs,
  fileList,
  importRequest,
  isInside,
  parseSource,
  REPO_ROOT,
  repoRelative,
  SRC_DIR,
  shippedSources,
  stringLiterals,
  tempDir,
  unionMembers,
} from "./test-support.js";

const SESSION_CONTRACT = join(SRC_DIR, "session", "contract.ts");

/**
 * A stand-in for Pi's command context. It lives in this file rather than in `test-support.ts`
 * because T-PI-20 allows the name `switchSession` in `src/adapters/pi/` and
 * `src/host/pi-extension/` alone, and reads every file that is not a `*.test.ts`.
 */
const fakePiRuntime = (cwd: string, home: HomePath): unknown => ({
  cwd,
  home,
  switchSession(_path: string, options: { withSession: () => void }) {
    options.withSession();
    return Promise.resolve({ cancelled: false });
  },
});

/** The runtime handle the target's declared landing needs — never one this file invented. */
const runtimeFor = (adapter: AgentAdapter, cwd: string, home: HomePath): unknown =>
  adapter.capabilities().landing === "create-and-switch" ? fakePiRuntime(cwd, home) : null;

/** Where a direction lands. Never a home a session was seeded into (FR-4, AC-4). */
const targetHomeOf = (scene: Bench, agent: AgentId): HomePath => join(scene.root, `${agent}-into`);

interface Direction {
  name: string;
  source: AgentId;
  target: AgentId;
  profile: TargetProfile;
  report: PreviewReport;
  result: LandingResult;
}

/** Every source crossed with every target: the scope table, whatever is in the list. */
async function runEveryDirection(scene: Bench): Promise<Direction[]> {
  const sources = scene.host.registry().sources().map(agentOf);
  const done: Direction[] = [];

  for (const target of scene.host.registry().targets()) {
    const agent = agentOf(target);
    const profile = scene.host
      .profiles()
      .build(agent, targetHomeOf(scene, agent), scene.host.config());
    const pipeline = await scene.host.pipelineFor(profile);

    for (const source of sources) {
      const request = importRequest(scene, source, profile);
      const report = await pipeline.preview(request);
      expect([report.blocked, report.blockedReason]).toEqual([false, null]);
      const result = await pipeline.commit(
        request,
        runtimeFor(target, REPO_ROOT, profile.home),
        report.confirmationToken,
      );
      done.push({
        name: `${source} → ${agent}`,
        source,
        target: agent,
        profile,
        report,
        result,
      });
    }
  }
  return done;
}

describe("the nine directions of the scope table", () => {
  let scene: Bench;
  let directions: Direction[];
  let before: Map<AgentId, Map<string, string>>;
  let after: Map<AgentId, Map<string, string>>;

  beforeAll(async () => {
    scene = await bench();

    before = new Map();
    for (const [agent, home] of scene.homes) before.set(agent, await checksumTree(home));

    directions = await runEveryDirection(scene);

    after = new Map();
    for (const [agent, home] of scene.homes) after.set(agent, await checksumTree(home));
  }, 120_000);

  afterAll(async () => {
    scene?.guard.restore();
    await cleanupTempDirs();
  });

  describe("T-ROO-14 — AC-1: all nine directions", () => {
    it("runs every cell of the table, including the three diagonal ones", () => {
      expect(directions).toHaveLength(9);
      const diagonal = directions.filter((direction) => direction.source === direction.target);
      expect(diagonal).toHaveLength(3);
      // A diagonal cell moves a session between two homes of one agent (FR-4).
      for (const direction of diagonal) {
        expect(direction.result.ref.home).not.toBe(scene.homes.get(direction.source));
      }
    });

    it("every one of them lands what it planned", () => {
      for (const direction of directions) {
        expect([direction.name, direction.result.ref.agent]).toEqual([
          direction.name,
          direction.target,
        ]);
        expect([direction.name, direction.result.ref.home]).toEqual([
          direction.name,
          direction.profile.home,
        ]);
        // FR-52: what the target stored is what the adapter said it sent.
        expect([direction.name, direction.result.itemsStored]).toEqual([
          direction.name,
          direction.result.itemsSent,
        ]);
        expect(direction.result.itemsSent).toBeGreaterThan(0);
      }
    });

    it("every preview reads the same, whatever the direction (FR-21)", () => {
      for (const direction of directions) {
        expect(direction.report.lines.length).toBeGreaterThan(0);
        expect(direction.report.headerLines.length).toBeGreaterThan(0);
        expect(direction.report.budgetLine).not.toBe("");
      }
    });

    it("either switches the user in or says how to get in (FR-45)", () => {
      for (const direction of directions) {
        const adapter = scene.host.registry().get(direction.target);
        if (adapter.capabilities().landing === "create-and-switch") {
          expect([direction.name, direction.result.switched]).toEqual([direction.name, true]);
        } else {
          expect(direction.result.handover, direction.name).not.toBeNull();
          expect(direction.result.handover?.command ?? "").toContain(direction.result.ref.id);
        }
      }
    });
  });

  describe("T-ROO-15 — AC-2: the imported turns are native", () => {
    it("the target's own resume list holds the imported session (FR-51)", async () => {
      for (const direction of directions) {
        const adapter = scene.host.registry().get(direction.target);
        const rows = await adapter.listSessions(direction.profile.home);
        expect(
          rows.map((row) => row.ref.id),
          direction.name,
        ).toContain(direction.result.ref.id);
      }
    }, 60_000);

    it("the target's own scrollback holds the turns (FR-46)", async () => {
      for (const direction of directions) {
        const adapter = scene.host.registry().get(direction.target);
        const rows = await adapter.listSessions(direction.profile.home);
        const row = rows.find((candidate) => candidate.ref.id === direction.result.ref.id);
        expect(row, direction.name).toBeDefined();
        if (row === undefined) continue;

        const reread = await adapter.loadSession(row);
        expect(reread.turns.length, direction.name).toBeGreaterThan(0);
        expect(reread.turns.some((turn) => turn.text.length > 0)).toBe(true);

        const facts = await adapter.readBack(direction.profile.home, direction.result.ref.id);
        expect([direction.name, facts.openable]).toEqual([direction.name, true]);
      }
    }, 60_000);

    // Compaction is not asserted here and is not asserted anywhere: the requirements state it
    // needs a real turn in the target first. It is recorded as untested, not as passing.
    it.todo("compaction keeps working on the imported turns — untested, needs a real turn");
  });

  describe("T-ROO-17 — AC-4: every source file is byte-identical", () => {
    it("no source home changed while nine imports ran (NG-1)", () => {
      for (const [agent, sums] of before) {
        const now = after.get(agent);
        expect(now, `${agent} home disappeared`).toBeDefined();
        if (now === undefined) continue;
        expect([...sums.entries()].sort()).toEqual([...(now.entries() ?? [])].sort());
      }
    });

    it("the source homes were not empty, so the comparison means something", () => {
      const seeded = [...before.values()].filter((sums) => sums.size > 0);
      expect(seeded.length).toBe(scene.host.registry().sources().length);
    });
  });

  describe("T-ROO-19 — AC-6: a work profile", () => {
    it("the session opens under the second profile, and both still exist (FR-4)", async () => {
      const both = scene.host
        .registry()
        .all()
        .find(
          (adapter) =>
            adapter.capabilities().roles.includes("source") &&
            adapter.capabilities().roles.includes("target"),
        );
      expect(both).toBeDefined();
      if (both === undefined) return;

      const agent = agentOf(both);
      const personal = scene.homes.get(agent) ?? "";
      const work = targetHomeOf(scene, agent);
      expect(personal).not.toBe(work);

      const inPersonal = await both.listSessions(personal);
      const inWork = await both.listSessions(work);
      expect(inPersonal.map((row) => row.ref.id)).toContain(scene.seeded.get(agent));
      expect(inWork.length).toBeGreaterThan(0);
      // Two homes of one agent are two targets, and the import added to the second one only.
      expect(inWork.map((row) => row.ref.id)).not.toContain(scene.seeded.get(agent));
    }, 60_000);
  });
});

describe("T-ROO-16 — AC-3: a stale file is read again, not edited blind", () => {
  let scene: Bench;
  let workspace: string;
  const OLD = "the-original-line-that-must-never-cross-over";
  const NEW = "the-line-that-replaced-it";
  const FILE = "notes/stale.txt";
  const THREAD = "01JSTALE0000000000000000AC3";

  /**
   * The source home has to hold a file that really contains a result body, or the test would be
   * asserting about a body nobody recorded. The fourth agent's format has one — its `ran.body` —
   * and its folder is a test fixture, so a thread can be written here by hand. The three shipped
   * agents drop the body while reading, which is the very thing under test.
   */
  beforeAll(async () => {
    workspace = await tempDir("stale");
    scene = await bench({ fourthAgent: true });

    const home = scene.homes.get(FIXTURE_AGENT_ID) ?? "";
    const thread: FixtureThread = {
      kind: FIXTURE_DOC_KIND,
      id: THREAD,
      topic: "make the parser accept an empty file",
      opened: "2026-08-01T09:00:00.000Z",
      touched: "2026-08-01T09:30:00.000Z",
      workspace: REPO_ROOT,
      vcs: { commit: null, branch: "main", touchedPaths: [] },
      notice: [],
      exchanges: [
        {
          stamp: "2026-08-01T09:00:00.000Z",
          speaker: "human",
          shape: "said",
          words: `look at ${FILE} and make the parser accept an empty file`,
        },
        {
          stamp: "2026-08-01T09:01:00.000Z",
          speaker: "machine",
          shape: "ran",
          words: "",
          ran: {
            tool: "Read",
            args: `'${FILE}'`,
            outcome: `Read('${FILE}') → 3 lines`,
            impact: "reads",
            body: `${OLD}\nsecond line\nthird line`,
          },
        },
        {
          stamp: "2026-08-01T09:02:00.000Z",
          speaker: "machine",
          shape: "said",
          words: `${FILE} has three lines and no empty-file branch.`,
        },
      ],
    };
    const path = fixtureThreadPath(home, THREAD);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(thread), "utf8");
  }, 60_000);

  afterAll(async () => {
    scene?.guard.restore();
    await cleanupTempDirs();
  });

  it("the landed session names the file, carries no content, and says it may be stale", async () => {
    // The file changed after the source session read it, which is the whole point of FR-25:
    // the target must read it again rather than trust what it was told.
    await writeFile(join(workspace, "stale.txt"), `${NEW}\n`, "utf8");

    const [target] = scene.host.registry().targets();
    expect(target).toBeDefined();
    if (target === undefined) return;

    const profile = scene.host
      .profiles()
      .build(agentOf(target), join(scene.root, "stale-into"), scene.host.config());
    const pipeline = await scene.host.pipelineFor(profile);
    const request = {
      destinationCwd: REPO_ROOT,
      target: profile,
      selection: { by: "session-id" as const, id: THREAD },
      onlyAgent: FIXTURE_AGENT_ID,
      onlyHome: scene.homes.get(FIXTURE_AGENT_ID) ?? null,
    };

    const report = await pipeline.preview(request);
    expect([report.blocked, report.blockedReason]).toEqual([false, null]);
    const result = await pipeline.commit(
      request,
      runtimeFor(target, REPO_ROOT, profile.home),
      report.confirmationToken,
    );

    const rows = await target.listSessions(profile.home);
    const row = rows.find((candidate) => candidate.ref.id === result.ref.id);
    expect(row).toBeDefined();
    if (row === undefined) return;

    const landed = await target.loadSession(row);
    expect(landed.turns.length).toBeGreaterThan(0);
    expect(JSON.stringify(landed)).not.toContain(OLD);

    // What actually crossed is the bytes in the target home, whatever shape the target's own
    // reader gives them back in. The file must be named — the target has to know what to read
    // again — and the record must say the content it was told about may be stale (FR-25).
    const written = await Promise.all(
      (await fileList(profile.home)).map((name) => readFile(join(profile.home, name), "utf8")),
    );
    const bytes = written.join("\n");
    expect(bytes).toContain(FILE);
    expect(bytes).not.toContain(OLD);
    expect(bytes).not.toContain(NEW);
    expect(bytes).toMatch(/may be stale/i);
  }, 60_000);

  // Whether the target then reads the file again is a real turn in a real agent, which is the
  // acceptance test of docs/requirements.md and is run by hand (see T-ROO-13 and the plan).
  it.todo("the target reads the file again before editing it — run by hand with a live agent");
});

describe("T-ROO-18 — AC-5: a very large session leaves room to work", () => {
  let scene: Bench;

  beforeAll(async () => {
    scene = await bench({ session: hugeSession() });
  }, 60_000);

  afterAll(async () => {
    scene?.guard.restore();
    await cleanupTempDirs();
  });

  it("fits the budget, says what it dropped, and leaves the window room", async () => {
    const [source] = [...scene.seeded.keys()];
    const [target] = scene.host.registry().targets();
    expect(source).toBeDefined();
    expect(target).toBeDefined();
    if (source === undefined || target === undefined) return;

    const profile = scene.host
      .profiles()
      .build(agentOf(target), join(scene.root, "huge-into"), scene.host.config());
    const pipeline = await scene.host.pipelineFor(profile);
    const request = importRequest(scene, source, profile);

    const report = await pipeline.preview(request);
    expect(report.blocked).toBe(false);
    // FR-35: the preview says what was dropped, rather than dropping it quietly.
    expect(report.dropLines.length).toBeGreaterThan(0);
    expect(report.budgetLine).not.toBe("");

    const result = await pipeline.commit(
      request,
      runtimeFor(target, REPO_ROOT, profile.home),
      report.confirmationToken,
    );
    expect(result.itemsSent).toBeGreaterThan(0);
    expect(result.itemsSent).toBeLessThan(HUGE_TURNS);

    const rows = await target.listSessions(profile.home);
    const row = rows.find((candidate) => candidate.ref.id === result.ref.id);
    expect(row).toBeDefined();
    if (row === undefined) return;

    const landed = await target.loadSession(row);
    const characters = landed.turns.reduce(
      (total, turn) => total + turn.text.length + (turn.toolCall?.outcomeLine.length ?? 0),
      0,
    );
    // Four characters per token is the floor the tokenizer of `src/platform/tokens/` documents
    // for its heuristic family, so this over-counts rather than flatters the result.
    const spent = characters / 4;
    expect(spent).toBeLessThan(profile.windowTokens * scene.host.config().budgetShare * 1.5);
    expect(spent).toBeLessThan(profile.windowTokens);
  }, 120_000);
});

describe("T-ROO-20 — AC-7: a new adapter reaches both roles with one new folder", () => {
  let scene: Bench;
  let directions: Direction[];

  beforeAll(async () => {
    scene = await bench({ fourthAgent: true });
    directions = await runEveryDirection(scene);
  }, 180_000);

  afterAll(async () => {
    scene?.guard.restore();
    await cleanupTempDirs();
  });

  it("the fourth agent is in the list and fills both roles (FR-59)", () => {
    expect(scene.host.registry().all()).toHaveLength(4);
    // Which one is the fourth is read from the shipped `AgentId` union, never spelled out here:
    // this test must keep working when the union grows (FR-57).
    const shippedAgents = unionMembers(
      parseSource(SESSION_CONTRACT, readFileSync(SESSION_CONTRACT, "utf8")),
      "AgentId",
    );
    const fourth = scene.host
      .registry()
      .all()
      .map(agentOf)
      .find((agent) => !shippedAgents.includes(agent));
    expect(fourth).toBeDefined();
    expect(scene.host.registry().sources().map(agentOf)).toContain(fourth);
    expect(scene.host.registry().targets().map(agentOf)).toContain(fourth);
  });

  it("all 16 directions run", () => {
    expect(directions).toHaveLength(16);
    for (const direction of directions) {
      expect([direction.name, direction.result.itemsStored]).toEqual([
        direction.name,
        direction.result.itemsSent,
      ]);
    }
  });

  it("no rule, no preview and no other adapter learned its name (FR-57, FR-60)", () => {
    // It arrives through the injected list alone. If any shipped file had to know it, the "one
    // folder, one value, one line" claim would already be false.
    const named = shippedSources()
      .filter((source) =>
        stringLiterals(source).some((literal) => literal.text.includes("fixture-agent")),
      )
      .map((source) => repoRelative(source.path));
    expect(named).toEqual([]);
  });

  it("it costs exactly one folder outside the shipped tree", () => {
    const fixture = shippedSources().filter((source) =>
      isInside(source.path, join(REPO_ROOT, "test", "fixtures", "fixture-agent")),
    );
    expect(fixture).toEqual([]);
  });
});

describe("T-ROO-21 — nothing is written before confirmation, anywhere", () => {
  let scene: Bench;

  beforeAll(async () => {
    scene = await bench();
  }, 60_000);

  afterAll(async () => {
    scene?.guard.restore();
    await cleanupTempDirs();
  });

  it("listing and previewing every direction creates nothing (FR-16, FR-20)", async () => {
    for (const target of scene.host.registry().targets()) {
      const agent = agentOf(target);
      const home = join(scene.root, `${agent}-untouched`);
      const profile = scene.host.profiles().build(agent, home, scene.host.config());
      const pipeline = await scene.host.pipelineFor(profile);

      for (const source of scene.host.registry().sources().map(agentOf)) {
        const request = importRequest(scene, source, profile);
        await pipeline.list({
          destinationCwd: REPO_ROOT,
          target: profile,
          onlyAgent: source,
          onlyHome: scene.homes.get(source) ?? null,
        });
        const report = await pipeline.preview(request);
        expect(report.blocked).toBe(false);
        expect(await fileList(home)).toEqual([]);
      }
    }
  }, 120_000);

  it("the command binary writes nothing until --confirm (FR-20)", async () => {
    for (const target of scene.host.registry().targets()) {
      const adapter = target.capabilities();
      if (adapter.selection !== "numbered-list") continue;

      const home = join(scene.root, `${adapter.agent}-cli-untouched`);
      for (const argv of [[], ["1"]]) {
        const outcome = await runCommandBinary(
          {
            argv,
            cwd: REPO_ROOT,
            targetAgent: adapter.agent,
            targetHome: home,
          },
          { cwd: REPO_ROOT },
        );
        expect([argv.join(" "), outcome.exitCode], outcome.stderr.join("\n")).toEqual([
          argv.join(" "),
          0,
        ]);
        expect(outcome.stdout.length).toBeGreaterThan(0);
        expect(await fileList(home)).toEqual([]);
      }
    }
  }, 120_000);
});

describe("T-ROO-22 — a platform service can be replaced without touching a consumer", () => {
  interface Replacement {
    name: string;
    deps: () => { deps: Parameters<typeof bench>[0]; check: () => void };
  }

  const committed: PendingFile[] = [];

  const replacements: Replacement[] = [
    {
      name: "tokens: an estimator that always answers the same",
      deps: () => {
        let asked = 0;
        return {
          deps: {
            deps: {
              createEstimators: () => ({
                forFamily: () => ({
                  estimate: () => {
                    asked += 1;
                    return 4;
                  },
                }),
              }),
            },
          },
          check: () => expect(asked).toBeGreaterThan(0),
        };
      },
    },
    {
      name: "repo: a reader that knows nothing about the repository",
      deps: () => {
        let asked = 0;
        return {
          deps: {
            deps: {
              createRepo: () => ({
                checkCancellation() {},
                identify: () => {
                  asked += 1;
                  return Promise.resolve({
                    root: null,
                    commonDir: null,
                    isBare: false,
                    head: null,
                    branch: null,
                  });
                },
                distanceFrom: () => Promise.resolve({ known: false, ahead: 0, behind: 0 }),
              }),
            },
          },
          check: () => expect(asked).toBeGreaterThan(0),
        };
      },
    },
    {
      name: "store: a committer that records every file it is given",
      deps: () => {
        committed.length = 0;
        return {
          deps: {
            deps: {
              createCommitter: () => ({
                async commit(_root: string, files: PendingFile[]) {
                  committed.push(...files);
                  // It records, and then writes them its own way — plainly, with none of the
                  // shipped committer's staging. The landing reads the session back after the
                  // commit (FR-51), so a committer that only recorded would be testing that the
                  // pipeline stops, not that it runs.
                  const { mkdir, writeFile: write } = await import("node:fs/promises");
                  for (const file of files) {
                    await mkdir(join(file.absolutePath, ".."), {
                      recursive: true,
                    });
                    await write(file.absolutePath, file.bytes);
                  }
                  return {
                    createdPaths: files.map((file) => file.absolutePath),
                  };
                },
              }),
            },
          },
          check: () => expect(committed.length).toBeGreaterThan(0),
        };
      },
    },
    {
      name: "config: a loader that returns settings nobody wrote down",
      deps: () => {
        const config: ImportConfig = {
          extraHomes: [],
          budgetShare: 0.5,
          pinnedRecentTurns: 2,
          windowOverrides: [],
        };
        let asked = 0;
        return {
          deps: {
            deps: {
              configLoader: {
                load: () => {
                  asked += 1;
                  return Promise.resolve(config);
                },
              },
            },
          },
          check: () => expect(asked).toBe(1),
        };
      },
    },
  ];

  afterAll(async () => {
    await cleanupTempDirs();
  });

  it.each(replacements.map((replacement) => [replacement.name, replacement] as const))(
    "%s — the whole pipeline still runs",
    async (_name, replacement) => {
      const { deps, check } = replacement.deps();
      const scene = await bench(deps);
      try {
        const [source] = [...scene.seeded.keys()];
        const [target] = scene.host.registry().targets();
        expect(source).toBeDefined();
        expect(target).toBeDefined();
        if (source === undefined || target === undefined) return;

        const profile = scene.host
          .profiles()
          .build(agentOf(target), join(scene.root, "swapped-into"), scene.host.config());
        const pipeline = await scene.host.pipelineFor(profile);
        const request = importRequest(scene, source, profile);

        const listing = await pipeline.list({
          destinationCwd: REPO_ROOT,
          target: profile,
          onlyAgent: source,
          onlyHome: scene.homes.get(source) ?? null,
        });
        expect(listing.rows.length).toBeGreaterThan(0);

        const report = await pipeline.preview(request);
        expect([report.blocked, report.blockedReason]).toEqual([false, null]);

        const result = await pipeline.commit(
          request,
          runtimeFor(target, REPO_ROOT, profile.home),
          report.confirmationToken,
        );
        expect(result.itemsStored).toBe(result.itemsSent);

        check();
      } finally {
        scene.guard.restore();
      }
    },
    120_000,
  );

  it("no file outside src/platform/ had to change for any of them", () => {
    // The claim of the generic-subdomain classification, seen from the source: every consumer
    // takes its services by injection, so replacing one is a call site in a test and nothing
    // else. What proves it is that the four cases above compile against the published contracts
    // and run — and that no consumer names a concrete implementation.
    const platform = join(REPO_ROOT, "src", "platform");
    const naming = shippedSources()
      .filter((source) => !isInside(source.path, platform))
      .filter((source) => !isInside(source.path, join(REPO_ROOT, "src", "host")))
      .filter((source) =>
        /createFileCommitter|createRepoReader|createConfigLoader|estimatorFactory/.test(
          source.text,
        ),
      )
      .map((source) => repoRelative(source.path));
    expect(naming).toEqual([]);
  });
});

describe("T-ROO-23 — a windowOverrides config shrinks the budget end-to-end (FR-18)", () => {
  // Exercises the full chain: config.windowOverrides → host profile builder →
  // TargetProfile.windowTokens → pipeline rules → fewer turns in the plan.
  let scene: Bench;

  beforeAll(async () => {
    scene = await bench({ session: hugeSession() });
  }, 60_000);

  afterAll(async () => {
    scene?.guard.restore();
    await cleanupTempDirs();
  });

  it("keeps fewer turns under a smaller window than a larger one", async () => {
    const [source] = [...scene.seeded.keys()];
    const [target] = scene.host.registry().targets();
    expect(source).toBeDefined();
    expect(target).toBeDefined();
    if (source === undefined || target === undefined) return;

    const agent = agentOf(target);
    const base = scene.host.config();

    // Two profiles built through the profile builder with different windowOverrides —
    // the config setting this test exercises end-to-end.
    const smallProfile = scene.host.profiles().build(agent, join(scene.root, "window-small"), {
      ...base,
      windowOverrides: [{ agent, windowTokens: 20_000 }],
    });
    const largeProfile = scene.host.profiles().build(agent, join(scene.root, "window-large"), {
      ...base,
      windowOverrides: [{ agent, windowTokens: 200_000 }],
    });

    expect(smallProfile.windowTokens).toBe(20_000);
    expect(largeProfile.windowTokens).toBe(200_000);

    const smallPipeline = await scene.host.pipelineFor(smallProfile);
    const largePipeline = await scene.host.pipelineFor(largeProfile);

    const smallRequest = importRequest(scene, source, smallProfile);
    const largeRequest = importRequest(scene, source, largeProfile);

    const smallReport = await smallPipeline.preview(smallRequest);
    const largeReport = await largePipeline.preview(largeRequest);
    expect(smallReport.blocked).toBe(false);
    expect(largeReport.blocked).toBe(false);

    const smallResult = await smallPipeline.commit(
      smallRequest,
      runtimeFor(target, REPO_ROOT, smallProfile.home),
      smallReport.confirmationToken,
    );
    const largeResult = await largePipeline.commit(
      largeRequest,
      runtimeFor(target, REPO_ROOT, largeProfile.home),
      largeReport.confirmationToken,
    );

    expect(smallResult.itemsSent).toBeGreaterThan(0);
    // The larger window must carry strictly more turns than the smaller one (FR-18).
    expect(largeResult.itemsSent).toBeGreaterThan(smallResult.itemsSent);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Sessions the tests above need
// ---------------------------------------------------------------------------

const HUGE_TURNS = 400;

/** A session several times any target window: 400 turns of prose that cannot all cross. */
function hugeSession(): CanonicalSession {
  const paragraph = "the parser walks the buffer and keeps the last complete record. ".repeat(40);
  const turns: CanonicalTurn[] = Array.from({ length: HUGE_TURNS }, (_, index) => ({
    index,
    role: index % 2 === 0 ? ("user" as const) : ("agent" as const),
    kind: "message" as const,
    text: `${index}: ${paragraph}`,
    toolCall: null,
    timestamp: new Date(Date.UTC(2026, 7, 1, 9, 0, index % 60)).toISOString(),
  }));

  return {
    provenance: {
      ref: { agent: "codex", home: "/seed", id: "01JQ8Z3K7M4N5P6Q7R8S9T0V1X" },
      title: "a very long session",
      startedAt: "2026-08-01T09:00:00Z",
      updatedAt: "2026-08-01T18:00:00Z",
      repo: { commit: null, branch: "main", changedPaths: [] },
    },
    turns,
  };
}
