// GENERATED from src/host/pi-extension/module.md — the Public Contract section is the normative home.
// Declarations only: no behaviour, no defaults. If this file and module.md disagree,
// the document wins and this file is corrected.

import type {
  PiSwitchContext,
  PiSwitchOptions,
  PiSwitchResult,
} from "../../adapters/pi/contract.js";

export type { PiSwitchContext, PiSwitchOptions, PiSwitchResult };

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

/** What the user did at the picker or the confirmation. */
export type UserChoice = "selected" | "cancelled";

/** The picker over the listing (FR-9). */
export interface SessionPicker {
  /** Resolves with the chosen row, or with "cancelled" when the user escaped. */
  pick(listing: Listing): Promise<PickResult>;
}

/** The result of one picker interaction. */
export interface PickResult {
  choice: UserChoice;
  /** Set when choice is "selected". */
  selected: SessionDescriptor | null;
}

/** Pi's command context, as this module needs it. */
export interface PiCommandContext extends PiSwitchContext {
  /** The directory Pi is running in. Used to find the repository (FR-13). */
  cwd: string;
  /** The Pi home the user is running, which is the import target (FR-1, FR-2). */
  home: HomePath;
}

/** The /resume-from command inside Pi (FR-7, FR-9, FR-44). */
export interface PiResumeFromCommand {
  /**
   * Pi calls this when the user types /resume-from.
   * It is a command handler, which is the only call site C-10 proved safe for switchSession.
   */
  run(ctx: PiCommandContext, args: string[], pipeline: ImportPipeline): Promise<void>;
}
