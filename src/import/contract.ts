// GENERATED from src/import/module.md — the Public Contract section is the normative home.
// Declarations only: no behaviour, no defaults. If this file and module.md disagree,
// the document wins and this file is corrected.

import type {
  AdapterRole,
  AgentAdapter,
  AgentCapabilities,
  AgentRuntime,
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
  AgentRuntime,
  LandingLevel,
  ProvenanceSupport,
  SelectionLevel,
  SerializationContext,
  SerializedSession,
  StoredSessionFacts,
  SwitchOutcome,
  ValidationDefect,
};

import type { Place, RecoveryResult, RecoverySteps } from "../platform/repo/contract.js";

export type { Place, RecoveryResult, RecoverySteps };

import type {
  DiscoveryDestination,
  HomeFailure,
  Listing,
  SearchScope,
  SelectionError,
  SelectionInput,
  SessionFinder,
  SessionLocator,
} from "./discovery/contract.js";

export type {
  DiscoveryDestination,
  HomeFailure,
  Listing,
  SearchScope,
  SelectionError,
  SelectionInput,
  SessionFinder,
  SessionLocator,
};

import type {
  HandoverInstruction,
  LandingError,
  LandingResult,
  LandingStage,
  SessionLander,
} from "./landing/contract.js";

export type { HandoverInstruction, LandingError, LandingResult, LandingStage, SessionLander };

import type {
  PreviewBuilder,
  PreviewContent,
  PreviewReport,
  PreviewWarning,
  WarningKind,
} from "./preview/contract.js";

export type { PreviewBuilder, PreviewContent, PreviewReport, PreviewWarning, WarningKind };

import type {
  DropReason,
  PinReason,
  TransferPlan,
  TransferRules,
  TurnDrop,
  TurnPin,
} from "./transfer/contract.js";

export type { DropReason, PinReason, TransferPlan, TransferRules, TurnDrop, TurnPin };

import type { HomeEntry, ImportConfig, WindowOverride } from "../platform/config/contract.js";

export type { HomeEntry, ImportConfig, WindowOverride };

import type {
  Bytes,
  CommitError,
  CommitHandle,
  CommitRefusal,
  FileCommitter,
  PendingFile,
} from "../platform/store/contract.js";

export type { Bytes, CommitError, CommitHandle, CommitRefusal, FileCommitter, PendingFile };

import type { TokenEstimator } from "../platform/tokens/contract.js";

export type { TokenEstimator };

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

/** What to list (FR-10, FR-15). */
export interface ListRequest {
  /** Host-supplied absolute working directory; preserve native subdirectory and symlink spelling. */
  destinationCwd: string;
  /** Null in a bare shell, where listing needs no target agent (FR-61). */
  target: TargetProfile | null;
  onlyAgent: AgentId | null;
  onlyHome: HomePath | null;
}

/** What to preview, and later what to commit (FR-16, FR-20). */
export interface ImportRequest {
  /** Host-supplied absolute working directory; preserve native subdirectory and symlink spelling. */
  destinationCwd: string;
  target: TargetProfile;
  selection: SelectionInput;
  /**
   * Set when the session was already located. Discovery then uses this descriptor instead of
   * listing or parsing any home again (FR-61).
   */
  located?: SessionDescriptor | null;
  /** The initial prompt appended to the resumed session, when the host asked for one (FR-61). */
  prompt?: string | null;
  onlyAgent: AgentId | null;
  onlyHome: HomePath | null;
}

/** How the user named one session to restore (FR-61). */
export interface LocateRequest {
  selection: SelectionInput;
  /** The invocation directory, used only to resolve a row of this repository's list. */
  cwd: string;
  onlyAgent: AgentId | null;
  onlyHome: HomePath | null;
}

/** The directory an import of a located session records, and any note about it (FR-61). */
export interface ImportDestination {
  /** Absolute directory the imported session records as its own. */
  directory: string;
  /** A note the host prints as a warning; null when the destination needs none. */
  warning: string | null;
}

/**
 * One import, from listing to landing, plus the restore operations an identifier flow needs.
 * Every host drives these calls; none of the stages behind them is exported (FR-60).
 */
export interface ImportPipeline {
  list(request: ListRequest): Promise<Listing>;
  /** Writes nothing (FR-16). */
  preview(request: ImportRequest): Promise<PreviewReport>;
  /** Runs only after the user confirmed the preview (FR-20). */
  commit(
    request: ImportRequest,
    runtime: AgentRuntime,
    confirmationToken: string,
  ): Promise<LandingResult>;

  /** Resolves a row, ID/prefix or path; an ID or path is not filtered by repository (FR-61). */
  locate(request: LocateRequest): Promise<SessionDescriptor>;
  /** Where the session's recorded directory is, and how it could be recreated (FR-61). */
  place(descriptor: SessionDescriptor): Promise<Place>;
  /** The two summary lines every restore output starts with (FR-61). */
  summary(descriptor: SessionDescriptor, place: Place): string[];
  /** Binds the session file, directory and recovery argv into a token (FR-61). */
  recoveryToken(descriptor: SessionDescriptor, place: Place): string | null;
  /** Runs the recovery only when the token matches. A mismatch runs nothing (FR-61). */
  recover(descriptor: SessionDescriptor, place: Place, token: string): Promise<RecoveryResult>;
  /**
   * The directory an import records: the session directory, or the --to override (FR-61).
   * `place` is the session's place when the caller already resolved it, so a recoverable
   * directory's repository can be checked before a recovery writes anything.
   */
  destinationFor(
    descriptor: SessionDescriptor,
    to: string | null,
    place?: Place | null,
  ): Promise<ImportDestination>;
  /** The source agent's native command that resumes the session in `directory` (FR-61). */
  resumeCommand(descriptor: SessionDescriptor, directory: string, prompt: string | null): string;
  /** What the user types in the running agent to open the session there, or null (FR-66). */
  inPlaceCommand(ref: SessionRef): string | null;
  /** The conversation an import into `target` would keep, as plain text lines (FR-61). */
  context(descriptor: SessionDescriptor, target: TargetProfile): Promise<string[]>;
  /** Moves the user into an existing session of its own agent (FR-44, FR-61). */
  switchTo(descriptor: SessionDescriptor, runtime: AgentRuntime): Promise<SwitchOutcome>;
}
