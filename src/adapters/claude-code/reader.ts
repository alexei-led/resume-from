/**
 * Reading a Claude Code session into the neutral vocabulary.
 *
 * Two rules shape everything here: no result body crosses (FR-24) and no system prompt,
 * environment value, token or hidden reasoning crosses (FR-28, NG-7). Both are enforced by
 * what this file builds, not by what a caller does with it.
 */

import { readFile, stat } from "node:fs/promises";
import type {
  CanonicalSession,
  CanonicalTurn,
  HomePath,
  SessionDescriptor,
  ToolCallRecord,
  ToolEffect,
} from "./contract.js";
import {
  asArray,
  asObject,
  asString,
  ENTRY_TYPE_ASSISTANT,
  ENTRY_TYPE_SUMMARY,
  ENTRY_TYPE_USER,
  parseJsonl,
  type RawEntry,
  resolveActiveEntryPath,
  toIsoUtc,
} from "./entries.js";
import { listSessionFiles, sessionIdOf } from "./layout.js";
import { redactSensitiveStructure, redactSensitiveText } from "./redaction.js";

/** FR-25: every dropped body is marked in text the model can read. */
export const DROPPED_MARKER = "(content dropped: imported session, may be stale)";
export const UNREADABLE_TITLE = "(unreadable session file)";
export const UNTITLED = "(no user message)";

const MAX_TITLE_CHARS = 80;
const MAX_ARGUMENT_CHARS = 80;
const MAX_ARGUMENTS_CHARS = 200;

/** Claude Code tools that change the repository (FR-26). */
const MUTATING_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** Claude Code tools that only look. Everything else is "unknown", including Bash. */
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
  "TodoRead",
]);
/** Input keys that name the file a mutating call changed. */
const PATH_KEYS = ["file_path", "notebook_path", "path", "filePath"];

export interface SessionReadResult {
  turns: CanonicalTurn[];
  /**
   * Entries this adapter does not read: the other entry types of C-3, hidden reasoning, and
   * everything FR-28 excludes. `AgentAdapter` has no field for this count, so it is reported
   * here and asserted by T-CC-15.
   */
  skipped: number;
  /** Set when the file is cut mid-entry. Then the session is not readable at all. */
  unreadable: string | null;
  title: string;
  startedAt: string | null;
  updatedAt: string | null;
  repoPath: string | null;
  branch: string | null;
  changedPaths: string[];
}

interface ResultBody {
  /** The text of the result, when it had one. Its size crosses; its content never does. */
  body: string | null;
  /** True when a result of any shape was recorded, including a structured one. */
  present: boolean;
  isError: boolean;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function effectOf(toolName: string): ToolEffect {
  if (MUTATING_TOOLS.has(toolName)) return "mutating";
  if (READ_ONLY_TOOLS.has(toolName)) return "read-only";
  return "unknown";
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return `'${truncate(oneLine(value), MAX_ARGUMENT_CHARS)}'`;
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return String(value);
  return truncate(oneLine(JSON.stringify(value) ?? ""), MAX_ARGUMENT_CHARS);
}

/** The redacted source arguments, shortened so one call stays one line. */
export function renderArguments(input: unknown): string {
  const safeInput = redactSensitiveStructure(input);
  const object = asObject(safeInput);
  if (object === null) return safeInput === undefined ? "" : renderValue(safeInput);
  return truncate(Object.values(object).map(renderValue).join(", "), MAX_ARGUMENTS_CHARS);
}

/** The text of a tool result, used for its size only. It is never carried (FR-24). */
function resultBodyText(content: unknown): string | null {
  if (typeof content === "string") return content;
  const blocks = asArray(content);
  if (blocks === null) return null;
  const texts = blocks
    .map((block) => asString(asObject(block)?.text))
    .filter((text): text is string => text !== null);
  return texts.length === 0 ? null : texts.join("\n");
}

/** True when the source recorded a result of any shape — text, blocks, or a structured object. */
function hasResultBody(content: unknown): boolean {
  if (typeof content === "string") return content !== "";
  if (Array.isArray(content)) return content.length > 0;
  return asObject(content) !== null;
}

/** Exactly one line about the outcome (FR-23). */
function summarizeResult(result: ResultBody | undefined): {
  text: string;
  bodyDropped: boolean;
} {
  if (result === undefined) return { text: "no result recorded", bodyDropped: false };
  if (result.body === null) {
    // A structured result: its size is unknown, but it existed and it is being dropped (FR-25).
    if (result.present) {
      return {
        text: result.isError ? "error, result dropped" : "result recorded",
        bodyDropped: true,
      };
    }
    return {
      text: result.isError ? "error" : "no result recorded",
      bodyDropped: false,
    };
  }
  const lines = result.body === "" ? 0 : result.body.split("\n").length;
  const size = `${lines} line${lines === 1 ? "" : "s"}`;
  return {
    text: result.isError ? `error, ${size}` : size,
    bodyDropped: result.body.length > 0,
  };
}

function toolCallRecord(
  toolName: string,
  input: unknown,
  result: ResultBody | undefined,
): ToolCallRecord {
  const argumentsText = renderArguments(input);
  const { text, bodyDropped } = summarizeResult(result);
  const line = `${toolName}(${argumentsText}) → ${text}`;
  return {
    toolName,
    argumentsText,
    outcomeLine: redactSensitiveText(bodyDropped ? `${line} ${DROPPED_MARKER}` : line),
    effect: effectOf(toolName),
    bodyDropped,
    // FR-54: false when no tool_result block existed for this call id (broken tail signal).
    resultRecorded: result !== undefined,
  };
}

/** Tool results, keyed by the id of the call they answer. */
function collectResults(entries: RawEntry[]): Map<string, ResultBody> {
  const results = new Map<string, ResultBody>();
  for (const entry of entries) {
    if (entry.type !== ENTRY_TYPE_USER) continue;
    const blocks = asArray(asObject(entry.message)?.content);
    if (blocks === null) continue;
    for (const raw of blocks) {
      const block = asObject(raw);
      if (block === null || block.type !== "tool_result") continue;
      const id = asString(block.tool_use_id);
      if (id === null) continue;
      results.set(id, {
        body: resultBodyText(block.content),
        present: hasResultBody(block.content) || asObject(entry.toolUseResult) !== null,
        isError: block.is_error === true,
      });
    }
  }
  return results;
}

/** The visible text of a message. Tool-result blocks contribute nothing (FR-24). */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  const blocks = asArray(content);
  if (blocks === null) return "";
  const texts: string[] = [];
  for (const raw of blocks) {
    const block = asObject(raw);
    if (block?.type === "text") {
      const text = asString(block.text);
      if (text !== null) texts.push(text);
    }
  }
  return texts.join("\n");
}

/**
 * Claude records slash commands, their stdout, and !-prefixed shell input as user-shaped
 * carriers. None of it is conversation, so none of it crosses (FR-28) — a carrier kept as a
 * turn would also become the session title when it is the first user-shaped entry.
 */
function isLocalCommandCarrier(content: unknown): boolean {
  const text = messageText(content).trim();
  return (
    /(?:^|\n)<local-command-stdout>[\s\S]*<\/local-command-stdout>(?:\n|$)/.test(text) ||
    /(?:^|\n)<local-command-caveat>[\s\S]*<\/local-command-caveat>(?:\n|$)/.test(text) ||
    // Tag order varies by Claude Code version: <command-message> may come first.
    /^<command-(?:name|message|args)>[\s\S]*<\/command-(?:name|message|args)>/.test(text) ||
    /^<bash-input>[\s\S]*<\/bash-input>(?:\n|$)/.test(text) ||
    /^<bash-std(?:out|err)>[\s\S]*<\/bash-std(?:out|err)>(?:\n|$)/.test(text)
  );
}

function firstLine(text: string, max: number): string {
  const line = oneLine(text.split("\n")[0] ?? "");
  return truncate(line, max);
}

/** Read a whole session file into canonical turns. Pure: it takes the text, not a path. */
export function readSessionText(text: string): SessionReadResult {
  const parsed = parseJsonl(text);
  const active =
    parsed.unreadable === null
      ? resolveActiveEntryPath(parsed.entries)
      : { entries: [] as RawEntry[], unreadable: null };
  const unreadable = parsed.unreadable ?? active.unreadable;
  const results = collectResults(active.entries);

  const turns: CanonicalTurn[] = [];
  const changedPaths: string[] = [];
  let skipped = parsed.entries.length - active.entries.length;
  let repoPath: string | null = null;
  let branch: string | null = null;
  if (unreadable === null) {
    // Repository ownership is session metadata, not active-branch metadata. Claude can reset the
    // active chain after changing cwd, but the session still belongs to the directory it started in.
    for (const entry of parsed.entries) {
      if (entry.isSidechain === true) continue;
      repoPath = asString(entry.cwd);
      if (repoPath !== null) break;
    }
  }

  const push = (turn: Omit<CanonicalTurn, "index">): void => {
    // FR-28, security: credentials pasted as message text must not cross to a different vendor.
    // Tool-call turns carry text: "" so the condition is a no-op there (no double-redaction).
    const text = turn.text.length > 0 ? redactSensitiveText(turn.text) : turn.text;
    turns.push({ ...turn, text, index: turns.length });
  };

  for (const entry of active.entries) {
    if (branch === null) branch = asString(entry.gitBranch);

    // A sidechain is a separate sub-conversation, not a turn of this session.
    if (entry.isSidechain === true) {
      skipped++;
      continue;
    }
    const timestamp = toIsoUtc(entry.timestamp);

    if (entry.type === ENTRY_TYPE_USER && entry.isCompactSummary === true) {
      const summary = messageText(asObject(entry.message)?.content);
      if (summary.trim() === "") {
        skipped++;
      } else {
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

    if (entry.type === ENTRY_TYPE_USER) {
      // Meta entries carry injected context — environment blocks, command output, reminders.
      // FR-28 keeps all of it out of the canonical model.
      if (entry.isMeta === true) {
        skipped++;
        continue;
      }
      const content = asObject(entry.message)?.content;
      if (isLocalCommandCarrier(content)) {
        skipped++;
        continue;
      }
      const text = messageText(content);
      if (text.trim() === "") continue; // a tool-result carrier; its outcome already crossed
      push({ role: "user", kind: "message", text, toolCall: null, timestamp });
      continue;
    }

    if (entry.type === ENTRY_TYPE_ASSISTANT) {
      const content = asObject(entry.message)?.content;
      if (typeof content === "string") {
        push({
          role: "agent",
          kind: "message",
          text: content,
          toolCall: null,
          timestamp,
        });
        continue;
      }
      const blocks = asArray(content);
      if (blocks === null) {
        skipped++;
        continue;
      }
      let pending: string[] = [];
      const flush = (): void => {
        if (pending.length === 0) return;
        push({
          role: "agent",
          kind: "message",
          text: pending.join("\n"),
          toolCall: null,
          timestamp,
        });
        pending = [];
      };
      for (const raw of blocks) {
        const block = asObject(raw);
        const type = block?.type;
        if (block === null) {
          skipped++;
        } else if (type === "text") {
          const value = asString(block.text);
          if (value !== null) pending.push(value);
        } else if (type === "tool_use") {
          flush();
          const name = asString(block.name) ?? "unknown-tool";
          const id = asString(block.id);
          const record = toolCallRecord(
            name,
            block.input,
            id === null ? undefined : results.get(id),
          );
          if (record.effect === "mutating") {
            const input = asObject(block.input);
            for (const key of PATH_KEYS) {
              const value = asString(input?.[key]);
              if (value !== null) {
                if (!changedPaths.includes(value)) changedPaths.push(value);
                break;
              }
            }
          }
          push({
            role: "agent",
            kind: "tool-call",
            text: "",
            toolCall: record,
            timestamp,
          });
        } else {
          // thinking, redacted_thinking, server tool state: hidden reasoning and vendor state
          // never cross (FR-28, NG-8).
          skipped++;
        }
      }
      flush();
      continue;
    }

    if (entry.type === ENTRY_TYPE_SUMMARY) {
      const summary = asString(entry.summary);
      if (summary !== null) {
        push({
          role: "agent",
          kind: "summary",
          text: summary,
          toolCall: null,
          timestamp,
        });
        continue;
      }
    }

    // Every other entry type of C-3: system, attachment, file history, mode, and the rest.
    skipped++;
  }

  const firstUser = turns.find((turn) => turn.role === "user" && turn.kind === "message");
  const stamps = turns
    .map((turn) => turn.timestamp)
    .filter((value): value is string => value !== null);

  return {
    turns,
    skipped,
    unreadable,
    title: firstUser === undefined ? "" : firstLine(firstUser.text, MAX_TITLE_CHARS),
    startedAt: stamps[0] ?? null,
    updatedAt: stamps[stamps.length - 1] ?? null,
    repoPath,
    branch,
    changedPaths,
  };
}

/** One row per session file of the home, newest first (FR-11, FR-14). */
export async function listSessions(home: HomePath): Promise<SessionDescriptor[]> {
  const descriptors: SessionDescriptor[] = [];
  // Whole-file read and full parse per file: title, turn count, and updatedAt all require
  // parsing the entire JSONL (FR-11). Benchmarked at ≈ 5 ms per 2 MB file (warm OS cache);
  // 200 such files cost ≈ 1 s. Ceiling accepted; revisit if a home with thousands of
  // large sessions makes the listing noticeably slow to users.
  for (const file of await listSessionFiles(home)) {
    let text: string;
    let modified: string;
    try {
      text = await readFile(file, "utf8");
      modified = (await stat(file)).mtime.toISOString();
    } catch {
      continue;
    }
    const read = readSessionText(text);
    const broken = read.unreadable !== null;
    descriptors.push({
      ref: { agent: "claude-code", home, id: sessionIdOf(file) },
      title: broken ? UNREADABLE_TITLE : read.title === "" ? UNTITLED : read.title,
      startedAt: broken ? modified : (read.startedAt ?? modified),
      updatedAt: broken ? modified : (read.updatedAt ?? modified),
      turnCount: broken ? 0 : read.turns.length,
      repoPath: read.repoPath,
      filePath: file,
    });
  }
  descriptors.sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    return a.ref.id < b.ref.id ? -1 : 1;
  });
  return descriptors;
}

/** One session in the neutral vocabulary. A file cut mid-entry is reported, never guessed at. */
export async function loadSession(descriptor: SessionDescriptor): Promise<CanonicalSession> {
  let text: string;
  try {
    text = await readFile(descriptor.filePath, "utf8");
  } catch (cause) {
    throw new Error(`cannot read Claude Code session file ${descriptor.filePath}`, { cause });
  }
  const read = readSessionText(text);
  if (read.unreadable !== null) {
    throw new Error(
      `unreadable Claude Code session file ${descriptor.filePath}: ${read.unreadable}`,
    );
  }
  return {
    provenance: {
      ref: descriptor.ref,
      title: descriptor.title,
      startedAt: read.startedAt ?? descriptor.startedAt,
      updatedAt: read.updatedAt ?? descriptor.updatedAt,
      repo: {
        // Claude Code records the branch on every entry but never the commit.
        commit: null,
        branch: read.branch,
        changedPaths: read.changedPaths,
      },
    },
    turns: read.turns,
  };
}
