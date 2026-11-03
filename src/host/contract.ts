// GENERATED from src/host/module.md — the Public Contract section is the normative home.
// Declarations only: no behaviour, no defaults. If this file and module.md disagree,
// the document wins and this file is corrected.

import type {
  AdapterRole,
  AgentAdapter,
  AgentCapabilities,
  LandingLevel,
  ProvenanceSupport,
  SelectionLevel,
  SerializationContext,
  SerializedSession,
  StoredSessionFacts,
  SwitchOutcome,
  ValidationDefect,
} from "../adapters/contract.js";

export type {
  AdapterRole,
  AgentAdapter,
  AgentCapabilities,
  LandingLevel,
  ProvenanceSupport,
  SelectionLevel,
  SerializationContext,
  SerializedSession,
  StoredSessionFacts,
  SwitchOutcome,
  ValidationDefect,
};

import type { CliExit, CliInvocation, CliOutcome, CliRunner } from "./cli/contract.js";

export type { CliExit, CliInvocation, CliOutcome, CliRunner };

import type {
  PiCommandContext,
  PiResumeFromCommand,
  PiSwitchContext,
  PiSwitchOptions,
  PiSwitchResult,
} from "./pi-extension/contract.js";

export type {
  PiCommandContext,
  PiResumeFromCommand,
  PiSwitchContext,
  PiSwitchOptions,
  PiSwitchResult,
};

import type {
  AgentRuntime,
  HandoverInstruction,
  HomeFailure,
  ImportPipeline,
  ImportRequest,
  LandingResult,
  Listing,
  ListRequest,
  PreviewReport,
  PreviewWarning,
  SelectionError,
  SelectionInput,
  WarningKind,
} from "../import/contract.js";

export type {
  AgentRuntime,
  HandoverInstruction,
  HomeFailure,
  ImportPipeline,
  ImportRequest,
  LandingResult,
  Listing,
  ListRequest,
  PreviewReport,
  PreviewWarning,
  SelectionError,
  SelectionInput,
  WarningKind,
};

import type {
  ConfigError,
  ConfigLoader,
  HomeEntry,
  ImportConfig,
  WindowOverride,
} from "../platform/config/contract.js";

export type { ConfigError, ConfigLoader, HomeEntry, ImportConfig, WindowOverride };

import type {
  CommitDistance,
  RepoIdentity,
  RepoReader,
  WorktreeRecovery,
} from "../platform/repo/contract.js";

export type { CommitDistance, RepoIdentity, RepoReader, WorktreeRecovery };

import type {
  Bytes,
  CommitError,
  CommitHandle,
  CommitRefusal,
  FileCommitter,
  PendingFile,
} from "../platform/store/contract.js";

export type { Bytes, CommitError, CommitHandle, CommitRefusal, FileCommitter, PendingFile };

import type {
  EstimatorFactory,
  EstimatorFamily,
  TokenEstimator,
} from "../platform/tokens/contract.js";

export type { EstimatorFactory, EstimatorFamily, TokenEstimator };

import type {
  AgentId,
  CanonicalSession,
  CanonicalTurn,
  HomePath,
  ProvenanceMarker,
  RepoSnapshot,
  SessionDescriptor,
  SessionId,
  SessionRef,
  SourceProvenance,
  TargetProfile,
  ToolCallRecord,
  ToolEffect,
  TurnKind,
  TurnRole,
} from "../session/contract.js";

export type {
  AgentId,
  CanonicalSession,
  CanonicalTurn,
  HomePath,
  ProvenanceMarker,
  RepoSnapshot,
  SessionDescriptor,
  SessionId,
  SessionRef,
  SourceProvenance,
  TargetProfile,
  ToolCallRecord,
  ToolEffect,
  TurnKind,
  TurnRole,
};

/** The agent list. Adding an agent adds one line here (FR-57). */
export interface AgentRegistry {
  /** Every adapter, in the order they were listed. */
  all(): AgentAdapter[];
  /** Rejects when the agent has no adapter (FR-56). */
  get(agent: AgentId): AgentAdapter;
  /** Adapters whose roles include "source" (FR-59). */
  sources(): AgentAdapter[];
  /** Adapters whose roles include "target" (FR-59). */
  targets(): AgentAdapter[];
}

/** Builds one pipeline for one target agent. */
export interface HostWiring {
  registry(): AgentRegistry;
  pipelineFor(target: TargetProfile): Promise<ImportPipeline>;
  /** A pipeline for operations that need no target: list, locate and native resume (FR-61). */
  pipelineForListing(): Promise<ImportPipeline>;
}

/** Builds the target profile for the agent the user is in (FR-3, FR-18). */
export interface TargetProfileBuilder {
  /**
   * Uses the adapter's declared default home when home is null (FR-3),
   * and the user's window override when there is one (FR-18).
   */
  build(agent: AgentId, home: HomePath | null, config: ImportConfig): TargetProfile;
}
