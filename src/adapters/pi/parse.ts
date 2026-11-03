/**
 * Reading a Pi session file into the canonical vocabulary.
 *
 * Two rules decide everything here:
 * - no result body crosses (FR-24). A tool result becomes one outcome line (FR-23, FR-25);
 * - nothing is guessed. An entry type this adapter does not know is skipped and counted,
 *   and an unparsable line makes the whole file unreadable rather than shorter.
 */

import { redactSensitiveStructure, redactSensitiveText } from "../redaction.js";
import type { CanonicalTurn, ToolCallRecord } from "./contract.js";
import {
  asEntry,
  asHeader,
  DROPPED_BODY_NOTE,
  entryMessage,
  isRecord,
  NON_TURN_ENTRY_TYPES,
  oneLine,
  type PiEntry,
  type PiSessionHeader,
  shortArguments,
  toIsoUtc,
  toolCallBlocks,
  toolEffectFor,
  visibleText,
} from "./format.js";

export interface ParsedSessionFile {
  header: PiSessionHeader | null;
  entries: PiEntry[];
  /** True when a line was not JSON: the file was cut, or written by something else. */
  truncated: boolean;
}

export interface LoadedTurns {
  turns: CanonicalTurn[];
  /** Entry types this adapter does not know. Visible so the preview can warn (T-PI-14). */
  skippedEntryTypes: string[];
  skippedCount: number;
  /** Set when the append-only entry graph cannot produce one trustworthy active branch. */
  unreadable: string | null;
}

export interface ResolvedPiEntries {
  /** The active leaf's complete parent chain, before compaction is applied. */
  activePath: PiEntry[];
  /** The entries Pi would put in model context after applying its latest compaction. */
  contextEntries: PiEntry[];
  unreadable: string | null;
}

export function parseSessionText(text: string): ParsedSessionFile {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const entries: PiEntry[] = [];
  let header: PiSessionHeader | null = null;
  let truncated = false;

  for (const [index, line] of lines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      truncated = true;
      continue;
    }
    if (index === 0) {
      header = asHeader(value);
      if (header) continue;
    }
    const entry = asEntry(value);
    if (entry) entries.push(entry);
    else truncated = true;
  }

  return { header, entries, truncated };
}

function retainedTailEntries(compaction: PiEntry): PiEntry[] {
  if (!Array.isArray(compaction.retainedTail)) return [];
  return compaction.retainedTail.flatMap((message, index) => {
    if (!isRecord(message)) return [];
    return [
      {
        type: "message",
        id: `${compaction.id}:retained:${index}`,
        parentId: null,
        timestamp: compaction.timestamp,
        message,
      },
    ];
  });
}

/** Resolve Pi's active leaf and reproduce its compaction-aware context projection. */
export function resolveActiveEntries(entries: PiEntry[]): ResolvedPiEntries {
  if (entries.length === 0) {
    return { activePath: [], contextEntries: [], unreadable: null };
  }

  const byId = new Map<string, PiEntry>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      return {
        activePath: [],
        contextEntries: [],
        unreadable: `entry ${entry.type} has no id`,
      };
    }
    if (byId.has(entry.id)) {
      return {
        activePath: [],
        contextEntries: [],
        unreadable: `duplicate entry id ${entry.id}`,
      };
    }
    if (entry.parentId !== null && typeof entry.parentId !== "string") {
      return {
        activePath: [],
        contextEntries: [],
        unreadable: `entry ${entry.id} has a malformed parentId`,
      };
    }
    byId.set(entry.id, entry);
  }

  const reversed: PiEntry[] = [];
  const visited = new Set<string>();
  let current: PiEntry | undefined = entries[entries.length - 1];
  while (current !== undefined) {
    if (visited.has(current.id)) {
      return {
        activePath: [],
        contextEntries: [],
        unreadable: `entry graph contains a cycle at ${current.id}`,
      };
    }
    visited.add(current.id);
    reversed.push(current);
    if (current.parentId === null) break;
    const parent: PiEntry | undefined = byId.get(current.parentId);
    if (parent === undefined) {
      return {
        activePath: [],
        contextEntries: [],
        unreadable: `entry ${current.id} refers to missing parent ${current.parentId}`,
      };
    }
    current = parent;
  }

  const activePath = reversed.reverse();
  let compactionIndex = -1;
  for (let index = 0; index < activePath.length; index++) {
    if (activePath[index]?.type === "compaction") compactionIndex = index;
  }
  if (compactionIndex < 0) {
    return { activePath, contextEntries: activePath, unreadable: null };
  }

  const compaction = activePath[compactionIndex] as PiEntry;
  const afterCompaction = activePath.slice(compactionIndex + 1);
  const retainedTail = retainedTailEntries(compaction);
  if (retainedTail.length > 0) {
    return {
      activePath,
      contextEntries: [compaction, ...retainedTail, ...afterCompaction],
      unreadable: null,
    };
  }

  const firstKeptId =
    typeof compaction.firstKeptEntryId === "string" ? compaction.firstKeptEntryId : null;
  const firstKeptIndex =
    firstKeptId === null
      ? -1
      : activePath.findIndex((entry, index) => index < compactionIndex && entry.id === firstKeptId);
  const keptBefore = firstKeptIndex < 0 ? [] : activePath.slice(firstKeptIndex, compactionIndex);
  return {
    activePath,
    contextEntries: [compaction, ...keptBefore, ...afterCompaction],
    unreadable: null,
  };
}

/** The result bodies of a session, keyed by tool call id. Read once, never carried. */
function indexToolResults(
  entries: PiEntry[],
): Map<string, { body: string; present: boolean; isError: boolean }> {
  const results = new Map<string, { body: string; present: boolean; isError: boolean }>();
  for (const entry of entries) {
    const message = entryMessage(entry);
    if (message?.role !== "toolResult") continue;
    const callId = typeof message.toolCallId === "string" ? message.toolCallId : "";
    if (callId.length === 0) continue;
    results.set(callId, {
      body: visibleText(message.content),
      present:
        (typeof message.content === "string" && message.content.length > 0) ||
        (Array.isArray(message.content) && message.content.length > 0) ||
        isRecord(message.content),
      isError: message.isError === true,
    });
  }
  return results;
}

function outcomeOf(result: { body: string; present: boolean; isError: boolean } | undefined): {
  outcome: string;
  bodyDropped: boolean;
} {
  if (!result) return { outcome: "no result recorded", bodyDropped: false };
  if (result.body.trim().length === 0) {
    if (result.present) {
      return {
        outcome: `${result.isError ? "error, result dropped" : "result recorded"} ${DROPPED_BODY_NOTE}`,
        bodyDropped: true,
      };
    }
    return {
      outcome: result.isError ? "error" : "no output",
      bodyDropped: false,
    };
  }
  const lineCount = result.body.split("\n").length;
  const what = result.isError ? "error" : `${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
  return { outcome: `${what} ${DROPPED_BODY_NOTE}`, bodyDropped: true };
}

function toolCallRecord(
  name: string,
  args: Record<string, unknown>,
  result: { body: string; present: boolean; isError: boolean } | undefined,
): ToolCallRecord {
  const argumentsText = JSON.stringify(redactSensitiveStructure(args));
  const { outcome, bodyDropped } = outcomeOf(result);
  return {
    toolName: name,
    argumentsText,
    outcomeLine: redactSensitiveText(
      oneLine(`${name}(${shortArguments(argumentsText)}) → ${outcome}`),
    ),
    effect: toolEffectFor(name),
    bodyDropped,
    // FR-54: false when no toolResult entry existed for this call id (broken tail signal).
    resultRecorded: result !== undefined,
  };
}

function contextEntriesToTurns(entries: PiEntry[]): Omit<LoadedTurns, "unreadable"> {
  const results = indexToolResults(entries);
  const turns: CanonicalTurn[] = [];
  const skippedEntryTypes: string[] = [];
  let skippedCount = 0;

  const push = (turn: Omit<CanonicalTurn, "index">): void => {
    // FR-28, security: credentials pasted as message text must not cross to a different vendor.
    // Tool-call turns carry text: "" so the condition is a no-op there (no double-redaction).
    const text = turn.text.length > 0 ? redactSensitiveText(turn.text) : turn.text;
    turns.push({ ...turn, text, index: turns.length });
  };

  const skip = (type: string): void => {
    skippedCount += 1;
    if (!skippedEntryTypes.includes(type)) skippedEntryTypes.push(type);
  };

  for (const entry of entries) {
    const timestamp = toIsoUtc(entry.timestamp);

    if (entry.type === "compaction" || entry.type === "branch_summary") {
      const summary = typeof entry.summary === "string" ? entry.summary : "";
      if (summary.trim().length > 0) {
        push({
          role: "agent",
          kind: "summary",
          text: summary,
          toolCall: null,
          timestamp,
        });
      }
      continue;
    }

    if (entry.type === "message") {
      const message = entryMessage(entry);
      if (!message) {
        skip("message/malformed");
        continue;
      }
      if (message.role === "toolResult") continue;

      if (message.role === "user") {
        const text = visibleText(message.content);
        if (text.trim().length > 0) {
          push({
            role: "user",
            kind: "message",
            text,
            toolCall: null,
            timestamp,
          });
        }
        continue;
      }

      if (message.role === "assistant") {
        const content = Array.isArray(message.content) ? message.content : [];
        let buffered = "";
        const flush = (): void => {
          if (buffered.trim().length === 0) {
            buffered = "";
            return;
          }
          push({
            role: "agent",
            kind: "message",
            text: buffered,
            toolCall: null,
            timestamp,
          });
          buffered = "";
        };
        if (!Array.isArray(message.content)) {
          buffered = visibleText(message.content);
        }
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === "text" && typeof block.text === "string") {
            buffered = buffered.length > 0 ? `${buffered}\n${block.text}` : block.text;
            continue;
          }
          // "thinking" blocks are hidden reasoning and never cross (FR-28, NG-7).
          if (block.type !== "toolCall") continue;
          flush();
          const [call] = toolCallBlocks([block]);
          if (!call) continue;
          push({
            role: "agent",
            kind: "tool-call",
            text: "",
            toolCall: toolCallRecord(call.name, call.arguments, results.get(call.id)),
            timestamp,
          });
        }
        flush();
        continue;
      }

      skip(`message/${String(message.role)}`);
      continue;
    }

    if (NON_TURN_ENTRY_TYPES.has(entry.type)) continue;

    skip(entry.type);
  }

  return { turns, skippedEntryTypes, skippedCount };
}

export function entriesToTurns(entries: PiEntry[]): LoadedTurns {
  const resolved = resolveActiveEntries(entries);
  if (resolved.unreadable !== null) {
    return {
      turns: [],
      skippedEntryTypes: [],
      skippedCount: 0,
      unreadable: resolved.unreadable,
    };
  }
  return {
    ...contextEntriesToTurns(resolved.contextEntries),
    unreadable: null,
  };
}

/** Short human title: the session's own name, else its first user message. */
export function titleFromEntries(entries: PiEntry[]): string | null {
  for (const entry of entries) {
    if (entry.type !== "session_info") continue;
    if (typeof entry.name === "string" && entry.name.trim().length > 0) return entry.name;
  }
  for (const entry of entries) {
    const message = entryMessage(entry);
    if (message?.role !== "user") continue;
    const text = visibleText(message.content);
    // FR-28, security: the title flows into SourceProvenance and is shown in the selection list.
    // A credential typed as the first message must not appear there unredacted.
    if (text.trim().length > 0) return redactSensitiveText(text);
  }
  return null;
}

/** Keys Pi's mutating tools name their target with. */
const PATH_ARGUMENT_KEYS = ["path", "file_path", "filePath", "file", "target"];

function changedPathOf(toolName: string, args: Record<string, unknown>): string | null {
  if (toolEffectFor(toolName) !== "mutating") return null;
  for (const key of PATH_ARGUMENT_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

/** Files named by raw Pi tool inputs, before canonical credential redaction. */
export function changedPathsFromEntries(entries: PiEntry[]): string[] {
  const paths = new Set<string>();
  for (const entry of entries) {
    const message = entryMessage(entry);
    if (message?.role !== "assistant") continue;
    for (const call of toolCallBlocks(message.content)) {
      const path = changedPathOf(call.name, call.arguments);
      if (path !== null) paths.add(path);
    }
  }
  return [...paths];
}

/** The last timestamp the file recorded, ISO-8601 UTC, or null. */
export function lastTimestamp(entries: PiEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    const iso = toIsoUtc(entry.timestamp);
    if (iso) return iso;
  }
  return null;
}
