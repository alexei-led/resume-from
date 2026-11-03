// GENERATED from src/import/discovery/module.md — the Public Contract section is the normative home.
// Declarations only: no behaviour, no defaults. If this file and module.md disagree,
// the document wins and this file is corrected.

import type {
  AdapterRole,
  AgentAdapter,
  AgentCapabilities,
  LandingLevel,
  ProvenanceSupport,
  SelectionLevel,
} from "../../adapters/contract.js";

export type {
  AdapterRole,
  AgentAdapter,
  AgentCapabilities,
  LandingLevel,
  ProvenanceSupport,
  SelectionLevel,
};

import type { HomeEntry, ImportConfig } from "../../platform/config/contract.js";

export type { HomeEntry, ImportConfig };

import type { RepoIdentity, RepoReader } from "../../platform/repo/contract.js";

export type { RepoIdentity, RepoReader };

import type {
  AgentId,
  CanonicalSession,
  CanonicalTurn,
  HomePath,
  RepoSnapshot,
  SessionDescriptor,
  SessionId,
  SessionRef,
  SourceProvenance,
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
  RepoSnapshot,
  SessionDescriptor,
  SessionId,
  SessionRef,
  SourceProvenance,
  ToolCallRecord,
  ToolEffect,
  TurnKind,
  TurnRole,
};

/** How the user named the session to import (FR-12). */
export type SelectionInput =
  | { by: "row"; row: number }
  | { by: "session-id"; id: SessionId }
  | { by: "file-path"; path: string };

/** Which homes to search (FR-2, FR-5, FR-13, FR-15). */
export interface SearchScope {
  /** Absolute path of the repository the listing is filtered to (FR-13). */
  repoRoot: string;
  /** When set, only this agent is searched (FR-15). */
  onlyAgent: AgentId | null;
  /** When set, only this home is searched (FR-2). */
  onlyHome: HomePath | null;
}

/** Why a selection could not be resolved (FR-56). */
export interface SelectionError {
  /** What the user gave: the row, the session ID, or the path. */
  input: string;
  /** What failed, and what the user can do next. */
  message: string;
}

/** One home or session that could not be included. The listing continues without it. */
export interface HomeFailure {
  home: HomePath;
  agent: AgentId;
  /** Why the home or session was skipped, in one line. */
  message: string;
}

/** What a listing produced, including what it could not read. */
export interface Listing {
  /** Newest first, across every agent and home (FR-14, FR-15). */
  rows: SessionDescriptor[];
  /** Homes or sessions that were skipped. Reported to the user, never silent. */
  failures: HomeFailure[];
}

/** Fresh destination facts resolved by the caller for this listing only. */
export interface DiscoveryDestination {
  canonicalCwd: string;
  identity: RepoIdentity;
}

/** Finds one session anywhere on disk, without the repository filter (FR-61). */
export interface SessionLocator {
  /**
   * Resolves a case-insensitive exact ID, or a prefix of at least six characters.
   * `accept` narrows the candidates before ambiguity is decided.
   */
  byId(
    query: string,
    accept?: (descriptor: SessionDescriptor) => boolean | Promise<boolean>,
  ): Promise<SessionDescriptor>;
  /** Describes one session file directly (FR-12). */
  byPath(
    filePath: string,
    accept?: (descriptor: SessionDescriptor) => boolean | Promise<boolean>,
  ): Promise<SessionDescriptor>;
  /** Every search root, fully resolved, in the order a lookup visits them. */
  roots(): Promise<string[]>;
}

/** Finds, filters, orders and loads source sessions. It never writes. */
export interface SessionFinder {
  /** Newest first (FR-14), only sessions of the current repository (FR-13). */
  list(scope: SearchScope, destination?: DiscoveryDestination): Promise<Listing>;
  /** Resolves a choice against the same ordering list() produced. Rejects with SelectionError. */
  resolve(
    scope: SearchScope,
    input: SelectionInput,
    destination?: DiscoveryDestination,
  ): Promise<SessionDescriptor>;
  /**
   * True when one of the session's recorded directories belongs to the repository at
   * `directory`, using the same membership rule as listing (FR-13, FR-61).
   */
  belongs(descriptor: SessionDescriptor, directory: string): Promise<boolean>;
  /** Reads one session into the neutral vocabulary, through its source adapter. */
  load(descriptor: SessionDescriptor): Promise<CanonicalSession>;
}
