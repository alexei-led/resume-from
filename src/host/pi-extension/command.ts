import type {
  HandoverInstruction,
  HomeFailure,
  ImportPipeline,
  ImportRequest,
  LandingResult,
  ListRequest,
  PiCommandContext,
  PiResumeFromCommand,
  SelectionInput,
  SessionPicker,
  TargetProfile,
} from "./contract.js";
import { safeText } from "./presentation.js";
import type { PiUi } from "./ui.js";

/** The name Pi shows for the command (FR-7). */
export const RESUME_FROM_COMMAND_NAME = "resume-from";

const CONFIRM_QUESTION = "Import this session? (y/N)";
const CANCELLED_LINE = "Cancelled. Nothing was imported.";
const HELP_ARGUMENTS = new Set(["help", "-h", "--help"]);
const HELP_LINES = [
  `Usage: /${RESUME_FROM_COMMAND_NAME} [<session-id> | <file-path>]`,
  "No argument opens the session selector.",
  "<session-id> previews the matching session.",
  "<file-path> previews an absolute or relative session file.",
  "Pi asks for confirmation before importing anything.",
];
const USAGE_LINE = HELP_LINES[0] ?? `Usage: /${RESUME_FROM_COMMAND_NAME}`;
const BLOCKED_FALLBACK = "The import is blocked.";

export interface ResumeFromDeps {
  /** The picker opened when no argument names a session (FR-9). */
  picker: SessionPicker;
  /** How lines reach the user and how a confirmation is taken. */
  ui: PiUi;
  /**
   * The context window of the Pi the user is in, in tokens. Required, not
   * defaulted: this module holds no capability knowledge, so the size comes
   * from the composition root that builds the command.
   */
  windowTokens: number;
}

/** Builds the /resume-from command. `run` is the only path to the switch (C-10). */
export function createResumeFromCommand(deps: ResumeFromDeps): PiResumeFromCommand {
  return {
    run: (ctx, args, pipeline) => runResumeFrom(deps, ctx, args, pipeline),
  };
}

async function runResumeFrom(
  deps: ResumeFromDeps,
  ctx: PiCommandContext,
  args: string[],
  pipeline: ImportPipeline,
): Promise<void> {
  const scope: ListRequest = {
    destinationCwd: ctx.cwd,
    target: targetOf(deps, ctx),
    onlyAgent: null,
    onlyHome: null,
  };

  const selection = await resolveSelection(deps, args, pipeline, scope);
  if (selection === null) return;

  const request: ImportRequest = { ...scope, selection };
  const report = await withDiagnostic(deps.ui, "preview", () => pipeline.preview(request));
  if (report === null) return;
  deps.ui.show(report.lines); // Verbatim and unreordered (FR-21).

  if (report.blocked) {
    deps.ui.show([report.blockedReason ?? BLOCKED_FALLBACK]);
    return; // A blocked preview is never offered for confirmation (FR-33).
  }

  if ((await deps.ui.confirm(CONFIRM_QUESTION)) !== "selected") {
    deps.ui.show([CANCELLED_LINE]);
    return; // Nothing is written before the user confirms (FR-16, FR-20).
  }

  // Pi's own context is the runtime handle the Pi adapter switches with (FR-44).
  const landing = await withDiagnostic(deps.ui, "import", () =>
    pipeline.commit(request, ctx, report.confirmationToken),
  );
  if (landing !== null && !landing.switched) present(deps.ui, landing);
}

/** Catch only pipeline failures, not UI errors or presentation after a successful switch. */
async function withDiagnostic<T>(
  ui: PiUi,
  stage: string,
  operation: () => Promise<T>,
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    // Pipeline errors may wrap an abort; preserve cancellation rather than relabel it.
    const seen = new Set<Error>();
    for (
      let cause: unknown = error;
      cause instanceof Error && !seen.has(cause);
      cause = cause.cause
    ) {
      if (cause.name === "AbortError") throw error;
      seen.add(cause);
    }
    const message = error instanceof Error ? error.message : String(error);
    ui.show([`The ${stage} failed: ${safeText(message)}`]);
    return null;
  }
}

/** The import target is always the Pi home the user is in (FR-1, FR-2). */
function targetOf(deps: ResumeFromDeps, ctx: PiCommandContext): TargetProfile {
  return { agent: "pi", home: ctx.home, windowTokens: deps.windowTokens };
}

/** The selection, or null when the user cancelled or there was nothing to pick. */
async function resolveSelection(
  deps: ResumeFromDeps,
  args: string[],
  pipeline: ImportPipeline,
  scope: ListRequest,
): Promise<SelectionInput | null> {
  const given = args.filter((argument) => argument.trim().length > 0);
  if (given.length === 1 && HELP_ARGUMENTS.has(given[0] ?? "")) {
    deps.ui.show(HELP_LINES);
    return null;
  }
  if (given.length > 1) {
    deps.ui.show([USAGE_LINE]);
    return null;
  }
  const [only] = given;
  if (only !== undefined) return parseArgument(only); // An argument skips the picker (FR-12).

  const listing = await withDiagnostic(deps.ui, "listing", () => pipeline.list(scope));
  if (listing === null) return null;
  if (listing.failures.length > 0) {
    deps.ui.show(listing.failures.map(formatFailure)); // Home and session failures are never silent.
  }
  if (listing.excluded > 0) {
    // Non-membership is the normal product of searching a whole home (FR-13): the count is
    // shown, the sessions are not narrated row by row.
    const count = listing.excluded;
    deps.ui.show([
      `${count} ${count === 1 ? "session" : "sessions"} ${count === 1 ? "does" : "do"} not belong to this repository and ${count === 1 ? "was" : "were"} not listed.`,
    ]);
  }
  if (listing.rows.length === 0) {
    deps.ui.show([`No sessions to import for ${scope.destinationCwd}.`]);
    return null; // A picker over nothing is a trap.
  }

  const picked = await deps.picker.pick(listing);
  if (picked.choice !== "selected" || picked.selected === null) {
    deps.ui.show([CANCELLED_LINE]);
    return null;
  }
  // The file path, not the session ID: an ID is unique only inside one home and
  // a SelectionInput carries no home.
  return { by: "file-path", path: picked.selected.filePath };
}

/** A session ID or a file path (FR-12). Resolving the path is the pipeline's job. */
function parseArgument(argument: string): SelectionInput {
  return argument.includes("/") || argument.includes("\\")
    ? { by: "file-path", path: argument }
    : { by: "session-id", id: argument };
}

function formatFailure(failure: HomeFailure): string {
  return `${failure.agent} ${failure.home}: ${failure.message}`;
}

/**
 * Shows the marker and handover when the switch did not happen (FR-45, FR-47).
 * A successful switch invalidates the command context; the package shim renders
 * the persisted provenance marker as a transcript entry in the replacement session instead.
 */
function present(ui: PiUi, landing: LandingResult): void {
  ui.show(landing.marker.lines);
  if (landing.handover !== null) ui.show(formatHandover(landing.handover));
}

function formatHandover(handover: HandoverInstruction): string[] {
  return [`The session is ready: ${handover.sessionId}`, `Open it with: ${handover.command}`];
}
