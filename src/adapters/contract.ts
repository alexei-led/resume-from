// GENERATED from src/adapters/module.md — the Public Contract section is the normative home.
// Declarations only: no behaviour, no defaults. If this file and module.md disagree,
// the document wins and this file is corrected.

import type { Bytes, PendingFile } from "../platform/store/contract.js";

export type { Bytes, PendingFile };

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

/** How the agent lets the user choose a source session (FR-9, FR-10, FR-58). */
export type SelectionLevel = "interactive-picker" | "numbered-list";

/** How far the adapter can take the landing (FR-42). */
export type LandingLevel = "create-and-switch" | "create-only";

/** Which roles the adapter fills (FR-59). */
export type AdapterRole = "source" | "target";

/** How the agent can show the marker outside the model context (FR-47, FR-48). */
export type ProvenanceSupport = "out-of-context-entry" | "host-output-only";

/** Everything the rest of the system may know about one agent (FR-58). */
export interface AgentCapabilities {
  agent: AgentId;
  roles: AdapterRole[];
  selection: SelectionLevel;
  landing: LandingLevel;
  provenance: ProvenanceSupport;
  /** Home used when the user names none (FR-3). */
  defaultHome: HomePath;
  /** Context window assumed for this agent when configuration overrides none (FR-18). */
  defaultWindowTokens: number;
  /**
   * The order a global ID lookup searches agents in, keyed by the shape of the query (FR-61).
   * Lower is searched first; equal ranks keep the agent list's order.
   */
  idLookup: { v4: number; v7: number; other: number };
}

/**
 * An opaque handle supplied by the host of the same agent, for example Pi's
 * command context. Nothing outside the adapter of that agent inspects it.
 */
export type AgentRuntime = unknown;

/** A structural defect found before placement (FR-50). */
export interface ValidationDefect {
  /** Pointer into the offending item, for example "items/3/usage". */
  path: string;
  /** What is missing or malformed, and why the agent would fail on it. */
  message: string;
}

/** The host-supplied absolute destination, preserving native subdirectory and symlink spelling. */
export interface SerializationContext {
  cwd: string;
}

/** What serializing a canonical session into the target format produced. */
export interface SerializedSession {
  sessionId: SessionId;
  /** The files to create. The adapter never writes them itself (FR-49, FR-53). */
  files: PendingFile[];
  /** Items the adapter expects the target to store (FR-52). */
  itemCount: number;
}

/** What the target actually holds, read back after the commit (FR-51, FR-52). */
export interface StoredSessionFacts {
  sessionId: SessionId;
  /** Items the target stored. A difference from itemCount is an error (FR-52). */
  itemCount: number;
  /** True when the target's own commands can open the session (FR-51). */
  openable: boolean;
}

/** The outcome of asking the agent to move the user into the new session (FR-44). */
export interface SwitchOutcome {
  switched: boolean;
  /** True when the agent asked the user and the user declined. */
  cancelled: boolean;
}

/** What every agent adapter provides. One folder per agent implements it (FR-57). */
export interface AgentAdapter {
  capabilities(): AgentCapabilities;

  /** Source role. Opens source files for reading only (FR-8, NG-1, AC-4). */
  listSessions(home: HomePath): Promise<SessionDescriptor[]>;
  /** Source role. Reads one session into the neutral vocabulary. Drops every result body. */
  loadSession(descriptor: SessionDescriptor): Promise<CanonicalSession>;

  /**
   * Source role. Directories or glob patterns where this agent keeps session files, including
   * homes named by its environment. A global lookup expands them (FR-61).
   */
  searchRoots(): string[];
  /**
   * Source role. Sessions under one search root whose ID matches `query`. Only matching files
   * are parsed, never every file of a home.
   */
  findSessions(root: string, query: string): Promise<SessionDescriptor[]>;
  /** Source role. Describes one session file directly, for selection by path (FR-12, FR-61). */
  describeSession(filePath: string): Promise<SessionDescriptor>;

  /**
   * The native command that resumes the session in its own agent. Paths are absolute and quoted
   * only when needed; the home variable appears only when it is not the agent's default home.
   */
  resumeCommand(input: {
    home: HomePath;
    directory: string;
    sessionId: SessionId;
    filePath: string;
    prompt: string | null;
  }): string;

  /** Target role. Produces bytes only. It never creates a file (FR-49, FR-53). */
  serialize(
    session: CanonicalSession,
    target: TargetProfile,
    marker: ProvenanceMarker,
    context: SerializationContext,
  ): SerializedSession;
  /** Target role. Checks the structure before placement. Empty means valid (FR-50). */
  validate(serialized: SerializedSession): ValidationDefect[];
  /** Target role. Reads the committed session back, to compare item counts (FR-51, FR-52). */
  readBack(home: HomePath, sessionId: SessionId): Promise<StoredSessionFacts>;

  /** Target role, only when capabilities().landing is "create-and-switch" (FR-43, FR-44). */
  switchTo(home: HomePath, sessionId: SessionId, runtime: AgentRuntime): Promise<SwitchOutcome>;
}
