/**
 * The source role: a Kimi Code home becomes a list of sessions, and one session's
 * `wire.jsonl` becomes the canonical vocabulary. Every result body is dropped (FR-24),
 * every think part is ignored (FR-28), and the turn structure follows the replay fold
 * Kimi Code itself runs on resume, so a listed row always opens the session it counted.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type {
  CanonicalSession,
  CanonicalTurn,
  SessionDescriptor,
  ToolCallRecord,
  ToolEffect,
} from "./contract.js";
import {
  isNotFoundError,
  listSessionDirs,
  msToIsoUtc,
  sessionsRoot,
  stateFilePath,
  wireFilePath,
} from "./layout.js";
import { redactSensitiveArgumentsText, redactSensitiveText } from "./redaction.js";
import type { WireRecord, WireStreamState } from "./wire.js";
import {
  classifyRecord,
  KIMI_LOOP_TOOL_CALL,
  KIMI_LOOP_TOOL_RESULT,
  KIMI_ORIGIN_COMPACTION_SUMMARY,
  KIMI_ORIGIN_USER,
  KIMI_PART_TEXT,
  KIMI_RECORD_APPEND_LOOP_EVENT,
  KIMI_RECORD_APPEND_MESSAGE,
  KIMI_RECORD_APPLY_COMPACTION,
  KIMI_RECORD_CLEAR,
  KIMI_RECORD_UNDO,
  loopEventOf,
  messageOriginKind,
  messageRole,
  streamWireRecords,
  textOfContent,
} from "./wire.js";

const TITLE_LIMIT = 80;
const ARGUMENTS_PREVIEW_LIMIT = 60;

/** Tools whose name alone settles the question (FR-26). Everything else stays "unknown". */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "glob",
  "find",
  "ls",
  "list_dir",
  "view_image",
  "web_search",
  "search",
]);
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "delete",
  "delete_file",
  "apply_patch",
  "create_file",
  "move",
  "rename",
]);

/** The `state.json` payload, in the fields this module uses. */
export interface KimiSessionState {
  id: string;
  title: string;
  lastPrompt: string;
  createdAt: number | null;
  updatedAt: number | null;
  cwd: string | null;
}

export class KimiWireUnreadableError extends Error {
  constructor(filePath: string) {
    super(`Kimi Code session is unreadable: ${filePath} was cut mid-record`);
    this.name = "KimiWireUnreadableError";
  }
}

/** Reads `state.json`. Null when the file is absent or not a session metadata object. */
export async function readSessionState(sessionDir: string): Promise<KimiSessionState | null> {
  let text: string;
  try {
    text = await readFile(stateFilePath(sessionDir), "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id === "") return null;
  const cwd = typeof record.cwd === "string" && record.cwd !== "" ? record.cwd : null;
  return {
    id: record.id,
    title: typeof record.title === "string" ? record.title : "",
    lastPrompt: typeof record.lastPrompt === "string" ? record.lastPrompt : "",
    createdAt: typeof record.createdAt === "number" ? record.createdAt : null,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : null,
    cwd,
  };
}

export interface KimiWireScan {
  filePath: string;
  turns: CanonicalTurn[];
  /** Records of a type this module does not understand. Kimi Code drops them in silence too. */
  skippedRecords: number;
  changedPaths: string[];
  truncated: boolean;
}

/** Lenient: a file cut mid-record still yields whatever parsed, with `truncated` set. */
export async function scanWire(filePath: string): Promise<KimiWireScan> {
  // The same streamed reader the listing uses, so both call a line over the cap damage: one
  // reader, one damage rule, and no whole file in memory. Reading stops at the first damage
  // through `stop`, which lets the reader end the file on its own terms; `readWire` refuses a
  // damaged file anyway, so the rest of it cannot matter.
  const state: WireStreamState = { truncated: false, stop: false };
  const records: WireRecord[] = [];
  for await (const record of streamWireRecords(filePath, state)) {
    if (state.truncated) {
      state.stop = true;
      continue;
    }
    records.push(record);
  }
  const builder = new TurnBuilder();
  for (const record of records) builder.apply(record);
  return {
    filePath,
    turns: builder.turns,
    skippedRecords: builder.skippedRecords,
    changedPaths: builder.changedPaths(),
    truncated: state.truncated,
  };
}

/** Strict: an import source must not silently become a shorter session. */
export async function readWire(filePath: string): Promise<KimiWireScan> {
  const scan = await scanWire(filePath);
  if (scan.truncated) throw new KimiWireUnreadableError(filePath);
  return scan;
}

/** What the selection list needs from one wire file (FR-11, FR-14). */
export interface WireSummary {
  filePath: string;
  title: string;
  turnCount: number;
  startedAt: string | null;
  updatedAt: string | null;
  truncated: boolean;
}

/**
 * Sums up one wire file for the selection list in a single streamed pass: no turn is built
 * and no argument is redacted. Every count comes from the same classifier the loader uses,
 * so a row cannot disagree with the session it opens.
 */
export async function summarizeWire(filePath: string): Promise<WireSummary> {
  const state: WireStreamState = { truncated: false, stop: false };
  let title = "";
  let firstStamp: string | null = null;
  let lastStamp: string | null = null;
  let seenRecord = false;
  // Markers only, in source order: enough to apply `context.undo` and `context.clear` the way
  // the loader does, so a row's turnCount is the turn count of the session it opens (T-ADA-7).
  // No text is held and no turn is built.
  const markers: { kind: "message" | "summary" | "tool-call"; role: "user" | "agent" | "" }[] = [];

  for await (const record of streamWireRecords(filePath, state)) {
    if (!seenRecord) {
      seenRecord = true;
      firstStamp = msToIsoUtc(record.time);
    }
    const stamp = msToIsoUtc(record.time);
    if (stamp !== null) lastStamp = stamp;

    if (record.type === KIMI_RECORD_UNDO) {
      const count = record.record.count;
      if (typeof count === "number" && count > 0) {
        let removedUser = 0;
        while (markers.length > 0) {
          const last = markers[markers.length - 1];
          if (last === undefined || last.kind === "summary") break;
          markers.pop();
          if (last.kind === "message" && last.role === "user") {
            removedUser += 1;
            if (removedUser >= count) break;
          }
        }
      }
      continue;
    }
    if (record.type === KIMI_RECORD_CLEAR) {
      markers.length = 0;
      continue;
    }

    const classified = classifyRecord(record);
    if (!Array.isArray(classified)) continue;
    for (const part of classified) {
      if (part.kind === "none") continue;
      if (part.kind === "message") {
        markers.push({ kind: "message", role: part.role });
        if (title === "" && part.role === "user") title = part.text;
      } else {
        markers.push({ kind: part.kind, role: "" });
      }
    }
  }

  return {
    filePath,
    // The title reaches the target's metadata, so it is redacted as the turn text is (FR-28).
    title: titleOf(redactSensitiveText(title)),
    turnCount: markers.length,
    startedAt: firstStamp,
    updatedAt: lastStamp ?? firstStamp,
    truncated: state.truncated,
  };
}

export async function listKimiCodeSessions(home: string): Promise<SessionDescriptor[]> {
  const descriptors: SessionDescriptor[] = [];
  let failed = 0;
  let firstFailure: unknown = null;

  for (const sessionDir of await listSessionDirs(sessionsRoot(home))) {
    let state: KimiSessionState | null;
    try {
      state = await readSessionState(sessionDir);
    } catch (error) {
      failed += 1;
      firstFailure ??= error;
      continue;
    }
    if (state === null) continue; // Not a session directory: no metadata, nothing to list.
    const filePath = wireFilePath(sessionDir);
    let summary: WireSummary;
    try {
      summary = await summarizeWire(filePath);
    } catch (error) {
      if (isNotFoundError(error)) continue; // A session may disappear during a concurrent cleanup.
      // One unreadable session must not hide the rest of the home. The home still reports a
      // failure when nothing at all could be read, so a broken mount is never silent.
      failed += 1;
      firstFailure ??= error;
      continue;
    }
    const repoPaths = state.cwd !== null && isAbsolute(state.cwd) ? [state.cwd] : [];
    descriptors.push({
      ref: { agent: "kimi-code", home, id: state.id },
      title: summary.title !== "" ? summary.title : titleOf(redactSensitiveText(state.title)),
      startedAt: msToIsoUtc(state.createdAt) ?? summary.startedAt ?? "",
      updatedAt: msToIsoUtc(state.updatedAt) ?? summary.updatedAt ?? summary.startedAt ?? "",
      turnCount: summary.turnCount,
      repoPath: repoPaths[0] ?? null,
      repoPaths,
      startDirectory: repoPaths[0] ?? null,
      filePath,
    });
  }

  if (descriptors.length === 0 && failed > 0) {
    throw firstFailure instanceof Error ? firstFailure : new Error(String(firstFailure));
  }
  descriptors.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return descriptors;
}

export async function loadKimiCodeSession(
  descriptor: SessionDescriptor,
): Promise<CanonicalSession> {
  const wire = await readWire(descriptor.filePath);
  return {
    provenance: {
      ref: descriptor.ref,
      title: descriptor.title,
      startedAt: descriptor.startedAt,
      updatedAt: descriptor.updatedAt,
      repo: {
        // The format records no git state; changedPaths come from the mutating calls (FR-36).
        commit: null,
        branch: null,
        changedPaths: wire.changedPaths,
      },
    },
    turns: wire.turns,
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
 * Replays one wire file into canonical turns. The structure mirrors the fold Kimi Code's own
 * resume runs: `context.append_message` records enter the history as they are,
 * `context.append_loop_event` records contribute text parts and tool calls with their results,
 * a `context.undo` removes back to the recorded count of real user turns and stops at a
 * compaction summary, `context.clear` empties the history, and a `context.apply_compaction`
 * records the summary. Think parts produce nothing (FR-28); tool results are measured, never
 * carried (FR-24, FR-25).
 */
class TurnBuilder {
  readonly turns: CanonicalTurn[] = [];
  skippedRecords = 0;
  private readonly pendingCalls = new Map<string, number>();
  private readonly changed = new Set<string>();

  changedPaths(): string[] {
    return [...this.changed];
  }

  apply(record: WireRecord): void {
    switch (record.type) {
      case KIMI_RECORD_APPEND_MESSAGE:
        this.applyMessage(record);
        return;
      case KIMI_RECORD_APPEND_LOOP_EVENT:
        this.applyLoopEvent(record);
        return;
      case KIMI_RECORD_APPLY_COMPACTION: {
        const summary = record.record.summary;
        if (typeof summary === "string" && summary.trim() !== "") {
          this.push(
            "agent",
            "summary",
            redactSensitiveText(summary),
            null,
            msToIsoUtc(record.time),
          );
        }
        return;
      }
      case KIMI_RECORD_UNDO:
        this.undo(record);
        return;
      case KIMI_RECORD_CLEAR:
        this.turns.length = 0;
        this.pendingCalls.clear();
        return;
      default: {
        const classified = classifyRecord(record);
        if (!Array.isArray(classified)) this.skippedRecords += 1;
        return;
      }
    }
  }

  private push(
    role: CanonicalTurn["role"],
    kind: CanonicalTurn["kind"],
    text: string,
    toolCall: CanonicalTurn["toolCall"],
    timestamp: string | null,
  ): void {
    this.turns.push({ index: this.turns.length, role, kind, text, toolCall, timestamp });
  }

  private applyMessage(record: WireRecord): void {
    const role = messageRole(record);
    const origin = messageOriginKind(record);
    const message = record.record.message;
    if (role === null || typeof message !== "object" || message === null) return;
    const messageRecord = message as Record<string, unknown>;
    const timestamp = msToIsoUtc(record.time);

    if (role === "user") {
      if (origin === KIMI_ORIGIN_COMPACTION_SUMMARY) {
        const text = textOfContent(messageRecord.content);
        if (text.trim() !== "") {
          this.push("agent", "summary", redactSensitiveText(text), null, timestamp);
        }
        return;
      }
      if (origin !== KIMI_ORIGIN_USER) return; // date reminders, system injections: no turn
      const text = textOfContent(messageRecord.content);
      if (text.trim() === "") return;
      // FR-28, security: credentials in message text must not cross to a different vendor.
      this.push("user", "message", redactSensitiveText(text), null, timestamp);
      return;
    }

    if (role === "assistant") {
      const text = textOfContent(messageRecord.content);
      if (text.trim() !== "") {
        // FR-28, security: credentials in message text must not cross to a different vendor.
        this.push("agent", "message", redactSensitiveText(text), null, timestamp);
      }
      if (!Array.isArray(messageRecord.toolCalls)) return;
      for (const call of messageRecord.toolCalls) {
        if (typeof call !== "object" || call === null) continue;
        const callRecord = call as Record<string, unknown>;
        const id = typeof callRecord.id === "string" ? callRecord.id : null;
        if (id === null) continue;
        const fn =
          typeof callRecord.function === "object" && callRecord.function !== null
            ? (callRecord.function as Record<string, unknown>)
            : callRecord; // the flat shape loop events use
        const name = typeof fn.name === "string" ? fn.name : "";
        if (name === "") continue;
        const rawArguments = fn.arguments;
        const argumentsText =
          typeof rawArguments === "string"
            ? rawArguments
            : rawArguments === undefined
              ? ""
              : JSON.stringify(rawArguments);
        this.openCall(id, name, argumentsText, timestamp);
      }
      return;
    }

    if (role === "tool") {
      const id = typeof messageRecord.toolCallId === "string" ? messageRecord.toolCallId : null;
      if (id === null) return;
      const isError = messageRecord.isError === true;
      this.closeCall(id, textOfContent(messageRecord.content), isError);
    }
  }

  private applyLoopEvent(record: WireRecord): void {
    const event = loopEventOf(record);
    if (event === null) return;
    const timestamp = msToIsoUtc(record.time);
    const type = typeof event.type === "string" ? event.type : "";

    if (type === "content.part") {
      const part = event.part;
      if (typeof part !== "object" || part === null) return;
      const partRecord = part as Record<string, unknown>;
      if (partRecord.type !== KIMI_PART_TEXT) return; // think never crosses (FR-28)
      const text = typeof partRecord.text === "string" ? partRecord.text : "";
      if (text.trim() === "") return;
      // FR-28, security: credentials in message text must not cross to a different vendor.
      this.push("agent", "message", redactSensitiveText(text), null, timestamp);
      return;
    }

    if (type === KIMI_LOOP_TOOL_CALL) {
      const id = typeof event.toolCallId === "string" ? event.toolCallId : null;
      const name = typeof event.name === "string" ? event.name : "";
      if (id === null || name === "") return;
      const args = event.args;
      const argumentsText = args === undefined ? "" : JSON.stringify(args);
      this.openCall(id, name, argumentsText, timestamp);
      return;
    }

    if (type === KIMI_LOOP_TOOL_RESULT) {
      const id = typeof event.toolCallId === "string" ? event.toolCallId : null;
      if (id === null) return;
      const result = event.result;
      const resultRecord =
        typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
      const output = typeof resultRecord.output === "string" ? resultRecord.output : "";
      this.closeCall(id, output, resultRecord.isError === true);
    }
  }

  /**
   * Opens one tool-call turn. The result is not here yet: it arrives as a `tool` message or a
   * `tool.result` event, and until then the call stays unanswered (FR-54's broken-tail signal).
   */
  private openCall(
    id: string,
    name: string,
    argumentsText: string,
    timestamp: string | null,
  ): void {
    const safeArguments = redactSensitiveArgumentsText(argumentsText);
    const effect = effectOf(name);
    const record: ToolCallRecord = {
      toolName: name,
      argumentsText: safeArguments,
      outcomeLine: redactSensitiveText(
        `${name}(${singleLine(safeArguments, ARGUMENTS_PREVIEW_LIMIT)}) → no output recorded`,
      ),
      effect,
      bodyDropped: false,
      resultRecorded: false,
    };
    this.push("agent", "tool-call", "", record, timestamp);
    this.pendingCalls.set(id, this.turns.length - 1);
    if (effect === "mutating") {
      for (const path of pathsOf(safeArguments)) this.changed.add(path);
    }
  }

  /**
   * Closes an open call with its recorded result. Only the shape of the output is measured;
   * not one fragment of it is carried (FR-24, FR-25). A result with no open call — one whose
   * call an undo removed, for example — is ignored, exactly as the engine's fold ignores it.
   */
  private closeCall(id: string, output: string, isError: boolean): void {
    const index = this.pendingCalls.get(id);
    if (index === undefined) return;
    this.pendingCalls.delete(id);
    const turn = this.turns[index];
    if (turn === undefined || turn.toolCall === null) return;
    const head = `${turn.toolCall.toolName}(${singleLine(turn.toolCall.argumentsText, ARGUMENTS_PREVIEW_LIMIT)})`;
    const measured = `${output.split("\n").length} lines, body dropped`;
    turn.toolCall.outcomeLine = redactSensitiveText(
      `${head} → ${isError ? `error, ${measured}` : measured}`,
    );
    turn.toolCall.bodyDropped = true;
    turn.toolCall.resultRecorded = true;
  }

  /** `context.undo`: remove back `count` real user turns, stopping at a compaction summary. */
  private undo(record: WireRecord): void {
    const count = record.record.count;
    if (typeof count !== "number" || count <= 0 || this.turns.length === 0) return;
    let removedUser = 0;
    while (this.turns.length > 0) {
      const last = this.turns[this.turns.length - 1];
      if (last === undefined || last.kind === "summary") break; // the fold never undoes past a compaction summary
      this.turns.pop();
      for (const [id, index] of this.pendingCalls) {
        if (index >= this.turns.length) this.pendingCalls.delete(id);
      }
      if (last.role === "user" && last.kind === "message") {
        removedUser += 1;
        if (removedUser >= count) break;
      }
    }
    // Re-index so a turn's position stays stable and dense after the removal.
    for (const [index, turn] of this.turns.entries()) turn.index = index;
  }
}

function effectOf(toolName: string): ToolEffect {
  const normalized = toolName.toLowerCase();
  if (MUTATING_TOOLS.has(normalized)) return "mutating";
  if (READ_ONLY_TOOLS.has(normalized)) return "read-only";
  return "unknown";
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
