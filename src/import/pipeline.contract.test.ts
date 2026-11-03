// T-IMP-7 to T-IMP-12: the nine directions, the recomputed plan, and the refusals.

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentId, ImportRequest } from "./contract.js";
import { ImportFailure } from "./errors.js";
import {
  AGENTS,
  checksumTree,
  commitPreviewed,
  createWorld,
  defaultConfig,
  instrument,
  landedFilePath,
  landedSessionId,
  referenceSpec,
  sessionFilePath,
  type World,
  worldDeps,
  writeSession,
} from "./test-support.js";
import { createImportPipeline } from "./wiring.js";

const SOURCE_ID = "source-1";

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

function importRequest(world: World, target: AgentId, id = SOURCE_ID): ImportRequest {
  return { ...listRequest(world, target), selection: { by: "session-id", id } };
}

/** Every ordered pair of the three agents, including each with itself (FR-4, FR-6). */
const DIRECTIONS: Array<[AgentId, AgentId]> = AGENTS.flatMap((source) =>
  AGENTS.map((target): [AgentId, AgentId] => [source, target]),
);

describe("T-IMP-7 — all nine directions run end to end", () => {
  it.each(DIRECTIONS)("imports a %s session into %s", async (source, target) => {
    const world = await newWorld();
    await writeSession(
      world.homeOf(source),
      referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot }),
    );
    const pipeline = createImportPipeline(worldDeps(world));

    const listing = await pipeline.list(listRequest(world, target));
    expect(listing.rows.map((row) => row.ref.agent)).toEqual([source]);

    const report = await pipeline.preview(importRequest(world, target));
    expect(report.blocked).toBe(false);

    const landed = await pipeline.commit(
      importRequest(world, target),
      null,
      report.confirmationToken,
    );
    expect(landed.ref.agent).toBe(target);
    expect(landed.ref.home).toBe(world.targetHomeOf(target));
    expect(landed.itemsStored).toBe(landed.itemsSent);
    expect(landed.marker.sourceAgent).toBe(source);

    const files = await checksumTree(world.targetHomeOf(target));
    expect(Object.keys(files)).toHaveLength(1);
  });
});

describe("T-IMP-8 — preview and commit compute the same plan", () => {
  it("produces a deeply equal plan in both invocations", async () => {
    const world = await newWorld();
    await writeSession(
      world.homeOf("codex"),
      referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot }),
    );

    // Two pipelines, as the two invocations of a numbered-list host would be (FR-10).
    const previewRun = instrument(worldDeps(world));
    const report = await previewRun.pipeline.preview(importRequest(world, "pi"));
    const commitRun = instrument(worldDeps(world));
    await commitRun.pipeline.commit(importRequest(world, "pi"), null, report.confirmationToken);

    expect(previewRun.plans).toHaveLength(1);
    expect(commitRun.plans).toHaveLength(1);
    expect(commitRun.plans[0]).toEqual(previewRun.plans[0]);
    expect(commitRun.landed[0]).toEqual(previewRun.plans[0]);
  });
});

describe("T-IMP-9 — commit refuses when the source moved", () => {
  it("asks for another preview and writes nothing", async () => {
    const world = await newWorld();
    await writeSession(
      world.homeOf("codex"),
      referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot }),
    );
    const pipeline = createImportPipeline(worldDeps(world));

    const report = await pipeline.preview(importRequest(world, "pi"));
    const before = await checksumTree(world.targetHomeOf("pi"));

    // The source agent wrote on after the user saw the preview.
    await appendFile(sessionFilePath(world.homeOf("codex"), SOURCE_ID), "a line written later\n");

    const failure = await pipeline
      .commit(importRequest(world, "pi"), null, report.confirmationToken)
      .catch((cause) => cause);
    expect(failure).toBeInstanceOf(ImportFailure);
    expect(failure.stage).toBe("confirmation");
    expect(failure.message).toMatch(/preview it again/i);
    expect(await checksumTree(world.targetHomeOf("pi"))).toEqual(before);
  });

  it("refuses a tampered confirmation token before serialization", async () => {
    const world = await newWorld();
    await writeSession(
      world.homeOf("codex"),
      referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot }),
    );
    const pipeline = createImportPipeline(worldDeps(world));
    const request = importRequest(world, "pi");
    const report = await pipeline.preview(request);
    const tampered = `${report.confirmationToken.slice(0, -1)}x`;

    const failure = await pipeline.commit(request, null, tampered).catch((cause) => cause);

    expect(failure).toBeInstanceOf(ImportFailure);
    expect(failure.stage).toBe("confirmation");
    expect(world.calls).not.toContain("pi.serialize");
    expect(await checksumTree(world.targetHomeOf("pi"))).toEqual({});
  });

  it("does not commit a different session after a numbered row is reordered", async () => {
    const world = await newWorld();
    const earlier = referenceSpec({ id: "earlier", repoPath: world.repoRoot });
    await writeSession(world.homeOf("codex"), earlier);
    const pipeline = createImportPipeline(worldDeps(world));
    const request: ImportRequest = {
      ...listRequest(world, "pi"),
      onlyAgent: "codex",
      selection: { by: "row", row: 1 },
    };
    const report = await pipeline.preview(request);
    const laterTurns = earlier.turns.map((turn, index) => ({
      ...turn,
      timestamp: `2099-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    }));
    await writeSession(
      world.homeOf("codex"),
      referenceSpec({
        id: "later",
        repoPath: world.repoRoot,
        turns: laterTurns,
      }),
    );

    const failure = await pipeline
      .commit(request, null, report.confirmationToken)
      .catch((cause) => cause);

    expect(failure).toBeInstanceOf(ImportFailure);
    expect(failure.stage).toBe("confirmation");
    expect(world.calls).not.toContain("pi.serialize");
    expect(await checksumTree(world.targetHomeOf("pi"))).toEqual({});
  });
});

describe("T-IMP-10 — a blocked plan cannot be committed", () => {
  it("reports blocked in the preview and refuses before any adapter serializes", async () => {
    const world = await newWorld();
    await writeSession(
      world.homeOf("codex"),
      referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot }),
    );
    const pipeline = createImportPipeline(worldDeps(world));
    // A window this small cannot hold the pinned turns alone (FR-33).
    const request = {
      ...importRequest(world, "pi"),
      target: world.targetFor("pi", 40),
    };

    const report = await pipeline.preview(request);
    expect(report.blocked).toBe(true);
    expect(report.blockedReason).not.toBeNull();

    const failure = await pipeline
      .commit(request, null, report.confirmationToken)
      .catch((cause) => cause);
    expect(failure).toBeInstanceOf(ImportFailure);
    expect(failure.stage).toBe("blocked");
    expect(world.calls).not.toContain("pi.serialize");
    expect(await checksumTree(world.targetHomeOf("pi"))).toEqual({});
  });
});

describe("T-IMP-11 — one error shape for every stage", () => {
  it("turns a discovery failure into an ImportFailure", async () => {
    const world = await newWorld();
    const pipeline = createImportPipeline(worldDeps(world));

    const failure = await pipeline
      .preview({
        ...importRequest(world, "pi"),
        selection: { by: "row", row: 9 },
      })
      .catch((cause) => cause);

    expect(failure).toBeInstanceOf(ImportFailure);
    expect(failure.stage).toBe("discovery");
    expect(failure.message).toMatch(/run the list again/i);
  });

  it("turns a blocked plan into an ImportFailure", async () => {
    const world = await newWorld();
    await writeSession(
      world.homeOf("codex"),
      referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot }),
    );
    const pipeline = createImportPipeline(worldDeps(world));

    const request = {
      ...importRequest(world, "pi"),
      target: world.targetFor("pi", 40),
    };
    const report = await pipeline.preview(request);
    const failure = await pipeline
      .commit(request, null, report.confirmationToken)
      .catch((cause) => cause);

    expect(failure).toBeInstanceOf(ImportFailure);
    expect(failure.stage).toBe("blocked");
    expect(failure.message).toMatch(/preview it again/i);
  });

  it("turns a validation defect into an ImportFailure that carries the defects", async () => {
    const defects = [{ path: "items/3/usage", message: "the target needs a usage record" }];
    const world = await newWorld({
      adapter: (agent) => (agent === "pi" ? { defects } : {}),
    });
    await writeSession(
      world.homeOf("codex"),
      referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot }),
    );
    const pipeline = createImportPipeline(worldDeps(world));

    const failure = await commitPreviewed(pipeline, importRequest(world, "pi")).catch(
      (cause) => cause,
    );

    expect(failure).toBeInstanceOf(ImportFailure);
    expect(failure.stage).toBe("landing");
    expect(failure.defects).toEqual(defects);
    expect(failure.message).toContain("items/3/usage");
  });

  it("turns a commit refusal into an ImportFailure", async () => {
    const world = await newWorld();
    await writeSession(
      world.homeOf("codex"),
      referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot }),
    );
    // Something already occupies the path the adapter chose.
    const taken = landedFilePath(world.targetHomeOf("pi"), landedSessionId(SOURCE_ID));
    await mkdir(dirname(taken), { recursive: true });
    await writeFile(taken, "not ours\n");
    const pipeline = createImportPipeline(worldDeps(world));

    const failure = await commitPreviewed(pipeline, importRequest(world, "pi")).catch(
      (cause) => cause,
    );

    expect(failure).toBeInstanceOf(ImportFailure);
    expect(failure.stage).toBe("landing");
    expect(failure.message).toMatch(/already exists/i);
    expect(failure.message).toMatch(/again/i);
  });

  it("turns a read-back mismatch into an ImportFailure", async () => {
    const world = await newWorld({
      adapter: (agent) => (agent === "pi" ? { readBackDelta: -1 } : {}),
    });
    await writeSession(
      world.homeOf("codex"),
      referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot }),
    );
    const pipeline = createImportPipeline(worldDeps(world));

    const failure = await commitPreviewed(pipeline, importRequest(world, "pi")).catch(
      (cause) => cause,
    );

    expect(failure).toBeInstanceOf(ImportFailure);
    expect(failure.stage).toBe("landing");
    expect(failure.message).toMatch(/incomplete/i);
    const created = landedFilePath(world.targetHomeOf("pi"), landedSessionId(SOURCE_ID));
    expect(failure.message).toContain(created);
    expect(Object.keys(await checksumTree(world.targetHomeOf("pi")))).toEqual([
      "landed/imported-source-1.json",
    ]);
  });
});

describe("T-IMP-12 — role checks are enforced", () => {
  it("refuses a target whose adapter has no target role, naming the role", async () => {
    const world = await newWorld({
      adapter: (agent) => (agent === "pi" ? { capabilities: { roles: ["source"] } } : {}),
    });
    await writeSession(
      world.homeOf("codex"),
      referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot }),
    );
    const pipeline = createImportPipeline(worldDeps(world));

    const failure = await pipeline
      .commit(importRequest(world, "pi"), null, "")
      .catch((cause) => cause);

    expect(failure).toBeInstanceOf(ImportFailure);
    expect(failure.stage).toBe("target");
    expect(failure.message).toContain('"target"');
    expect(failure.message).toContain("pi");
    expect(world.calls).not.toContain("pi.serialize");
  });

  it("never lists the sessions of an adapter without the source role", async () => {
    const world = await newWorld({
      adapter: (agent) => (agent === "claude-code" ? { capabilities: { roles: ["target"] } } : {}),
    });
    await writeSession(
      world.homeOf("claude-code"),
      referenceSpec({ id: "claude-1", repoPath: world.repoRoot }),
    );
    await writeSession(
      world.homeOf("codex"),
      referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot }),
    );

    const listing = await createImportPipeline(worldDeps(world)).list(listRequest(world, "pi"));

    expect(listing.rows.map((row) => row.ref.id)).toEqual([SOURCE_ID]);
    expect(world.calls).not.toContain("claude-code.listSessions");
  });
});

describe("T-IMP-27 — a work profile is added by configuration alone", () => {
  it("lists the sessions of both homes of one agent", async () => {
    const world = await newWorld();
    const workHome = `${world.root}/homes/claude-team`;
    await writeSession(
      world.homeOf("claude-code"),
      referenceSpec({ id: "personal-1", repoPath: world.repoRoot }),
    );
    await writeSession(workHome, referenceSpec({ id: "work-1", repoPath: world.repoRoot }));

    const config = defaultConfig({
      extraHomes: [{ agent: "claude-code", home: workHome }],
    });
    const listing = await createImportPipeline(worldDeps(world, { config })).list(
      listRequest(world, "pi"),
    );

    expect(listing.rows.map((row) => row.ref.id).sort()).toEqual(["personal-1", "work-1"]);
    expect(listing.failures).toEqual([]);
  });
});
