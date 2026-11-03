// The three operations every host drives, and the order of the four stages behind them.
// Nothing here knows an agent: the source adapter comes from the chosen session and the
// target adapter from the target profile (FR-6, FR-60).

import { resolve } from "node:path";
import type {
  Place,
  RecoveryResult,
  RecoverySteps,
  RepoIdentity,
  WorktreeRecovery,
} from "../platform/repo/contract.js";
import { confirmationToken, recoveryToken, tokenMatches } from "./confirmation.js";
import type {
  AgentAdapter,
  AgentRuntime,
  CanonicalSession,
  FileCommitter,
  ImportConfig,
  ImportDestination,
  ImportPipeline,
  ImportRequest,
  LandingError,
  LandingResult,
  Listing,
  ListRequest,
  LocateRequest,
  PreviewBuilder,
  PreviewContent,
  PreviewReport,
  SearchScope,
  SessionDescriptor,
  SessionFinder,
  SessionLander,
  SessionLocator,
  TargetProfile,
  TokenEstimator,
  TransferPlan,
  TransferRules,
} from "./contract.js";
import { canonicalPath, isDirectory } from "./discovery/index.js";
import { ImportFailure, reasonOf } from "./errors.js";
import { summaryLines } from "./landing/index.js";

/** The role a target adapter must declare to receive an import (FR-59). */
const TARGET_ROLE = "target";

const PREVIEW_AGAIN = "Preview it again, then confirm.";
const IMPORT_AGAIN = "Fix the cause, then run the import again.";

/** Fresh destination facts for one request; native spelling stays distinct from canonical identity. */
export interface DestinationContext {
  cwd: string;
  canonicalCwd: string;
  identity: RepoIdentity;
}

/** The four stages, and the services they are driven with. `wiring.ts` builds them. */
export interface PipelineStages {
  /** Observe the repository reader's cancellation even when no Git lookup is needed. */
  checkCancellation(): void;
  finder: SessionFinder;
  /** Global lookup shared by the identifier flow (FR-61). */
  locator: SessionLocator;
  /** Plans and runs the one recovery this tool may perform (FR-61). */
  recovery: WorktreeRecovery;
  rules: TransferRules;
  /** Resolve fresh destination facts, without replacing the host's native cwd spelling. */
  destinationFor(cwd: string): Promise<DestinationContext>;
  /** A preview builder that reads the repository the request names. */
  previewFor(destination: DestinationContext, descriptor: SessionDescriptor): PreviewBuilder;
  lander: SessionLander;
  /** Every adapter the composition root constructed. This module only looks one up. */
  adapters: readonly AgentAdapter[];
  config: ImportConfig;
  estimator: TokenEstimator;
  committer: FileCommitter;
  /** ISO-8601 UTC. Only the landing reads it, so a preview and a commit agree (FR-47). */
  now(): string;
}

/** What one recompute of the preview produced. */
interface Computed {
  descriptor: SessionDescriptor;
  destination: DestinationContext;
  plan: TransferPlan;
  report: PreviewReport;
}

function scopeOf(request: ListRequest | ImportRequest): SearchScope {
  return {
    repoRoot: request.destinationCwd,
    onlyAgent: request.onlyAgent,
    onlyHome: request.onlyHome,
  };
}

/**
 * The adapter that receives the import. This lookup is the only place `AgentId` decides
 * anything in this module, and a lookup is not a branch on the pair (FR-59, FR-60).
 */
function targetAdapter(adapters: readonly AgentAdapter[], target: TargetProfile): AgentAdapter {
  const found = adapters.filter((adapter) => adapter.capabilities().agent === target.agent);
  if (found.length === 0) {
    throw new ImportFailure(
      "target",
      `There is no adapter for "${target.agent}", so an import cannot be sent to it. Run the import from an agent the tool supports, or add an adapter for "${target.agent}".`,
    );
  }
  const usable = found.find((adapter) => adapter.capabilities().roles.includes(TARGET_ROLE));
  if (!usable) {
    throw new ImportFailure(
      "target",
      `The "${target.agent}" adapter cannot receive an import: it declares the role(s) ${found[0]?.capabilities().roles.join(", ")} and not "${TARGET_ROLE}". Choose a target agent whose adapter has the "${TARGET_ROLE}" role.`,
    );
  }
  return usable;
}

/** A rejection carrying what the landing already explained (FR-50, FR-56). */
function isLandingError(cause: unknown): cause is LandingError & Error {
  return cause instanceof Error && "stage" in cause && "defects" in cause;
}

export function createPipelineFromStages(stages: PipelineStages): ImportPipeline {
  async function destinationFor(cwd: string): Promise<DestinationContext> {
    try {
      const destination = await stages.destinationFor(cwd);
      if (destination.identity.isBare) {
        throw new Error(
          "A bare repository cannot be an import destination. Run the import from a linked worktree instead.",
        );
      }
      return destination;
    } catch (cause) {
      throw new ImportFailure(
        "preview",
        `The destination ${cwd} could not be used: ${reasonOf(cause)} Nothing was written. Check the destination directory and preview again.`,
        { cause },
      );
    }
  }

  async function resolveSession(
    request: ImportRequest,
    destination: DestinationContext,
  ): Promise<SessionDescriptor> {
    // A located descriptor is already read: discovery must not list or parse a home again (FR-61).
    if (request.located !== undefined && request.located !== null) return request.located;
    try {
      return await stages.finder.resolve(scopeOf(request), request.selection, destination);
    } catch (cause) {
      throw new ImportFailure("discovery", `The session could not be chosen: ${reasonOf(cause)}`, {
        cause,
      });
    }
  }

  async function load(descriptor: SessionDescriptor): Promise<CanonicalSession> {
    try {
      return await stages.finder.load(descriptor);
    } catch (cause) {
      throw new ImportFailure(
        "discovery",
        `The source session ${descriptor.ref.id} could not be read: ${reasonOf(cause)}. Nothing was written. Check that ${descriptor.filePath} still exists and can be read, then run the import again.`,
        { cause },
      );
    }
  }

  /** The one adapter that reads this session's agent (FR-59, FR-60). */
  function sourceAdapter(agent: SessionDescriptor["ref"]["agent"]): AgentAdapter {
    const adapter = stages.adapters.find((candidate) => {
      const capabilities = candidate.capabilities();
      return capabilities.agent === agent && capabilities.roles.includes("source");
    });
    if (adapter === undefined) {
      throw new ImportFailure(
        "discovery",
        `There is no adapter that can read a "${agent}" session, so nothing was done.`,
      );
    }
    return adapter;
  }

  /** The token that binds one recovery plan, or null when there is nothing to recover. */
  function recoveryPlanToken(descriptor: SessionDescriptor, place: Place): string | null {
    return place.state === "recoverable" && place.recovery !== null
      ? recoveryToken(descriptor, place.recovery)
      : null;
  }

  /** One plain-text line per kept turn, the form `--context` prints (FR-61). */
  function turnLine(turn: CanonicalSession["turns"][number]): string {
    if (turn.kind === "tool-call" && turn.toolCall !== null) {
      const call = turn.toolCall;
      // Every adapter's outcome line already starts with `name(args) →` (FR-23); name it only
      // when one did not, exactly as the Claude Code writer does.
      const line = call.outcomeLine.includes(call.toolName)
        ? call.outcomeLine
        : `${call.toolName}(${call.argumentsText}) → ${call.outcomeLine}`;
      return `Tool: ${line}`;
    }
    if (turn.kind === "summary") return `Summary: ${turn.text}`;
    return turn.role === "user" ? `User: ${turn.text}` : `Agent: ${turn.text}`;
  }

  /** Throws the one error shape a host prints when a destination cannot be used. */
  function destinationFailure(message: string): ImportFailure {
    return new ImportFailure("discovery", message);
  }

  /**
   * Resolve, load, apply the rules, build the report. `commit` runs exactly this again
   * rather than taking a plan from the host: the numbered-list hosts of FR-10 are separate
   * processes, and a plan cannot travel between them.
   */
  async function compute(request: ImportRequest): Promise<Computed> {
    const destination = await destinationFor(request.destinationCwd);
    const descriptor = await resolveSession(request, destination);
    const session = await load(descriptor);

    let plan: TransferPlan;
    try {
      plan = stages.rules.apply(session, request.target, stages.config, stages.estimator);
    } catch (cause) {
      throw new ImportFailure(
        "plan",
        `What to carry over could not be decided for session ${descriptor.ref.id}: ${reasonOf(cause)}. Nothing was written. ${IMPORT_AGAIN}`,
        { cause },
      );
    }

    let report: PreviewContent;
    try {
      report = await stages.previewFor(destination, descriptor).build(plan);
      stages.checkCancellation();
    } catch (cause) {
      throw new ImportFailure(
        "preview",
        `The preview of session ${descriptor.ref.id} could not be built: ${reasonOf(cause)}. Nothing was written. ${IMPORT_AGAIN}`,
        { cause },
      );
    }

    const token = confirmationToken(descriptor, plan, report, {
      canonicalCwd: destination.canonicalCwd,
      commonDir: destination.identity.commonDir,
    });
    return {
      descriptor,
      destination,
      plan,
      report: { ...report, confirmationToken: token },
    };
  }

  return {
    async list(request: ListRequest): Promise<Listing> {
      try {
        const destination = await destinationFor(request.destinationCwd);
        return await stages.finder.list(scopeOf(request), destination);
      } catch (cause) {
        throw new ImportFailure(
          "discovery",
          `The sessions of this repository could not be listed: ${reasonOf(cause)}. Check that ${request.destinationCwd} is readable, then run the list again.`,
          { cause },
        );
      }
    },

    async preview(request: ImportRequest): Promise<PreviewReport> {
      // Refused here as well as in commit, so a host is told about an impossible
      // target before it shows the user a preview it could never confirm.
      targetAdapter(stages.adapters, request.target);
      // A blocked plan still produces a report: the user is told why it cannot run (FR-33).
      return (await compute(request)).report;
    },

    async commit(
      request: ImportRequest,
      runtime: AgentRuntime,
      suppliedToken: string,
    ): Promise<LandingResult> {
      const adapter = targetAdapter(stages.adapters, request.target);
      const { descriptor, destination, plan, report } = await compute(request);

      if (!tokenMatches(report.confirmationToken, suppliedToken)) {
        throw new ImportFailure(
          "confirmation",
          `The source session, destination, or preview changed after confirmation. Nothing was written to ${request.target.home}. ${PREVIEW_AGAIN}`,
        );
      }

      if (plan.blockedReason !== null) {
        // blockedReason already ends in a sentence and carries the cause-specific
        // advice (FR-33, FR-56); this adds only what the pipeline alone knows.
        throw new ImportFailure(
          "blocked",
          `The import cannot run: ${plan.blockedReason} Nothing was written to ${request.target.home}. ${PREVIEW_AGAIN}`,
        );
      }

      // The freshness check. The listing reports when the source file last moved; the plan
      // carries when the content it was built from was last recorded. A file that moved past
      // its own last turn is a session the user has not seen (FR-20, FR-56).
      if (descriptor.updatedAt !== plan.provenance.updatedAt) {
        throw new ImportFailure(
          "source-changed",
          `The source session ${descriptor.ref.id} changed after the preview: ${descriptor.filePath} was last written at ${descriptor.updatedAt}, and the conversation the preview showed ends at ${plan.provenance.updatedAt}. Nothing was written. ${PREVIEW_AGAIN}`,
        );
      }

      try {
        stages.checkCancellation();
        return await stages.lander.land(
          plan,
          adapter,
          stages.committer,
          runtime,
          stages.now(),
          destination,
          request.prompt ?? null,
        );
      } catch (cause) {
        // The landing states what failed and what to do next for every one of its stages;
        // anything else reaching here is a defect and gets the generic next step (FR-56).
        const known = isLandingError(cause);
        const message = known
          ? cause.message
          : `The import could not be placed in ${request.target.home}: ${reasonOf(cause)}. ${IMPORT_AGAIN}`;
        throw new ImportFailure("landing", message, {
          cause,
          defects: known ? cause.defects : [],
        });
      }
    },

    async locate(request: LocateRequest): Promise<SessionDescriptor> {
      const scope: SearchScope = {
        repoRoot: request.cwd,
        onlyAgent: request.onlyAgent,
        onlyHome: request.onlyHome,
      };
      if (request.selection.by === "row") {
        return await stages.finder.resolve(scope, request.selection);
      }

      // An ID or a path is global: the agent is decided by the root that holds the file (FR-61).
      const home = request.onlyHome === null ? null : await canonicalPath(request.onlyHome);
      const accept = async (descriptor: SessionDescriptor): Promise<boolean> => {
        if (request.onlyAgent !== null && descriptor.ref.agent !== request.onlyAgent) return false;
        return home === null || (await canonicalPath(descriptor.ref.home)) === home;
      };
      return request.selection.by === "session-id"
        ? await stages.locator.byId(request.selection.id, accept, home)
        : await stages.locator.byPath(request.selection.path, accept);
    },

    async place(descriptor: SessionDescriptor): Promise<Place> {
      stages.checkCancellation();
      const directory = descriptor.startDirectory ?? descriptor.repoPath;
      if (directory === null) {
        return {
          state: "unrecoverable",
          directory: "",
          branch: null,
          warnings: [],
          recovery: null,
          reason: "the session records no directory",
        };
      }
      // The branch and commit a recovery may use are recorded in the conversation, not the row.
      const session = await load(descriptor);
      const place = await stages.recovery.place({
        directory,
        branch: session.provenance.repo.branch,
        commit: session.provenance.repo.commit,
      });
      stages.checkCancellation();
      return place;
    },

    summary: summaryLines,

    recoveryToken(descriptor: SessionDescriptor, place: Place): string | null {
      return recoveryPlanToken(descriptor, place);
    },

    async recover(
      descriptor: SessionDescriptor,
      place: Place,
      token: string,
    ): Promise<RecoveryResult> {
      const expected = recoveryPlanToken(descriptor, place);
      if (expected === null) {
        return {
          ok: false,
          stderr: "",
          message: "this session's directory needs no recovery",
        };
      }
      if (!tokenMatches(expected, token)) {
        return {
          ok: false,
          stderr: "",
          message:
            "the confirmation token does not match this recovery, so nothing was run. Run the exact Confirm: command shown by the preview.",
        };
      }
      return await stages.recovery.recover(place.recovery as RecoverySteps);
    },

    async destinationFor(
      descriptor: SessionDescriptor,
      to: string | null,
      place: Place | null = null,
    ): Promise<ImportDestination> {
      const recorded = descriptor.startDirectory ?? descriptor.repoPath;
      if (to === null) {
        if (recorded === null) {
          throw destinationFailure(
            `The session ${descriptor.ref.id} records no directory, so there is nowhere to import it. Pass --to <dir> to name an existing checkout.`,
          );
        }
        return { directory: recorded, warning: null };
      }

      const directory = resolve(to);
      if (!(await isDirectory(directory))) {
        throw destinationFailure(
          `The --to directory ${directory} does not exist. Create it, or name an existing checkout.`,
        );
      }
      // Fresh identity, and the bare-repository refusal, through the same check as any import.
      const destination = await destinationFor(directory);
      if (recorded !== null && (await isDirectory(recorded))) {
        if (!(await stages.finder.belongs(descriptor, directory))) {
          throw destinationFailure(
            `The --to directory ${directory} belongs to a different repository than the session's recorded ${recorded}. Import into a checkout of the same repository.`,
          );
        }
        return { directory, warning: null };
      }
      // The session's own directory is gone: the override is the only anchor, so it must
      // be a real checkout rather than an arbitrary directory (FR-61).
      if (destination.identity.root === null) {
        throw destinationFailure(
          `The --to directory ${directory} is not a git checkout. Name an existing checkout of a repository.`,
        );
      }
      // A recoverable directory is not there yet, so its membership cannot be read from it.
      // The recovery plan names the repository the recreated directory will belong to; a
      // --to checkout of a different repository is refused before any worktree is written
      // (revised NG-9). The check runs on the plan, so it precedes the recovery.
      const anchor = place?.state === "recoverable" ? place.recovery?.commands[0]?.cwd : undefined;
      if (anchor !== undefined && anchor !== "") {
        const anchorCommon = (await stages.destinationFor(anchor)).identity.commonDir;
        if (anchorCommon === null || anchorCommon !== destination.identity.commonDir) {
          throw destinationFailure(
            `The --to directory ${directory} belongs to a different repository than the session's recorded ${recorded ?? anchor}. Import into a checkout of the same repository.`,
          );
        }
      }
      return {
        directory,
        warning:
          recorded === null
            ? null
            : `the session's recorded directory ${recorded} is missing; importing into ${directory} anyway`,
      };
    },

    resumeCommand(descriptor: SessionDescriptor, directory: string, prompt: string | null): string {
      return sourceAdapter(descriptor.ref.agent).resumeCommand({
        home: descriptor.ref.home,
        directory,
        sessionId: descriptor.ref.id,
        filePath: descriptor.filePath,
        prompt,
      });
    },

    async context(descriptor: SessionDescriptor, target: TargetProfile): Promise<string[]> {
      const session = await load(descriptor);
      const plan = stages.rules.apply(session, target, stages.config, stages.estimator);
      stages.checkCancellation();
      return plan.turns.map(turnLine);
    },

    async switchTo(
      descriptor: SessionDescriptor,
      runtime: AgentRuntime,
    ): Promise<{ switched: boolean; cancelled: boolean }> {
      return await sourceAdapter(descriptor.ref.agent).switchTo(
        descriptor.ref.home,
        descriptor.ref.id,
        runtime,
        descriptor.filePath,
      );
    },
  };
}
