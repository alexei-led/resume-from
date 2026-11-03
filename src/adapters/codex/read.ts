/**
 * The source role: a Codex home becomes a list of sessions, and one session becomes the
 * canonical vocabulary. Every result body is dropped (FR-24) and every reasoning trace is
 * ignored (FR-28, C-4).
 */

import { isAbsolute } from "node:path";
import { redactSensitiveArgumentsText, redactSensitiveText } from "../redaction.js";
import type {
  CanonicalSession,
  CanonicalTurn,
  SessionDescriptor,
  ToolCallRecord,
  ToolEffect,
  TurnKind,
  TurnRole,
} from "./contract.js";
import type { CodexSessionMeta, RolloutEntry, RolloutStreamState } from "./rollout.js";
import {
  CODEX_ENTRY_COMPACTED,
  CODEX_ENTRY_EVENT_MSG,
  CODEX_ENTRY_RESPONSE_ITEM,
  CODEX_EVENT_AGENT_MESSAGE,
  CODEX_EVENT_ITEM_COMPLETED,
  CODEX_EVENT_USER_MESSAGE,
  CODEX_EXTENSION_KIND_WEB_SEARCH,
  CODEX_ITEM_CUSTOM_TOOL_CALL,
  CODEX_ITEM_CUSTOM_TOOL_CALL_OUTPUT,
  CODEX_ITEM_FUNCTION_CALL,
  CODEX_ITEM_FUNCTION_CALL_OUTPUT,
  CODEX_THREAD_ITEM_AGENT_MESSAGE,
  CODEX_THREAD_ITEM_COLLAB_AGENT_TOOL_CALL,
  CODEX_THREAD_ITEM_COMMAND_EXECUTION,
  CODEX_THREAD_ITEM_CONTEXT_COMPACTION,
  CODEX_THREAD_ITEM_EXTENSION,
  CODEX_THREAD_ITEM_FILE_CHANGE,
  CODEX_THREAD_ITEM_IMAGE_VIEW,
  CODEX_THREAD_ITEM_MCP_TOOL_CALL,
  CODEX_THREAD_ITEM_REASONING,
  CODEX_THREAD_ITEM_SUB_AGENT_ACTIVITY,
  CODEX_THREAD_ITEM_USER_MESSAGE,
  isNotFoundError,
  KNOWN_ENTRY_TYPES,
  listRolloutFiles,
  payloadType,
  readSessionMeta,
  sessionsRoot,
  streamRolloutEntries,
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

/**
 * `Extension.kind` values that are reads by their own name. Any other kind is a call whose kind
 * does not settle the question, so it stays "unknown" (FR-26).
 */
const READ_ONLY_EXTENSION_KINDS: ReadonlySet<string> = new Set([CODEX_EXTENSION_KIND_WEB_SEARCH]);

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
  // The same streamed reader the listing uses, so both call a line over the cap damage (C-13): one
  // reader, one damage rule, and no whole file in memory. Reading stops at the first damage through
  // `stop`, which lets the reader end the file on its own terms instead of being abandoned mid-read;
  // `readRollout` refuses a damaged file anyway, so the rest of it cannot matter.
  const state: RolloutStreamState = { truncated: false, stop: false };
  const entries: RolloutEntry[] = [];
  for await (const entry of streamRolloutEntries(filePath, state)) {
    if (state.truncated) {
      state.stop = true;
      continue;
    }
    entries.push(entry);
  }

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
    truncated: state.truncated,
  };
}

/** Strict: FR-51's "unreadable" answer. */
export async function readRollout(filePath: string): Promise<CodexRollout> {
  const rollout = await scanRollout(filePath);
  if (rollout.truncated) throw new CodexRolloutUnreadableError(filePath);
  return rollout;
}

/** What the selection list needs from one rollout file (FR-11, FR-14). */
export interface RolloutSummary {
  filePath: string;
  meta: CodexSessionMeta | null;
  title: string;
  startedAt: string | null;
  updatedAt: string | null;
  turnCount: number;
  truncated: boolean;
}

/**
 * Sums up one rollout for the selection list in a single streamed pass (C-13): no turn is built,
 * no argument is redacted, and neither the file nor its entries are held whole. Every field comes
 * from the same classifier the loader uses, so a row cannot disagree with the session it opens.
 */
export async function summarizeRollout(filePath: string): Promise<RolloutSummary> {
  // The listing never stops early: every entry decides the row (C-13).
  const state: RolloutStreamState = { truncated: false, stop: false };
  let meta: CodexSessionMeta | null = null;
  let firstEntryStamp: string | null = null;
  let seenEntry = false;
  let lastStamp: string | null = null;
  let messages = 0;
  let itemToolCalls = 0;
  let summaryTurns = 0;
  let itemSeen = false;
  let legacyDialogueBeforeItems = false;
  let legacyCallsBeforeItems = 0;
  let legacyCallsAfterItems = 0;
  let title = "";

  for await (const entry of streamRolloutEntries(filePath, state)) {
    if (meta === null) meta = readSessionMeta(entry);
    const stamp = toIsoUtc(entry.timestamp);
    if (!seenEntry) {
      seenEntry = true;
      firstEntryStamp = stamp;
    }
    if (stamp !== null) lastStamp = stamp;
    const itemTurn = isItemCompletedTurn(entry);
    if (itemTurn) itemSeen = true;

    const turn = classifyEntry(entry);
    switch (turn.kind) {
      case "summary":
        summaryTurns += 1;
        break;
      case "message":
        messages += 1;
        if (!itemSeen && isLegacyMessageTurn(entry)) legacyDialogueBeforeItems = true;
        if (turn.role === "user" && title === "") title = turn.text;
        break;
      case "tool-call":
        if (turn.schema === "item-completed") itemToolCalls += 1;
        else if (itemSeen) legacyCallsAfterItems += 1;
        else legacyCallsBeforeItems += 1;
        break;
      default:
        // "none" and "unknown" contribute no turn.
        break;
    }
  }

  const metaStamp = toIsoUtc(meta?.timestamp ?? null);
  return {
    filePath,
    meta,
    // The title reaches the target's metadata, so it is redacted as the turn text is (FR-28).
    title: titleOf(redactSensitiveText(title)),
    startedAt: metaStamp ?? firstEntryStamp,
    updatedAt: lastStamp ?? metaStamp,
    // The calls a mixed-era file made before its first item turn are kept; the rest are repeats or
    // an item-era file's whole `response_item` stream, so they are not counted (C-12).
    turnCount:
      summaryTurns +
      messages +
      itemToolCalls +
      (itemSeen
        ? legacyDialogueBeforeItems
          ? legacyCallsBeforeItems
          : 0
        : legacyCallsBeforeItems + legacyCallsAfterItems),
    truncated: state.truncated,
  };
}

export async function listCodexSessions(home: string): Promise<SessionDescriptor[]> {
  const descriptors: SessionDescriptor[] = [];
  let failed = 0;
  let firstFailure: unknown = null;

  for (const filePath of await listRolloutFiles(sessionsRoot(home))) {
    let summary: RolloutSummary;
    try {
      summary = await summarizeRollout(filePath);
    } catch (error) {
      if (isNotFoundError(error)) continue; // A rollout may disappear during a concurrent cleanup.
      // One unreadable rollout must not hide the rest of the home (C-13). The home still reports a
      // failure when nothing at all could be read, so a broken mount is never silent.
      failed += 1;
      firstFailure ??= error;
      continue;
    }
    const meta = summary.meta;
    if (meta === null) continue;
    const repoPaths = meta.cwd !== null && isAbsolute(meta.cwd) ? [meta.cwd] : [];
    descriptors.push({
      ref: { agent: "codex", home, id: meta.id },
      title: summary.title,
      startedAt: summary.startedAt ?? "",
      updatedAt: summary.updatedAt ?? summary.startedAt ?? "",
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
  descriptors.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return descriptors;
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
 * Two dialogue schemas exist, and a rollout may even carry both (C-7, C-12):
 *
 * - the older one: messages from `event_msg` (`user_message`/`agent_message`) and tool calls from
 *   `response_item` (`function_call`/`custom_tool_call`);
 * - the `item_completed` one: every turn — user text, agent text and every tool-like action — is a
 *   single `event_msg` whose `payload.item.type` says which. Its `response_item` stream repeats the
 *   same actions at a coarser granularity, so once a file speaks it, those repeats are not read as
 *   turns.
 *
 * Messages are never gated by schema: a legacy thread that was resumed by a newer client carries
 * the dialogue of both eras, and each stays readable. The repeat rule therefore applies to tool
 * calls only.
 *
 * Reasoning, in either shape, produces nothing at all (C-4, FR-28, NG-8). Which entries count is
 * settled by `classifyEntry`, the same function the selection list counts with.
 */
function toCanonicalTurns(entries: RolloutEntry[]): {
  turns: CanonicalTurn[];
  skippedEntries: number;
  changedPaths: string[];
} {
  const cut = entries.findIndex(isItemCompletedTurn);
  const legacyCalls = legacyCallScope(entries, cut);
  const outputs = legacyCalls === "none" ? new Map<string, string>() : callOutputs(entries);
  const turns: CanonicalTurn[] = [];
  const changed = new Set<string>();
  let skippedEntries = 0;

  for (const [position, entry] of entries.entries()) {
    const turn = classifyEntry(entry);
    if (turn.kind === "unknown") {
      skippedEntries += 1;
      continue;
    }
    if (turn.kind === "none") continue;
    if (turn.kind === "summary") {
      turns.push({
        index: turns.length,
        role: "agent",
        kind: "summary",
        // FR-28, security: credentials in message text must not cross to a different vendor.
        text: redactSensitiveText(turn.text),
        toolCall: null,
        timestamp: toIsoUtc(entry.timestamp),
      });
      continue;
    }
    if (turn.kind === "message") {
      turns.push({
        index: turns.length,
        role: turn.role,
        kind: "message",
        // FR-28, security: credentials in message text must not cross to a different vendor.
        text: redactSensitiveText(turn.text),
        toolCall: null,
        timestamp: toIsoUtc(entry.timestamp),
      });
      continue;
    }
    // The newer schema repeats its actions in `response_item`, so those repeats are not turns.
    if (turn.schema === "legacy" && !readsLegacyCall(legacyCalls, position, cut)) continue;
    const body =
      turn.schema === "item-completed" ? itemTurn(entry) : legacyCallTurn(entry, outputs);
    if (body === null) continue;
    turns.push({
      index: turns.length,
      role: body.role,
      kind: body.kind,
      text: body.text,
      toolCall: body.toolCall,
      timestamp: toIsoUtc(entry.timestamp),
    });
    for (const path of body.changedPaths) changed.add(path);
  }

  return { turns, skippedEntries, changedPaths: [...changed] };
}

/** Which stream a tool call came from (C-7, C-12). */
type DialogueSchema = "legacy" | "item-completed";

/**
 * What one entry contributes to a session, decided from that entry alone (C-7, C-12). The listing
 * counts these classes and the loader builds turns from them, so the two cannot disagree: a turn
 * cannot be counted as one thing and built as another.
 */
type EntryTurn =
  | { kind: "message"; role: TurnRole; text: string }
  | { kind: "summary"; text: string }
  | { kind: "tool-call"; schema: DialogueSchema }
  | { kind: "none" }
  | { kind: "unknown" };

/**
 * Classifies one entry without building anything: no record, no redaction, and no string work beyond
 * the message text a title needs. A kind this module does not understand is reported, never guessed
 * at (C-6); reasoning, compaction and activity markers are understood and carry no turn (C-4, C-12).
 * An empty message carries no turn in either schema, so both eras agree on what a row counts.
 */
function classifyEntry(entry: RolloutEntry): EntryTurn {
  if (!KNOWN_ENTRY_TYPES.has(entry.type)) return { kind: "unknown" };

  if (entry.type === CODEX_ENTRY_COMPACTED) {
    const message = entry.payload.message;
    if (typeof message !== "string" || message.trim() === "") return { kind: "none" };
    return { kind: "summary", text: message };
  }

  if (entry.type === CODEX_ENTRY_EVENT_MSG) {
    const type = payloadType(entry);
    if (type === CODEX_EVENT_ITEM_COMPLETED) return itemCompletedTurn(entry);
    if (type !== CODEX_EVENT_USER_MESSAGE && type !== CODEX_EVENT_AGENT_MESSAGE)
      return { kind: "none" };
    const message = entry.payload.message;
    if (typeof message !== "string" || message.trim() === "") return { kind: "none" };
    return {
      kind: "message",
      role: type === CODEX_EVENT_USER_MESSAGE ? "user" : "agent",
      text: message,
    };
  }

  if (entry.type !== CODEX_ENTRY_RESPONSE_ITEM) return { kind: "none" };
  const type = payloadType(entry);
  if (type !== CODEX_ITEM_FUNCTION_CALL && type !== CODEX_ITEM_CUSTOM_TOOL_CALL)
    return { kind: "none" };
  const toolName = entry.payload.name;
  if (typeof toolName !== "string" || toolName === "") return { kind: "none" };
  return { kind: "tool-call", schema: "legacy" };
}

/** The class of one `item_completed` entry, from the same tables its builder reads (C-12). */
function itemCompletedTurn(entry: RolloutEntry): EntryTurn {
  const item = itemCompletedItem(entry);
  if (item === null) return { kind: "none" };
  const itemType = typeof item.type === "string" ? item.type : "";
  const role = ITEM_MESSAGE_ROLES.get(itemType);
  if (role !== undefined) {
    const text = itemContentText(item);
    // An item the model sent no text in — an image only, for one — carries no turn, exactly as the
    // older schema's empty message does, so a row and the session it opens agree on the count. It
    // does not mark the file as recording turns as items either: `isItemCompletedTurn` asks the same
    // question this function answers.
    if (text.trim() === "") return { kind: "none" };
    return { kind: "message", role, text };
  }
  if (ITEM_TOOL_TURN_BUILDERS.has(itemType)) return { kind: "tool-call", schema: "item-completed" };
  return IGNORED_ITEM_TYPES.has(itemType) ? { kind: "none" } : { kind: "unknown" };
}

/**
 * True when this entry records a turn as an `item_completed` item (C-12), whatever text a message
 * carries. A file that records turns this way repeats them coarsely in `response_item`, so those
 * repeats are not read as turns. An empty message or a kind that carries no turn marks nothing.
 */
function isItemCompletedTurn(entry: RolloutEntry): boolean {
  const turn = itemCompletedTurn(entry);
  return turn.kind === "message" || turn.kind === "tool-call";
}

/** Which older-schema tool calls a rollout still has to offer (C-12). */
type LegacyCallScope = "all" | "before-items" | "none";

/**
 * Which older-schema calls a rollout still has to offer (C-12). `response_item` in a file that
 * records turns as items holds the coarser repeat of those items, so those calls are not read — but
 * a thread that a newer client resumed keeps the dialogue of both eras, and the calls it made
 * before the first item turn are the only record of that work. Those are read; the ones after it
 * are the repeats.
 */
function legacyCallScope(entries: RolloutEntry[], cut: number): LegacyCallScope {
  if (cut === -1) return "all";
  return entries.slice(0, cut).some(isLegacyMessageTurn) ? "before-items" : "none";
}

/** True when one older-schema call at this position is read under `scope` (C-12). */
function readsLegacyCall(scope: LegacyCallScope, position: number, cut: number): boolean {
  if (scope === "all") return true;
  return scope === "before-items" && position < cut;
}

/** True when this entry is an older-schema dialogue message that carries text (C-7). */
function isLegacyMessageTurn(entry: RolloutEntry): boolean {
  if (entry.type !== CODEX_ENTRY_EVENT_MSG) return false;
  const type = payloadType(entry);
  if (type !== CODEX_EVENT_USER_MESSAGE && type !== CODEX_EVENT_AGENT_MESSAGE) return false;
  const message = entry.payload.message;
  return typeof message === "string" && message.trim() !== "";
}

/** The recorded answers of the older schema's calls, by call id (FR-25, FR-54). */
function callOutputs(entries: RolloutEntry[]): Map<string, string> {
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
  return outputs;
}

/** One older-schema `response_item` call becomes one tool-call turn (C-7). */
function legacyCallTurn(
  entry: RolloutEntry,
  outputs: ReadonlyMap<string, string>,
): ItemTurn | null {
  const toolName = entry.payload.name;
  if (typeof toolName !== "string" || toolName === "") return null;
  const rawArguments =
    payloadType(entry) === CODEX_ITEM_FUNCTION_CALL ? entry.payload.arguments : entry.payload.input;
  const argumentsText = typeof rawArguments === "string" ? rawArguments : "";
  const callId = entry.payload.call_id;
  // FR-54: use has() not get() — outputs.get() can return "" for an empty result.
  const resultRecorded = typeof callId === "string" && outputs.has(callId);
  const output = typeof callId === "string" ? (outputs.get(callId) ?? null) : null;
  const toolCall = toolCallRecord(toolName, argumentsText, output, resultRecorded);
  return toolTurn(toolCall, toolCall.effect === "mutating" ? pathsOf(argumentsText) : []);
}

/** One `item_completed` entry becomes one tool-call turn, through the table that built it (C-12). */
function itemTurn(entry: RolloutEntry): ItemTurn | null {
  const item = itemCompletedItem(entry);
  return item === null ? null : turnFromItemCompleted(item);
}

/** The inner `item` of an `item_completed` entry, when the entry is one (C-12). */
function itemCompletedItem(entry: RolloutEntry): Record<string, unknown> | null {
  if (entry.type !== CODEX_ENTRY_EVENT_MSG) return null;
  if (payloadType(entry) !== CODEX_EVENT_ITEM_COMPLETED) return null;
  const item = entry.payload.item;
  return typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null;
}

/** Item kinds that are understood and deliberately carry no turn (C-4, C-12). */
const IGNORED_ITEM_TYPES: ReadonlySet<string> = new Set([
  CODEX_THREAD_ITEM_REASONING,
  CODEX_THREAD_ITEM_CONTEXT_COMPACTION,
  CODEX_THREAD_ITEM_SUB_AGENT_ACTIVITY,
]);

/** Everything one `item_completed` item contributes to a canonical turn. */
interface ItemTurn {
  role: TurnRole;
  kind: TurnKind;
  text: string;
  toolCall: ToolCallRecord | null;
  changedPaths: string[];
}

/** How one `item_completed` kind becomes a turn. The classifier reads the same tables (C-12). */
type ItemTurnBuilder = (item: Record<string, unknown>) => ItemTurn;

/** The role of a message item, by kind. A kind outside this table is not a message (C-12). */
const ITEM_MESSAGE_ROLES: ReadonlyMap<string, TurnRole> = new Map([
  [CODEX_THREAD_ITEM_USER_MESSAGE, "user"],
  [CODEX_THREAD_ITEM_AGENT_MESSAGE, "agent"],
]);

/**
 * Every `item_completed` kind that carries a tool call, and how its record is built (C-12). The
 * classifier and the builder read this one table, so no kind can be counted as a turn and then
 * built as none, or the reverse.
 */
const ITEM_TOOL_TURN_BUILDERS: ReadonlyMap<string, ItemTurnBuilder> = new Map([
  [CODEX_THREAD_ITEM_COMMAND_EXECUTION, commandExecutionTurn],
  [CODEX_THREAD_ITEM_FILE_CHANGE, fileChangeTurn],
  [CODEX_THREAD_ITEM_EXTENSION, extensionTurn],
  [CODEX_THREAD_ITEM_MCP_TOOL_CALL, mcpToolCallTurn],
  [CODEX_THREAD_ITEM_COLLAB_AGENT_TOOL_CALL, collabAgentToolCallTurn],
  [CODEX_THREAD_ITEM_IMAGE_VIEW, imageViewTurn],
]);

/**
 * One `item_completed` item becomes one canonical turn. The kind of the call is settled by
 * `item.type` itself, so the effect is read from that and never guessed from a tool name (FR-26).
 * Returns null for a kind that carries no turn.
 */
function turnFromItemCompleted(item: Record<string, unknown>): ItemTurn | null {
  const itemType = typeof item.type === "string" ? item.type : "";
  const role = ITEM_MESSAGE_ROLES.get(itemType);
  if (role !== undefined) {
    return {
      role,
      kind: "message",
      // FR-28, security: credentials in message text must not cross to a different vendor.
      text: redactSensitiveText(itemContentText(item)),
      toolCall: null,
      changedPaths: [],
    };
  }
  return ITEM_TOOL_TURN_BUILDERS.get(itemType)?.(item) ?? null;
}

/** The common shape of a turn a tool-like item produces. */
function toolTurn(toolCall: ToolCallRecord, changedPaths: string[] = []): ItemTurn {
  return { role: "agent", kind: "tool-call", text: "", toolCall, changedPaths };
}

/** `CommandExecution`: the shell line the model wrote, and the shape of its output (FR-23..FR-25). */
function commandExecutionTurn(item: Record<string, unknown>): ItemTurn {
  const output = firstString(item.aggregated_output, item.formatted_output, item.stdout);
  return toolTurn(toolCallRecord("exec", commandText(item.command), output, output !== null));
}

/** `FileChange`: the patch is the argument, and its paths are the files the call touched (FR-24, FR-36). */
function fileChangeTurn(item: Record<string, unknown>): ItemTurn {
  const paths = objectKeys(item.changes);
  return toolTurn(
    itemToolCallRecord(
      "apply_patch",
      fileChangeArguments(item.changes),
      `${paths.length} file(s) changed`,
      "mutating",
      false,
    ),
    paths,
  );
}

/** `Extension`: a tool action such as a web search, with its queries kept and its results dropped. */
function extensionTurn(item: Record<string, unknown>): ItemTurn {
  const kind = firstNonEmptyString(item.kind) ?? "extension";
  const results = Array.isArray(item.results) ? item.results.length : 0;
  return toolTurn(
    itemToolCallRecord(
      kind,
      extensionArguments(item),
      `${results} result(s) dropped`,
      READ_ONLY_EXTENSION_KINDS.has(kind) ? "read-only" : "unknown",
      true,
    ),
  );
}

/** `McpToolCall`: a server tool call, named by server and tool (FR-27). */
function mcpToolCallTurn(item: Record<string, unknown>): ItemTurn {
  const call = mcpToolCall(item);
  return toolTurn(
    itemToolCallRecord(
      call.toolName,
      call.argumentsText,
      mcpOutcome(item),
      // A server's own `readOnlyHint` is a claim by another party, not the item kind (FR-26).
      "unknown",
      item.result !== undefined && item.result !== null,
    ),
  );
}

/** `CollabAgentToolCall`: an action on another agent of the same client. */
function collabAgentToolCallTurn(item: Record<string, unknown>): ItemTurn {
  const call = collabAgentToolCall(item);
  return toolTurn(
    itemToolCallRecord(
      call.toolName,
      call.argumentsText,
      call.outcome,
      "unknown",
      objectKeys(item.agents_states).length > 0,
    ),
  );
}

/** `ImageView`: the path the model asked for; the image itself never crosses (FR-24). */
function imageViewTurn(item: Record<string, unknown>): ItemTurn {
  return toolTurn(
    itemToolCallRecord(
      "view_image",
      firstNonEmptyString(item.path) ?? "",
      "image not carried",
      "read-only",
      false,
    ),
  );
}

/**
 * The text of a message item. `content[].type` is `"text"` on a user message and `"Text"` on an
 * agent message, so the text is taken from the part's own field and never by that casing.
 */
function itemContentText(item: Record<string, unknown>): string {
  const content = item.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null
        ? firstNonEmptyString((part as Record<string, unknown>).text)
        : null,
    )
    .filter((part): part is string => part !== null)
    .join("\n");
}

/** A Codex command is an argv array; the shell line the model wrote is its joined form. */
function commandText(value: unknown): string {
  if (Array.isArray(value))
    return value.filter((part): part is string => typeof part === "string").join(" ");
  return typeof value === "string" ? value : "";
}

/**
 * FR-24 protects a result body, not a tool argument, and the legacy `apply_patch` call already
 * carries the patch text it was given. A `FileChange` item is the same kind of argument, so the
 * patch is rebuilt from it whole — path plus content — in `apply_patch`'s own shape.
 */
function fileChangeArguments(changes: unknown): string {
  if (typeof changes !== "object" || changes === null) return "";
  const parts: string[] = [];
  for (const [path, change] of Object.entries(changes)) {
    const record =
      typeof change === "object" && change !== null ? (change as Record<string, unknown>) : {};
    const kind = firstNonEmptyString(record.type) ?? "update";
    const verb = kind === "add" ? "Add" : kind === "delete" ? "Delete" : "Update";
    const content = firstNonEmptyString(record.content);
    parts.push(`*** ${verb} File: ${path}${content === null ? "" : `\n${content}`}`);
  }
  return parts.join("\n");
}

/** The queries an `Extension` item searched with, one per line. */
function extensionArguments(item: Record<string, unknown>): string {
  const action = item.action;
  if (typeof action === "object" && action !== null) {
    const queries = (action as Record<string, unknown>).queries;
    if (Array.isArray(queries)) {
      const lines = queries.filter(
        (query): query is string => typeof query === "string" && query !== "",
      );
      if (lines.length > 0) return lines.join("\n");
    }
  }
  return firstNonEmptyString(item.query) ?? "";
}

/**
 * A server tool call names itself in `server` and `tool` and states its arguments as JSON. Both
 * are kept: the name unchanged (FR-27) and the arguments redacted like any other call (FR-24).
 */
function mcpToolCall(item: Record<string, unknown>): {
  toolName: string;
  argumentsText: string;
} {
  const server = firstNonEmptyString(item.server);
  const tool = firstNonEmptyString(item.tool);
  const toolName =
    server !== null && tool !== null ? `${server}.${tool}` : (tool ?? server ?? "mcp");
  return { toolName, argumentsText: jsonArguments(item.arguments) };
}

/** The recorded status of a server call, plus how many result items were dropped (FR-24, FR-25). */
function mcpOutcome(item: Record<string, unknown>): string {
  const result = item.result;
  const record =
    typeof result === "object" && result !== null ? (result as Record<string, unknown>) : null;
  const content = record === null ? null : record.content;
  const results = Array.isArray(content) ? content.length : record === null ? 0 : 1;
  const dropped = `${results} result(s) dropped`;
  const status = firstNonEmptyString(item.status);
  return status === null ? dropped : `${status}, ${dropped}`;
}

/**
 * An action on another agent. Its `tool` field names the action, and the agents it addresses are
 * the argument; the per-agent states it records are that call's result and are dropped (FR-24).
 */
function collabAgentToolCall(item: Record<string, unknown>): {
  toolName: string;
  argumentsText: string;
  outcome: string;
} {
  const targets = [
    ...stringValues(item.receiver_agents),
    ...stringValues(item.receiver_thread_ids),
  ];
  return {
    toolName: firstNonEmptyString(item.tool) ?? "collab-agent",
    argumentsText: targets.join("\n"),
    outcome: firstNonEmptyString(item.status) ?? "no status recorded",
  };
}

/** Tool arguments as the recorded JSON text, or as they already are when they are a string. */
function jsonArguments(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return "";
  return JSON.stringify(value);
}

/** The non-empty strings of an array field, in source order. */
function stringValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((part): part is string => typeof part === "string" && part !== "");
}

/** Non-empty string keys of an object, in source order — the paths a change touched. */
function objectKeys(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  return Object.keys(value).filter((key) => key !== "");
}

/** The first value that is a string, empty string included: an empty result was still recorded. */
function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return null;
}

/** The first value that is a non-empty string, or null. `""` counts as absent here. */
function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

/**
 * A structured item states its own outcome, so this variant names it instead of measuring a dropped
 * body. The arguments still cross redacted, exactly like the legacy tool-call path (FR-24, FR-28).
 */
function itemToolCallRecord(
  toolName: string,
  argumentsText: string,
  outcome: string,
  effect: ToolEffect,
  bodyDropped: boolean,
): ToolCallRecord {
  const safeArguments = redactSensitiveArgumentsText(argumentsText);
  const head = `${toolName}(${singleLine(safeArguments, ARGUMENTS_PREVIEW_LIMIT)})`;
  return {
    toolName,
    argumentsText: safeArguments,
    outcomeLine: redactSensitiveText(`${head} → ${outcome}`),
    effect,
    bodyDropped,
    resultRecorded: true,
  };
}

/** Only the shape of the output is measured. Not one fragment of it is carried (FR-24, FR-25). */
function toolCallRecord(
  toolName: string,
  argumentsText: string,
  output: string | null,
  resultRecorded: boolean,
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
    // FR-54: false when no *_call_output entry existed for this call_id (broken tail signal).
    resultRecorded,
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
