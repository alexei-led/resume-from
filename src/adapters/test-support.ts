/**
 * The conformance suite's harness.
 *
 * This module implements no adapter (`src/adapters/module.md`, Functional Responsibilities), so
 * everything it ships is here: one parameter table and one direction runner, used by every
 * T-ADA-* body. A new agent adds one entry to `ALL_ADAPTERS` and nothing else — that is FR-57
 * in its mechanical form, and FR-60's: the same test bodies run against every entry.
 *
 * Two deliberate choices, both worth naming:
 *
 * - **Source homes are seeded by the source adapter's own `serialize`.** Only the adapter of an
 *   agent may hold that agent's file format (this module's Encapsulated Knowledge says so), so
 *   the suite never writes a native fixture by hand. What the port promises is exercised through
 *   the port.
 * - **Files are created by `src/platform/store/`**, the one module allowed to create files
 *   (FR-49, FR-53, C-3). The harness plays the part `src/import/landing/` plays in production:
 *   validate first, place only when there is no defect. `src/adapters/` itself never calls the
 *   store — its own code has no runtime behaviour at all.
 *
 * Deliberately not named `*.test.ts`: Vitest collects those, and this file holds no tests.
 */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createFixtureAgentAdapter,
  FIXTURE_AGENT_ID,
  FIXTURE_DOC_KIND,
  type FixtureExchange,
} from "../../test/fixtures/fixture-agent/index.js";
import { REFERENCE_SESSION } from "../../test/fixtures/reference-session.js";
import { createFileCommitter } from "../platform/store/index.js";
import { claudeCodeAdapter } from "./claude-code/index.js";
import { codexAdapterFactory } from "./codex/index.js";
import type {
  AdapterRole,
  AgentAdapter,
  AgentId,
  AgentRuntime,
  CanonicalSession,
  CanonicalTurn,
  PendingFile,
  ProvenanceMarker,
  SerializedSession,
  SessionDescriptor,
  StoredSessionFacts,
  TargetProfile,
} from "./contract.js";
import { kimiCodeAdapterFactory } from "./kimi-code/index.js";
import { piAdapterFactory } from "./pi/index.js";

/** The note FR-25 requires on a record whose result body was dropped. */
export const DROPPED_NOTE = "(content dropped: imported session, may be stale)";
/** The string T-ADA-10 hunts for. It is a result body, and no direction may carry it across. */
export const SECRET_BODY = "SECRET-BODY-CONTENT";

/** The content of an entry no adapter can read. It must produce no turn (T-ADA-20). */
export const UNKNOWN_MARKER = "UNKNOWN-ENTRY-CONTENT";

/** The excluded content of T-ADA-19: reasoning, a system prompt, a key, telemetry (FR-28). */
export const EXCLUDED_CONTENT = {
  reasoning: "REASONING-TRACE-the-user-is-probably-lying-about-the-token",
  systemPrompt: "SYSTEM-PROMPT-you-are-a-helpful-assistant-with-tools",
  apiKey: "OPENAI_API_KEY=sk-SECRET-KEY-VALUE-0123456789",
  telemetry: "TELEMETRY-EVENT-session_resumed-user_id-42",
};

export const EXCLUDED_STRINGS: string[] = Object.values(EXCLUDED_CONTENT);

/** One entry of the conformance suite's parameter list. */
export interface AdapterCase {
  /** The agent id the adapter declares. */
  id: string;
  /** Its folder under `src/adapters/`, or null for an agent that has none (the fixture). */
  folder: string | null;
  /** True for the invented fourth agent of T-ADA-21 and T-ADA-22. */
  invented: boolean;
  create(): AgentAdapter;
  /**
   * A runtime handle its `switchTo` accepts, or null when it declares "create-only".
   * Capability, never name: the suite asks `capabilities().landing` before it calls this.
   */
  runtime(answer: "switch" | "cancel"): AgentRuntime | null;
  /**
   * Remove `count` fields the agent requires from a serialized session (T-ADA-16, T-ADA-17).
   * Which field is agent knowledge — `src/adapters/module.md` names Pi's `usage` object itself.
   */
  damage(serialized: SerializedSession, count: number): SerializedSession;
  /**
   * Put content the adapter must never carry across into a committed source file: a tool result
   * body and the excluded content of FR-28 (T-ADA-10, T-ADA-19).
   */
  hide(bytes: Buffer, secrets: string[]): Buffer;
  /**
   * Add an entry in a shape this adapter does not know, carrying `UNKNOWN_MARKER`. It must
   * produce no turn, and it must not make the file unreadable (T-ADA-20).
   */
  plantUnknown(bytes: Buffer): Buffer;
}

// --- the parameter list ------------------------------------------------------------------

/** A Pi command context. C-10: `switchSession` is called from a command handler, never events. */
function piRuntime(answer: "switch" | "cancel"): AgentRuntime {
  return {
    switchSession: async (_filePath: string, _options: unknown) => ({
      cancelled: answer === "cancel",
    }),
  };
}

function jsonlLines(bytes: Buffer): Record<string, unknown>[] {
  return bytes
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function jsonlBytes(entries: Record<string, unknown>[]): Buffer {
  return Buffer.from(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function withBytes(serialized: SerializedSession, bytes: Buffer): SerializedSession {
  const first = serialized.files[0];
  if (first === undefined) throw new Error("the serialized session holds no file to damage");
  return {
    ...serialized,
    files: [{ absolutePath: first.absolutePath, bytes }],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * One line of content an adapter cannot read, carrying a result body and every excluded value at
 * once. Its `type` is unknown to all three real formats, and every envelope field each parser
 * touches is present, so only the type is strange: the file stays whole, the entry produces no
 * turn, and nothing it holds may reach the target.
 *
 * The body is shaped like all three agents' result shapes simultaneously. If any reader ever
 * starts recognising one of them, this line is what fires.
 */
function lastGraphId(entries: Record<string, unknown>[], field: "id" | "uuid"): string | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type === "session") continue;
    const value = entry?.[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function probeLine(
  secrets: string[],
  sessionId: string,
  parentId: string | null,
  parentUuid: string | null,
): Record<string, unknown> {
  const body = secrets.join(" | ");
  return {
    type: "resume_from_probe",
    id: "probe-0001",
    parentId,
    uuid: "00000000-0000-4000-8000-00000000ffff",
    parentUuid,
    sessionId,
    timestamp: "2026-08-01T09:16:09.000Z",
    payload: { type: "function_call_output", call_id: "probe", output: body },
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "probe", content: body }],
    },
    toolUseResult: { stdout: body },
    reasoning: {
      encrypted_content: body,
      summary: [{ type: "summary_text", text: body }],
    },
    systemPrompt: body,
    env: { OPENAI_API_KEY: body },
    telemetry: { event: body },
  };
}

function appendProbe(bytes: Buffer, secrets: string[]): Buffer {
  const entries = jsonlLines(bytes);
  const sessionId = String(entries[0]?.sessionId ?? entries[0]?.id ?? "probe-session");
  return jsonlBytes([
    ...entries,
    probeLine(secrets, sessionId, lastGraphId(entries, "id"), lastGraphId(entries, "uuid")),
  ]);
}

function appendUnknownEntry(bytes: Buffer): Buffer {
  const entries = jsonlLines(bytes);
  return jsonlBytes([
    ...entries,
    {
      type: "resume_from_unknown_entry",
      id: "unknown-0001",
      parentId: lastGraphId(entries, "id"),
      uuid: "00000000-0000-4000-8000-00000000fffe",
      parentUuid: lastGraphId(entries, "uuid"),
      timestamp: "2026-08-01T09:16:10.000Z",
      payload: { type: "sparkle", note: UNKNOWN_MARKER },
      note: UNKNOWN_MARKER,
    },
  ]);
}

/** Damage `count` assistant `usage` objects — the field C-11 measured Pi crashing without. */
function damageAssistantUsage(
  serialized: SerializedSession,
  count: number,
  isAssistant: (entry: Record<string, unknown>) => boolean,
): SerializedSession {
  const first = serialized.files[0];
  if (first === undefined) throw new Error("nothing to damage");
  const entries = jsonlLines(first.bytes);
  let damaged = 0;
  for (const entry of entries) {
    if (damaged === count) break;
    if (!isAssistant(entry)) continue;
    const message = asRecord(entry.message);
    if (message === null || message.usage === undefined) continue;
    delete message.usage;
    damaged += 1;
  }
  if (damaged < count) throw new Error(`only ${damaged} of ${count} usage objects were damaged`);
  return withBytes(serialized, jsonlBytes(entries));
}

/** The metadata fields Codex's picker cannot list a thread without. */
const CODEX_META_FIELDS = ["cwd", "originator", "cli_version"];

export const PI_CASE: AdapterCase = {
  id: "pi",
  folder: "pi",
  invented: false,
  create: () => piAdapterFactory.create(),
  runtime: piRuntime,
  damage: (serialized, count) =>
    damageAssistantUsage(serialized, count, (entry) => {
      const message = asRecord(entry.message);
      return entry.type === "message" && message?.role === "assistant";
    }),
  hide: appendProbe,
  plantUnknown: appendUnknownEntry,
};

export const CODEX_CASE: AdapterCase = {
  id: "codex",
  folder: "codex",
  invented: false,
  create: () => codexAdapterFactory.create(),
  runtime: () => null,
  damage: (serialized, count) => {
    const first = serialized.files[0];
    if (first === undefined) throw new Error("nothing to damage");
    const entries = jsonlLines(first.bytes);
    const meta = asRecord(entries[0]?.payload);
    if (meta === null) throw new Error("the first entry carries no session metadata");
    for (const field of CODEX_META_FIELDS.slice(0, count)) delete meta[field];
    return withBytes(serialized, jsonlBytes(entries));
  },
  hide: appendProbe,
  plantUnknown: appendUnknownEntry,
};

export const CLAUDE_CODE_CASE: AdapterCase = {
  id: "claude-code",
  folder: "claude-code",
  invented: false,
  create: () => claudeCodeAdapter.create(),
  runtime: () => null,
  damage: (serialized, count) =>
    damageAssistantUsage(serialized, count, (entry) => entry.type === "assistant"),
  hide: appendProbe,
  plantUnknown: appendUnknownEntry,
};

/** The metadata fields Kimi Code's session index cannot list a session without. */
const KIMI_CODE_META_FIELDS = ["cwd", "agents", "createdAt"];

export const KIMI_CODE_CASE: AdapterCase = {
  id: "kimi-code",
  folder: "kimi-code",
  invented: false,
  create: () => kimiCodeAdapterFactory.create(),
  runtime: () => null,
  damage: (serialized, count) => {
    const state = serialized.files.find((file) => file.absolutePath.endsWith("state.json"));
    if (state === undefined) throw new Error("nothing to damage");
    const stateRecord = JSON.parse(state.bytes.toString("utf8")) as Record<string, unknown>;
    for (const field of KIMI_CODE_META_FIELDS.slice(0, count)) delete stateRecord[field];
    const damaged = {
      ...state,
      bytes: Buffer.from(`${JSON.stringify(stateRecord, null, 2)}\n`, "utf8"),
    };
    return {
      ...serialized,
      files: serialized.files.map((file) => (file === state ? damaged : file)),
    };
  },
  hide: appendProbe,
  plantUnknown: appendUnknownEntry,
};

/** The invented fifth agent. Its capabilities alone decide what happens to it. */
export const FIXTURE_CASE: AdapterCase = {
  id: FIXTURE_AGENT_ID,
  folder: null,
  invented: true,
  create: () => createFixtureAgentAdapter(),
  runtime: () => null,
  damage: (serialized, count) => {
    const first = serialized.files[0];
    if (first === undefined) throw new Error("nothing to damage");
    const document = JSON.parse(first.bytes.toString("utf8")) as {
      exchanges: FixtureExchange[];
    };
    for (const exchange of document.exchanges.slice(0, count)) {
      delete (exchange as Partial<FixtureExchange>).stamp;
    }
    return withBytes(serialized, Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8"));
  },
  hide: (bytes, secrets) => {
    const document = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (document.kind !== FIXTURE_DOC_KIND) throw new Error("not a fixture-agent thread");
    const exchanges = document.exchanges as FixtureExchange[];
    // A native tool call, with the result body this agent recorded. Loading it must drop the
    // body and keep the outcome line (FR-23, FR-24, FR-25).
    exchanges.push({
      stamp: "2026-08-01T09:16:09Z",
      speaker: "machine",
      shape: "ran",
      words: "",
      ran: {
        tool: "Read",
        args: "'src/secret.ts'",
        outcome: "Read('src/secret.ts') → 12 lines",
        impact: "reads",
        body: secrets.join("\n"),
      },
    });
    document.vault = {
      reasoning: secrets,
      systemPrompt: secrets.join(" "),
      env: { OPENAI_API_KEY: secrets.join(" ") },
      telemetry: { payload: secrets },
    };
    return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  },
  plantUnknown: (bytes) => {
    const document = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const exchanges = document.exchanges as FixtureExchange[];
    exchanges.push({
      stamp: "2026-08-01T09:16:10Z",
      speaker: "machine",
      shape: "sparkled",
      words: UNKNOWN_MARKER,
    });
    return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  },
};

/** Every real agent the product ships. T-ADA-9 to T-ADA-12 need all of their directions. */
export const REAL_ADAPTERS: AdapterCase[] = [PI_CASE, CODEX_CASE, CLAUDE_CODE_CASE, KIMI_CODE_CASE];

/** Every adapter the suite runs, the invented fourth included (T-ADA-21). */
export const ALL_ADAPTERS: AdapterCase[] = [...REAL_ADAPTERS, FIXTURE_CASE];

/** Every ordered pair of `cases`, each agent with itself included (FR-4's diagonal). */
export function directionsOf(cases: AdapterCase[]): { source: AdapterCase; target: AdapterCase }[] {
  return cases.flatMap((source) => cases.map((target) => ({ source, target })));
}

export function hasRole(adapter: AgentAdapter, role: AdapterRole): boolean {
  return adapter.capabilities().roles.includes(role);
}

// --- throwaway homes, and the one module allowed to create files -------------------------

const committer = createFileCommitter();
const roots: string[] = [];

/** Refuse anything outside the temporary directory. C-3: a bad write damages real sessions. */
export async function assertThrowaway(target: string): Promise<void> {
  const temp = await realpath(tmpdir());
  const resolved = path.resolve(target);
  if (resolved !== temp && !resolved.startsWith(`${temp}${path.sep}`)) {
    throw new Error(`refusing to touch ${resolved}: the suite only ever writes below ${temp}`);
  }
}

/** A throwaway agent home. Never a real one (docs/tech-stack.md, C-3). */
export async function throwawayHome(label: string): Promise<string> {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), `resume-from-ada-${label}-`));
  roots.push(root);
  return root;
}

export async function cleanupHomes(): Promise<void> {
  for (const root of roots.splice(0)) {
    await assertThrowaway(root);
    await rm(root, { recursive: true, force: true });
  }
}

/** What `src/import/landing/` does: validate first, place only when there is no defect (FR-50). */
export async function land(
  adapter: AgentAdapter,
  serialized: SerializedSession,
): Promise<{ defects: number; createdPaths: string[] }> {
  const defects = adapter.validate(serialized);
  if (defects.length > 0) {
    return { defects: defects.length, createdPaths: [] };
  }
  return { defects: 0, createdPaths: await commit(serialized.files) };
}

/** Create files through the only module allowed to create them (FR-49, FR-53). */
export async function commit(files: PendingFile[]): Promise<string[]> {
  for (const file of files) await assertThrowaway(file.absolutePath);
  const first = files[0];
  if (first === undefined) return [];
  const root = roots.find((candidate) => {
    const fromRoot = path.relative(candidate, first.absolutePath);
    return fromRoot !== ".." && !fromRoot.startsWith(`..${path.sep}`) && !path.isAbsolute(fromRoot);
  });
  if (root === undefined) throw new Error(`no throwaway home owns ${first.absolutePath}`);
  // One commit per file, in order: the store's one-file atomicity invariant stays untouched,
  // and an adapter that orders its files safely (wire before state, for Kimi Code) leaves no
  // visible partial session when a landing is interrupted between commits.
  const created: string[] = [];
  for (const file of files) {
    const handle = await committer.commit(root, [file]);
    created.push(...handle.createdPaths);
  }
  return created;
}

/** Every file below `dir`: its bytes, its size and its modification time. */
export async function snapshot(dir: string): Promise<Map<string, string>> {
  const sums = new Map<string, string>();
  const walk = async (current: string): Promise<void> => {
    let items: Dirent[];
    try {
      items = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) {
        sums.set(`${path.relative(dir, full)}/`, "dir");
        await walk(full);
        continue;
      }
      const info = await stat(full);
      const digest = createHash("sha256")
        .update(await readFile(full))
        .digest("hex");
      sums.set(path.relative(dir, full), `${info.size}:${info.mtimeMs}:${digest}`);
    }
  };
  await walk(dir);
  return sums;
}

export async function filesUnder(dir: string): Promise<string[]> {
  return [...(await snapshot(dir)).keys()].filter((name) => !name.endsWith("/")).sort();
}

// --- sessions the suite imports ----------------------------------------------------------

export function markerFor(
  session: CanonicalSession,
  importedAt = "2026-08-02T10:00:00Z",
): ProvenanceMarker {
  const ref = session.provenance.ref;
  return {
    sourceAgent: ref.agent,
    sourceHome: ref.home,
    sourceSessionId: ref.id,
    importedAt,
    droppedSummary: "3 tool result bodies dropped",
    lines: [
      `Imported from ${ref.agent} — ${ref.id}`,
      "3 tool result bodies dropped",
      "Files may have changed since. Re-read before editing.",
    ],
  };
}

export function targetProfile(adapter: AgentAdapter, home: string): TargetProfile {
  const capabilities = adapter.capabilities();
  return {
    agent: capabilities.agent,
    home,
    windowTokens: capabilities.defaultWindowTokens,
  };
}

function turn(
  partial: Partial<CanonicalTurn> & {
    index: number;
    role: CanonicalTurn["role"];
  },
): CanonicalTurn {
  return {
    kind: "message",
    text: "",
    toolCall: null,
    timestamp: "2026-08-01T09:14:02Z",
    ...partial,
  };
}

/**
 * The session of T-ADA-11, T-ADA-12 and T-ADA-23: a dropped 400-line `Read`, a mutating `Edit`,
 * a `shell` call, and a tool name no adapter has ever heard of.
 */
export const TOOL_SESSION: CanonicalSession = {
  provenance: {
    ref: {
      agent: "codex" as AgentId,
      home: "/home/testuser/.codex",
      id: "tools-0001",
    },
    title: "make the auth token refresh work",
    startedAt: "2026-08-01T09:14:02Z",
    updatedAt: "2026-08-01T09:16:08Z",
    repo: {
      commit: "3f2a1bc9d4e5f60718293a4b5c6d7e8f90a1b2c3",
      branch: "fix/auth-refresh",
      changedPaths: ["src/auth.ts"],
    },
  },
  turns: [
    turn({ index: 0, role: "user", text: "make the auth token refresh work" }),
    turn({
      index: 1,
      role: "agent",
      kind: "tool-call",
      toolCall: {
        toolName: "Read",
        argumentsText: "'src/auth.ts'",
        outcomeLine: `Read('src/auth.ts') → 400 lines ${DROPPED_NOTE}`,
        effect: "read-only",
        bodyDropped: true,
        resultRecorded: true,
      },
      timestamp: "2026-08-01T09:14:06Z",
    }),
    turn({
      index: 2,
      role: "agent",
      kind: "tool-call",
      toolCall: {
        toolName: "Edit",
        argumentsText: "'src/auth.ts'",
        outcomeLine: "Edit('src/auth.ts') → 1 hunk applied",
        effect: "mutating",
        bodyDropped: false,
        resultRecorded: true,
      },
      timestamp: "2026-08-01T09:14:31Z",
    }),
    turn({
      index: 3,
      role: "agent",
      kind: "tool-call",
      toolCall: {
        toolName: "shell",
        argumentsText: "'npm test'",
        outcomeLine: `shell('npm test') → 1 failing, 23 passing ${DROPPED_NOTE}`,
        effect: "unknown",
        bodyDropped: true,
        resultRecorded: true,
      },
      timestamp: "2026-08-01T09:15:19Z",
    }),
    turn({
      index: 4,
      role: "agent",
      kind: "tool-call",
      toolCall: {
        toolName: "Frobnicate",
        argumentsText: "'the widget'",
        outcomeLine: "Frobnicate('the widget') → 1 widget frobnicated",
        effect: "unknown",
        bodyDropped: false,
        resultRecorded: true,
      },
      timestamp: "2026-08-01T09:15:44Z",
    }),
    turn({
      index: 5,
      role: "agent",
      kind: "summary",
      text: "So far: the refresh never persisted the new token. Fixed and tested.",
      timestamp: "2026-08-01T09:15:50Z",
    }),
    turn({
      index: 6,
      role: "user",
      text: "inject the clock, don't mock the whole module",
    }),
  ],
};

export { REFERENCE_SESSION };

/** The tool names T-ADA-12 follows across a direction. */
export const TOOL_NAMES = ["Read", "Edit", "shell", "Frobnicate"];

/** Text a turn shows the user. Empty for a tool call, whose line is its outcome. */
export function visibleTexts(session: CanonicalSession): string[] {
  return session.turns
    .filter((item) => item.kind !== "tool-call" && item.text.trim().length > 0)
    .map((item) => item.text);
}

// --- one direction of the scope table ----------------------------------------------------

export interface DirectionRun {
  sourceHome: string;
  targetHome: string;
  /** The session the source home was seeded with, as the source adapter reads it back. */
  loaded: CanonicalSession;
  descriptor: SessionDescriptor;
  serialized: SerializedSession;
  /** What the target holds after the commit. */
  reloaded: CanonicalSession;
  /** Every byte the commit created, as text. */
  targetText: string;
  createdPaths: string[];
  facts: StoredSessionFacts;
  /** The source home before the import ran, and after it finished (T-ADA-14, NG-1, AC-4). */
  sourceBefore: Map<string, string>;
  sourceAfter: Map<string, string>;
}

/** Seed a throwaway home with one session, written by that agent's own adapter. */
export async function seedSource(
  source: AdapterCase,
  session: CanonicalSession,
  options: { hide?: string[]; unknown?: boolean; home?: string } = {},
): Promise<{ home: string; sessionId: string; filePath: string }> {
  const adapter = source.create();
  const home = options.home ?? (await throwawayHome(`src-${source.id}`));
  const serialized = adapter.serialize(session, targetProfile(adapter, home), markerFor(session), {
    cwd: "/repo",
  });
  const planted: string[] = [];
  const files = serialized.files.map((file, index) => {
    if (index !== 0) return file;
    let bytes = file.bytes;
    if (options.hide !== undefined) {
      bytes = source.hide(bytes, options.hide);
      planted.push(...options.hide);
    }
    if (options.unknown === true) {
      bytes = source.plantUnknown(bytes);
      planted.push(UNKNOWN_MARKER);
    }
    return { absolutePath: file.absolutePath, bytes };
  });
  const created = await commit(files);
  const filePath = created[0];
  if (filePath === undefined) throw new Error(`${source.id} serialized no file to seed with`);
  if (planted.length > 0) {
    // Without this the hunt for planted content would pass on a source that never held it.
    const seeded = await readFile(filePath, "utf8");
    for (const value of planted) {
      if (!seeded.includes(value)) {
        throw new Error(`the ${source.id} source file does not hold the planted ${value}`);
      }
    }
  }
  return { home, sessionId: serialized.sessionId, filePath };
}

/**
 * One cell of the scope table: read with the source adapter, write with the target adapter,
 * commit, and read the result back with the target adapter acting as a source.
 *
 * Source and target always get their own home, including the diagonal cells where the two
 * agents are the same (FR-4).
 */
export async function runDirection(
  source: AdapterCase,
  target: AdapterCase,
  session: CanonicalSession,
  options: { hide?: string[]; unknown?: boolean } = {},
): Promise<DirectionRun> {
  const sourceAdapter = source.create();
  const targetAdapter = target.create();
  const seeded = await seedSource(source, session, options);
  const sourceBefore = await snapshot(seeded.home);

  const descriptors = await sourceAdapter.listSessions(seeded.home);
  const descriptor = descriptors.find((item) => item.ref.id === seeded.sessionId);
  if (descriptor === undefined) {
    throw new Error(
      `${source.id} did not list the session ${seeded.sessionId} it wrote into ${seeded.home}`,
    );
  }
  const loaded = await sourceAdapter.loadSession(descriptor);

  const targetHome = await throwawayHome(`dst-${target.id}`);
  const serialized = targetAdapter.serialize(
    loaded,
    targetProfile(targetAdapter, targetHome),
    markerFor(loaded),
    { cwd: "/repo" },
  );
  const defects = targetAdapter.validate(serialized);
  if (defects.length > 0) {
    throw new Error(
      `${source.id} → ${target.id} produced ${defects.length} defect(s): ${defects
        .map((defect) => `${defect.path}: ${defect.message}`)
        .join("; ")}`,
    );
  }
  const createdPaths = await commit(serialized.files);
  const facts = await targetAdapter.readBack(targetHome, serialized.sessionId);

  const written = await targetAdapter.listSessions(targetHome);
  const writtenDescriptor = written.find((item) => item.ref.id === serialized.sessionId);
  if (writtenDescriptor === undefined) {
    throw new Error(`${target.id} did not list the session it just committed into ${targetHome}`);
  }
  const reloaded = await targetAdapter.loadSession(writtenDescriptor);

  const texts: string[] = [];
  for (const created of createdPaths) texts.push(await readFile(created, "utf8"));

  return {
    sourceHome: seeded.home,
    targetHome,
    loaded,
    descriptor,
    serialized,
    reloaded,
    targetText: texts.join("\n"),
    createdPaths,
    facts,
    sourceBefore,
    sourceAfter: await snapshot(seeded.home),
  };
}

/** Every text a session shows, as one string. Used to hunt for content that must not cross. */
export function sessionText(session: CanonicalSession): string {
  return JSON.stringify(session);
}

// --- the network tripwire (T-ADA-15) -----------------------------------------------------

const require_ = createRequire(import.meta.url);
const attempts: string[] = [];
let restore: (() => void)[] = [];

function trip(name: string): never {
  attempts.push(name);
  throw new Error(`no adapter may open a network connection: ${name} was called (FR-8)`);
}

/**
 * Fail on any use of the network. The adapters read files and nothing else, so the whole suite
 * runs with this installed: an import must work with the source agent stopped or out of quota.
 */
export function installNetworkTripwire(): void {
  attempts.length = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((): never => trip("fetch")) as unknown as typeof fetch;
  restore.push(() => {
    globalThis.fetch = realFetch;
  });

  for (const [moduleName, fnNames] of [
    ["node:http", ["request", "get"]],
    ["node:https", ["request", "get"]],
    ["node:net", ["connect", "createConnection"]],
  ] as const) {
    const loaded = require_(moduleName) as Record<string, unknown>;
    for (const fnName of fnNames) {
      const real = loaded[fnName];
      try {
        loaded[fnName] = (): never => trip(`${moduleName}.${fnName}`);
        restore.push(() => {
          loaded[fnName] = real;
        });
      } catch {
        // A frozen builtin cannot be patched; `fetch` remains the tripwire that matters.
      }
    }
  }
}

export function networkAttempts(): string[] {
  return [...attempts];
}

/** Forget the deliberate call a test makes to prove the tripwire is armed. */
export function clearNetworkAttempts(): void {
  attempts.length = 0;
}

export function restoreNetwork(): void {
  for (const undo of restore.reverse()) undo();
  restore = [];
}
