/**
 * What a Codex rollout file is: where it lives, how it is named, and which entries it holds.
 *
 * Every fact here was confirmed against codex-cli 0.146.0, and the `item_completed` schema below
 * against codex-cli 0.151.0-alpha and again against 0.157.1, 0.158.0 and 0.159.2 (Constraints:
 * "Facts about Codex are verified against the installed version, never assumed"). The entry names
 * are the ones C-7, C-8 and C-12 measured: `event_msg` drives the visible history and the picker
 * preview, `response_item` drives the model history only.
 */

import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { HomePath, SessionId } from "./contract.js";

/** Codex reads this variable to find its home; so does this adapter (FR-2, FR-3). */
export const CODEX_HOME_ENV = "CODEX_HOME";

/** The version this module's format knowledge was verified against. */
export const CODEX_CLI_VERSION = "0.146.0";

/** Recorded in the rollout so a thread imported by this tool is identifiable. */
export const CODEX_ORIGINATOR = "resume-from";

/** `thread/list`'s default filter keeps interactive sources; "cli" is one of them (C-7). */
export const CODEX_SOURCE_CLI = "cli";

export const CODEX_ENTRY_SESSION_META = "session_meta";
export const CODEX_ENTRY_EVENT_MSG = "event_msg";
export const CODEX_ENTRY_RESPONSE_ITEM = "response_item";
export const CODEX_ENTRY_COMPACTED = "compacted";

export const CODEX_EVENT_USER_MESSAGE = "user_message";
export const CODEX_EVENT_AGENT_MESSAGE = "agent_message";

/**
 * The second dialogue schema (C-12): one `event_msg` per turn, whose kind is `payload.item.type`
 * rather than `payload.type`. A rollout that speaks it has no `user_message`/`agent_message`
 * entries at all, so reading only those two names yields zero dialogue.
 */
export const CODEX_EVENT_ITEM_COMPLETED = "item_completed";

/** `payload.item.type` values that carry a turn this module can use (C-12). */
export const CODEX_THREAD_ITEM_USER_MESSAGE = "UserMessage";
export const CODEX_THREAD_ITEM_AGENT_MESSAGE = "AgentMessage";
export const CODEX_THREAD_ITEM_COMMAND_EXECUTION = "CommandExecution";
export const CODEX_THREAD_ITEM_FILE_CHANGE = "FileChange";
export const CODEX_THREAD_ITEM_EXTENSION = "Extension";
export const CODEX_THREAD_ITEM_IMAGE_VIEW = "ImageView";

/** A call to a server tool, named by `server` and `tool` rather than by a model-visible name. */
export const CODEX_THREAD_ITEM_MCP_TOOL_CALL = "McpToolCall";

/** An action on another agent of the same client, named by its own `tool` field. */
export const CODEX_THREAD_ITEM_COLLAB_AGENT_TOOL_CALL = "CollabAgentToolCall";

/**
 * Item kinds that carry no turn: reasoning cannot move (C-4), a compaction has no text, and a
 * subagent activity marker reports progress that its own tool call already records.
 */
export const CODEX_THREAD_ITEM_REASONING = "Reasoning";
export const CODEX_THREAD_ITEM_CONTEXT_COMPACTION = "ContextCompaction";
export const CODEX_THREAD_ITEM_SUB_AGENT_ACTIVITY = "SubAgentActivity";

/** The one `Extension.kind` measured to be a read: a web search (C-12). */
export const CODEX_EXTENSION_KIND_WEB_SEARCH = "web.search";

export const CODEX_ITEM_FUNCTION_CALL = "function_call";
export const CODEX_ITEM_FUNCTION_CALL_OUTPUT = "function_call_output";
export const CODEX_ITEM_CUSTOM_TOOL_CALL = "custom_tool_call";
export const CODEX_ITEM_CUSTOM_TOOL_CALL_OUTPUT = "custom_tool_call_output";

/**
 * Top-level entry types codex-cli 0.146.0 writes. An entry outside this set is an entry this
 * module does not understand: it is skipped and counted, never guessed at (C-6).
 */
export const KNOWN_ENTRY_TYPES: ReadonlySet<string> = new Set([
  CODEX_ENTRY_SESSION_META,
  CODEX_ENTRY_EVENT_MSG,
  CODEX_ENTRY_RESPONSE_ITEM,
  "turn_context",
  "world_state",
  CODEX_ENTRY_COMPACTED,
  "inter_agent_communication_metadata",
]);

/** One JSONL line of a rollout file. */
export interface RolloutEntry {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

/** The `session_meta` payload, in the fields this module uses. */
export interface CodexSessionMeta {
  id: string;
  timestamp: string | null;
  cwd: string | null;
  commit: string | null;
  branch: string | null;
}

/** Always absolute: a HomePath is an absolute path, whatever the environment holds (FR-2). */
export function defaultCodexHome(): HomePath {
  const configured = process.env[CODEX_HOME_ENV];
  return configured !== undefined && configured !== ""
    ? resolve(configured)
    : join(homedir(), ".codex");
}

/** Where Codex moves a thread once it is archived. */
export const ARCHIVED_SESSIONS_DIR = "archived_sessions";
/** Archived threads are compressed; the adapter reads them with `zlib.zstdDecompressSync`. */
export const ARCHIVED_SESSION_SUFFIX = ".jsonl.zst";
/** Archived sessions older than this are not searched (FR-61, a constant by user decision). */
export const ARCHIVED_SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function sessionsRoot(home: HomePath): string {
  return join(home, "sessions");
}

/**
 * Where a global lookup searches: the configured home and every `~/.codex*` profile. Archived
 * threads live beside the live sessions, so both are roots. These are glob patterns; discovery
 * expands them.
 */
export function searchRoots(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): string[] {
  const roots: string[] = [];
  const configured = env[CODEX_HOME_ENV];
  if (configured !== undefined && configured !== "") {
    const home = resolve(configured);
    roots.push(join(home, "sessions"), join(home, ARCHIVED_SESSIONS_DIR));
  }
  roots.push(
    join(resolve(userHome), ".codex*", "sessions"),
    join(resolve(userHome), ".codex*", ARCHIVED_SESSIONS_DIR),
  );
  return roots;
}

/** The home of a search root: the directory above `sessions` or `archived_sessions`. */
export function homeOfSessionsRoot(root: string): HomePath {
  return dirname(root);
}

/** The home of a rollout file: the directory that holds its `sessions` (or archived) root. */
export function homeOfSessionFile(filePath: string): HomePath {
  let directory = dirname(filePath);
  for (;;) {
    const name = basename(directory);
    if (name === "sessions" || name === ARCHIVED_SESSIONS_DIR) return dirname(directory);
    const parent = dirname(directory);
    if (parent === directory) return dirname(filePath);
    directory = parent;
  }
}

/** `<home>/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-mm-ss-<id>.jsonl`, as Codex lays them out. */
export function rolloutFilePath(home: HomePath, sessionId: SessionId, at: Date): string {
  const iso = at.toISOString();
  const [date = "", time = ""] = iso.slice(0, 19).split("T");
  const [year = "", month = "", day = ""] = date.split("-");
  const stamp = `${date}T${time.replaceAll(":", "-")}`;
  return join(sessionsRoot(home), year, month, day, `rollout-${stamp}-${sessionId}.jsonl`);
}

/** True when the file name is a rollout, live or archived. */
export function isRolloutFileName(name: string): boolean {
  return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

/** True when the rollout is an archived, compressed one. */
export function isArchivedRolloutFileName(name: string): boolean {
  return name.startsWith("rollout-") && name.endsWith(ARCHIVED_SESSION_SUFFIX);
}

/** The exact thread id encoded after Codex's fixed timestamp prefix. */
export function sessionIdFromRolloutFileName(name: string): string | null {
  const base = name.endsWith(ARCHIVED_SESSION_SUFFIX)
    ? name.slice(0, -ARCHIVED_SESSION_SUFFIX.length) + ".jsonl"
    : name;
  const match = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/.exec(base);
  return match?.[1] ?? null;
}

/** Rollouts below one sessions root, without following symlinks or hiding I/O failures. */
export async function listRolloutFiles(root: string): Promise<string[]> {
  const rootInfo = await lstat(root).catch((error: unknown) => {
    if (isNotFoundError(error)) return null;
    throw error;
  });
  if (rootInfo === null) return [];
  if (rootInfo.isSymbolicLink()) return [];
  if (!rootInfo.isDirectory()) throw new Error(`Codex sessions root is not a directory: ${root}`);

  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full);
      else if (
        entry.isFile() &&
        (isRolloutFileName(entry.name) || isArchivedRolloutFileName(entry.name))
      ) {
        found.push(full);
      }
    }
  };
  await walk(root);
  return found;
}

export function parseEntry(line: string): RolloutEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string") return null;
  const payload = record.payload;
  return {
    timestamp: typeof record.timestamp === "string" ? record.timestamp : "",
    type: record.type,
    payload:
      typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {},
  };
}

/**
 * A rollout that cannot be parsed line for line is truncated: Codex writes one whole JSON
 * object per line, so a line that is not one means the file was cut mid-entry.
 */
export function parseRolloutText(text: string): {
  entries: RolloutEntry[];
  truncated: boolean;
} {
  const entries: RolloutEntry[] = [];
  let truncated = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const entry = parseEntry(line);
    if (entry === null) truncated = true;
    else entries.push(entry);
  }
  return { entries, truncated };
}

export function stringifyRollout(entries: RolloutEntry[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

/**
 * A Codex entry is kilobytes; a longer line is damage, not a turn. Such a line is dropped whole and
 * the file counts as truncated, so no rollout can exhaust memory or the maximum string length (C-13).
 */
const MAX_ENTRY_LINE_CHARS = 16 * 1024 * 1024;

/** State a consumer and `streamRolloutEntries` share (C-13). */
export interface RolloutStreamState {
  /** Set by the reader when a line could not be read. */
  truncated: boolean;
  /** Set by the consumer to end the stream at the next line, without abandoning it mid-read. */
  stop: boolean;
}

/**
 * Yields the entries of a rollout without ever holding the file (C-13). A line that is not one whole
 * JSON object marks the file truncated, exactly as `parseRolloutText` does; a line longer than any
 * Codex entry is dropped whole instead of being materialized as one string.
 */
export async function* streamRolloutEntries(
  filePath: string,
  state: RolloutStreamState,
): AsyncGenerator<RolloutEntry> {
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
          // The tail of an over-long line: its newline is the last of it.
          droppingLine = false;
          continue;
        }
        const entry = line.trim() === "" ? null : parseEntry(line);
        if (entry !== null) {
          yield entry;
          if (state.stop === true) return;
        } else if (line.trim() !== "") {
          state.truncated = true;
        }
      }
      if (pending.length > MAX_ENTRY_LINE_CHARS) {
        pending = "";
        droppingLine = true;
        state.truncated = true;
      }
    }
    if (!droppingLine && pending.trim() !== "") {
      const entry = parseEntry(pending);
      if (entry !== null) yield entry;
      else state.truncated = true;
    }
  } finally {
    stream.destroy();
  }
}

export function payloadType(entry: RolloutEntry): string {
  const type = entry.payload.type;
  return typeof type === "string" ? type : "";
}

/** The entries Codex renders as history, and the only ones this module writes (C-7, C-8). */
export function isMessageEvent(entry: RolloutEntry): boolean {
  if (entry.type !== CODEX_ENTRY_EVENT_MSG) return false;
  const type = payloadType(entry);
  return type === CODEX_EVENT_USER_MESSAGE || type === CODEX_EVENT_AGENT_MESSAGE;
}

export function messageTextOf(entry: RolloutEntry): string {
  const message = entry.payload.message;
  return typeof message === "string" ? message : "";
}

export function readSessionMeta(entry: RolloutEntry): CodexSessionMeta | null {
  if (entry.type !== CODEX_ENTRY_SESSION_META) return null;
  const id = entry.payload.id ?? entry.payload.session_id;
  if (typeof id !== "string" || id === "") return null;
  const git = entry.payload.git;
  const gitRecord = typeof git === "object" && git !== null ? (git as Record<string, unknown>) : {};
  return {
    id,
    timestamp: stringOrNull(entry.payload.timestamp) ?? stringOrNull(entry.timestamp),
    cwd: stringOrNull(entry.payload.cwd),
    commit: stringOrNull(gitRecord.commit_hash),
    branch: stringOrNull(gitRecord.branch),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** ISO-8601 UTC, or null when the source recorded nothing usable. */
export function toIsoUtc(value: string | null): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}
