/**
 * The construction order, as code (Internal Design, steps 1 to 5).
 *
 * 1. Configuration, once. Everything downstream reads the result, and a rejected configuration
 *    stops the command before an adapter exists or a home is read (FR-56).
 * 2. The platform services: the estimator factory, the repository reader, the committer.
 * 3. The adapters of the list. `capabilities()` is cheap and pure, so it may be read at once.
 * 4. The target profile, built by the caller from the agent the entry point is running in.
 * 5. The pipeline, wired with the services and the adapters.
 *
 * Every step is injectable, because a composition root whose parts cannot be replaced cannot be
 * tested — and because the deps are thunks, not values, "nothing is built before the
 * configuration is loaded" is a property a test can observe rather than a promise.
 */

import { createImportPipeline } from "../import/index.js";
import { createConfigLoader } from "../platform/config/index.js";
import { createRepoReader, createWorktreeRecovery } from "../platform/repo/index.js";
import { createFileCommitter } from "../platform/store/index.js";
import { estimatorFactory } from "../platform/tokens/index.js";
import { AGENTS, type AgentEntry } from "./agents.js";
import type {
  AdapterRole,
  AgentId,
  AgentRegistry,
  ConfigLoader,
  EstimatorFactory,
  EstimatorFamily,
  FileCommitter,
  HostWiring,
  ImportConfig,
  ImportPipeline,
  RepoReader,
  TargetProfile,
  TargetProfileBuilder,
  WorktreeRecovery,
} from "./contract.js";
import { createTargetProfileBuilder } from "./profile.js";
import { createAgentRegistry } from "./registry.js";

/** The role an adapter must declare to receive an import (FR-59). */
const TARGET_ROLE: AdapterRole = "target";

/** Everything the composition root builds, and what a test may replace. */
export interface HostDeps {
  /** The agent list. Defaults to the one list of the tree (FR-57). */
  agents?: readonly AgentEntry[];
  configLoader?: ConfigLoader;
  createEstimators?: () => EstimatorFactory;
  createRepo?: () => RepoReader;
  createRecovery?: () => WorktreeRecovery;
  createCommitter?: () => FileCommitter;
  /** Host invocation directory. Each pipeline request independently supplies its destination. */
  cwd?: string;
  /** The import time written into the marker (FR-47). Injected so a preview and a commit agree. */
  now?: () => string;
}

/**
 * The wiring, plus the two things an entry point needs to reach step 4: the configuration that
 * was loaded once, and the builder that turns an agent and a home into a profile.
 */
export interface Host extends HostWiring {
  registry(): AgentRegistry;
  profiles(): TargetProfileBuilder;
  /** The one configuration of this process (Constraints: loaded once per process). */
  config(): ImportConfig;
  pipelineFor(target: TargetProfile): Promise<ImportPipeline>;
  /** A pipeline for operations that need no target: list, locate and native resume (FR-61). */
  pipelineForListing(): Promise<ImportPipeline>;
}

export async function createHost(deps: HostDeps = {}): Promise<Host> {
  // Step 1. It rejects before anything else exists, which is what FR-56 asks for.
  const config = await (deps.configLoader ?? createConfigLoader()).load();

  // Step 2.
  const estimators = (deps.createEstimators ?? (() => estimatorFactory))();
  const repo = (deps.createRepo ?? createRepoReader)();
  const recovery = (deps.createRecovery ?? (() => createWorktreeRecovery()))();
  const committer = (deps.createCommitter ?? createFileCommitter)();

  // Step 3. The list is the only place that knows which implementations exist. Each adapter
  // names itself, so the family is keyed by what it declares and never by what the list assumed.
  const families = new Map<AgentId, EstimatorFamily>();
  const adapters = (deps.agents ?? AGENTS).map((entry) => {
    const adapter = entry.create();
    const agent = adapter.capabilities().agent;
    if (!families.has(agent)) families.set(agent, entry.family);
    return adapter;
  });

  const registry = createAgentRegistry(adapters);
  const profiles = createTargetProfileBuilder(registry);

  // One construction for both entry points: the only difference is the estimator family.
  const buildPipeline = (family: EstimatorFamily): ImportPipeline =>
    createImportPipeline({
      adapters,
      config,
      estimator: estimators.forFamily(family),
      committer,
      repo,
      recovery,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });

  return {
    registry: () => registry,
    profiles: () => profiles,
    config: () => config,

    // Step 5. Async so a refusal reaches the caller as a rejection, never as a throw.
    async pipelineFor(target: TargetProfile): Promise<ImportPipeline> {
      const declared = registry.get(target.agent).capabilities();
      if (!declared.roles.includes(TARGET_ROLE)) {
        throw new Error(
          `The "${target.agent}" adapter cannot receive an import: it declares the role(s) ` +
            `${declared.roles.join(", ")} and not "${TARGET_ROLE}" (FR-59). ` +
            "Run the import from an agent whose adapter has that role.",
        );
      }
      return buildPipeline(families.get(target.agent) ?? "generic");
    },

    // The list, lookup and native resume need no target. Building them with the generic
    // estimator keeps a bare shell free of an agent it never uses (FR-61).
    async pipelineForListing(): Promise<ImportPipeline> {
      return buildPipeline("generic");
    },
  };
}
