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

/** One line of user text, shortened to the room a summary line has. */
function oneLine(value: string): string {
  const line = value.replace(/\s+/gu, " ").trim();
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
  return {
    sourceAgent: ref.agent,
    sourceHome: ref.home,
    sourceSessionId: ref.id,
    importedAt,
    droppedSummary: summariseDrops(plan),
    lines: [
      `↻ Restored from ${ref.agent} ${ref.id.slice(0, 8)} ` +
        `(${shortenPath(ref.home, home)}) · ${formatTime(importedAt)}`,
      `  ${directoryText(directory, home)} · ${plan.provenance.repo.branch ?? "no branch"}`,
      `${counted(plan.keptTurnCount, "turn", "turns")} kept · ${summariseDrops(plan)}`,
    ],
  };
}
