// The one summary builder: the restore header, the provenance marker, and the
// plain-text `--context` block all compose these lines, so the labels, the `~`
// shortening and the time format cannot drift apart (FR-61).

import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { Place } from "../../platform/repo/contract.js";
import type { ProvenanceMarker, SessionDescriptor } from "../../session/contract.js";
import type { TransferPlan } from "../transfer/contract.js";

const MAX_TITLE = 60;
const NOTHING_DROPPED = "Nothing was dropped: the whole session crossed over.";
const DROPPED_PREFIX = "Dropped on import: ";
const PART_SEPARATOR = "; ";

function counted(amount: number, one: string, many: string): string {
  return `${amount} ${amount === 1 ? one : many}`;
}

function globalPattern(source: string): RegExp {
  return new RegExp(source, "gu");
}

// A marker line is written into the target's session file and read back by the agent, so it must
// carry no terminal escape or control character: a crafted session could otherwise forge a label
// line or move the cursor in the resumed transcript.
const ANSI_SEQUENCE = globalPattern(
  String.raw`\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])`,
);
// `\p{Cf}` removes invisible format controls (bidi overrides and the like); `\p{Zl}`/`\p{Zp}`
// remove the line and paragraph separators that would otherwise split a stored marker line.
const UNSAFE_CONTROL = globalPattern(String.raw`[\x00-\x1f\x7f-\x9f\p{Cf}\p{Zl}\p{Zp}]`);

/** Untrusted text with escapes and control characters removed. */
function safeText(value: string): string {
  return value.replace(ANSI_SEQUENCE, " ").replace(UNSAFE_CONTROL, " ");
}

/** Untrusted text collapsed to one sanitised line, with no length limit. */
function safeComponent(value: string): string {
  return safeText(value).replace(/\s+/gu, " ").trim();
}

/** One line of user text, shortened to the room a summary line has. */
function oneLine(value: string): string {
  const line = safeComponent(value);
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
}

/** ISO-8601 UTC, shortened to the minute. Unknown shapes are printed as they came. */
export function formatTime(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  return match === null ? value : `${match[1]} ${match[2]}Z`;
}

/** `~` when the path is under the home, the absolute path otherwise. */
export function shortenPath(value: string, home: string = homedir()): string {
  const within = relative(home, value);
  if (within === "" || (!within.startsWith("..") && !within.startsWith("/"))) {
    return within === "" ? "~" : `~${join("/", within).replaceAll("\\", "/")}`;
  }
  return value;
}

/** A recorded directory, or a short phrase when the session records none. */
function directoryText(value: string, home: string): string {
  return value === "" ? "(no recorded directory)" : shortenPath(value, home);
}

/** One line naming what the rules removed (FR-47). Never more than one line. */
export function summariseDrops(plan: TransferPlan): string {
  const parts: string[] = [];
  if (plan.droppedTurnCount > 0) parts.push(counted(plan.droppedTurnCount, "turn", "turns"));
  if (plan.bodiesDropped > 0) {
    parts.push(counted(plan.bodiesDropped, "tool result body", "tool result bodies"));
  }
  const brokenTails = plan.drops.filter((drop) => drop.reason === "broken-tail").length;
  if (brokenTails === 1) parts.push("an incomplete trailing tool call");
  if (brokenTails > 1) parts.push(`${brokenTails} incomplete trailing tool calls`);
  if (parts.length === 0) return NOTHING_DROPPED;
  return `${DROPPED_PREFIX}${parts.join(PART_SEPARATOR)}.`;
}

/** The two summary lines every restore output starts with (FR-61). */
export function summaryLines(
  descriptor: SessionDescriptor,
  place: Place,
  home: string = homedir(),
): string[] {
  const title = oneLine(descriptor.title) || "(untitled)";
  const first =
    `↻ ${descriptor.ref.agent} ${descriptor.ref.id.slice(0, 8)} · ` +
    `${shortenPath(descriptor.ref.home, home)} · ` +
    `${formatTime(descriptor.updatedAt)} · ${title}`;
  const state =
    place.state === "present"
      ? null
      : place.state === "recoverable"
        ? "directory missing; it can be recreated"
        : "directory missing and cannot be recovered";
  const second = [
    directoryText(place.directory, home),
    place.branch ?? "no branch",
    ...(state === null ? [] : [state]),
  ].join(" · ");
  return [first, `  ${second}`];
}

/**
 * The three-line provenance marker the imported session shows (FR-47): where it came
 * from, where it now lives, and what was dropped.
 */
export function buildMarker(
  plan: TransferPlan,
  importedAt: string,
  directory: string,
  home: string = homedir(),
): ProvenanceMarker {
  const { ref } = plan.provenance;
  // Every session-derived part is one-lined and stripped before it joins a marker line, so the
  // marker keeps its three-line contract whatever the source recorded.
  return {
    sourceAgent: ref.agent,
    sourceHome: ref.home,
    sourceSessionId: ref.id,
    importedAt,
    droppedSummary: summariseDrops(plan),
    lines: [
      `↻ Restored from ${safeComponent(ref.agent)} ${safeComponent(ref.id.slice(0, 8))} ` +
        `(${safeComponent(shortenPath(ref.home, home))}) · ${formatTime(importedAt)}`,
      `  ${safeComponent(directoryText(directory, home))} · ` +
        `${safeComponent(plan.provenance.repo.branch ?? "no branch")}`,
      `${counted(plan.keptTurnCount, "turn", "turns")} kept · ${summariseDrops(plan)}`,
    ],
  };
}
