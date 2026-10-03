/**
 * What a Kimi Code `wire.jsonl` is: one JSON record per line, the event journal the
 * engine replays to rebuild a session's context on resume.
 *
 * Every fact here was confirmed against Kimi Code's replay fold
 * (packages/agent-core-v2/src/agent/replayBuilder/fold.ts) and real session files: the
 * dialogue lives in `context.append_message` records and `context.append_loop_event`
 * records (`content.part`, `tool.call`, `tool.result`), a compaction is a
 * `context.apply_compaction` record, and a record type outside the known set is skipped
 * and counted, never guessed at.
 */

import { createReadStream } from "node:fs";

/** Record types current Kimi Code writes. A type outside this set is not understood. */
export const KIMI_RECORD_METADATA = "metadata";
export const KIMI_RECORD_TURN_PROMPT = "turn.prompt";
export const KIMI_RECORD_TURN_ENDED = "turn.ended";
export const KIMI_RECORD_APPEND_MESSAGE = "context.append_message";
export const KIMI_RECORD_APPEND_LOOP_EVENT = "context.append_loop_event";
export const KIMI_RECORD_UNDO = "context.undo";
export const KIMI_RECORD_UNDONE = "context.undone";
export const KIMI_RECORD_CLEAR = "context.clear";
export const KIMI_RECORD_APPLY_COMPACTION = "context.apply_compaction";

export const KIMI_LOOP_STEP_BEGIN = "step.begin";
export const KIMI_LOOP_STEP_END = "step.end";
export const KIMI_LOOP_CONTENT_PART = "content.part";
export const KIMI_LOOP_TOOL_CALL = "tool.call";
export const KIMI_LOOP_TOOL_RESULT = "tool.result";

export const KIMI_PART_TEXT = "text";
export const KIMI_PART_THINK = "think";

export const KIMI_ORIGIN_USER = "user";
export const KIMI_ORIGIN_INJECTION = "injection";
export const KIMI_ORIGIN_COMPACTION_SUMMARY = "compaction_summary";

/**
 * Every top-level record type current Kimi Code writes. A record outside this set is
 * skipped and counted, never guessed at — Kimi Code's own fold ignores what it does not
 * know, and so does this reader.
 */
export const KNOWN_RECORD_TYPES: ReadonlySet<string> = new Set([
  KIMI_RECORD_METADATA,
  "runtime.set_binding",
  "profile.bind",
  "permission.set_mode",
  "permission.record_approval_result",
  "prompt.accepted",
  "prompt.steered",
  "prompt.completed",
  "prompt.aborted",
  "turn.steer",
  "turn.cancel",
  KIMI_RECORD_TURN_PROMPT,
  KIMI_RECORD_TURN_ENDED,
  "turn.step.interrupted",
  "turn.step.retrying",
  "agent.turn.started",
  "agent.turn.ended",
  "agent.message.appended",
  "agent.switched",
  KIMI_RECORD_APPEND_MESSAGE,
  KIMI_RECORD_APPEND_LOOP_EVENT,
  KIMI_RECORD_UNDO,
  KIMI_RECORD_UNDONE,
  KIMI_RECORD_CLEAR,
  KIMI_RECORD_APPLY_COMPACTION,
  "config.update",
  "llm.request",
  "llm.tools_snapshot",
  "usage.record",
  "token_counting.measured",
  "token_counting.turn_recorded",
  "token_counting.truncated",
  "token_counting.rebased",
  "interaction.request",
  "interaction.resolved",
  "file_history.tracked",
  "file_history.checkpoint",
  "plugin.session_start",
  "task.started",
  "task.terminated",
  "task.waitDelivered",
  "subagent.spawned",
  "subagent.started",
  "subagent.completed",
  "subagent.cancelled",
  "plan_mode.enter",
  "plan_mode.exit",
  "plan_mode.cancel",
  "plan.revision",
  "full_compaction.begin",
  "full_compaction.complete",
  "full_compaction.cancel",
  "staleGuard.recorded",
  "swarm_mode.enter",
  "swarm_mode.exit",
  "forked",
  "tools.update_store",
]);

/** One JSON line of a `wire.jsonl` file. */
export interface WireRecord {
  type: string;
  time: number | null;
  record: Record<string, unknown>;
}

export function parseRecord(line: string): WireRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string") return null;
  const time = record.time;
  return {
    type: record.type,
    time: typeof time === "number" && Number.isFinite(time) ? time : null,
    record,
  };
}

/**
 * A wire file that cannot be parsed line for line is truncated: Kimi Code writes one
 * whole JSON object per line, so a line that is not one means the file was cut mid-record.
 */
export function parseWireText(text: string): { records: WireRecord[]; truncated: boolean } {
  const records: WireRecord[] = [];
  let truncated = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const record = parseRecord(line);
    if (record === null) truncated = true;
    else records.push(record);
  }
  return { records, truncated };
}

export function stringifyWire(records: readonly Record<string, unknown>[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

/**
 * A wire record is kilobytes; a longer line is damage, not a turn. Such a line is dropped
 * whole and the file counts as truncated, so no session file can exhaust memory or the
 * maximum string length.
 */
const MAX_RECORD_LINE_CHARS = 16 * 1024 * 1024;

/** State a consumer and `streamWireRecords` share. */
export interface WireStreamState {
  /** Set by the reader when a line could not be read. */
  truncated: boolean;
  /** Set by the consumer to end the stream at the next line, without abandoning it mid-read. */
  stop: boolean;
}

/**
 * Yields the records of a wire file without ever holding the file whole. A line that is
 * not one whole JSON object marks the file truncated, exactly as `parseWireText` does; a
 * line longer than any wire record is dropped whole instead of being materialized as one
 * string.
 */
export async function* streamWireRecords(
  filePath: string,
  state: WireStreamState,
): AsyncGenerator<WireRecord> {
  const stream = createReadStream(filePath, { encoding: "utf8", highWaterMark: 1 << 20 });
  let pending = "";
  let droppingLine = false;
  try {
    for await (const chunk of stream) {
      pending += chunk;
      for (;;) {
        const end = pending.indexOf("\n");
        if (end === -1) break;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (droppingLine) {
          droppingLine = false;
          continue;
        }
        const record = line.trim() === "" ? null : parseRecord(line);
        if (record !== null) {
          yield record;
          if (state.stop === true) return;
        } else if (line.trim() !== "") {
          state.truncated = true;
        }
      }
      if (pending.length > MAX_RECORD_LINE_CHARS) {
        pending = "";
        droppingLine = true;
        state.truncated = true;
      }
    }
    if (!droppingLine && pending.trim() !== "") {
      const record = parseRecord(pending);
      if (record !== null) yield record;
      else state.truncated = true;
    }
  } finally {
    stream.destroy();
  }
}

/** The text parts of a message `content` array, joined. Think parts are never read (FR-28). */
export function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null
        ? (part as Record<string, unknown>).text
        : undefined,
    )
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

/** The role of a `context.append_message` message, or null when it carries none. */
export function messageRole(record: WireRecord): string | null {
  const message = record.record.message;
  if (typeof message !== "object" || message === null) return null;
  const role = (message as Record<string, unknown>).role;
  return typeof role === "string" ? role : null;
}

/** The `origin.kind` of a `context.append_message` message. */
export function messageOriginKind(record: WireRecord): string | null {
  const message = record.record.message;
  if (typeof message !== "object" || message === null) return null;
  const origin = (message as Record<string, unknown>).origin;
  if (typeof origin !== "object" || origin === null) return null;
  const kind = (origin as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : null;
}

/** The inner event of a `context.append_loop_event` record. */
export function loopEventOf(record: WireRecord): Record<string, unknown> | null {
  const event = record.record.event;
  return typeof event === "object" && event !== null ? (event as Record<string, unknown>) : null;
}

/**
 * What one record contributes to a session, decided from that record alone. One record
 * can contribute more than one turn — an assistant `context.append_message` carries its
 * text and its tool calls — so the classifier returns every contribution in source order.
 * The listing counts these and the loader builds turns from them, so the two cannot
 * disagree: a turn cannot be counted as one thing and built as another.
 */
export type RecordContribution =
  | { kind: "message"; role: "user" | "agent"; text: string }
  | { kind: "summary"; text: string }
  | { kind: "tool-call" }
  | { kind: "none" };

export type RecordTurn = RecordContribution[] | { kind: "unknown" };

function messageContributions(record: WireRecord): RecordContribution[] {
  const role = messageRole(record);
  const origin = messageOriginKind(record);
  const message = record.record.message;
  if (role === null || typeof message !== "object" || message === null) return [{ kind: "none" }];
  const messageRecord = message as Record<string, unknown>;

  if (role === "user") {
    if (origin === KIMI_ORIGIN_COMPACTION_SUMMARY) {
      const text = textOfContent(messageRecord.content);
      return text.trim() === "" ? [{ kind: "none" }] : [{ kind: "summary", text }];
    }
    if (origin !== KIMI_ORIGIN_USER) return [{ kind: "none" }]; // injections and the like
    const text = textOfContent(messageRecord.content);
    return text.trim() === "" ? [{ kind: "none" }] : [{ kind: "message", role: "user", text }];
  }

  if (role === "assistant") {
    const contributions: RecordContribution[] = [];
    const text = textOfContent(messageRecord.content);
    if (text.trim() !== "") contributions.push({ kind: "message", role: "agent", text });
    const toolCalls = Array.isArray(messageRecord.toolCalls) ? messageRecord.toolCalls : [];
    for (const call of toolCalls) {
      if (
        typeof call === "object" &&
        call !== null &&
        typeof (call as Record<string, unknown>).id === "string"
      ) {
        contributions.push({ kind: "tool-call" });
      }
    }
    return contributions.length === 0 ? [{ kind: "none" }] : contributions;
  }

  if (role === "tool") return [{ kind: "none" }]; // the result of a call, consumed by it
  return [{ kind: "none" }];
}

function loopEventContributions(record: WireRecord): RecordContribution[] {
  const event = loopEventOf(record);
  if (event === null) return [{ kind: "none" }];
  const type = typeof event.type === "string" ? event.type : "";
  if (type === KIMI_LOOP_CONTENT_PART) {
    const part = event.part;
    if (typeof part !== "object" || part === null) return [{ kind: "none" }];
    const partRecord = part as Record<string, unknown>;
    if (partRecord.type !== KIMI_PART_TEXT) return [{ kind: "none" }]; // think never crosses (FR-28)
    const text = typeof partRecord.text === "string" ? partRecord.text : "";
    return text.trim() === "" ? [{ kind: "none" }] : [{ kind: "message", role: "agent", text }];
  }
  if (type === KIMI_LOOP_TOOL_CALL) {
    const name = event.name;
    return typeof name === "string" && name !== "" ? [{ kind: "tool-call" }] : [{ kind: "none" }];
  }
  if (type === KIMI_LOOP_TOOL_RESULT) return [{ kind: "none" }]; // consumed by its call
  return [{ kind: "none" }]; // step.begin, step.end and the rest carry no turn
}

/**
 * Classifies one record without building anything. A type outside the known set is
 * reported, never guessed at; records that carry no turn (prompt lifecycle, usage, undo
 * bookkeeping, think parts) are understood and counted as none.
 */
export function classifyRecord(record: WireRecord): RecordTurn {
  if (!KNOWN_RECORD_TYPES.has(record.type)) return { kind: "unknown" };
  if (record.type === KIMI_RECORD_APPEND_MESSAGE) return messageContributions(record);
  if (record.type === KIMI_RECORD_APPEND_LOOP_EVENT) return loopEventContributions(record);
  if (record.type === KIMI_RECORD_APPLY_COMPACTION) {
    const summary = record.record.summary;
    return typeof summary === "string" && summary.trim() !== ""
      ? [{ kind: "summary", text: summary }]
      : [{ kind: "none" }];
  }
  return [{ kind: "none" }];
}

/** How many turns one record contributes, for the selection list's count (FR-11). */
export function countRecordTurns(record: WireRecord): { turns: number; unknown: boolean } {
  const classified = classifyRecord(record);
  if (!Array.isArray(classified)) return { turns: 0, unknown: true };
  return { turns: classified.filter((part) => part.kind !== "none").length, unknown: false };
}
