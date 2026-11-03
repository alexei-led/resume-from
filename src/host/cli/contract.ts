// GENERATED from src/host/cli/module.md — the Public Contract section is the normative home.
// Declarations only: no behaviour, no defaults. If this file and module.md disagree,
// the document wins and this file is corrected.

import type {
  AgentRuntime,
  HandoverInstruction,
  HomeFailure,
  ImportDestination,
  ImportPipeline,
  ImportRequest,
  LandingResult,
  Listing,
  ListRequest,
  Place,
  PreviewReport,
  PreviewWarning,
  RecoveryResult,
  SelectionError,
  SelectionInput,
  SwitchOutcome,
  WarningKind,
} from "../../import/contract.js";

export type {
  AgentRuntime,
  HandoverInstruction,
  HomeFailure,
  ImportDestination,
  ImportPipeline,
  ImportRequest,
  LandingResult,
  Listing,
  ListRequest,
  Place,
  PreviewReport,
  PreviewWarning,
  RecoveryResult,
  SelectionError,
  SelectionInput,
  SwitchOutcome,
  WarningKind,
};

import type {
  AgentId,
  HomePath,
  ProvenanceMarker,
  SessionDescriptor,
  SessionId,
  SessionRef,
  TargetProfile,
} from "../../session/contract.js";

export type {
  AgentId,
  HomePath,
  ProvenanceMarker,
  SessionDescriptor,
  SessionId,
  SessionRef,
  TargetProfile,
};

/** One invocation of the command binary (FR-10). */
export interface CliInvocation {
  /** Arguments after the command name. */
  argv: string[];
  /** The directory the agent is running in. Used to find the repository (FR-13). */
  cwd: string;
  /**
   * The agent the binary is running inside. The shim states it; the binary never guesses.
   * Null in a bare shell, where no agent is hosting the command (FR-61).
   */
  targetAgent: AgentId | null;
  /** The target home, when the shim knows it. Otherwise the adapter default is used (FR-3). */
  targetHome: HomePath | null;
}

/** 0 success, 1 refused, 2 error (FR-56). */
export type CliExit = 0 | 1 | 2;

/** What one invocation produced. */
export interface CliOutcome {
  stdout: string[];
  stderr: string[];
  exitCode: CliExit;
}

/** Runs one invocation of the command binary. */
export interface CliRunner {
  run(invocation: CliInvocation, pipeline: ImportPipeline): Promise<CliOutcome>;
}
