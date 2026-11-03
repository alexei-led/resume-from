// T-IMP-1 to T-IMP-6: which stage runs when, and which adapter each stage is given.

import { afterEach, describe, expect, it } from "vitest";
import type { AgentId, ImportRequest } from "./contract.js";
import { createPipelineFromStages } from "./pipeline.js";
import {
  AGENTS,
  commitPreviewed,
  createWorld,
  instrument,
  recordingStages,
  referenceSpec,
  type World,
  worldDeps,
  writeSession,
} from "./test-support.js";
import { createImportPipeline } from "./wiring.js";

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

function importRequest(world: World, target: AgentId, id: string): ImportRequest {
  return { ...listRequest(world, target), selection: { by: "session-id", id } };
}

/** The methods of a call log, with the agent names removed (FR-60). */
function methodsOf(calls: string[]): string[] {
  return calls.map((call) => call.slice(call.indexOf(".") + 1));
}

describe("T-IMP-1 — list touches only discovery", () => {
  it("calls the finder and no other stage", async () => {
    const { calls, stages } = recordingStages();
    const pipeline = createPipelineFromStages(stages);

    await pipeline.list({
      destinationCwd: "/repo",
      target: { agent: "pi", home: "/homes/pi", windowTokens: 200_000 },
      onlyAgent: null,
      onlyHome: null,
    });

    expect(calls).toEqual(["finder.list"]);
  });
});

describe("T-IMP-2 — preview runs four steps in order", () => {
  it("resolves, loads, applies the rules and builds the report, and never lands", async () => {
    const { calls, stages } = recordingStages();
    const pipeline = createPipelineFromStages(stages);

    await pipeline.preview({
      destinationCwd: "/repo",
      target: { agent: "pi", home: "/homes/pi", windowTokens: 200_000 },
      selection: { by: "row", row: 1 },
      onlyAgent: null,
      onlyHome: null,
    });

    expect(calls).toEqual(["finder.resolve", "finder.load", "rules.apply", "preview.build"]);
    expect(calls).not.toContain("lander.land");
  });
});

describe("T-IMP-3 — commit repeats the preview then lands", () => {
  it("runs the four preview steps and hands the lander the plan the rules produced", async () => {
    const { calls, stages, plans, landed } = recordingStages();
    const pipeline = createPipelineFromStages(stages);
    const request = {
      destinationCwd: "/repo",
      target: {
        agent: "pi" as const,
        home: "/homes/pi",
        windowTokens: 200_000,
      },
      selection: { by: "row" as const, row: 1 },
      onlyAgent: null,
      onlyHome: null,
    };
    const report = await pipeline.preview(request);
    calls.length = 0;
    plans.length = 0;

    await pipeline.commit(request, null, report.confirmationToken);

    expect(calls).toEqual([
      "finder.resolve",
      "finder.load",
      "rules.apply",
      "preview.build",
      "lander.land",
    ]);
    expect(landed).toHaveLength(1);
    expect(landed[0]).toBe(plans[0]);
  });
});

it("checks cancellation again between computed preview and landing", async () => {
  const controller = new AbortController();
  const reason = new Error("stop before landing");
  let abortAfterPreview = false;
  const { stages, landed } = recordingStages({
    checkCancellation() {
      controller.signal.throwIfAborted();
      if (abortAfterPreview) queueMicrotask(() => controller.abort(reason));
    },
  });
  const pipeline = createPipelineFromStages(stages);
  const request = {
    destinationCwd: "/repo",
    target: { agent: "pi" as const, home: "/homes/pi", windowTokens: 200_000 },
    selection: { by: "row" as const, row: 1 },
    onlyAgent: null,
    onlyHome: null,
  };
  const report = await pipeline.preview(request);
  abortAfterPreview = true;

  await expect(pipeline.commit(request, null, report.confirmationToken)).rejects.toMatchObject({
    stage: "landing",
    cause: reason,
  });
  expect(landed).toEqual([]);
});

describe("T-IMP-4 — the source adapter is chosen by the session's agent", () => {
  it.each(AGENTS)("loads a %s session with the adapter of that agent", async (agent) => {
    const world = await newWorld();
    for (const each of AGENTS) {
      await writeSession(
        world.homeOf(each),
        referenceSpec({ id: `${each}-1`, repoPath: world.repoRoot }),
      );
    }

    await createImportPipeline(worldDeps(world)).preview(importRequest(world, "pi", `${agent}-1`));

    expect(world.calls.filter((call) => call.endsWith(".loadSession"))).toEqual([
      `${agent}.loadSession`,
    ]);
  });
});

describe("T-IMP-5 — the target adapter is chosen by the target profile", () => {
  it.each(AGENTS)("lands into %s with the adapter of that agent", async (agent) => {
    const world = await newWorld();
    await writeSession(
      world.homeOf("codex"),
      referenceSpec({ id: "codex-1", repoPath: world.repoRoot }),
    );

    const pipeline = createImportPipeline(worldDeps(world));
    await commitPreviewed(pipeline, importRequest(world, agent, "codex-1"));

    expect(world.calls.filter((call) => call.endsWith(".serialize"))).toEqual([
      `${agent}.serialize`,
    ]);
    expect(world.calls.filter((call) => call.endsWith(".readBack"))).toEqual([`${agent}.readBack`]);
  });
});

describe("T-IMP-6 — the diagonal is not a special case", () => {
  it("runs the same stages and the same adapter methods as any other direction", async () => {
    const world = await newWorld();
    const secondPiHome = `${world.root}/homes/pi-work`;
    const config = {
      extraHomes: [{ agent: "pi" as const, home: secondPiHome }],
    };

    await writeSession(secondPiHome, referenceSpec({ id: "pi-work-1", repoPath: world.repoRoot }));
    await writeSession(
      world.homeOf("codex"),
      referenceSpec({ id: "codex-1", repoPath: world.repoRoot }),
    );

    const deps = worldDeps(world, {
      config: { ...worldDeps(world).config, ...config },
    });

    // pi (work home) → pi (a second home): the diagonal of the scope table (FR-4).
    const diagonal = instrument(deps);
    await commitPreviewed(diagonal.pipeline, importRequest(world, "pi", "pi-work-1"));
    const diagonalCalls = methodsOf(world.calls.splice(0));

    // codex → pi: an ordinary direction.
    const across = instrument(deps);
    await commitPreviewed(across.pipeline, importRequest(world, "pi", "codex-1"));
    const acrossCalls = methodsOf(world.calls.splice(0));

    expect(diagonal.order).toEqual(across.order);
    expect(diagonalCalls).toEqual(acrossCalls);
  });
});
