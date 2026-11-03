import { realpath } from "node:fs/promises";
// T-IMP-20 to T-IMP-26: what the user gets, and what never crosses over.

import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentId, CanonicalTurn, ImportRequest } from "./contract.js";
import {
  AGENTS,
  charEstimator,
  checksumTree,
  commitPreviewed,
  createWorld,
  defaultConfig,
  halfEstimator,
  instrument,
  landedFilePath,
  landedSessionId,
  referenceSpec,
  type SessionSpec,
  type World,
  worldDeps,
  writeSession,
} from "./test-support.js";
import { createImportPipeline } from "./wiring.js";

const SOURCE_ID = "source-1";
const SECRET = "SECRET-BODY-CONTENT";
const FIRST_REQUEST = "make the auth token refresh work";
const SUMMARY = "So far: the refresh call succeeded but the token was never written back.";

const worlds: World[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

async function newWorld(...args: Parameters<typeof createWorld>): Promise<World> {
  const world = await createWorld(...args);
  worlds.push(world);
  return world;
}

function listRequest(world: World, target: AgentId) {
  return {
    destinationCwd: world.repoRoot,
    target: world.targetFor(target),
    onlyAgent: null,
    onlyHome: null,
  };
}

function importRequest(world: World, target: AgentId): ImportRequest {
  return {
    ...listRequest(world, target),
    selection: { by: "session-id", id: SOURCE_ID },
  };
}

const DIRECTIONS: Array<[AgentId, AgentId]> = AGENTS.flatMap((source) =>
  AGENTS.map((target): [AgentId, AgentId] => [source, target]),
);

function stamp(index: number): string {
  return new Date(Date.UTC(2026, 7, 1, 9, index)).toISOString();
}

function message(index: number, role: "user" | "agent", text: string): CanonicalTurn {
  return {
    index,
    role,
    kind: "message",
    text,
    toolCall: null,
    timestamp: stamp(index),
  };
}

function tool(index: number, name: string, args: string, mutating: boolean): CanonicalTurn {
  return {
    index,
    role: "agent",
    kind: "tool-call",
    text: "",
    toolCall: {
      toolName: name,
      argumentsText: args,
      outcomeLine: `${name}(${args}) → done`,
      effect: mutating ? "mutating" : "read-only",
      bodyDropped: !mutating,
    },
    timestamp: stamp(index),
  };
}

/** A worked session: a first request, reads, edits, a summary, and more than 20 turns. */
function workedSession(turnCount = 25): CanonicalTurn[] {
  const turns: CanonicalTurn[] = [message(0, "user", FIRST_REQUEST)];
  for (let index = 1; index < turnCount; index += 1) {
    if (index === 12) {
      turns.push({ ...message(index, "agent", SUMMARY), kind: "summary" });
      continue;
    }
    if (index % 4 === 1) turns.push(tool(index, "Read", `'src/auth-${index}.ts'`, false));
    else if (index % 4 === 2) turns.push(tool(index, "Edit", `'src/auth-${index}.ts'`, true));
    else if (index % 4 === 3)
      turns.push(message(index, "agent", `step ${index}: looked at the token`));
    else turns.push(message(index, "user", `and now step ${index}, please`));
  }
  return turns;
}

/** A session several times the size of any window, with few pinned edits. */
function bigSession(turnCount: number): CanonicalTurn[] {
  const filler = "x".repeat(180);
  const turns: CanonicalTurn[] = [message(0, "user", FIRST_REQUEST)];
  for (let index = 1; index < turnCount; index += 1) {
    if (index === 12) turns.push({ ...message(index, "agent", SUMMARY), kind: "summary" });
    else if (index % 50 === 0) turns.push(tool(index, "Edit", `'src/auth-${index}.ts'`, true));
    else if (index % 5 === 0) turns.push(tool(index, "Read", `'src/auth-${index}.ts'`, false));
    else turns.push(message(index, index % 2 === 0 ? "user" : "agent", `step ${index} ${filler}`));
  }
  return turns;
}

async function landedText(world: World, target: AgentId): Promise<string> {
  return await readFile(
    landedFilePath(world.targetHomeOf(target), landedSessionId(SOURCE_ID)),
    "utf8",
  );
}

describe("T-IMP-20 — the acceptance scenario, without a live agent", () => {
  it("lands everything needed to continue a Codex session inside Pi", async () => {
    const world = await newWorld();
    const turns = workedSession();
    await writeSession(
      world.homeOf("codex"),
      referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot, turns }),
    );
    const pipeline = createImportPipeline(worldDeps(world));
    // A window small enough that the older turns cannot all fit (FR-30, FR-32).
    const request = {
      ...importRequest(world, "pi"),
      target: world.targetFor("pi", 4_000),
    };

    const listing = await pipeline.list(listRequest(world, "pi"));
    expect(listing.rows[0]?.turnCount).toBe(turns.length);

    const report = await pipeline.preview(request);
    expect(report.blocked).toBe(false);
    expect(report.dropLines.join(" ")).toMatch(/older turns? dropped/);

    const landed = await pipeline.commit(request, null, report.confirmationToken);
    expect(landed.itemsStored).toBe(landed.itemsSent);

    const text = await landedText(world, "pi");
    // The first request, the summary, and the last five turns crossed over (FR-32).
    expect(text).toContain(FIRST_REQUEST);
    expect(text).toContain(SUMMARY);
    for (const turn of turns.slice(-5)) {
      if (turn.kind === "tool-call") expect(text).toContain(turn.toolCall?.outcomeLine);
      else expect(text).toContain(turn.text);
    }
    // The edits are pinned, and every tool record kept its one outcome line (FR-23, FR-32).
    expect(text).toContain("Edit('src/auth-2.ts') → done");
    expect(landed.marker.lines.join("\n")).toContain("codex");
  });
});

describe("T-IMP-21 — no result body reaches any target, in any direction", () => {
  it.each(DIRECTIONS)("carries no body from %s to %s", async (source, target) => {
    const world = await newWorld();
    const turns = workedSession(12);
    const bodies = Object.fromEntries(turns.map((turn) => [turn.index, `${SECRET} ${turn.index}`]));
    const spec: Partial<SessionSpec> = {
      id: SOURCE_ID,
      repoPath: world.repoRoot,
      turns,
      bodies,
    };
    await writeSession(world.homeOf(source), referenceSpec(spec));

    const pipeline = createImportPipeline(worldDeps(world));
    await commitPreviewed(pipeline, importRequest(world, target));

    // The source file holds the bodies; nothing the pipeline wrote does (FR-24).
    expect(await readFile(`${world.homeOf(source)}/sessions/${SOURCE_ID}.jsonl`, "utf8")).toContain(
      SECRET,
    );
    expect(await landedText(world, target)).not.toContain(SECRET);
  });
});

describe("T-IMP-22 — a very large session leaves room to work", () => {
  it("fits the budget and says what it dropped", async () => {
    const world = await newWorld();
    // The source is several times the window it is imported into.
    const turns = bigSession(200);
    await writeSession(
      world.homeOf("codex"),
      referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot, turns }),
    );
    const run = instrument(worldDeps(world));
    const request = {
      ...importRequest(world, "pi"),
      target: world.targetFor("pi", 8_000),
    };

    const report = await run.pipeline.preview(request);
    const plan = run.plans[0];

    expect(plan).toBeDefined();
    expect(plan?.blockedReason).toBeNull();
    expect(plan?.estimatedTokens ?? 0).toBeLessThanOrEqual(plan?.budgetTokens ?? 0);
    expect(plan?.droppedTurnCount ?? 0).toBeGreaterThan(0);
    expect(report.dropLines.join(" ")).toMatch(/dropped/);
    expect(report.lines.join("\n")).toContain(report.budgetLine);

    // The claim is about what lands, not only about what was planned (AC-5).
    await run.pipeline.commit(request, null, report.confirmationToken);
    const landed = JSON.parse(await landedText(world, "pi")) as {
      turns: CanonicalTurn[];
    };
    expect(landed.turns).toHaveLength(plan?.keptTurnCount ?? 0);
    expect(landed.turns.length).toBeLessThan(turns.length);
    const cost = landed.turns.reduce(
      (total, turn) =>
        total + charEstimator.estimate(turn.text + (turn.toolCall?.outcomeLine ?? "")),
      0,
    );
    expect(cost).toBeLessThanOrEqual(plan?.budgetTokens ?? 0);
  });
});

describe("T-IMP-23 — the nine directions cannot be told apart", () => {
  it("renders the same preview structure and drives the same landing sequence", async () => {
    const structures = new Set<string>();
    const sequences = new Set<string>();

    for (const [source, target] of DIRECTIONS) {
      const world = await newWorld({
        // The same declared capabilities everywhere: a difference in the call sequence must
        // come from a capability, never from an agent's name (FR-58, FR-60).
        adapter: () => ({ capabilities: { landing: "create-and-switch" } }),
      });
      await writeSession(
        world.homeOf(source),
        referenceSpec({
          id: SOURCE_ID,
          repoPath: world.repoRoot,
          turns: workedSession(12),
        }),
      );
      const pipeline = createImportPipeline(worldDeps(world));

      const report = await pipeline.preview(importRequest(world, target));
      world.calls.length = 0;
      await pipeline.commit(importRequest(world, target), null, report.confirmationToken);

      const canonicalDestination = await realpath(world.repoRoot);
      const anonymous = report.lines.map((line) =>
        line
          .replaceAll(world.homeOf(source), "HOME")
          .replaceAll(canonicalDestination, "DESTINATION")
          .replaceAll(world.targetHomeOf(target), "HOME")
          .replaceAll(source, "AGENT")
          .replaceAll(target, "AGENT"),
      );
      structures.add(anonymous.join("\n"));
      sequences.add(world.calls.map((call) => call.slice(call.indexOf(".") + 1)).join(" "));
    }

    expect(structures.size).toBe(1);
    expect(sequences.size).toBe(1);
  });
});

describe("T-IMP-24 — adding a fake fourth agent changes nothing here", () => {
  const FAKE = "fixture-agent" as AgentId;
  const FOUR = [...AGENTS, FAKE];

  it("runs all sixteen directions with the fake agent registered", async () => {
    for (const source of FOUR) {
      for (const target of FOUR) {
        const world = await newWorld({ agents: FOUR });
        await writeSession(
          world.homeOf(source),
          referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot }),
        );
        const pipeline = createImportPipeline(worldDeps(world));
        const landed = await commitPreviewed(pipeline, importRequest(world, target));
        expect(landed.ref.agent).toBe(target);
        expect(Object.keys(await checksumTree(world.targetHomeOf(target)))).toHaveLength(1);
      }
    }
  });

  it("names no agent in its own code", async () => {
    for (const file of ["pipeline.ts", "wiring.ts", "errors.ts", "index.ts"]) {
      const text = await readFile(new URL(file, import.meta.url), "utf8");
      expect(text, file).not.toMatch(/["'`](pi|codex|claude-code)["'`]/);
    }
  });
});

describe("T-IMP-25 — the canonical vocabulary survives a round trip", () => {
  const TURN_KEYS = ["index", "kind", "role", "text", "timestamp", "toolCall"].sort();
  const TOOL_KEYS = [
    "toolName",
    "argumentsText",
    "outcomeLine",
    "effect",
    "bodyDropped",
    "resultRecorded",
  ].sort();

  it("adds no field and needs none the vocabulary does not have", async () => {
    const world = await newWorld();
    await writeSession(
      world.homeOf("codex"),
      referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot }),
    );
    const run = instrument(worldDeps(world));

    await commitPreviewed(run.pipeline, importRequest(world, "pi"));

    const serialized = JSON.parse(await landedText(world, "pi")) as {
      turns: CanonicalTurn[];
      provenance: {
        ref: unknown;
        title: unknown;
        startedAt: unknown;
        updatedAt: unknown;
        repo: unknown;
      };
    };
    expect(serialized.turns.length).toBeGreaterThan(0);
    for (const turn of serialized.turns) {
      expect(Object.keys(turn).sort()).toEqual(TURN_KEYS);
      if (turn.toolCall) expect(Object.keys(turn.toolCall).sort()).toEqual(TOOL_KEYS);
    }
    expect(Object.keys(serialized.provenance).sort()).toEqual(
      ["ref", "title", "startedAt", "updatedAt", "repo"].sort(),
    );
    // The rules changed no turn beyond dropping bodies the vocabulary cannot carry.
    expect(run.plans[0]?.turns.map((turn) => turn.index)).toEqual(
      serialized.turns.map((turn) => turn.index),
    );
  });
});

describe("T-IMP-26 — swapping the estimator changes only the numbers", () => {
  it("produces the same plan structure with different counts", async () => {
    const world = await newWorld();
    await writeSession(
      world.homeOf("codex"),
      referenceSpec({
        id: SOURCE_ID,
        repoPath: world.repoRoot,
        turns: bigSession(200),
      }),
    );
    const request = {
      ...importRequest(world, "pi"),
      target: world.targetFor("pi", 8_000),
    };
    const config = defaultConfig();

    const wide = instrument(worldDeps(world, { config, estimator: charEstimator }));
    const narrow = instrument(worldDeps(world, { config, estimator: halfEstimator }));
    const wideReport = await wide.pipeline.preview(request);
    const narrowReport = await narrow.pipeline.preview(request);

    const widePlan = wide.plans[0];
    const narrowPlan = narrow.plans[0];
    expect(widePlan).toBeDefined();
    expect(narrowPlan).toBeDefined();
    expect(Object.keys(widePlan ?? {}).sort()).toEqual(Object.keys(narrowPlan ?? {}).sort());
    expect(wideReport.blocked).toBe(false);
    expect(narrowReport.blocked).toBe(false);
    // Only the numbers moved: a cheaper estimator carries more turns.
    expect(narrowPlan?.estimatedTokens).not.toBe(widePlan?.estimatedTokens);
    expect(narrowPlan?.keptTurnCount ?? 0).toBeGreaterThan(widePlan?.keptTurnCount ?? 0);
    expect(narrowReport.headerLines).toHaveLength(wideReport.headerLines.length);
  });
});

describe("T-IMP-27 — a session with no importable turns is blocked", () => {
  it("preview reports blocked; commit refuses and says Nothing was written", async () => {
    const world = await newWorld();
    await writeSession(
      world.homeOf("codex"),
      referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot, turns: [] }),
    );
    const pipeline = createImportPipeline(worldDeps(world));

    const report = await pipeline.preview(importRequest(world, "pi"));
    expect(report.blocked).toBe(true);
    expect(report.blockedReason).toMatch(/nothing to import/i);
    // Session is empty (not budget-driven); cause-specific message must not suggest a budget fix.
    expect(report.blockedReason).not.toMatch(/budget/i);

    await expect(
      pipeline.commit(importRequest(world, "pi"), null, report.confirmationToken),
    ).rejects.toThrow(/Nothing was written/);
  });
});
