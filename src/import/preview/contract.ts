// GENERATED from src/import/preview/module.md — the Public Contract section is the normative home.
// Declarations only: no behaviour, no defaults. If this file and module.md disagree,
// the document wins and this file is corrected.

import type {
  DropReason,
  PinReason,
  TransferPlan,
  TurnDrop,
  TurnPin,
} from "../transfer/contract.js";

export type { DropReason, PinReason, TransferPlan, TurnDrop, TurnPin };

import type { CommitDistance, RepoIdentity, RepoReader } from "../../platform/repo/contract.js";

export type { CommitDistance, RepoIdentity, RepoReader };

import type {
  AgentId,
  CanonicalSession,
  CanonicalTurn,
  HomePath,
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

/** What a warning is about. Repository warnings sort first (FR-19). */
export type WarningKind = "repo-state" | "budget" | "broken-tail" | "capability";

/** One warning line of the preview (FR-19). */
export interface PreviewWarning {
  kind: WarningKind;
  /** The rendered line, ready to show. */
  line: string;
}

/** Everything the user sees before confirming (FR-16 to FR-21). */
export interface PreviewReport {
  /** Opaque binding that must be returned unchanged to commit this exact preview (FR-20). */
  confirmationToken: string;
  /** Source, target, and the turn counts that cross and are dropped (FR-17). */
  headerLines: string[];
  /** For example "Budget: 34k tokens of a 200k window" (FR-18). */
  budgetLine: string;
  /** Repository warnings first (FR-19). */
  warnings: PreviewWarning[];
  /** For example "12 older turns dropped" (FR-35). */
  dropLines: string[];
  /** True when the import cannot run. Nothing may be written (FR-33). */
  blocked: boolean;
  /** Set when blocked is true. States what to change. */
  blockedReason: string | null;
  /** The whole preview, rendered. The same shape for all nine directions (FR-21). */
  lines: string[];
}

/** Preview content before the pipeline binds it to a confirmation token. */
export type PreviewContent = Omit<PreviewReport, "confirmationToken">;

/** Builds the preview from a plan and the current repository state. */
export interface PreviewBuilder {
  /** `summary` is the shared restore header, already rendered by the pipeline. */
  build(plan: TransferPlan, summary: readonly string[]): Promise<PreviewContent>;
}
