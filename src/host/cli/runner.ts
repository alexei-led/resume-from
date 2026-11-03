// One invocation of the command binary: parse, call the pipeline, print.
// Every decision this file appears to make is a decision the pipeline made (FR-60).
//
// Two flows share this file. A row without --to keeps the numbered-list flow (preview,
// then confirm). An ID, prefix, path, or any invocation with --to restores a located
// session: place it, gate any recovery on its token, then resume natively or import.

import { CONFIRM_FLAG, isConfirmFlag, parseArgs, USAGE } from "./args.js";
import type {
  AgentId,
  CliInvocation,
  CliOutcome,
  CliRunner,
  ImportPipeline,
  ImportRequest,
  ListRequest,
  Place,
  PreviewReport,
  SessionDescriptor,
  TargetProfile,
} from "./contract.js";
import { safeLines, safeText } from "./presentation.js";
import {
  renderContext,
  renderLanding,
  renderListing,
  renderNative,
  renderPreview,
  renderRecovery,
  renderWarnings,
} from "./render.js";

/**
 * The shim may state the target home; it never states the window size.
 * These stand for "not stated": the pipeline was built for this target and
 * applies the adapter default (FR-3).
 */
const HOME_NOT_STATED = "";
const WINDOW_NOT_STATED = 0;

/**
 * @param target the profile the pipeline was built for, or null in a bare shell.
 * The shim-stated home wins, but only through the profile builder, which resolves "~/x" and
 * relative paths to absolute form (FR-3, T-CLI-18).
 */
export function createCliRunner(target: TargetProfile | null = null): CliRunner {
  return {
    run: (invocation, pipeline) => run(invocation, pipeline, target),
  };
}

async function run(
  invocation: CliInvocation,
  pipeline: ImportPipeline,
  fallback: TargetProfile | null,
): Promise<CliOutcome> {
  const parsed = parseArgs(invocation.argv, invocation.cwd);
  if (!parsed.ok) {
    return { stdout: [], stderr: [parsed.problem, USAGE], exitCode: 2 };
  }

  const { selection, onlyAgent, onlyHome, confirmationToken, to, prompt, context } = parsed.args;
  const target: TargetProfile | null =
    invocation.targetAgent === null
      ? null
      : {
          // The shim states the agent. The binary never guesses it.
          agent: invocation.targetAgent,
          home: fallback?.home ?? invocation.targetHome ?? HOME_NOT_STATED,
          windowTokens: fallback?.windowTokens ?? WINDOW_NOT_STATED,
        };

  if (target === null && to !== null) {
    return failure(
      "--to needs the agent to import into, and a bare shell has none.",
      "Run this from the agent's slash command, or pass --target-agent.",
    );
  }

  if (selection === null) {
    const request: ListRequest = {
      destinationCwd: invocation.cwd,
      target,
      onlyAgent,
      onlyHome,
    };
    try {
      const listing = await pipeline.list(request);
      return { stdout: renderListing(listing, invocation.cwd), stderr: [], exitCode: 0 };
    } catch (error) {
      return failure(
        `The listing failed: ${messageOf(error)}`,
        "Fix that, then run /resume-from again.",
      );
    }
  }

  // A row of the numbered list keeps the preview → confirm flow; --to opts into the
  // located flow so the destination can change without re-listing (FR-61).
  if (selection.by === "row" && to === null && target !== null && !context) {
    return await importFlow(
      invocation,
      pipeline,
      {
        destinationCwd: invocation.cwd,
        target,
        selection,
        prompt,
        onlyAgent,
        onlyHome,
      },
      { suppliedToken: confirmationToken },
    );
  }

  return await restoreFlow(invocation, pipeline, target, {
    selection,
    to,
    prompt,
    context,
    onlyAgent,
    onlyHome,
    confirmationToken,
  });
}

interface LocatedRequest {
  selection: ImportRequest["selection"];
  to: string | null;
  prompt: string | null;
  context: boolean;
  onlyAgent: AgentId | null;
  onlyHome: string | null;
  confirmationToken: string | null;
}

async function restoreFlow(
  invocation: CliInvocation,
  pipeline: ImportPipeline,
  target: TargetProfile | null,
  request: LocatedRequest,
): Promise<CliOutcome> {
  let descriptor: SessionDescriptor;
  try {
    descriptor = await pipeline.locate({
      selection: request.selection,
      cwd: invocation.cwd,
      onlyAgent: request.onlyAgent,
      onlyHome: request.onlyHome,
    });
  } catch (error) {
    // The lookup error already names the roots it searched; a second line would bury it.
    return failure(messageOf(error));
  }

  let place: Place;
  try {
    place = await pipeline.place(descriptor);
  } catch (error) {
    return failure(`The session's directory could not be resolved: ${messageOf(error)}`);
  }

  // --context is read-only: it never recovers and never confirms (FR-61).
  if (request.context) {
    if (target === null) {
      return failure(
        "--context needs the agent it is running inside.",
        "Run --context from the agent's slash command or prompt, or pass --target-agent.",
      );
    }
    try {
      const turns = await pipeline.context(descriptor, target);
      return {
        stdout: renderContext(pipeline.summary(descriptor, place), place, turns),
        stderr: [],
        exitCode: 0,
      };
    } catch (error) {
      return failure(`The conversation could not be read: ${messageOf(error)}`);
    }
  }

  // A directory that cannot be recovered blocks a restore, unless --to names another
  // checkout: importing there is allowed, with the warning destinationFor adds (FR-61).
  if (place.state === "unrecoverable" && request.to === null) {
    return {
      stdout: [
        ...pipeline.summary(descriptor, place).map(safeText),
        ...renderWarnings(place.warnings),
        ...(place.reason === null ? [] : [`⚠ ${safeText(place.reason)}`]),
      ],
      stderr: [`The directory of session ${descriptor.ref.id} cannot be recovered.`],
      exitCode: 1,
    };
  }

  let recovered = false;
  if (place.state === "recoverable") {
    const token = pipeline.recoveryToken(descriptor, place);
    if (token === null) {
      return failure("The recovery plan could not be bound to a confirmation token.");
    }
    if (request.confirmationToken === null) {
      return {
        stdout: renderRecovery(
          pipeline.summary(descriptor, place),
          place,
          renderCommand(invocation, [...withoutConfirmation(invocation.argv), CONFIRM_FLAG, token]),
        ),
        stderr: [],
        exitCode: 0,
      };
    }
    const result = await pipeline.recover(descriptor, place, request.confirmationToken);
    if (!result.ok) {
      return {
        stdout: [],
        stderr: [
          `The recovery did not run: ${safeText(result.message ?? "the recovery failed")}`,
          ...(result.stderr.trim() === "" ? [] : [result.stderr.trim()]),
        ],
        exitCode: 2,
      };
    }
    recovered = true;
    try {
      place = await pipeline.place(descriptor);
    } catch (error) {
      return failure(`The directory was recreated but could not be read back: ${messageOf(error)}`);
    }
    if (place.state !== "present") {
      return failure(
        `The recovery reported success, but ${place.directory} is still not usable.`,
        "Inspect the directory and run the command again.",
      );
    }
  }

  // Same agent, no --to override: the agent's own resume command, and nothing written.
  const native = target === null || (request.to === null && descriptor.ref.agent === target.agent);
  if (native) {
    try {
      const command = pipeline.resumeCommand(descriptor, place.directory, request.prompt);
      return {
        stdout: renderNative(pipeline.summary(descriptor, place), place, command),
        stderr: [],
        exitCode: 0,
      };
    } catch (error) {
      return failure(`The resume command could not be rendered: ${messageOf(error)}`);
    }
  }

  let destination: { directory: string; warning: string | null };
  try {
    destination = await pipeline.destinationFor(descriptor, request.to);
  } catch (error) {
    return failure(messageOf(error), "Name an existing checkout of the same repository.");
  }

  const importRequest: ImportRequest = {
    destinationCwd: destination.directory,
    target: target as TargetProfile,
    selection: request.selection,
    located: descriptor,
    prompt: request.prompt,
    onlyAgent: request.onlyAgent,
    onlyHome: request.onlyHome,
  };
  const destinationLines =
    destination.warning === null ? [] : renderWarnings([destination.warning]);
  // A token used for this invocation's recovery does not confirm the import preview that
  // follows it, so the preview and its own Confirm line are shown (FR-61).
  return await importFlow(invocation, pipeline, importRequest, {
    suppliedToken: recovered ? null : request.confirmationToken,
    prefix: destinationLines,
  });
}

interface ImportOptions {
  suppliedToken?: string | null;
  prefix?: string[];
}

async function importFlow(
  invocation: CliInvocation,
  pipeline: ImportPipeline,
  request: ImportRequest,
  options: ImportOptions = {},
): Promise<CliOutcome> {
  const suppliedToken = options.suppliedToken ?? null;
  const prefix = options.prefix ?? [];

  // Confirming still previews first: a blocked import must not be committed (FR-33).
  let report: PreviewReport;
  try {
    report = await pipeline.preview(request);
  } catch (error) {
    return failure(
      `Could not open the preview: ${messageOf(error)}`,
      `Run ${renderCommand(invocation, [])} to see the numbered list again.`,
    );
  }

  if (report.blocked) {
    return {
      stdout: [...prefix, ...safeLines(report.lines)],
      stderr: [
        `The import cannot run: ${safeText(report.blockedReason ?? "the preview did not say why.")}`,
      ],
      exitCode: 1,
    };
  }

  if (suppliedToken === null) {
    return {
      stdout: [
        ...prefix,
        ...renderPreview(
          report.lines,
          renderCommand(invocation, [
            ...withoutConfirmation(invocation.argv),
            CONFIRM_FLAG,
            report.confirmationToken,
          ]),
        ),
      ],
      stderr: [],
      exitCode: 0,
    };
  }

  try {
    // Neither Codex nor Claude Code can move the user, so there is no runtime (C-2).
    const result = await pipeline.commit(request, null, suppliedToken);
    return { stdout: renderLanding(result), stderr: [], exitCode: 0 };
  } catch (error) {
    return failure(
      `The import failed: ${messageOf(error)}`,
      `Run ${renderCommand(invocation, withoutConfirmation(invocation.argv))} to see the preview again.`,
    );
  }
}

function failure(what: string, nextStep?: string): CliOutcome {
  return { stdout: [], stderr: nextStep === undefined ? [what] : [what, nextStep], exitCode: 2 };
}

function withoutConfirmation(argv: string[]): string[] {
  const index = argv.findIndex(isConfirmFlag);
  if (index < 0) return argv;
  // "--confirm <token>" consumes two slots; "--confirm=<token>" consumes one.
  const consumed = argv[index] === CONFIRM_FLAG ? 2 : 1;
  return [...argv.slice(0, index), ...argv.slice(index + consumed)];
}

function renderCommand(invocation: CliInvocation, argv: string[]): string {
  // A plugin re-run is the host's own command; a manual shell invocation must stay runnable
  // there, which means repeating the shim flags the person wrote (FR-66).
  if (invocation.plugin) return ["/resume-from", ...argv].map(quoteArgument).join(" ");
  const shim: string[] = [];
  if (invocation.targetAgent !== null) {
    shim.push("--target-agent", invocation.targetAgent);
    if (invocation.targetHome !== null) shim.push("--target-home", invocation.targetHome);
  }
  const separator = shim.length > 0 ? ["--"] : [];
  return ["resume-from", ...shim, ...separator, ...argv].map(quoteArgument).join(" ");
}

function quoteArgument(argument: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(argument)) return argument;
  return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

function messageOf(error: unknown): string {
  let text: string;
  if (typeof error === "string") text = error;
  else if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    text = typeof message === "string" ? message : String(error);
  } else {
    text = String(error);
  }
  // Sanitise each line on its own: a candidate list is multi-line on purpose, and collapsing
  // the line breaks would print every candidate as one unreadable run-on line.
  return text.split("\n").map(safeText).join("\n");
}
