// GENERATED from src/import/landing/module.md — the Public Contract section is the normative home.
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
} from "../../adapters/contract.js";

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

import type {
  DropReason,
  PinReason,
  TransferPlan,
  TurnDrop,
  TurnPin,
} from "../transfer/contract.js";

export type { DropReason, PinReason, TransferPlan, TurnDrop, TurnPin };

import type {
  Bytes,
  CommitError,
  CommitHandle,
  CommitRefusal,
  FileCommitter,
  PendingFile,
} from "../../platform/store/contract.js";

export type { Bytes, CommitError, CommitHandle, CommitRefusal, FileCommitter, PendingFile };

import type {
  AgentId,
  CanonicalSession,
  CanonicalTurn,
  HomePath,
  ProvenanceMarker,
  RepoSnapshot,
  SessionId,
  SessionRef,
  SourceProvenance,
  TargetProfile,
  ToolCallRecord,
  ToolEffect,
  TurnKind,
  TurnRole,
} from "../../session/contract.js";

export type {
  AgentId,
  CanonicalSession,
  CanonicalTurn,
  HomePath,
  ProvenanceMarker,
  RepoSnapshot,
  SessionId,
  SessionRef,
  SourceProvenance,
  TargetProfile,
  ToolCallRecord,
  ToolEffect,
  TurnKind,
  TurnRole,
};

/** What the user must do next when the adapter cannot switch (FR-45). */
export interface HandoverInstruction {
  sessionId: SessionId;
  /** The native command that opens the new session, for example "claude --resume <id>". */
  command: string;
}

/** What the landing produced (FR-40 to FR-47, FR-52). */
export interface LandingResult {
  ref: SessionRef;
  switched: boolean;
  /** Set when the adapter could only create (FR-43, FR-45). */
  handover: HandoverInstruction | null;
  itemsSent: number;
  itemsStored: number;
  marker: ProvenanceMarker;
}

/** Which step of the landing failed (FR-56). */
export type LandingStage = "serialize" | "validate" | "commit" | "read-back" | "switch";

/** A landing that failed. Nothing remains in the target home (FR-53). */
export interface LandingError {
  stage: LandingStage;
  /** What failed, and what the user can do next (FR-56). */
  message: string;
  /** The structural defects, when the stage is "validate" (FR-50). */
  defects: ValidationDefect[];
  /** True when a commit was made and then undone. */
  rolledBack: boolean;
}

/** Places a plan in the target home. Adds only, all or nothing (FR-49, FR-53). */
export interface SessionLander {
  /**
   * Runs after the user confirmed the preview (FR-20).
   * Rejects with a LandingError, leaving the target home unchanged.
   */
  land(
    plan: TransferPlan,
    adapter: AgentAdapter,
    committer: FileCommitter,
    runtime: AgentRuntime,
    importedAt: string,
    context: SerializationContext,
    prompt?: string | null,
  ): Promise<LandingResult>;
}
