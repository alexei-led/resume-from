// Requirement sections D and E, as executable rules. Pure: no clock, no filesystem,
// no network, no randomness — the preview and the commit of one request must agree.

import type {
  CanonicalSession,
  CanonicalTurn,
  ImportConfig,
  PinReason,
  SourceProvenance,
  TargetProfile,
  TokenEstimator,
  ToolCallRecord,
  TransferPlan,
  TransferRules,
  TurnDrop,
  TurnPin,
} from "./contract.js";

/** FR-25. The record ends with this, so the target model reads that the body is gone. */
const DROPPED_BODY_MARKER = "(content dropped: imported session, may be stale)";

/** FR-23. One line, in words, when the source recorded no outcome at all. */
const NO_OUTCOME_RECORDED = "(outcome not recorded by the source)";

/** FR-33. The one advice sentence every budget-driven block ends with. */
const BUDGET_ADVICE =
  "Raise budgetShare, lower pinnedRecentTurns, or choose a target with a larger window.";

/** Role/kind delimiters and message framing that target serializers add around every turn. */
const TURN_FRAMING_TOKENS = 4;

/** The order pins are reported in when one turn is pinned for more than one reason. */
const PIN_ORDER: readonly PinReason[] = [
  "first-request",
  "recent-turn",
  "summary",
  "changed-files",
];

/** FR-23: one line about the outcome. Line breaks and blank lines collapse to single spaces. */
function toSingleLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
}

function normalizeRecord(record: ToolCallRecord): ToolCallRecord {
  const outcome = toSingleLine(record.outcomeLine);
  const stated = outcome === "" ? NO_OUTCOME_RECORDED : outcome;
  return {
    toolName: record.toolName,
    argumentsText: record.argumentsText,
    // Append only when the adapter did not already embed it (Pi, Claude Code embed it;
    // Codex does not). toSingleLine runs first so trailing whitespace cannot defeat endsWith.
    outcomeLine:
      record.bodyDropped && !stated.endsWith(DROPPED_BODY_MARKER)
        ? `${stated} ${DROPPED_BODY_MARKER}`
        : stated,
    effect: record.effect,
    bodyDropped: record.bodyDropped,
    ...(record.resultRecorded !== undefined ? { resultRecorded: record.resultRecorded } : {}),
  };
}

/**
 * Rebuilt field by field, never copied by reference or spread: a field the canonical
 * vocabulary has no room for — hidden reasoning, a system prompt, an environment block,
 * telemetry, vendor state, a smuggled result body — must not survive into the plan (FR-28).
 */
function normalizeTurn(turn: CanonicalTurn): CanonicalTurn {
  return {
    index: turn.index,
    role: turn.role,
    kind: turn.kind,
    text: turn.text,
    toolCall: turn.toolCall ? normalizeRecord(turn.toolCall) : null,
    timestamp: turn.timestamp,
  };
}

/** FR-54: a tool call the source never recorded a result for. */
function isUnansweredCall(turn: CanonicalTurn | undefined): boolean {
  if (turn?.kind !== "tool-call") return false;
  // Check resultRecorded directly; outcomeLine is always non-empty (adapters fill it with a
  // fallback text), so an outcomeLine=="" check would be dead and never catch real broken tails.
  //
  // Use === false, not !resultRecorded: an absent flag (undefined) means "unknown, treat as
  // recorded" — construction sites outside this module may omit the field (e.g. test fixtures),
  // and we must not silently break tails that were never broken. Only an explicit false fires. (FR-54)
  return !turn.toolCall || turn.toolCall.resultRecorded === false;
}

/** Adapters understand their native tool schema; this layer only normalizes their path list. */
function dedupeChangedPaths(recorded: readonly string[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const path of recorded) {
    if (path !== "" && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

/** FR-32. A turn can be pinned for more than one reason; every reason is reported. */
function computePins(turns: readonly CanonicalTurn[], pinnedRecentTurns: number): TurnPin[] {
  const reasons = new Map<number, Set<PinReason>>();
  const pin = (index: number, reason: PinReason): void => {
    const existing = reasons.get(index);
    if (existing) existing.add(reason);
    else reasons.set(index, new Set([reason]));
  };

  const firstRequest = turns.find((turn) => turn.role === "user" && turn.kind === "message");
  if (firstRequest) pin(firstRequest.index, "first-request");

  const recent = Math.min(Math.max(0, Math.trunc(pinnedRecentTurns)), turns.length);
  for (const turn of turns.slice(turns.length - recent)) pin(turn.index, "recent-turn");

  for (const turn of turns) {
    if (turn.kind === "summary") pin(turn.index, "summary");
    if (turn.toolCall?.effect === "mutating") pin(turn.index, "changed-files");
  }

  const pins: TurnPin[] = [];
  for (const turn of turns) {
    const set = reasons.get(turn.index);
    if (!set) continue;
    reasons.delete(turn.index);
    for (const reason of PIN_ORDER) {
      if (set.has(reason)) pins.push({ index: turn.index, reason });
    }
  }
  return pins;
}

/** The cost of what actually ships for this turn: its text, or its record's three fields. */
function turnCost(turn: CanonicalTurn, estimator: TokenEstimator): number {
  const record = turn.toolCall;
  const text = record
    ? `${turn.text}\n${record.toolName}\n${record.argumentsText}\n${record.outcomeLine}`
    : turn.text;
  return estimator.estimate(text) + TURN_FRAMING_TOKENS;
}

function copyProvenance(provenance: SourceProvenance, changedPaths: string[]): SourceProvenance {
  return {
    ref: {
      agent: provenance.ref.agent,
      home: provenance.ref.home,
      id: provenance.ref.id,
    },
    title: provenance.title,
    startedAt: provenance.startedAt,
    updatedAt: provenance.updatedAt,
    repo: {
      commit: provenance.repo.commit,
      branch: provenance.repo.branch,
      changedPaths,
    },
  };
}

function apply(
  session: CanonicalSession,
  target: TargetProfile,
  config: ImportConfig,
  estimator: TokenEstimator,
): TransferPlan {
  const source = session.turns;
  const drops: TurnDrop[] = [];

  // 1. Drop the broken tail (FR-54, FR-55): every consecutive trailing call the source never
  // answered — an interrupted parallel tool batch leaves several unanswered calls, not one.
  let cut = source.length;
  while (cut > 0 && isUnansweredCall(source[cut - 1])) {
    const turn = source[cut - 1];
    if (turn) drops.push({ index: turn.index, reason: "broken-tail" });
    cut -= 1;
  }
  const brokenTailDropped = cut < source.length;

  // 2. Select content (FR-22 to FR-28). The record shape is what enforces FR-24.
  const selected = source.slice(0, cut).map(normalizeTurn);

  // 3. Compute the budget (FR-29, FR-30).
  const budgetTokens = Math.floor(config.budgetShare * target.windowTokens);

  // 4. Pin (FR-32).
  const pins = computePins(selected, config.pinnedRecentTurns);
  const pinned = new Set(pins.map((entry) => entry.index));

  const costs = selected.map((turn) => turnCost(turn, estimator));
  let estimatedTokens = 0;
  let pinnedTokens = 0;
  for (const [position, turn] of selected.entries()) {
    const cost = costs[position] ?? 0;
    estimatedTokens += cost;
    if (pinned.has(turn.index)) pinnedTokens += cost;
  }

  // 5. Stop if the pinned content alone exceeds the budget (FR-33).
  let blockedReason: string | null = null;
  const kept = selected.map(() => true);
  if (pinnedTokens > budgetTokens) {
    blockedReason =
      `Pinned content needs ${pinnedTokens} tokens but the budget is ${budgetTokens} tokens ` +
      `(budgetShare ${config.budgetShare} of a ${target.windowTokens}-token window). ` +
      BUDGET_ADVICE;
  } else {
    // 6. Drop the oldest unpinned turn until the estimate fits (FR-31, FR-34).
    for (const [position, turn] of selected.entries()) {
      if (estimatedTokens <= budgetTokens) break;
      if (pinned.has(turn.index)) continue;
      kept[position] = false;
      estimatedTokens -= costs[position] ?? 0;
      drops.push({ index: turn.index, reason: "budget" });
    }
  }

  // 7. Report (FR-17, FR-18, FR-35).
  const turns = selected.filter((_, position) => kept[position]);

  // 7a. Block a plan that would import nothing: a zero-turn result is an import that cannot
  // succeed regardless of budget, and "Nothing to import" is the honest diagnosis (FR-17, FR-33).
  // The cause determines the advice: budget-driven drops suggest raising the budget;
  // an empty-content session (no budget drops) means the session itself has nothing to offer.
  if (blockedReason === null && turns.length === 0) {
    const budgetDriven = drops.some((d) => d.reason === "budget");
    blockedReason = budgetDriven
      ? `nothing to import — the budget removed all turns. ${BUDGET_ADVICE}`
      : "nothing to import — the session has no importable content. Choose a different session.";
  }

  drops.sort((left, right) => left.index - right.index);
  return {
    target: {
      agent: target.agent,
      home: target.home,
      ...(target.sessionDir === undefined ? {} : { sessionDir: target.sessionDir }),
      windowTokens: target.windowTokens,
    },
    provenance: copyProvenance(
      session.provenance,
      dedupeChangedPaths(session.provenance.repo.changedPaths),
    ),
    turns,
    pins,
    drops,
    keptTurnCount: turns.length,
    droppedTurnCount: drops.length,
    // Counted over the whole selection, not the survivors: step 2 removed every body
    // before the budget ran, so a turn the budget later dropped still lost one.
    bodiesDropped: selected.filter((turn) => turn.toolCall?.bodyDropped === true).length,
    estimatedTokens,
    budgetTokens,
    brokenTailDropped,
    blockedReason,
  };
}

/** The rules hold no state, so every instance behaves identically (T-TRA-19). */
export function createTransferRules(): TransferRules {
  return { apply };
}
