// T-IMP-13 to T-IMP-19: what the pipeline is not allowed to touch, and what it does not export.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentId, ImportRequest } from "./contract.js";
import { ImportFailure } from "./errors.js";
import * as importModule from "./index.js";
import {
  AGENTS,
  checksumTree,
  commitPreviewed,
  createWorld,
  instrument,
  landedFilePath,
  landedSessionId,
  referenceSpec,
  type StubStage,
  type World,
  worldDeps,
  writeSession,
} from "./test-support.js";
import { createImportPipeline } from "./wiring.js";

// Nothing in the import path may reach the network (FR-8). Anything that tried would
// throw here rather than reach a socket.
const noNetwork = () => {
  throw new Error("the network is unavailable");
};
vi.mock("node:http", () => ({
  default: { request: noNetwork, get: noNetwork },
}));
vi.mock("node:https", () => ({
  default: { request: noNetwork, get: noNetwork },
}));
vi.mock("node:dns", () => ({
  default: { lookup: noNetwork, resolve: noNetwork },
}));

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

function importRequest(world: World, target: AgentId): ImportRequest {
  return {
    ...listRequest(world, target),
    target: world.targetFor(target),
    selection: { by: "session-id", id: SOURCE_ID },
  };
}

const DIRECTIONS: Array<[AgentId, AgentId]> = AGENTS.flatMap((source) =>
  AGENTS.map((target): [AgentId, AgentId] => [source, target]),
);

describe("T-IMP-13 — list and preview write nothing", () => {
  it.each(DIRECTIONS)("leaves every home unchanged for %s → %s", async (source, target) => {
    const world = await newWorld();
    await writeSession(
      world.homeOf(source),
      referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot }),
    );
    const pipeline = createImportPipeline(worldDeps(world));
    const before = await checksumTree(world.root);

    await pipeline.list(listRequest(world, target));
    await pipeline.preview(importRequest(world, target));

    expect(await checksumTree(world.root)).toEqual(before);
  });
});

describe("T-IMP-14 — failures preserve existing target data", () => {
  const failures: Array<[string, () => Promise<World>, (world: World) => Promise<void>, boolean]> =
    [
      [
        "serialize",
        () =>
          newWorld({
            adapter: (agent) => (agent === "pi" ? { failAt: ["serialize"] } : {}),
          }),
        async () => undefined,
        false,
      ],
      [
        "validate",
        () =>
          newWorld({
            adapter: (agent) =>
              agent === "pi" ? { defects: [{ path: "items/0", message: "no role" }] } : {},
          }),
        async () => undefined,
        false,
      ],
      [
        "commit",
        () => newWorld(),
        async (world) => {
          // The path the adapter chose is taken, so the committer refuses before writing.
          const taken = landedFilePath(world.targetHomeOf("pi"), landedSessionId(SOURCE_ID));
          await mkdir(dirname(taken), { recursive: true });
          await writeFile(taken, "not ours\n");
        },
        false,
      ],
      [
        "read-back",
        () =>
          newWorld({
            adapter: (agent) => (agent === "pi" ? { readBackDelta: 1 } : {}),
          }),
        async () => undefined,
        true,
      ],
    ];

  it.each(failures)(
    "preserves existing target data when %s fails",
    async (_stage, build, seed, keepsPublication) => {
      const world = await build();
      await writeSession(
        world.homeOf("codex"),
        referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot }),
      );
      await seed(world);
      const before = await checksumTree(world.targetHomeOf("pi"));

      const pipeline = createImportPipeline(worldDeps(world));
      const failure = await commitPreviewed(pipeline, importRequest(world, "pi")).catch(
        (cause) => cause,
      );

      expect(failure).toBeInstanceOf(ImportFailure);
      const after = await checksumTree(world.targetHomeOf("pi"));
      expect(after).toMatchObject(before);
      expect(Object.keys(after)).toHaveLength(
        Object.keys(before).length + (keepsPublication ? 1 : 0),
      );
      if (keepsPublication) {
        expect(failure.message).toContain(
          landedFilePath(world.targetHomeOf("pi"), landedSessionId(SOURCE_ID)),
        );
      }
    },
  );

  it("keeps the valid session when only the switch fails, and says how to open it", async () => {
    const world = await newWorld({
      adapter: (agent) => (agent === "pi" ? { failAt: ["switchTo" as StubStage] } : {}),
    });
    await writeSession(
      world.homeOf("codex"),
      referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot }),
    );

    const pipeline = createImportPipeline(worldDeps(world));
    // A runtime is what asks the landing to move the user; null means create only (FR-61).
    const failure = await commitPreviewed(pipeline, importRequest(world, "pi"), {}).catch(
      (cause) => cause,
    );

    expect(failure).toBeInstanceOf(ImportFailure);
    expect(failure.message).toMatch(/kept/i);
    expect(Object.keys(await checksumTree(world.targetHomeOf("pi")))).toHaveLength(1);
  });
});

describe("T-IMP-15 — every source file is byte-identical after every direction", () => {
  it.each(DIRECTIONS)("does not touch the source home for %s → %s", async (source, target) => {
    const world = await newWorld();
    await writeSession(
      world.homeOf(source),
      referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot }),
    );
    const pipeline = createImportPipeline(worldDeps(world));
    const before = await Promise.all(AGENTS.map((agent) => checksumTree(world.homeOf(agent))));

    await pipeline.list(listRequest(world, target));
    const report = await pipeline.preview(importRequest(world, target));
    await pipeline.commit(importRequest(world, target), null, report.confirmationToken);

    expect(await Promise.all(AGENTS.map((agent) => checksumTree(world.homeOf(agent))))).toEqual(
      before,
    );
  });
});

describe("T-IMP-16 — no stage can be reached around the pipeline", () => {
  it("exports the pipeline factory and its error, and no stage", () => {
    expect(Object.keys(importModule).sort()).toEqual(["ImportFailure", "createImportPipeline"]);
  });
});

describe("T-IMP-17 — no state is carried between calls", () => {
  it("commits from a freshly constructed pipeline and lands the plan the preview showed", async () => {
    const world = await newWorld();
    await writeSession(
      world.homeOf("codex"),
      referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot }),
    );

    // Two pipelines, two dependency sets: the two invocations of FR-10.
    const before = await checksumTree(world.root);
    const previewRun = instrument(worldDeps(world));
    const previewReport = await previewRun.pipeline.preview(importRequest(world, "pi"));

    // No temporary file, no cache: the preview left the tree exactly as it found it.
    expect(await checksumTree(world.root)).toEqual(before);

    const commitRun = instrument(worldDeps(world));
    const landed = await commitRun.pipeline.commit(
      importRequest(world, "pi"),
      null,
      previewReport.confirmationToken,
    );

    expect(previewReport.blocked).toBe(false);
    expect(landed.itemsStored).toBe(landed.itemsSent);
    expect(commitRun.landed[0]).toEqual(previewRun.plans[0]);
  });
});

describe("T-IMP-18 — an unknown target agent is refused", () => {
  it.each(["preview", "commit"] as const)("names the agent in %s", async (operation) => {
    const world = await newWorld();
    await writeSession(
      world.homeOf("codex"),
      referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot }),
    );
    const pipeline = createImportPipeline(worldDeps(world));
    const request: ImportRequest = {
      ...importRequest(world, "codex"),
      target: {
        agent: "gemini" as AgentId,
        home: `${world.root}/homes/gemini`,
        windowTokens: 100_000,
      },
    };

    const failure = await (operation === "preview"
      ? pipeline.preview(request)
      : pipeline.commit(request, null, "")
    ).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ImportFailure);
    expect((failure as ImportFailure).stage).toBe("target");
    expect((failure as ImportFailure).message).toContain("gemini");
  });
});

describe("T-IMP-19 — the whole pipeline runs with the network stubbed to fail", () => {
  it.each(DIRECTIONS)("imports %s → %s with no network", async (source, target) => {
    vi.stubGlobal("fetch", () => {
      throw new Error("the network is unavailable");
    });
    try {
      const world = await newWorld();
      await writeSession(
        world.homeOf(source),
        referenceSpec({ id: SOURCE_ID, repoPath: world.repoRoot }),
      );
      const pipeline = createImportPipeline(worldDeps(world));

      await pipeline.list(listRequest(world, target));
      const report = await pipeline.preview(importRequest(world, target));
      const landed = await pipeline.commit(
        importRequest(world, target),
        null,
        report.confirmationToken,
      );

      expect(landed.ref.agent).toBe(target);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
