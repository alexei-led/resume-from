/**
 * The fake fourth agent.
 *
 * It exists so several tests across the tree can add an agent nobody wrote a rule for
 * (T-ADA-21, T-ADA-22, T-HOS-10, T-HOS-18, T-IMP-24, T-CLI-23, T-ROO-20). Its behaviour is
 * decided by the capabilities it declares and by nothing else — no rule, no preview and no
 * other adapter knows its name.
 *
 * It lives outside `src/` on purpose (`src/adapters/module.md`, Constraints): it has no
 * `module.md`, it is not a module of the design tree, and `src/host/`'s agent list never holds
 * it. That is what keeps T-SES-9 true — the values of `AgentId` equal the folder names under
 * `src/adapters/` — while still letting the tests exercise a fourth agent.
 *
 * Its format is deliberately unlike the three real ones: one whole JSON document per session,
 * not JSONL, with its own vocabulary (`exchanges`, `speaker`, `shape`, `words`). An adapter that
 * only works because the rest of the system guessed at JSONL fails here.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterRole,
  AgentAdapter,
  AgentCapabilities,
  AgentId,
  AgentRuntime,
  CanonicalSession,
  CanonicalTurn,
  HomePath,
  ProvenanceMarker,
  SerializationContext,
  SerializedSession,
  SessionDescriptor,
  SessionId,
  StoredSessionFacts,
  SwitchOutcome,
  TargetProfile,
  ToolEffect,
  ValidationDefect,
} from "../../../src/adapters/contract.js";

/**
 * The one place the fixture leaves the declared vocabulary. `AgentId` is closed over the three
 * folders under `src/adapters/` (T-SES-9), and this agent has no folder there on purpose, so the
 * id it declares is asserted rather than inferred. Every other value it produces is well typed.
 */
export const FIXTURE_AGENT_ID = "fixture-agent" as AgentId;

export const FIXTURE_THREADS_DIR = "threads";
export const FIXTURE_FILE_SUFFIX = ".fixture.json";
export const FIXTURE_DOC_KIND = "fixture-agent-thread";
export const FIXTURE_WINDOW_TOKENS = 120_000;
export const FIXTURE_DROPPED_NOTE = "(content dropped: imported session, may be stale)";
const UNREADABLE_TITLE = "(unreadable session file)";
const EMPTY_WORDS = "(empty exchange)";
const MAX_MINT_ATTEMPTS = 8;

/** What one exchange of a fixture-agent thread holds. `ran` only ever appears in a source file. */
export interface FixtureExchange {
  stamp: string;
  speaker: "human" | "machine";
  /** `said` is a message, `recap` a summary, `ran` a tool call. Anything else is skipped. */
  shape: string;
  words: string;
  ran?: {
    tool: string;
    args: string;
    outcome: string;
    impact: "reads" | "writes" | "unclear";
    /** The result body the agent recorded. It never crosses (FR-24). */
    body?: string;
  };
}

export interface FixtureThread {
  kind: string;
  id: string;
  topic: string;
  opened: string;
  touched: string;
  workspace: string;
  vcs: { commit: string | null; branch: string | null; touchedPaths: string[] };
  /** The provenance marker. Shown to the user, never sent to the model (FR-47, FR-48). */
  notice: string[];
  exchanges: FixtureExchange[];
  /** Everything this agent keeps to itself: reasoning, prompts, environment, telemetry. */
  vault?: Record<string, unknown>;
}

export interface FixtureAgentOptions {
  /** Defaults to both roles. `["source"]` is what T-ADA-22 uses. */
  roles?: AdapterRole[];
  defaultHome?: HomePath;
}

export function fixtureThreadPath(home: HomePath, id: SessionId): string {
  return path.join(home, FIXTURE_THREADS_DIR, `${id}${FIXTURE_FILE_SUFFIX}`);
}

const IMPACTS: Record<string, ToolEffect> = {
  reads: "read-only",
  writes: "mutating",
  unclear: "unknown",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readThread(text: string): FixtureThread | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.kind !== FIXTURE_DOC_KIND) return null;
  if (typeof value.id !== "string" || !Array.isArray(value.exchanges)) return null;
  return value as unknown as FixtureThread;
}

/** A thread's turns. The vault and every result body stay behind (FR-24, FR-28). */
function threadTurns(thread: FixtureThread): { turns: CanonicalTurn[]; skipped: number } {
  const turns: CanonicalTurn[] = [];
  let skipped = 0;
  for (const exchange of thread.exchanges) {
    if (!isRecord(exchange)) {
      skipped += 1;
      continue;
    }
    const role = exchange.speaker === "human" ? "user" : "agent";
    const timestamp = typeof exchange.stamp === "string" ? exchange.stamp : null;
    if (exchange.shape === "said" || exchange.shape === "recap") {
      turns.push({
        index: turns.length,
        role,
        kind: exchange.shape === "recap" ? "summary" : "message",
        text: typeof exchange.words === "string" ? exchange.words : "",
        toolCall: null,
        timestamp,
      });
      continue;
    }
    if (exchange.shape === "ran" && isRecord(exchange.ran)) {
      const ran = exchange.ran as NonNullable<FixtureExchange["ran"]>;
      const bodyDropped = typeof ran.body === "string" && ran.body.length > 0;
      turns.push({
        index: turns.length,
        role: "agent",
        kind: "tool-call",
        text: "",
        toolCall: {
          // FR-27: the name crosses exactly as this agent recorded it.
          toolName: ran.tool,
          argumentsText: ran.args,
          outcomeLine: bodyDropped ? `${ran.outcome} ${FIXTURE_DROPPED_NOTE}` : ran.outcome,
          effect: IMPACTS[ran.impact] ?? "unknown",
          bodyDropped,
          // FR-54: this agent always records an outcome for every call it runs.
          resultRecorded: true,
        },
        timestamp,
      });
      continue;
    }
    // Nothing is guessed: a shape this adapter does not know produces no turn.
    skipped += 1;
  }
  return { turns, skipped };
}

function exchangeOf(turn: CanonicalTurn, fallbackStamp: string): FixtureExchange {
  const call = turn.toolCall;
  // A tool call crosses as one line of text, never as a structure the agent could replay
  // (FR-26, NG-6).
  const words =
    turn.kind === "tool-call" && call !== null
      ? call.outcomeLine.includes(call.toolName)
        ? call.outcomeLine
        : `${call.toolName}(${call.argumentsText}) → ${call.outcomeLine}`
      : turn.text;
  return {
    stamp: turn.timestamp ?? fallbackStamp,
    speaker: turn.role === "user" ? "human" : "machine",
    shape: turn.kind === "summary" ? "recap" : "said",
    words: words.trim() === "" ? EMPTY_WORDS : words,
  };
}

function mintThreadId(home: HomePath): SessionId {
  for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
    const id = `fx-${randomUUID()}`;
    if (!existsSync(fixtureThreadPath(home, id))) return id;
  }
  throw new Error(`fixture agent: no unused thread id in ${home}`);
}

function missingRole(role: AdapterRole): Error {
  return new Error(
    `the fixture-agent adapter declares no "${role}" role, so it cannot be used as an import ${
      role === "source" ? "source" : "target"
    } (FR-59)`,
  );
}

export function createFixtureAgentAdapter(options: FixtureAgentOptions = {}): AgentAdapter {
  const roles: AdapterRole[] = options.roles ?? ["source", "target"];
  const capabilities: AgentCapabilities = Object.freeze({
    agent: FIXTURE_AGENT_ID,
    roles: Object.freeze([...roles]) as AdapterRole[],
    selection: "numbered-list",
    landing: "create-only",
    provenance: "out-of-context-entry",
    defaultHome: options.defaultHome ?? path.resolve(path.sep, "fixture-agent-home"),
    defaultWindowTokens: FIXTURE_WINDOW_TOKENS,
    idLookup: { v4: 0, v7: 0, other: 0 },
  });
  const has = (role: AdapterRole): boolean => roles.includes(role);

  function describeThread(
    home: HomePath,
    filePath: string,
    thread: FixtureThread | null,
  ): SessionDescriptor {
    const id = path.basename(filePath).slice(0, -FIXTURE_FILE_SUFFIX.length);
    if (thread === null) {
      // A file this adapter cannot read is reported as unreadable, never as a shorter session.
      return {
        ref: { agent: FIXTURE_AGENT_ID, home, id },
        title: `${UNREADABLE_TITLE} ${path.basename(filePath)}`,
        startedAt: "",
        updatedAt: "",
        turnCount: 0,
        repoPath: null,
        repoPaths: [],
        startDirectory: null,
        filePath,
      };
    }
    return {
      ref: { agent: FIXTURE_AGENT_ID, home, id: thread.id },
      title: thread.topic,
      startedAt: thread.opened,
      updatedAt: thread.touched,
      turnCount: threadTurns(thread).turns.length,
      repoPath: path.isAbsolute(thread.workspace) ? thread.workspace : null,
      repoPaths: path.isAbsolute(thread.workspace) ? [thread.workspace] : [],
      startDirectory: path.isAbsolute(thread.workspace) ? thread.workspace : null,
      filePath,
    };
  }

  function searchRoots(): string[] {
    return [path.join(capabilities.defaultHome, FIXTURE_THREADS_DIR)];
  }

  async function describeFile(home: HomePath, filePath: string): Promise<SessionDescriptor> {
    const text = await readFile(filePath, "utf8").catch(() => null);
    return describeThread(home, filePath, text === null ? null : readThread(text));
  }

  return {
    capabilities(): AgentCapabilities {
      return capabilities;
    },

    searchRoots,

    async findSessions(root: string, query: string): Promise<SessionDescriptor[]> {
      if (!has("source")) throw missingRole("source");
      const names = (await readdir(root).catch(() => [])).filter((name) =>
        name.endsWith(FIXTURE_FILE_SUFFIX),
      );
      const wanted = query.toLowerCase();
      const rows: SessionDescriptor[] = [];
      for (const name of names.sort()) {
        const id = name.slice(0, -FIXTURE_FILE_SUFFIX.length);
        const matches =
          id.toLowerCase() === wanted ||
          (wanted.length >= 6 && id.toLowerCase().startsWith(wanted));
        if (!matches) continue;
        rows.push(await describeFile(path.dirname(root), path.join(root, name)));
      }
      return rows;
    },

    describeSession(filePath: string): Promise<SessionDescriptor> {
      return describeFile(path.dirname(path.dirname(filePath)), filePath);
    },

    resumeCommand(input): string {
      const prompt = input.prompt === null ? "" : ` '${input.prompt}'`;
      return `cd ${input.directory} && fixture-agent resume ${input.sessionId}${prompt}`;
    },

    async listSessions(home: HomePath): Promise<SessionDescriptor[]> {
      if (!has("source")) throw missingRole("source");
      const dir = path.join(home, FIXTURE_THREADS_DIR);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return [];
      }
      const descriptors: SessionDescriptor[] = [];
      for (const name of names.sort()) {
        if (!name.endsWith(FIXTURE_FILE_SUFFIX)) continue;
        const filePath = path.join(dir, name);
        descriptors.push(await describeFile(home, filePath));
      }
      return descriptors.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    async loadSession(descriptor: SessionDescriptor): Promise<CanonicalSession> {
      if (!has("source")) throw missingRole("source");
      const text = await readFile(descriptor.filePath, "utf8");
      const thread = readThread(text);
      if (thread === null) {
        throw new Error(
          `the fixture-agent thread ${descriptor.filePath} cannot be read: it is cut mid-document or not a fixture-agent thread`,
        );
      }
      const { turns } = threadTurns(thread);
      return {
        provenance: {
          ref: { agent: FIXTURE_AGENT_ID, home: descriptor.ref.home, id: thread.id },
          title: thread.topic,
          startedAt: thread.opened,
          updatedAt: thread.touched,
          repo: {
            commit: thread.vcs?.commit ?? null,
            branch: thread.vcs?.branch ?? null,
            changedPaths: thread.vcs?.touchedPaths ?? [],
          },
        },
        turns,
      };
    },

    serialize(
      session: CanonicalSession,
      target: TargetProfile,
      marker: ProvenanceMarker,
      context: SerializationContext,
    ): SerializedSession {
      if (!has("target")) throw missingRole("target");
      const id = mintThreadId(target.home);
      const fallbackStamp = marker.importedAt;
      const thread: FixtureThread = {
        kind: FIXTURE_DOC_KIND,
        id,
        topic: session.provenance.title,
        opened: session.provenance.startedAt,
        touched: session.provenance.updatedAt,
        workspace: context.cwd,
        vcs: {
          commit: session.provenance.repo.commit,
          branch: session.provenance.repo.branch,
          touchedPaths: session.provenance.repo.changedPaths,
        },
        notice: marker.lines,
        exchanges: session.turns.map((turn) => exchangeOf(turn, fallbackStamp)),
      };
      return {
        sessionId: id,
        files: [
          {
            absolutePath: fixtureThreadPath(target.home, id),
            bytes: Buffer.from(`${JSON.stringify(thread, null, 2)}\n`, "utf8"),
          },
        ],
        itemCount: thread.exchanges.length,
      };
    },

    validate(serialized: SerializedSession): ValidationDefect[] {
      if (!has("target")) throw missingRole("target");
      const defects: ValidationDefect[] = [];
      const file = serialized.files[0];
      if (serialized.files.length !== 1 || file === undefined) {
        return [{ path: "files", message: "a fixture-agent thread is exactly one document" }];
      }
      if (!path.isAbsolute(file.absolutePath) || !file.absolutePath.endsWith(FIXTURE_FILE_SUFFIX)) {
        defects.push({
          path: "files/0/absolutePath",
          message: `a thread is an absolute ${FIXTURE_FILE_SUFFIX} path, not ${file.absolutePath}`,
        });
      }
      let value: unknown;
      try {
        value = JSON.parse(file.bytes.toString("utf8"));
      } catch {
        defects.push({ path: "files/0/bytes", message: "the document is not whole JSON" });
        return defects;
      }
      if (!isRecord(value)) {
        defects.push({ path: "files/0/bytes", message: "the document is not an object" });
        return defects;
      }
      if (value.kind !== FIXTURE_DOC_KIND) {
        defects.push({ path: "kind", message: `the document kind must be ${FIXTURE_DOC_KIND}` });
      }
      if (value.id !== serialized.sessionId) {
        defects.push({
          path: "id",
          message: `the document names ${String(value.id)}, not the session ${serialized.sessionId}`,
        });
      }
      const exchanges = Array.isArray(value.exchanges) ? value.exchanges : null;
      if (exchanges === null) {
        defects.push({ path: "exchanges", message: "the document holds no exchanges array" });
        return defects;
      }
      exchanges.forEach((exchange: unknown, index: number) => {
        const at = `exchanges/${index}`;
        if (!isRecord(exchange)) {
          defects.push({ path: at, message: "an exchange must be an object" });
          return;
        }
        // The fixture agent reads `stamp` without a guard, exactly the way C-11 says Pi reads
        // `usage`: a thread missing one stops the agent after the file is already in place.
        if (typeof exchange.stamp !== "string" || Number.isNaN(Date.parse(exchange.stamp))) {
          defects.push({
            path: `${at}/stamp`,
            message: "the exchange has no ISO-8601 stamp, and the agent reads it without a guard",
          });
        }
        if (exchange.speaker !== "human" && exchange.speaker !== "machine") {
          defects.push({ path: `${at}/speaker`, message: "the speaker must be human or machine" });
        }
        if (typeof exchange.words !== "string" || exchange.words === "") {
          defects.push({ path: `${at}/words`, message: "an exchange with no words is invisible" });
        }
      });
      if (exchanges.length !== serialized.itemCount) {
        defects.push({
          path: "itemCount",
          message: `itemCount says ${serialized.itemCount} and the document holds ${exchanges.length}`,
        });
      }
      return defects;
    },

    async readBack(home: HomePath, sessionId: SessionId): Promise<StoredSessionFacts> {
      if (!has("target")) throw missingRole("target");
      const absent: StoredSessionFacts = { sessionId, itemCount: 0, openable: false };
      const text = await readFile(fixtureThreadPath(home, sessionId), "utf8").catch(() => null);
      if (text === null) return absent;
      const thread = readThread(text);
      if (thread === null) return absent;
      return {
        sessionId,
        itemCount: thread.exchanges.length,
        openable: thread.id === sessionId && thread.exchanges.length > 0,
      };
    },

    switchTo(home: HomePath, sessionId: SessionId, _runtime: AgentRuntime): Promise<SwitchOutcome> {
      if (!has("target")) return Promise.reject(missingRole("target"));
      return Promise.reject(
        new Error(
          'the fixture agent declares landing "create-only": it cannot move the user into a ' +
            `session. Run: fixture-agent --home ${home} resume ${sessionId}`,
        ),
      );
    },
  };
}
