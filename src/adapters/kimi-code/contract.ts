// GENERATED from src/adapters/kimi-code/module.md — the Public Contract section is the normative home.
// Declarations only: no behaviour, no defaults. If this file and module.md disagree,
// the document wins and this file is corrected.

import type {
  AdapterRole,
  AgentAdapter,
  AgentCapabilities,
  AgentRuntime,
  Bytes,
  LandingLevel,
  PendingFile,
  ProvenanceSupport,
  SelectionLevel,
  SerializationContext,
  SerializedSession,
  StoredSessionFacts,
  SwitchOutcome,
  ValidationDefect,
} from "../contract.js";

export type {
  AdapterRole,
  AgentAdapter,
  AgentCapabilities,
  AgentRuntime,
  Bytes,
  LandingLevel,
  PendingFile,
  ProvenanceSupport,
  SelectionLevel,
  SerializationContext,
  SerializedSession,
  StoredSessionFacts,
  SwitchOutcome,
  ValidationDefect,
};

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
} from "../../session/contract.js";

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

/** The injectable seam that keeps serialize pure (no ambient process state). */
export interface KimiCodeSerializeDeps {
  /** Produces the new session's UUID, without the `session_` prefix. Injected so two calls with the same deps are byte-equal. */
  newSessionId(): string;
}

/** Builds the Kimi Code adapter. The only export of this module (FR-57). */
export interface KimiCodeAdapterFactory {
  create(overrides?: Partial<KimiCodeSerializeDeps>): AgentAdapter;
}
