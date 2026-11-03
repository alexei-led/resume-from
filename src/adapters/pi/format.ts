/**
 * Everything this tool knows about Pi's session file layout.
 *
 * Verified against the installed Pi 0.83.0 (`dist/core/session-manager.js`,
 * `dist/config.js`), not assumed:
 *
 * - the home is Pi's agent directory: `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`;
 * - sessions live in `<home>/sessions/<encoded cwd>/<timestamp>_<id>.jsonl`;
 * - a file is JSONL: one `session` header, then entries with `id`/`parentId`/`timestamp`;
 * - an assistant message without a numeric `usage` object crashes Pi (C-11).
 *
 * When Pi changes, this file changes. Nothing outside this folder holds these facts.
 */

import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ToolEffect } from "./contract.js";

/** Pi's current session file version (`CURRENT_SESSION_VERSION`). */
export const PI_SESSION_VERSION = 3;

export const SESSIONS_DIR_NAME = "sessions";
const PI_CONFIG_DIR_NAME = ".pi";
const PI_AGENT_DIR_NAME = "agent";
/** Pi's own override of its agent directory (`ENV_AGENT_DIR` in Pi's config). */
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
/** Pi's own override of an individual session directory. */
export const PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

/**
 * The customType of the provenance entry. It is written as a `custom` entry, which Pi's
 * `buildSessionContext` drops on the floor: the marker is stored and shown, never sent to
 * the model (FR-47, FR-48). `src/host/pi-extension/` registers the renderer that shows it.
 */
export const MARKER_CUSTOM_TYPE = "resume-from-provenance";

/** Prefix of the title of a session file that cannot be read (T-PI-13). */
export const UNREADABLE_TITLE_PREFIX = "(unreadable) ";

/** What replaces a tool result body (FR-24, FR-25). */
export const DROPPED_BODY_NOTE = "(content dropped: imported session, may be stale)";

/** Context window assumed for Pi when configuration overrides none (FR-18). */
export const DEFAULT_WINDOW_TOKENS = 200_000;

/** What an imported assistant turn declares about itself. It cost nothing to import. */
export const IMPORTED_API = "resume-from";
export const IMPORTED_PROVIDER = "resume-from";
export const IMPORTED_MODEL = "imported-session";

const MAX_TITLE_LENGTH = 80;
const MAX_OUTCOME_ARGUMENTS = 60;

/** Pi's default agent directory. Mirrors Pi's own `getAgentDir()`. */
export function defaultPiHome(): string {
  const override = process.env[ENV_AGENT_DIR];
  if (override && override.trim().length > 0) return resolve(override);
  return join(homedir(), PI_CONFIG_DIR_NAME, PI_AGENT_DIR_NAME);
}

/** Pi's encoding of a working directory into one directory name. */
export function encodeCwd(cwd: string): string {
  const resolved = resolve(cwd);
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function sessionsRoot(home: string): string {
  return join(home, SESSIONS_DIR_NAME);
}

/**
 * Where a global lookup searches. Pi treats any directory whose name holds "sessions" as a
 * session directory (`sessions`, `sessions-work`, and so on): the roots are those directories,
 * and the home of a session found below one is the agent directory that contains it.
 */
export function searchRoots(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): string[] {
  const roots: string[] = [];
  const agentDir = env[ENV_AGENT_DIR];
  if (agentDir !== undefined && agentDir.trim().length > 0) {
    roots.push(join(resolve(agentDir), SESSIONS_DIR_NAME));
  }
  const sessionDir = env[PI_SESSION_DIR_ENV];
  if (sessionDir !== undefined && sessionDir.trim().length > 0) {
    roots.push(resolve(sessionDir));
  }
  roots.push(join(resolve(userHome), PI_CONFIG_DIR_NAME, PI_AGENT_DIR_NAME, "*sessions*"));
  return roots;
}

/** The home of a search root: the agent directory above a `*sessions*` directory. */
export function homeOfSessionsRoot(root: string): string {
  return dirname(root);
}

/** The agent directory that holds a session directory, and so the session file. */
export function homeOfSessionFile(filePath: string): string {
  let directory = dirname(filePath);
  for (;;) {
    if (basename(directory).includes(SESSIONS_DIR_NAME)) return dirname(directory);
    const parent = dirname(directory);
    if (parent === directory) return dirname(filePath);
    directory = parent;
  }
}

export function sessionDirFor(home: string, cwd: string): string {
  return join(sessionsRoot(home), encodeCwd(cwd));
}

/** Pi's own file naming: the ISO timestamp with `:` and `.` replaced, then the id. */
export function sessionFileName(isoTimestamp: string, sessionId: string): string {
  return `${isoTimestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
}

/** The session id Pi would read out of a session file name, or null. */
export function sessionIdFromFileName(fileName: string): string | null {
  const match = /^.*?_(.+)\.jsonl$/.exec(fileName);
  return match?.[1] ?? null;
}

// --- The on-disk shapes -----------------------------------------------------------

export interface PiSessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
}

export interface PiEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export type PiEntry = PiEntryBase & Record<string, unknown>;

export interface PiTextBlock {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface PiThinkingBlock {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
}

export interface PiImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PiToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type PiContentBlock = PiTextBlock | PiThinkingBlock | PiToolCallBlock | PiImageBlock;

/** The six numbers Pi dereferences without a guard. Missing any of them is C-11. */
export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface PiUserMessage {
  role: "user";
  content: string | PiContentBlock[];
  timestamp: number;
}

export interface PiAssistantMessage {
  role: "assistant";
  content: PiContentBlock[];
  api: string;
  provider: string;
  model: string;
  usage: PiUsage;
  stopReason: string;
  timestamp: number;
}

export interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: PiContentBlock[];
  isError: boolean;
  timestamp: number;
}

export type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

export interface PiMessageEntry extends PiEntryBase {
  type: "message";
  message: PiMessage;
}

export interface PiCompactionEntry extends PiEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId?: string;
  retainedTail?: PiMessage[];
  tokensBefore: number;
}

export interface PiCustomEntry extends PiEntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

/**
 * Entry types Pi writes that carry no turn: settings, bookmarks, and extension state.
 * They are known, so they are not reported as skipped.
 *
 * `custom_message` is deliberately absent. Pi's `sessionEntryToContextMessages` turns it
 * into a real context message, so an extension can put conversation content there. This
 * adapter does not know that content's shape, so it is skipped — and counted, so the skip
 * is visible rather than a silent shortening of the session.
 */
export const NON_TURN_ENTRY_TYPES: ReadonlySet<string> = new Set([
  "model_change",
  "thinking_level_change",
  "custom",
  "label",
  "session_info",
]);

// --- Small readers ----------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asHeader(value: unknown): PiSessionHeader | null {
  if (!isRecord(value)) return null;
  if (value.type !== "session") return null;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  const timestamp = typeof value.timestamp === "string" ? value.timestamp : "";
  const cwd = typeof value.cwd === "string" ? value.cwd : "";
  return {
    type: "session",
    ...(typeof value.version === "number" ? { version: value.version } : {}),
    id: value.id,
    timestamp,
    cwd,
  };
}

export function asEntry(value: unknown): PiEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value.type !== "string" || value.type.length === 0) return null;
  return value as PiEntry;
}

export function entryMessage(entry: PiEntry): Record<string, unknown> | null {
  if (entry.type !== "message") return null;
  return isRecord(entry.message) ? entry.message : null;
}

/** The visible text of a message content, hidden reasoning excluded (FR-28). */
export function visibleText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== "text") continue;
    if (typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

export function toolCallBlocks(content: unknown): PiToolCallBlock[] {
  if (!Array.isArray(content)) return [];
  const calls: PiToolCallBlock[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "toolCall") continue;
    if (typeof block.name !== "string") continue;
    calls.push({
      type: "toolCall",
      id: typeof block.id === "string" ? block.id : "",
      name: block.name,
      arguments: isRecord(block.arguments) ? block.arguments : {},
    });
  }
  return calls;
}

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "ls",
  "list",
  "find",
  "glob",
  "grep",
  "search",
  "tree",
  "fetch",
  "webfetch",
  "web_search",
  "websearch",
]);

const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "multiedit",
  "apply_patch",
  "applypatch",
  "patch",
  "create",
  "delete",
  "remove",
  "move",
  "rename",
  "mkdir",
  "notebookedit",
]);

/** Did the call change the repository? (FR-26) A shell is never assumed either way. */
export function toolEffectFor(toolName: string): ToolEffect {
  const name = toolName.trim().toLowerCase();
  if (READ_ONLY_TOOLS.has(name)) return "read-only";
  if (MUTATING_TOOLS.has(name)) return "mutating";
  return "unknown";
}

/** One line, whatever the input contained. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function shortArguments(argumentsText: string): string {
  return truncate(oneLine(argumentsText), MAX_OUTCOME_ARGUMENTS);
}

export function shortTitle(text: string): string {
  return truncate(oneLine(text), MAX_TITLE_LENGTH);
}

/** ISO-8601 UTC, or null when the source recorded nothing usable. */
export function toIsoUtc(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export function emptyUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
