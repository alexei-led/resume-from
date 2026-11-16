/**
 * Writing a canonical session into a new Pi session file (FR-41).
 *
 * Two shapes were deliberately not used:
 *
 * - a `compaction` entry for a summary turn. Pi's `buildContextEntries` treats the latest
 *   compaction as authoritative and drops everything before its `firstKeptEntryId`, so a
 *   summary written that way would hide every imported turn from the model.
 * - a `toolCall` content block for a tool-call turn. Pi — and the provider behind it —
 *   expects a matching `toolResult`, and FR-24 dropped the body that result would need.
 *   An imported tool call is therefore one assistant text entry carrying its outcome line,
 *   which also gives T-PI-4 its "one message entry per canonical turn".
 */

import { join } from "node:path";
import type {
  CanonicalSession,
  CanonicalTurn,
  PendingFile,
  ProvenanceMarker,
  SerializationContext,
  SerializedSession,
  TargetProfile,
} from "./contract.js";
import {
  emptyUsage,
  IMPORTED_API,
  IMPORTED_MODEL,
  IMPORTED_PROVIDER,
  MARKER_CUSTOM_TYPE,
  PI_SESSION_VERSION,
  type PiAssistantMessage,
  type PiSessionHeader,
  type PiUserMessage,
  sessionDirFor,
  sessionFileName,
  toIsoUtc,
} from "./format.js";

export interface PiSerializeDeps {
  now(): Date;
  newSessionId(): string;
  newEntryId(): string;
}

/** A turn with no visible text at all. The shape still needs one entry (T-PI-4). */
const EMPTY_TURN_TEXT = "(empty turn)";

function turnText(turn: CanonicalTurn): string {
  const text = turn.kind === "tool-call" ? (turn.toolCall?.outcomeLine ?? "") : turn.text;
  return text.trim().length > 0 ? text : EMPTY_TURN_TEXT;
}

export function serializeSession(
  session: CanonicalSession,
  target: TargetProfile,
  marker: ProvenanceMarker,
  context: SerializationContext,
  deps: PiSerializeDeps,
): SerializedSession {
  const cwd = context.cwd;
  const sessionId = deps.newSessionId();
  const createdAt = deps.now().toISOString();
  const fallbackTime = toIsoUtc(session.provenance.updatedAt) ?? createdAt;

  const header: PiSessionHeader = {
    type: "session",
    version: PI_SESSION_VERSION,
    id: sessionId,
    timestamp: createdAt,
    cwd,
  };

  const entries: Record<string, unknown>[] = [];
  let parentId: string | null = null;
  const chain = (entry: Record<string, unknown>, timestamp: string): void => {
    const id = deps.newEntryId();
    entries.push({ ...entry, id, parentId, timestamp });
    parentId = id;
  };

  // The marker first: Pi stores and shows it, and never sends it to the model (FR-47, FR-48).
  chain(
    {
      type: "custom",
      customType: MARKER_CUSTOM_TYPE,
      data: {
        sourceAgent: marker.sourceAgent,
        sourceHome: marker.sourceHome,
        sourceSessionId: marker.sourceSessionId,
        importedAt: marker.importedAt,
        droppedSummary: marker.droppedSummary,
        lines: marker.lines,
      },
    },
    createdAt,
  );

  for (const turn of session.turns) {
    const timestamp = toIsoUtc(turn.timestamp) ?? fallbackTime;
    const epoch = Date.parse(timestamp);
    const text = turnText(turn);
    if (turn.role === "user") {
      const message: PiUserMessage = {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: epoch,
      };
      chain({ type: "message", message }, timestamp);
      continue;
    }
    const message: PiAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text }],
      api: IMPORTED_API,
      provider: IMPORTED_PROVIDER,
      model: IMPORTED_MODEL,
      // Zero is honest — importing spent no tokens — and it is what C-11 demands: the
      // object must be there, with numbers Pi can add up.
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: epoch,
    };
    chain({ type: "message", message }, timestamp);
  }

  const lines = [header, ...entries].map((entry) => JSON.stringify(entry));
  const file: PendingFile = {
    absolutePath: join(
      target.sessionDir ?? sessionDirFor(target.home, cwd),
      sessionFileName(createdAt, sessionId),
    ),
    bytes: Buffer.from(`${lines.join("\n")}\n`, "utf8"),
  };

  return { sessionId, files: [file], itemCount: entries.length };
}
