/**
 * The source role: a Codex home becomes a list of sessions, and one session becomes the
 * canonical vocabulary. Every result body is dropped (FR-24) and every reasoning trace is
 * ignored (FR-28, C-4).
 */

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import type {
  CanonicalSession,
  CanonicalTurn,
  SessionDescriptor,
  ToolCallRecord,
  ToolEffect,
} from "./contract.js";
import { redactSensitiveArgumentsText, redactSensitiveText } from "./redaction.js";
import type { CodexSessionMeta, RolloutEntry } from "./rollout.js";
import {
  CODEX_ENTRY_COMPACTED,
  CODEX_ENTRY_EVENT_MSG,
  CODEX_ENTRY_RESPONSE_ITEM,
  CODEX_EVENT_AGENT_MESSAGE,
  CODEX_EVENT_USER_MESSAGE,
  CODEX_ITEM_CUSTOM_TOOL_CALL,
  CODEX_ITEM_CUSTOM_TOOL_CALL_OUTPUT,
  CODEX_ITEM_FUNCTION_CALL,
  CODEX_ITEM_FUNCTION_CALL_OUTPUT,
  KNOWN_ENTRY_TYPES,
  listRolloutFiles,
  parseEntry,
  parseRolloutText,
  payloadType,
  readSessionMeta,
  sessionsRoot,
  toIsoUtc,
} from "./rollout.js";

const TITLE_LIMIT = 80;
const ARGUMENTS_PREVIEW_LIMIT = 60;

/** Tools whose name alone settles the question (FR-26). Everything else stays "unknown". */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "read",
  "view_image",
  "list_dir",
  "grep",
  "find",
  "web_search",
]);
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "apply_patch",
  "write_file",
  "edit_file",
  "create_file",
  "delete_file",
]);

export interface CodexRollout {
  filePath: string;
  meta: CodexSessionMeta | null;
  turns: CanonicalTurn[];
  /** Entries of a type this module does not understand. Codex drops them in silence (C-6). */
  skippedEntries: number;
  startedAt: string | null;
  updatedAt: string | null;
  title: string;
  changedPaths: string[];
  truncated: boolean;
}

export class CodexRolloutUnreadableError extends Error {
  constructor(filePath: string) {
    super(`Codex thread is unreadable: ${filePath} was cut mid-entry`);
    this.name = "CodexRolloutUnreadableError";
  }
}

/** Lenient: a file cut mid-entry still yields whatever parsed, with `truncated` set. */
export async function scanRollout(filePath: string): Promise<CodexRollout> {
  // Whole-file read: listing a home reads every rollout, and C-5 measured those files
  // in megabytes. Ceiling accepted because title and turn count both need the whole file;
  // revisit if a home with thousands of threads makes the listing feel slow.
  const text = await readFile(filePath, "utf8");
  const { entries, truncated } = parseRolloutText(text);

  let meta: CodexSessionMeta | null = null;
  for (const entry of entries) {
    meta = readSessionMeta(entry);
    if (meta !== null) break;
  }

  const { turns, skippedEntries, changedPaths } = toCanonicalTurns(entries);
  const firstUserTurn = turns.find((turn) => turn.role === "user" && turn.kind === "message");
  const lastStamp = [...entries].reverse().find((entry) => toIsoUtc(entry.timestamp) !== null);

  return {
    filePath,
    meta,
    turns,
    skippedEntries,
    startedAt: toIsoUtc(meta?.timestamp ?? entries[0]?.timestamp ?? null),
    updatedAt: toIsoUtc(lastStamp?.timestamp ?? meta?.timestamp ?? null),
    title: titleOf(firstUserTurn?.text ?? ""),
    changedPaths,
    truncated,
  };
}

/** Strict: FR-51's "unreadable" answer. */
export async function readRollout(filePath: string): Promise<CodexRollout> {
  const rollout = await scanRollout(filePath);
  if (rollout.truncated) throw new CodexRolloutUnreadableError(filePath);
  return rollout;
}

export async function listCodexSessions(home: string): Promise<SessionDescriptor[]> {
  const descriptors: SessionDescriptor[] = [];
  for (const filePath of await listRolloutFiles(sessionsRoot(home))) {
    let summary: RolloutSummary;
    try {
      summary = await summarizeRollout(filePath);
    } catch {
      // A rollout may disappear, be unreadable, or exceed a runtime limit. One bad file must
      // not prevent discovery of the other sessions in this home.
      continue;
    }
    if (summary.meta === null) continue;
    descriptors.push({
      ref: { agent: "codex", home, id: summary.meta.id },
      title: summary.title,
      startedAt: summary.startedAt ?? "",
      updatedAt: summary.updatedAt ?? summary.startedAt ?? "",
      turnCount: summary.turnCount,
      repoPath: summary.meta.cwd !== null && isAbsolute(summary.meta.cwd) ? summary.meta.cwd : null,
      filePath,
    });
  }
  descriptors.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return descriptors;
}

interface RolloutSummary {
  meta: CodexSessionMeta | null;
  title: string;
  startedAt: string | null;
  updatedAt: string | null;
  turnCount: number;
}

/** Reads JSONL one entry at a time and retains only picker fields, never the transcript. */
async function summarizeRollout(filePath: string): Promise<RolloutSummary> {
  const lines = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let meta: CodexSessionMeta | null = null;
  let firstStamp: string | null = null;
  let lastStamp: string | null = null;
  let title = "";
  let turnCount = 0;

  for await (const line of lines) {
    if (line.trim() === "") continue;
    const entry = parseEntry(line);
    if (entry === null) continue;
    const stamp = toIsoUtc(entry.timestamp);
    firstStamp ??= stamp;
    lastStamp = stamp ?? lastStamp;
    meta ??= readSessionMeta(entry);

    const type = payloadType(entry);
    if (entry.type === CODEX_ENTRY_COMPACTED) {
      if (typeof entry.payload.message === "string" && entry.payload.message.trim() !== "")
        turnCount += 1;
    } else if (entry.type === CODEX_ENTRY_EVENT_MSG) {
      if (
        (type === CODEX_EVENT_USER_MESSAGE || type === CODEX_EVENT_AGENT_MESSAGE) &&
        typeof entry.payload.message === "string" &&
        entry.payload.message.trim() !== ""
      ) {
        turnCount += 1;
        if (title === "" && type === CODEX_EVENT_USER_MESSAGE)
          title = titleOf(entry.payload.message);
      }
    } else if (
      entry.type === CODEX_ENTRY_RESPONSE_ITEM &&
      (type === CODEX_ITEM_FUNCTION_CALL || type === CODEX_ITEM_CUSTOM_TOOL_CALL) &&
      typeof entry.payload.name === "string" &&
      entry.payload.name !== ""
    ) {
      turnCount += 1;
    }
  }

  return {
    meta,
    title,
    startedAt: toIsoUtc(meta?.timestamp ?? null) ?? firstStamp,
    updatedAt: lastStamp ?? toIsoUtc(meta?.timestamp ?? null),
    turnCount,
  };
}

export async function loadCodexSession(descriptor: SessionDescriptor): Promise<CanonicalSession> {
  const rollout = await readRollout(descriptor.filePath);
  return {
    provenance: {
      ref: descriptor.ref,
      title: descriptor.title,
      startedAt: descriptor.startedAt,
      updatedAt: descriptor.updatedAt,
      repo: {
        commit: rollout.meta?.commit ?? null,
        branch: rollout.meta?.branch ?? null,
        changedPaths: rollout.changedPaths,
      },
    },
    turns: rollout.turns,
  };
}

function titleOf(text: string): string {
  const line =
    text
      .split("\n")
      .find((candidate) => candidate.trim() !== "")
      ?.trim() ?? "";
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line;
}

/**
 * Messages come from `event_msg` and tool calls from `response_item`: the same text appears in
 * both shapes, and taking each from one place is what keeps every turn out of the session twice.
 * Reasoning, in either shape, produces nothing at all (C-4, FR-28, NG-8).
 */
function toCanonicalTurns(entries: RolloutEntry[]): {
  turns: CanonicalTurn[];
  skippedEntries: number;
  changedPaths: string[];
} {
  const outputs = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== CODEX_ENTRY_RESPONSE_ITEM) continue;
    const type = payloadType(entry);
    if (type !== CODEX_ITEM_FUNCTION_CALL_OUTPUT && type !== CODEX_ITEM_CUSTOM_TOOL_CALL_OUTPUT)
      continue;
    const callId = entry.payload.call_id;
    if (typeof callId !== "string") continue;
    outputs.set(callId, outputTextOf(entry.payload.output));
  }

  const turns: CanonicalTurn[] = [];
  const changed = new Set<string>();
  let skippedEntries = 0;

  for (const entry of entries) {
    if (!KNOWN_ENTRY_TYPES.has(entry.type)) {
      skippedEntries += 1;
      continue;
    }
    const type = payloadType(entry);

    if (entry.type === CODEX_ENTRY_COMPACTED) {
      const message = entry.payload.message;
      if (typeof message !== "string" || message.trim() === "") continue;
      turns.push({
        index: turns.length,
        role: "agent",
        kind: "summary",
        text: message,
        toolCall: null,
        timestamp: toIsoUtc(entry.timestamp),
      });
      continue;
    }

    if (entry.type === CODEX_ENTRY_EVENT_MSG) {
      if (type !== CODEX_EVENT_USER_MESSAGE && type !== CODEX_EVENT_AGENT_MESSAGE) continue;
      const message = entry.payload.message;
      if (typeof message !== "string" || message.trim() === "") continue;
      turns.push({
        index: turns.length,
        role: type === CODEX_EVENT_USER_MESSAGE ? "user" : "agent",
        kind: "message",
        text: message,
        toolCall: null,
        timestamp: toIsoUtc(entry.timestamp),
      });
      continue;
    }

    if (entry.type !== CODEX_ENTRY_RESPONSE_ITEM) continue;
    if (type !== CODEX_ITEM_FUNCTION_CALL && type !== CODEX_ITEM_CUSTOM_TOOL_CALL) continue;

    const toolName = typeof entry.payload.name === "string" ? (entry.payload.name as string) : "";
    if (toolName === "") continue;
    const rawArguments =
      type === CODEX_ITEM_FUNCTION_CALL ? entry.payload.arguments : entry.payload.input;
    const argumentsText = typeof rawArguments === "string" ? rawArguments : "";
    const callId = entry.payload.call_id;
    const output = typeof callId === "string" ? (outputs.get(callId) ?? null) : null;
    const toolCall = toolCallRecord(toolName, argumentsText, output);
    if (toolCall.effect === "mutating")
      for (const path of pathsOf(argumentsText)) changed.add(path);
    turns.push({
      index: turns.length,
      role: "agent",
      kind: "tool-call",
      text: "",
      toolCall,
      timestamp: toIsoUtc(entry.timestamp),
    });
  }

  return { turns, skippedEntries, changedPaths: [...changed] };
}

/** Only the shape of the output is measured. Not one fragment of it is carried (FR-24, FR-25). */
function toolCallRecord(
  toolName: string,
  argumentsText: string,
  output: string | null,
): ToolCallRecord {
  const safeArguments = redactSensitiveArgumentsText(argumentsText);
  const head = `${toolName}(${singleLine(safeArguments, ARGUMENTS_PREVIEW_LIMIT)})`;
  const outcomeLine =
    output === null
      ? `${head} → no output recorded`
      : `${head} → ${output.split("\n").length} lines, body dropped`;
  return {
    toolName,
    argumentsText: safeArguments,
    outcomeLine: redactSensitiveText(outcomeLine),
    effect: effectOf(toolName),
    bodyDropped: output !== null,
  };
}

function effectOf(toolName: string): ToolEffect {
  if (MUTATING_TOOLS.has(toolName)) return "mutating";
  if (READ_ONLY_TOOLS.has(toolName)) return "read-only";
  return "unknown";
}

function outputTextOf(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((part) =>
        typeof part === "object" && part !== null
          ? String((part as Record<string, unknown>).text ?? "")
          : "",
      )
      .join("\n");
  }
  return output === undefined || output === null ? "" : JSON.stringify(output);
}

function singleLine(text: string, limit: number): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Files a mutating call touched, for RepoSnapshot.changedPaths (FR-36). */
function pathsOf(argumentsText: string): string[] {
  let text = argumentsText;
  const direct: string[] = [];
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const strings = Object.values(record).filter(
        (value): value is string => typeof value === "string",
      );
      text = strings.join("\n");
      for (const key of ["path", "file_path", "filename"]) {
        const value = record[key];
        if (typeof value === "string" && value !== "") direct.push(value);
      }
    }
  } catch {
    // Arguments that are not JSON are searched as they were recorded.
  }
  const patched = [...text.matchAll(/\*\*\* (?:Add|Update|Delete) File: (.+)/g)].map((match) =>
    (match[1] ?? "").trim(),
  );
  return [...direct, ...patched].filter((path) => path !== "");
}
