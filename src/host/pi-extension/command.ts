import type {
  HandoverInstruction,
  HomeFailure,
  ImportPipeline,
  ImportRequest,
  LandingResult,
  ListRequest,
  PiCommandContext,
  PiResumeFromCommand,
  Place,
  SelectionInput,
  SessionDescriptor,
  SessionPicker,
  TargetProfile,
} from "./contract.js";
import { safeText } from "./presentation.js";
import type { PiUi } from "./ui.js";

/** The name Pi shows for the command (FR-7). */
export const RESUME_FROM_COMMAND_NAME = "resume-from";

const CONFIRM_QUESTION = "Import this session? (y/N)";
/** A recovery recreates a directory, not the conversation; say which. */
const RECREATE_QUESTION = "Recreate the missing directory? (y/N)";
const CANCELLED_LINE = "Cancelled. Nothing was imported.";
const HELP_ARGUMENTS = new Set(["help", "-h", "--help"]);
const HELP_LINES = [
  `Usage: /${RESUME_FROM_COMMAND_NAME} [<id-or-prefix> | <file-path>]`,
  "No argument opens the session selector.",
  "<id-or-prefix> restores the matching session from anywhere.",
  "<file-path> restores an absolute or relative session file.",
  "A Pi session switches in place from any directory; anything else asks before writing.",
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

  const given = args.filter((argument) => argument.trim().length > 0);
  if (given.length === 1 && HELP_ARGUMENTS.has(given[0] ?? "")) {
    deps.ui.show(HELP_LINES);
    return;
  }
  if (given.length > 1) {
    deps.ui.show([USAGE_LINE]);
    return;
  }
  if (given.length === 1 && given[0] !== undefined) {
    // An explicit selector restores it in place, natively when it is already a Pi session.
    await restore(deps, ctx, parseArgument(given[0]), pipeline);
    return;
  }

  const selection = await chooseSession(deps, pipeline, scope);
  if (selection === null) return;
  await importSelection(deps, ctx, pipeline, scope, selection);
}

/** Restores an explicitly named session: recovery gate, then native switch or import (FR-61). */
async function restore(
  deps: ResumeFromDeps,
  ctx: PiCommandContext,
  selection: SelectionInput,
  pipeline: ImportPipeline,
): Promise<void> {
  const descriptor = await withDiagnostic(deps.ui, () =>
    pipeline.locate({ selection, cwd: ctx.cwd, onlyAgent: null, onlyHome: null }),
  );
  if (descriptor === null) return;

  let place = await withDiagnostic(deps.ui, () => pipeline.place(descriptor));
  if (place === null) return;

  if (place.state === "unrecoverable") {
    deps.ui.show([
      ...summaryLines(pipeline, descriptor, place),
      `The directory cannot be recovered: ${place.reason ?? "no repository was found"}`,
    ]);
    return;
  }

  if (place.state === "recoverable") {
    const token = pipeline.recoveryToken(descriptor, place);
    if (token === null) {
      deps.ui.show(["The recovery plan could not be bound to a confirmation token."]);
      return;
    }
    deps.ui.show([...summaryLines(pipeline, descriptor, place), ...recoveryLines(place)]);
    if ((await deps.ui.confirm(RECREATE_QUESTION)) !== "selected") {
      deps.ui.show([CANCELLED_LINE]);
      return;
    }
    const result = await withDiagnostic(deps.ui, () =>
      pipeline.recover(descriptor, place as Place, token),
    );
    if (result === null) return;
    if (!result.ok) {
      deps.ui.show([result.message ?? "The recovery failed."]);
      return;
    }
    const rechecked = await withDiagnostic(deps.ui, () => pipeline.place(descriptor));
    if (rechecked === null) return;
    place = rechecked;
    if (place.state !== "present") {
      deps.ui.show([`The recovery reported success, but ${place.directory} is not usable.`]);
      return;
    }
  }

  const target = targetOf(deps, ctx);
  if (descriptor.ref.agent === target.agent) {
    // Native: the original file, switched in process. Pi rebuilds its runtime for the
    // session's own directory, so the user lands there (FR-61).
    const outcome = await withDiagnostic(deps.ui, () => pipeline.switchTo(descriptor, ctx));
    // A failed or declined switch still leaves the user a way in.
    if (outcome?.switched === true) return;
    showResume(deps.ui, pipeline, descriptor, place);
    return;
  }

  await importLocated(deps, ctx, pipeline, descriptor, selection);
}

/** Imports a located descriptor into its recorded directory, then switches there (FR-44). */
async function importLocated(
  deps: ResumeFromDeps,
  ctx: PiCommandContext,
  pipeline: ImportPipeline,
  descriptor: SessionDescriptor,
  selection: SelectionInput,
): Promise<void> {
  const destination = await withDiagnostic(deps.ui, () =>
    pipeline.destinationFor(descriptor, null),
  );
  if (destination === null) return;

  await commitAfterPreview(
    deps,
    pipeline,
    {
      destinationCwd: destination.directory,
      target: targetOf(deps, ctx),
      selection,
      located: descriptor,
      onlyAgent: null,
      onlyHome: null,
    },
    // Pi's own context is the runtime handle the Pi adapter switches with (FR-44).
    ctx,
    destination.warning,
  );
}

/** The existing no-argument flow: list, pick, preview and import into this directory. */
async function importSelection(
  deps: ResumeFromDeps,
  ctx: PiCommandContext,
  pipeline: ImportPipeline,
  scope: ListRequest,
  selection: SelectionInput,
): Promise<void> {
  await commitAfterPreview(
    deps,
    pipeline,
    {
      destinationCwd: scope.destinationCwd,
      target: targetOf(deps, ctx),
      selection,
      onlyAgent: scope.onlyAgent,
      onlyHome: scope.onlyHome,
    },
    // Pi's own context is the runtime handle the Pi adapter switches with (FR-44).
    ctx,
    null,
  );
}

/** One preview, blocking check, confirmation and commit for every Pi import (FR-16, FR-33). */
async function commitAfterPreview(
  deps: ResumeFromDeps,
  pipeline: ImportPipeline,
  request: ImportRequest,
  runtime: PiCommandContext | null,
  warning: string | null,
): Promise<void> {
  const report = await withDiagnostic(deps.ui, () => pipeline.preview(request));
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
  if (warning !== null) deps.ui.show([`⚠ ${warning}`]);

  const landing = await withDiagnostic(deps.ui, () =>
    pipeline.commit(request, runtime, report.confirmationToken),
  );
  if (landing !== null && !landing.switched) present(deps.ui, landing);
}

/** The restore summary and its warnings, above a command or a question (FR-61). */
function summaryLines(
  pipeline: ImportPipeline,
  descriptor: SessionDescriptor,
  place: Place,
): string[] {
  return [
    ...pipeline.summary(descriptor, place).map(safeText),
    ...place.warnings.map((warning) => `⚠ ${safeText(warning)}`),
  ];
}

function recoveryLines(place: Place): string[] {
  return (place.recovery?.commands ?? []).map((command) => `Recover: ${safeText(command.display)}`);
}

function showResume(
  ui: PiUi,
  pipeline: ImportPipeline,
  descriptor: SessionDescriptor,
  place: Place,
): void {
  ui.show([
    ...summaryLines(pipeline, descriptor, place),
    `Resume: ${safeText(pipeline.resumeCommand(descriptor, place.directory, null))}`,
  ]);
}

/** Catch only pipeline failures, not UI errors or presentation after a successful switch. */
async function withDiagnostic<T>(ui: PiUi, operation: () => Promise<T>): Promise<T | null> {
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
    // The pipeline's own message already says what failed and what the user can do; an
    // internal stage name would only add jargon.
    const message = error instanceof Error ? error.message : String(error);
    ui.show([safeText(message)]);
    return null;
  }
}

/** The import target is always the Pi home the user is in (FR-1, FR-2). */
function targetOf(deps: ResumeFromDeps, ctx: PiCommandContext): TargetProfile {
  return { agent: "pi", home: ctx.home, windowTokens: deps.windowTokens };
}

/** The selection, or null when the user cancelled or there was nothing to pick. */
async function chooseSession(
  deps: ResumeFromDeps,
  pipeline: ImportPipeline,
  scope: ListRequest,
): Promise<SelectionInput | null> {
  const listing = await withDiagnostic(deps.ui, () => pipeline.list(scope));
  if (listing === null) return null;
  if (listing.failures.length > 0) {
    deps.ui.show(listing.failures.map(formatFailure)); // Home and session failures are never silent.
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
  ui.show(landing.marker.lines.map(safeText));
  if (landing.handover !== null) ui.show(formatHandover(landing.handover));
}

function formatHandover(handover: HandoverInstruction): string[] {
  return [`Resume: ${safeText(handover.command)}`];
}
