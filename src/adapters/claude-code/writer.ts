/**
 * Writing a canonical session into a new Claude Code session file.
 *
 * C-9 measured that a file holding one `user` entry and one `assistant` entry is listed by the
 * native resume list and opened by `claude --resume <id>` as native turns. This module writes
 * exactly those two entry types and nothing else: the other eight types of C-3 are eight more
 * ways to corrupt an internal application database.
 *
 * Nothing here touches the filesystem except to read. `serialize` returns bytes;
 * `src/import/landing/` creates the files (FR-49, FR-53).
 */

import { createHash, randomUUID } from "node:crypto";
import { type Dirent, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type {
  CanonicalSession,
  CanonicalTurn,
  ProvenanceMarker,
  SerializationContext,
  SerializedSession,
  SessionId,
  TargetProfile,
  ValidationDefect,
} from "./contract.js";
import {
  asObject,
  asString,
  ENTRY_TYPE_ASSISTANT,
  ENTRY_TYPE_SYSTEM,
  ENTRY_TYPE_USER,
  parseJsonl,
  toIsoUtc,
  WRITTEN_ENTRY_TYPES,
} from "./entries.js";
import { projectDir, SESSION_FILE_SUFFIX, sessionFilePath } from "./layout.js";

/** The version C-9 was measured against. Written so the target reads a version it knows. */
export const CLAUDE_CODE_FORMAT_VERSION = "2.1.220";
/**
 * The model field of an imported turn. No model produced it, and none is claimed.
 * "<synthetic>" is the value Claude Code resumes without a "model could not be restored" notice.
 */
export const IMPORTED_MODEL = "<synthetic>";
export const USER_TYPE = "external";
const EMPTY_TURN_TEXT = "(empty message)";
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const INERT_PROJECT_FILES = new Set(["sessions-index.json"]);
/** The shape a session registration index would take. Notes, scripts and folders are not it. */
const INDEX_FILE_SUFFIX = ".json";
const MAX_MINT_ATTEMPTS = 8;

interface EntryContext {
  sessionId: SessionId;
  repoPath: string;
  branch: string;
}

/** sha256-derived uuid, so one minted session id fixes every entry of the file. */
function deterministicUuid(seed: string, index: number): string {
  const digest = createHash("sha256").update(`${seed}:${index}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Refuse when the repository's record holds a JSON file this adapter does not recognise.
 *
 * Such a file may be a registration index the new session would have to be added to, and
 * adding it would mean opening an existing file for writing. FR-49 outranks convenience, so
 * the adapter declares the limitation instead of guessing (C-3). Claude Code reads only
 * session files there, so folders and other files (users and agents keep notes, scripts and
 * state beside the sessions) cannot hold a registration and are left alone.
 */
function refuseUnrecognisedProjectRecord(home: string, repoPath: string): void {
  const dir = projectDir(home, repoPath);
  let items: Dirent[];
  try {
    items = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // a record that does not exist yet is a new path, which is exactly what is allowed
  }
  for (const item of items) {
    if (!item.isFile() || !item.name.endsWith(INDEX_FILE_SUFFIX)) continue;
    if (INERT_PROJECT_FILES.has(item.name)) continue;
    throw new Error(
      `Claude Code adapter: ${path.join(dir, item.name)} is not a session file this adapter ` +
        "recognises. Registering the imported session may require editing it, and this adapter " +
        "only ever creates new paths (FR-49). Import refused.",
    );
  }
}

/** A session id whose file does not exist in the target home. A collision is never overwritten. */
function mintSessionId(home: string, repoPath: string): SessionId {
  for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
    const id = randomUUID();
    if (!existsSync(sessionFilePath(home, repoPath, id))) return id;
  }
  throw new Error(`Claude Code adapter: could not mint an unused session id in ${home}`);
}

function envelope(ctx: EntryContext, index: number, parentUuid: string | null, timestamp: string) {
  return {
    parentUuid,
    isSidechain: false,
    userType: USER_TYPE,
    cwd: ctx.repoPath,
    sessionId: ctx.sessionId,
    version: CLAUDE_CODE_FORMAT_VERSION,
    gitBranch: ctx.branch,
    uuid: deterministicUuid(ctx.sessionId, index),
    timestamp,
  };
}

/**
 * The provenance marker (FR-47, FR-48).
 *
 * It rides in one `system` entry with subtype `informational` and level `info`. Claude Code
 * renders it entirely gray, and its API filter excludes every `system` entry except
 * `local_command`, so it never reaches the model. A `user` entry flagged `isMeta` was the
 * earlier shape: it was not shown on resume and was not excluded from model context.
 */
function markerEntry(ctx: EntryContext, marker: ProvenanceMarker) {
  return {
    ...envelope(ctx, 0, null, toIsoUtc(marker.importedAt) ?? new Date(0).toISOString()),
    type: ENTRY_TYPE_SYSTEM,
    subtype: "informational",
    level: "info",
    isMeta: false,
    content: marker.lines.join("\n"),
  };
}

/** What one canonical turn says, as text. A tool call crosses as its one outcome line (FR-23). */
function turnText(turn: CanonicalTurn): string {
  const call = turn.toolCall;
  if (turn.kind === "tool-call" && call !== null) {
    // FR-27: the tool name crosses unchanged, whatever adapter recorded the call.
    return call.outcomeLine.includes(call.toolName)
      ? call.outcomeLine
      : `${call.toolName}(${call.argumentsText}) → ${call.outcomeLine}`;
  }
  return turn.text.trim() === "" ? EMPTY_TURN_TEXT : turn.text;
}

function buildEntries(
  session: CanonicalSession,
  marker: ProvenanceMarker,
  ctx: EntryContext,
): Record<string, unknown>[] {
  const fallbackTimestamp =
    toIsoUtc(marker.importedAt) ??
    toIsoUtc(session.provenance.updatedAt) ??
    new Date(0).toISOString();
  const entries: Record<string, unknown>[] = [markerEntry(ctx, marker)];

  for (const turn of session.turns) {
    const index = entries.length;
    const previous = entries[index - 1];
    const parentUuid = asString(previous?.uuid);
    const timestamp = toIsoUtc(turn.timestamp) ?? fallbackTimestamp;
    const base = envelope(ctx, index, parentUuid, timestamp);
    const text = turnText(turn);

    if (turn.role === "user") {
      entries.push({
        ...base,
        type: ENTRY_TYPE_USER,
        message: { role: "user", content: text },
      });
      continue;
    }
    entries.push({
      ...base,
      type: ENTRY_TYPE_ASSISTANT,
      message: {
        id: `msg_${base.uuid.replace(/-/g, "").slice(0, 24)}`,
        type: "message",
        role: "assistant",
        model: IMPORTED_MODEL,
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          service_tier: "standard",
        },
      },
    });
  }
  return entries;
}

/** Bytes only: the file is created by `src/import/landing/`, never here (FR-49, FR-53). */
export function serialize(
  session: CanonicalSession,
  target: TargetProfile,
  marker: ProvenanceMarker,
  context: SerializationContext,
): SerializedSession {
  const repoPath = context.cwd;
  refuseUnrecognisedProjectRecord(target.home, repoPath);

  const sessionId = mintSessionId(target.home, repoPath);
  const entries = buildEntries(session, marker, {
    sessionId,
    repoPath,
    branch: session.provenance.repo.branch ?? "",
  });
  const text = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

  return {
    sessionId,
    files: [
      {
        absolutePath: sessionFilePath(target.home, repoPath, sessionId),
        bytes: Buffer.from(text, "utf8"),
      },
    ],
    itemCount: entries.length,
  };
}

function checkEntry(
  entry: Record<string, unknown>,
  index: number,
  previousUuid: string | null,
  sessionId: SessionId,
  defects: ValidationDefect[],
): void {
  const at = `items/${index}`;
  const type = entry.type;
  if (typeof type !== "string" || !WRITTEN_ENTRY_TYPES.includes(type)) {
    defects.push({
      path: `${at}/type`,
      message: `entry type ${JSON.stringify(type)} is not one of ${WRITTEN_ENTRY_TYPES.join(", ")}; Claude Code would not show it as a turn`,
    });
  }
  if (asString(entry.uuid) === null) {
    defects.push({
      path: `${at}/uuid`,
      message: "missing uuid; the transcript chain cannot be built",
    });
  }
  const timestamp = asString(entry.timestamp);
  if (timestamp === null || !TIMESTAMP_PATTERN.test(timestamp)) {
    defects.push({
      path: `${at}/timestamp`,
      message: `malformed timestamp ${JSON.stringify(entry.timestamp)}; the resume list sorts on it`,
    });
  }
  if (asString(entry.sessionId) !== sessionId) {
    defects.push({
      path: `${at}/sessionId`,
      message: `entry sessionId ${JSON.stringify(entry.sessionId)} does not match the session being written`,
    });
  }
  if (index === 0) {
    if (entry.parentUuid !== null) {
      defects.push({
        path: `${at}/parentUuid`,
        message: "the first entry must have a null parentUuid",
      });
    }
  } else if (asString(entry.parentUuid) !== previousUuid) {
    defects.push({
      path: `${at}/parentUuid`,
      message: "parentUuid does not point at the entry before it; the transcript would break",
    });
  }

  // The marker entry carries visible content and no message (FR-47, FR-48). Its subtype,
  // level and isMeta are what make Claude Code show it gray and keep it out of model context.
  if (type === ENTRY_TYPE_SYSTEM) {
    if (asString(entry.content) === null) {
      defects.push({
        path: `${at}/content`,
        message: "system marker entry has no content; Claude Code would show nothing",
      });
    }
    if (entry.subtype !== "informational" || entry.level !== "info" || entry.isMeta !== false) {
      defects.push({
        path: `${at}`,
        message:
          "system marker entry is not informational/info with isMeta false; Claude Code may show it as a turn or send it to the model",
      });
    }
    return;
  }

  const message = asObject(entry.message);
  if (message === null) {
    defects.push({
      path: `${at}/message`,
      message: "null or missing message body; Claude Code would fail on it",
    });
    return;
  }
  const expectedRole = type === ENTRY_TYPE_ASSISTANT ? "assistant" : "user";
  if (message.role !== expectedRole) {
    defects.push({
      path: `${at}/message/role`,
      message: `message role ${JSON.stringify(message.role)} does not match entry type ${JSON.stringify(type)}`,
    });
  }
  const content = message.content;
  const emptyContent =
    content === null ||
    content === undefined ||
    (typeof content === "string" && content === "") ||
    (Array.isArray(content) && content.length === 0);
  if (emptyContent) {
    defects.push({
      path: `${at}/message/content`,
      message: "empty message content; the turn would be invisible",
    });
  }
  if (type === ENTRY_TYPE_ASSISTANT) {
    if (asObject(message.usage) === null) {
      defects.push({
        path: `${at}/message/usage`,
        message: "assistant message has no usage object",
      });
    }
    if (asString(message.model) === null) {
      defects.push({
        path: `${at}/message/model`,
        message: "assistant message has no model",
      });
    }
  }
}

/** Every structural defect, not the first (FR-50). Empty means the bytes may be placed. */
export function validate(serialized: SerializedSession): ValidationDefect[] {
  const defects: ValidationDefect[] = [];
  if (serialized.files.length === 0) {
    defects.push({ path: "files", message: "no file to place" });
  }
  let index = 0;
  serialized.files.forEach((file, fileIndex) => {
    if (!path.isAbsolute(file.absolutePath)) {
      defects.push({
        path: `files/${fileIndex}/absolutePath`,
        message: "path is not absolute",
      });
    }
    if (!file.absolutePath.endsWith(`${serialized.sessionId}${SESSION_FILE_SUFFIX}`)) {
      defects.push({
        path: `files/${fileIndex}/absolutePath`,
        message: `file name does not match the session id ${serialized.sessionId}; Claude Code keys a session by its file name`,
      });
    }
    const { entries, unreadable } = parseJsonl(file.bytes.toString("utf8"));
    if (unreadable !== null) {
      defects.push({
        path: `files/${fileIndex}`,
        message: `not a readable session file: ${unreadable}`,
      });
    }
    let previousUuid: string | null = null;
    for (const entry of entries) {
      checkEntry(entry, index, previousUuid, serialized.sessionId, defects);
      previousUuid = asString(entry.uuid);
      index++;
    }
  });
  if (index !== serialized.itemCount) {
    defects.push({
      path: "itemCount",
      message: `itemCount is ${serialized.itemCount} but the files hold ${index} items; FR-52 compares the two`,
    });
  }
  return defects;
}
