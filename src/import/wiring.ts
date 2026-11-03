// The Internal Design, as code: this module builds its four stages and nothing else builds
// them. Everything the stages need arrives from src/host/ — this module constructs no adapter,
// no committer, no estimator and no configuration.

import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { RepoReader, WorktreeRecovery } from "../platform/repo/contract.js";
import type {
  AgentAdapter,
  FileCommitter,
  ImportConfig,
  ImportPipeline,
  TokenEstimator,
} from "./contract.js";
import { createSessionFinder, createSessionLocator } from "./discovery/index.js";
import { createSessionLander } from "./landing/index.js";
import { createPipelineFromStages, type PipelineStages } from "./pipeline.js";
import { createPreviewBuilder } from "./preview/index.js";
import { createTransferRules } from "./transfer/index.js";

export interface ImportPipelineDeps {
  /** Every constructed adapter, in the order the composition root listed them (FR-57). */
  adapters: readonly AgentAdapter[];
  config: ImportConfig;
  estimator: TokenEstimator;
  committer: FileCommitter;
  /** Read by the preview to say how far the tree moved (FR-37, FR-38). */
  repo: RepoReader;
  /** Plans and runs the one recovery this tool may perform (FR-61). */
  recovery: WorktreeRecovery;
  /**
   * The import time written into the marker (FR-47). Injected because no stage may read a
   * clock: a preview and the commit that follows it must compute the same plan.
   */
  now?: () => string;
}

/** The four stages, wired. Internal: a host builds a pipeline, never a stage. */
export function buildStages(deps: ImportPipelineDeps): PipelineStages {
  return {
    checkCancellation: () => deps.repo.checkCancellation(),
    finder: createSessionFinder({ adapters: deps.adapters, config: deps.config, repo: deps.repo }),
    locator: createSessionLocator({ adapters: deps.adapters, config: deps.config }),
    recovery: deps.recovery,
    rules: createTransferRules(),
    // Per request: the preview reads the repository the request names (FR-13, FR-37).
    async destinationFor(cwd) {
      if (!isAbsolute(cwd)) throw new Error("The destination cwd must be absolute.");
      const canonicalCwd = await realpath(cwd);
      const identity = await deps.repo.identify(canonicalCwd);
      return { cwd, canonicalCwd, identity };
    },
    previewFor: ({ cwd, canonicalCwd, identity }, descriptor) =>
      createPreviewBuilder(deps.repo, cwd, canonicalCwd, identity, descriptor.repoPaths),
    lander: createSessionLander(),
    adapters: deps.adapters,
    config: deps.config,
    estimator: deps.estimator,
    committer: deps.committer,
    now: deps.now ?? (() => new Date().toISOString()),
  };
}

/** One import, from listing to landing. The only thing a host constructs here. */
export function createImportPipeline(deps: ImportPipelineDeps): ImportPipeline {
  return createPipelineFromStages(buildStages(deps));
}
