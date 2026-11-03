import type {
  AgentAdapter,
  AgentRuntime,
  CanonicalSession,
  CommitError,
  CommitRefusal,
  FileCommitter,
  HandoverInstruction,
  HomePath,
  LandingResult,
  LandingStage,
  SerializationContext,
  SerializedSession,
  SessionLander,
  SessionRef,
  StoredSessionFacts,
  SwitchOutcome,
  TransferPlan,
  ValidationDefect,
} from "./contract.js";
import { LandingFailure } from "./errors.js";
import { buildMarker } from "./marker.js";

/** The one landing level that moves the user in (FR-43, FR-44). */
const SWITCH_LEVEL = "create-and-switch";

const RETRY = "Fix the cause, then run the import again.";

const COMMIT_NEXT_STEP: Record<CommitRefusal, string> = {
  "path-exists":
    "Nothing was created and nothing existing was touched. Remove or rename that path, then run the import again.",
  "not-writable":
    "Nothing was created. Give the target home write permission, then run the import again.",
  "write-failed":
    "Nothing was created. Check the free space and the permissions of the target home, then run the import again.",
};

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * A rejection is only treated as a CommitError when its refusal is one this
 * module knows a next step for. Anything else gets the generic next step
 * instead of an interpolated "undefined" (FR-56).
 */
function asCommitError(cause: unknown): CommitError | null {
  if (typeof cause !== "object" || cause === null || !("refusal" in cause)) return null;
  const { refusal } = cause as { refusal: unknown };
  return typeof refusal === "string" && Object.hasOwn(COMMIT_NEXT_STEP, refusal)
    ? (cause as CommitError)
    : null;
}

function commitNextStep(refused: CommitError | null): string {
  if (refused === null) return `Nothing was created. ${RETRY}`;
  if (refused.remainingPaths !== undefined && refused.remainingPaths.length > 0) {
    return `Cleanup was incomplete. Inspect these paths, then run the import again: ${refused.remainingPaths.join(", ")}.`;
  }
  return COMMIT_NEXT_STEP[refused.refusal];
}

function failAfterCommit(
  createdPaths: string[],
  stage: LandingStage,
  what: string,
  home: HomePath,
): LandingFailure {
  const preserved =
    createdPaths.length === 0
      ? `No paths were created in ${home}.`
      : `The committed paths were preserved because automatic removal could delete replacements. Inspect them before retrying: ${createdPaths.join(", ")}.`;
  return new LandingFailure(stage, `${what} ${preserved} ${RETRY}`);
}

async function runLanding(
  plan: TransferPlan,
  adapter: AgentAdapter,
  committer: FileCommitter,
  runtime: AgentRuntime,
  importedAt: string,
  context: SerializationContext,
  prompt: string | null = null,
): Promise<LandingResult> {
  const home = plan.target.home;
  const target = plan.target.agent;

  // Second gate: the preview should already have stopped this plan (FR-33).
  if (plan.blockedReason !== null) {
    throw new LandingFailure(
      "serialize",
      // blockedReason ends in a sentence and carries the cause-specific advice (FR-33, FR-56).
      `The plan cannot be imported: ${plan.blockedReason} Nothing was written to ${home}. ${RETRY}`,
    );
  }

  const capabilities = adapter.capabilities();
  const marker = buildMarker(plan, importedAt);
  const session: CanonicalSession = {
    provenance: plan.provenance,
    turns: plan.turns,
  };

  let serialized: SerializedSession;
  try {
    serialized = adapter.serialize(session, plan.target, marker, context);
  } catch (cause) {
    throw new LandingFailure(
      "serialize",
      `The ${target} adapter could not turn the plan into its own session format: ${reasonOf(cause)}. Nothing was written to ${home}. ${RETRY}`,
    );
  }
  if (serialized.files.length !== 1) {
    throw new LandingFailure(
      "serialize",
      `The ${target} adapter produced ${serialized.files.length} files for one session. Exactly one file is required for atomic placement, so nothing was written to ${home}. Report this as an adapter bug.`,
    );
  }

  let defects: ValidationDefect[];
  try {
    defects = adapter.validate(serialized);
  } catch (cause) {
    throw new LandingFailure(
      "validate",
      `The ${target} adapter could not check the new session: ${reasonOf(cause)}. Nothing was written to ${home}. ${RETRY}`,
    );
  }
  if (defects.length > 0) {
    const summary = defects.map((defect) => `${defect.path}: ${defect.message}`).join("; ");
    throw new LandingFailure(
      "validate",
      `The new session is not valid for ${target}, so it was not placed: ${summary}. Nothing was written to ${home}. Report this as a bug, then run the import again once the adapter is fixed.`,
      { defects },
    );
  }

  let createdPaths: string[];
  try {
    ({ createdPaths } = await committer.commit(home, serialized.files));
  } catch (cause) {
    const refused = asCommitError(cause);
    const where = refused?.path ? ` (path: ${refused.path})` : "";
    const next = commitNextStep(refused);
    throw new LandingFailure(
      "commit",
      `Creating the new session in ${home} failed: ${reasonOf(cause)}${where} ${next}`,
    );
  }

  let stored: StoredSessionFacts;
  try {
    stored = await adapter.readBack(home, serialized.sessionId);
  } catch (cause) {
    throw failAfterCommit(
      createdPaths,
      "read-back",
      `The new session in ${home} could not be read back: ${reasonOf(cause)}.`,
      home,
    );
  }
  if (stored.sessionId !== serialized.sessionId) {
    throw failAfterCommit(
      createdPaths,
      "read-back",
      `${target} read back session ${stored.sessionId} instead of the new session ${serialized.sessionId}.`,
      home,
    );
  }
  if (stored.itemCount !== serialized.itemCount) {
    throw failAfterCommit(
      createdPaths,
      "read-back",
      `${target} stored ${stored.itemCount} of the ${serialized.itemCount} items that were sent, so the session is incomplete.`,
      home,
    );
  }
  if (!stored.openable) {
    throw failAfterCommit(
      createdPaths,
      "read-back",
      `${target} could not open the new session ${serialized.sessionId}.`,
      home,
    );
  }

  const ref: SessionRef = { agent: target, home, id: serialized.sessionId };
  const landed = {
    ref,
    itemsSent: serialized.itemCount,
    itemsStored: stored.itemCount,
    marker,
  };
  const filePath = serialized.files[0]?.absolutePath ?? "";
  // The adapter owns its own resume command, so the landing prints a runnable one (FR-45).
  const handover = (): HandoverInstruction => ({
    sessionId: serialized.sessionId,
    command: adapter.resumeCommand({
      home,
      directory: context.cwd,
      sessionId: serialized.sessionId,
      filePath,
      prompt,
    }),
  });

  // A null runtime means the host cannot move the user: create only, even for Pi, so an
  // import into another directory is not switched behind the user's back (FR-44, FR-61).
  if (capabilities.landing !== SWITCH_LEVEL || runtime === null) {
    return { ...landed, switched: false, handover: handover() };
  }

  let outcome: SwitchOutcome;
  try {
    outcome = await adapter.switchTo(home, serialized.sessionId, runtime);
  } catch (cause) {
    // The session is valid, so it is kept: destroying it would destroy work.
    throw new LandingFailure(
      "switch",
      `The new session was created and is valid, but moving you into it failed: ${reasonOf(cause)}. The session was kept. Open it yourself: ${handover().command}`,
    );
  }

  // A declined move is not a failure: the session stays and the user opens it later.
  return outcome.switched
    ? { ...landed, switched: true, handover: null }
    : { ...landed, switched: false, handover: handover() };
}

export function createSessionLander(): SessionLander {
  return {
    land: (plan, adapter, committer, runtime, importedAt, context, prompt) =>
      runLanding(plan, adapter, committer, runtime, importedAt, context, prompt),
  };
}
