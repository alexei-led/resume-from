/**
 * The target role: a canonical session becomes a new Kimi Code session directory — a
 * `state.json` the session index reads and a `wire.jsonl` the resume replay folds into
 * native turns.
 *
 * The shape written here is the one Kimi Code's own kimi-cli migration writes and its users
 * resume every day: a `metadata` record, one synthesized `turn.prompt` per conversation
 * turn, `context.append_message` records carrying the dialogue, and a `turn.ended` per
 * turn that has assistant content. That path is verified by Kimi Code itself; this module
 * follows it instead of inventing a leaner file.
 */

import { dirname } from "node:path";
import type {
  CanonicalSession,
  CanonicalTurn,
  ProvenanceMarker,
  SerializationContext,
  SerializedSession,
  SourceProvenance,
  TargetProfile,
  ValidationDefect,
} from "./contract.js";
import {
  agentDirPath,
  KIMI_MAIN_AGENT_ID,
  KIMI_SESSION_META_VERSION,
  KIMI_WIRE_PROTOCOL_VERSION,
  sessionDirPath,
  sessionsRoot,
  stateFilePath,
  wireFilePath,
} from "./layout.js";
import { inspectKimiState, inspectKimiWire } from "./validation.js";
import { stringifyWire } from "./wire.js";

// The seam's normative declaration lives in contract.ts; re-exported so existing import
// sites keep working without a second, silently driftable copy.
export type { KimiCodeSerializeDeps } from "./contract.js";

import type { KimiCodeSerializeDeps } from "./contract.js";

const TITLE_LIMIT = 50;
const PROMPT_LIMIT = 200;

export function serializeKimiCode(
  session: CanonicalSession,
  target: TargetProfile,
  marker: ProvenanceMarker,
  context: SerializationContext,
  deps: KimiCodeSerializeDeps,
): SerializedSession {
  const importedAt = resolveStamp(marker.importedAt, session.provenance);
  const stampMs = importedAt.getTime();
  const sessionId = `session_${deps.newSessionId()}`;
  const dir = sessionDirPath(sessionsRoot(target.home), context.cwd, sessionId);

  const wireRecords = buildWireRecords(session, stampMs, sessionId);
  const state = buildState(session, sessionId, dir, context, marker, importedAt);

  // Commit order is part of the format contract: the landing commits these files one at a
  // time, first to last, and an interrupted landing must never leave a session the agent
  // would list but cannot open. wire.jsonl first: without state.json next to it, Kimi Code's
  // session index never lists the directory and `kimi --resume` cannot resolve it, so the
  // intermediate state is a file no agent reads — the same guarantee the store gives its
  // one-file commits.
  return {
    sessionId,
    files: [
      {
        absolutePath: wireFilePath(dir),
        bytes: Buffer.from(stringifyWire(wireRecords), "utf8"),
      },
      {
        absolutePath: stateFilePath(dir),
        bytes: Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8"),
      },
    ],
    // What Kimi Code stores and `readBack` recounts: one record per context message.
    itemCount: wireRecords.filter((record) => record.type === "context.append_message").length,
  };
}

/**
 * FR-50, read against how Kimi Code opens a session: without `state.json` the session index
 * never lists the directory, and without well-formed `context.append_message` records the
 * resume replay has no conversation to rebuild.
 */
export function validateKimiCode(serialized: SerializedSession): ValidationDefect[] {
  const defects: ValidationDefect[] = [];
  if (serialized.files.length === 0) {
    defects.push({
      path: "files",
      message: "a Kimi Code session is a wire.jsonl and a state.json",
    });
    return defects;
  }
  const wire = serialized.files.find((file) => file.absolutePath.endsWith("wire.jsonl"));
  const state = serialized.files.find((file) => file.absolutePath.endsWith("state.json"));
  if (wire === undefined || state === undefined) {
    defects.push({
      path: "files",
      message: "a Kimi Code session needs exactly a wire.jsonl and a state.json",
    });
    return defects;
  }
  if (serialized.files.length !== 2) {
    defects.push({
      path: "files",
      message: `a Kimi Code session is two files, not ${serialized.files.length}`,
    });
  }
  // The wire lives under the session directory's agents/main record directory, one level
  // below the state.json — same session directory, not the same folder.
  if (!wire.absolutePath.startsWith(`${dirname(state.absolutePath)}${"/"}`)) {
    defects.push({
      path: "files",
      message: "the wire must live inside the state.json's session directory",
    });
  }

  const stateInspection = inspectKimiState(
    state.bytes.toString("utf8"),
    serialized.sessionId,
    null,
  );
  defects.push(...stateInspection.defects);

  const wireInspection = inspectKimiWire(wire.bytes.toString("utf8"));
  defects.push(...wireInspection.defects);
  if (wireInspection.itemCount !== serialized.itemCount) {
    defects.push({
      path: "itemCount",
      message: `itemCount says ${serialized.itemCount}, the wire holds ${wireInspection.itemCount} messages`,
    });
  }
  return defects;
}

interface TurnGroup {
  readonly turns: readonly CanonicalTurn[];
  readonly opensWithUser: boolean;
}

/** One group per user message, plus a fallback group for a leading agent-only run. */
function splitIntoTurns(turns: readonly CanonicalTurn[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let current: CanonicalTurn[] = [];
  let opensWithUser = false;
  const flush = (): void => {
    if (current.length === 0) return;
    groups.push({ turns: current, opensWithUser });
    current = [];
    opensWithUser = false;
  };
  for (const turn of turns) {
    if (turn.role === "user" && turn.kind === "message") {
      flush();
      current = [turn];
      opensWithUser = true;
      continue;
    }
    current.push(turn);
  }
  flush();
  return groups;
}

function buildWireRecords(
  session: CanonicalSession,
  stampMs: number,
  sessionId: string,
): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [
    { type: "metadata", protocol_version: KIMI_WIRE_PROTOCOL_VERSION, created_at: stampMs },
  ];
  const messageIds = messageIdSequence(sessionId);
  const groups = splitIntoTurns(session.turns);
  groups.forEach((group, turnId) => {
    const opener = group.opensWithUser ? group.turns[0] : undefined;
    records.push({
      type: "turn.prompt",
      agentId: KIMI_MAIN_AGENT_ID,
      input: opener !== undefined ? [{ type: "text", text: opener.text }] : [],
      origin: group.opensWithUser
        ? { kind: "user" }
        : { kind: "system_trigger", name: "imported_orphan" },
      time: timeOf(opener, stampMs),
    });
    for (const turn of group.turns) {
      for (const message of toMessageRecords(turn, stampMs, messageIds)) {
        records.push(message);
      }
    }
    if (group.turns.some((turn) => turn.role === "agent")) {
      records.push({
        type: "turn.ended",
        agentId: KIMI_MAIN_AGENT_ID,
        turnId,
        reason: "completed",
        time: stampMs,
      });
    }
  });
  return records;
}

/** One canonical turn becomes its `context.append_message` records, in wire order. */
function toMessageRecords(
  turn: CanonicalTurn,
  stampMs: number,
  nextMessageId: () => string,
): Record<string, unknown>[] {
  const time = timeOf(turn, stampMs);
  if (turn.kind === "summary") {
    if (turn.text.trim() === "") return [];
    return [
      appendMessage(
        {
          role: "user",
          content: [{ type: "text", text: turn.text }],
          toolCalls: [],
          origin: { kind: "compaction_summary" },
          id: nextMessageId(),
        },
        time,
      ),
    ];
  }
  if (turn.kind === "message") {
    if (turn.text.trim() === "") return [];
    if (turn.role === "user") {
      return [
        appendMessage(
          {
            role: "user",
            content: [{ type: "text", text: turn.text }],
            toolCalls: [],
            origin: { kind: "user" },
            id: nextMessageId(),
          },
          time,
        ),
      ];
    }
    return [
      appendMessage(
        { role: "assistant", content: [{ type: "text", text: turn.text }], toolCalls: [] },
        time,
      ),
    ];
  }
  // A tool call crosses as the call's one-line outcome, as text — never as a replayable
  // tool_call structure: the imported history must not hold anything the target agent could
  // mistake for a call to run (FR-26, NG-6), and the record's own line already names the tool
  // and what happened (FR-23, FR-25, FR-27).
  const call = turn.toolCall;
  if (call === null || call.outcomeLine.trim() === "") return [];
  return [
    appendMessage(
      { role: "assistant", content: [{ type: "text", text: call.outcomeLine }], toolCalls: [] },
      time,
    ),
  ];
}

function appendMessage(message: Record<string, unknown>, time: number): Record<string, unknown> {
  return { type: "context.append_message", agentId: KIMI_MAIN_AGENT_ID, message, time };
}

/** Deterministic per-session message ids: derived from the session id, never read from a clock. */
function messageIdSequence(sessionId: string): () => string {
  let counter = 0;
  return () => `${sessionId}-msg-${counter++}`;
}

function timeOf(turn: CanonicalTurn | undefined, fallbackMs: number): number {
  if (turn === undefined || turn.timestamp === null) return fallbackMs;
  const parsed = Date.parse(turn.timestamp);
  return Number.isNaN(parsed) ? fallbackMs : parsed;
}

function buildState(
  session: CanonicalSession,
  sessionId: string,
  dir: string,
  context: SerializationContext,
  marker: ProvenanceMarker,
  importedAt: Date,
): Record<string, unknown> {
  const firstUser = session.turns.find((turn) => turn.role === "user" && turn.kind === "message");
  const prompt = firstUser?.text ?? "";
  const title = titleOf(prompt);
  return {
    id: sessionId,
    version: KIMI_SESSION_META_VERSION,
    cwd: context.cwd,
    createdAt: importedAt.getTime(),
    updatedAt: importedAt.getTime(),
    archived: false,
    title,
    titleKind: "replaceable",
    isCustomTitle: false,
    lastPrompt: prompt.slice(0, PROMPT_LIMIT),
    lastTurnReason: "completed",
    agents: {
      [KIMI_MAIN_AGENT_ID]: {
        // Kimi Code's Session.resume() treats this as the record directory it reads
        // wire.jsonl from — the session's own agents/main, never the user's project.
        homedir: agentDirPath(dir),
        type: "main",
        parentAgentId: null,
      },
    },
    custom: {
      imported_from_resume_from: true,
      source_agent: session.provenance.ref.agent,
      source_home: session.provenance.ref.home,
      source_session_id: session.provenance.ref.id,
      imported_at: importedAt.toISOString(),
      dropped_summary: marker.droppedSummary,
    },
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
 * Resolve the stamp for the serialized files without reading the clock.
 * Chain: marker.importedAt → session.provenance.updatedAt → session.provenance.startedAt.
 * If none parse, fall back to the Unix epoch so serialize stays deterministic (the preview
 * and the commit of one request must agree, and no ambient state is read).
 */
function resolveStamp(importedAt: string, provenance: SourceProvenance): Date {
  for (const candidate of [importedAt, provenance.updatedAt, provenance.startedAt]) {
    const t = Date.parse(candidate);
    if (!Number.isNaN(t)) return new Date(t);
  }
  return new Date(0);
}
