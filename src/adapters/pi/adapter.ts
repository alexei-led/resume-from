/**
 * The Pi adapter. It fills both roles of the port: it reads Pi sessions into the canonical
 * vocabulary, and it writes canonical sessions back into files Pi can open.
 *
 * It never writes a file — `serialize` hands `PendingFile` values to `src/import/landing/`
 * (FR-49, FR-53) — never opens a source session for writing (NG-1, AC-4), never calls Pi's
 * model, and never opens a network connection (FR-8).
 */

import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { sessionIdMatches } from "../id-match.js";
import { resumeCommandLine } from "../shell.js";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentRuntime,
  CanonicalSession,
  HomePath,
  PiSwitchContext,
  ProvenanceMarker,
  SerializationContext,
  SerializedSession,
  SessionDescriptor,
  SessionId,
  StoredSessionFacts,
  SwitchOutcome,
  TargetProfile,
  ValidationDefect,
} from "./contract.js";
import {
  DEFAULT_WINDOW_TOKENS,
  defaultPiHome,
  homeOfSessionFile,
  homeOfSessionsRoot,
  searchRoots as piSearchRoots,
  sessionIdFromFileName,
  sessionsRoot,
  shortTitle,
  toIsoUtc,
  UNREADABLE_TITLE_PREFIX,
} from "./format.js";
import {
  changedPathsFromEntries,
  entriesToTurns,
  lastTimestamp,
  parseSessionText,
  resolveActiveEntries,
  titleFromEntries,
} from "./parse.js";
import { type PiSerializeDeps, serializeSession } from "./serialize.js";
import { validateSerialized } from "./validate.js";

export interface PiAdapterDeps extends PiSerializeDeps {
  /** Pi's own default agent directory. Overridden only by tests. */
  defaultHome(): string;
}

const DEFAULT_DEPS: PiAdapterDeps = {
  now: () => new Date(),
  newSessionId: () => randomUUID(),
  newEntryId: () => randomUUID().slice(0, 8),
  defaultHome: defaultPiHome,
};

/** Every `.jsonl` below one session directory. Pi keeps one directory per repository. */
async function sessionFilesInRoot(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let isDirectory: boolean;
      try {
        isDirectory = (await stat(full)).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) {
        if (depth > 0) await walk(full, depth - 1);
        continue;
      }
      if (name.endsWith(".jsonl")) files.push(full);
    }
  };
  await walk(root, 2);
  return files;
}

/** Every `.jsonl` below `<home>/sessions/`. */
function sessionFilesIn(home: HomePath): Promise<string[]> {
  return sessionFilesInRoot(sessionsRoot(home));
}

async function findSessionFile(home: HomePath, sessionId: SessionId): Promise<string | null> {
  const suffix = `_${sessionId}.jsonl`;
  for (const file of await sessionFilesIn(home)) {
    const name = basename(file);
    if (name.endsWith(suffix) || sessionIdFromFileName(name) === sessionId) return file;
  }
  return null;
}

function describe(
  home: HomePath,
  filePath: string,
  text: string,
  fileTime: string,
): SessionDescriptor {
  const parsed = parseSessionText(text);
  const id = parsed.header?.id ?? sessionIdFromFileName(basename(filePath)) ?? basename(filePath);
  const ref = { agent: "pi" as const, home, id };
  const startedAt = toIsoUtc(parsed.header?.timestamp) ?? fileTime;
  const resolved = resolveActiveEntries(parsed.entries);
  const repoPaths =
    parsed.header !== null && isAbsolute(parsed.header.cwd) ? [parsed.header.cwd] : [];

  if (!parsed.header || parsed.truncated || resolved.unreadable !== null) {
    return {
      ref,
      title: `${UNREADABLE_TITLE_PREFIX}${basename(filePath)}`,
      startedAt,
      updatedAt: lastTimestamp(resolved.activePath) ?? fileTime,
      turnCount: 0,
      repoPath: repoPaths[0] ?? null,
      repoPaths,
      startDirectory: repoPaths[0] ?? null,
      filePath,
    };
  }

  const loaded = entriesToTurns(parsed.entries);
  const title = titleFromEntries(resolved.activePath);
  return {
    ref,
    title: title ? shortTitle(title) : `${basename(filePath)}`,
    startedAt,
    updatedAt: lastTimestamp(resolved.activePath) ?? startedAt,
    turnCount: loaded.turns.length,
    repoPath: repoPaths[0] ?? null,
    repoPaths,
    startDirectory: repoPaths[0] ?? null,
    filePath,
  };
}

/** Reads one file into a row, or null when it cannot be read. */
async function describeFileOnDisk(
  home: HomePath,
  filePath: string,
): Promise<SessionDescriptor | null> {
  try {
    const text = await readFile(filePath, "utf8");
    const fileTime = new Date((await stat(filePath)).mtimeMs).toISOString();
    return describe(home, filePath, text, fileTime);
  } catch {
    return null;
  }
}

/** Sessions of one session directory whose ID matches the query (FR-61). */
async function findPiSessions(root: string, query: string): Promise<SessionDescriptor[]> {
  const home = homeOfSessionsRoot(root);
  const descriptors: SessionDescriptor[] = [];
  for (const filePath of await sessionFilesInRoot(root)) {
    const id = sessionIdFromFileName(basename(filePath));
    if (id === null || !sessionIdMatches(id, query)) continue;
    const descriptor = await describeFileOnDisk(home, filePath);
    if (descriptor !== null) descriptors.push(descriptor);
  }
  return descriptors.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** One session file described directly, for selection by path (FR-12). */
async function describePiSession(filePath: string): Promise<SessionDescriptor> {
  const home = homeOfSessionFile(filePath);
  const text = await readFile(filePath, "utf8");
  const fileTime = new Date((await stat(filePath)).mtimeMs).toISOString();
  return describe(home, filePath, text, fileTime);
}

/** The part of a Pi command context this module uses, and nothing else (C-10). */
function asSwitchContext(runtime: AgentRuntime): PiSwitchContext {
  if (typeof runtime !== "object" || runtime === null) {
    throw new TypeError(
      "the Pi adapter needs a PiSwitchContext with a switchSession function, and got " +
        `${runtime === null ? "null" : typeof runtime}`,
    );
  }
  const candidate = runtime as { switchSession?: unknown };
  if (typeof candidate.switchSession !== "function") {
    throw new TypeError(
      "the Pi adapter needs a PiSwitchContext with a switchSession function, and the runtime handle has none",
    );
  }
  return runtime as PiSwitchContext;
}

export function createPiAdapter(overrides: Partial<PiAdapterDeps> = {}): AgentAdapter {
  const deps: PiAdapterDeps = { ...DEFAULT_DEPS, ...overrides };

  return {
    capabilities(): AgentCapabilities {
      return {
        agent: "pi",
        // Pi is the only agent of the three that can move the user itself (C-10).
        roles: ["source", "target"],
        selection: "interactive-picker",
        landing: "create-and-switch",
        provenance: "out-of-context-entry",
        defaultHome: deps.defaultHome(),
        defaultWindowTokens: DEFAULT_WINDOW_TOKENS,
        // Pi writes mostly UUIDv7, some v4, and custom names; a custom query is its best case.
        idLookup: { v4: 2, v7: 1, other: 0 },
      };
    },

    async listSessions(home: HomePath): Promise<SessionDescriptor[]> {
      const descriptors: SessionDescriptor[] = [];
      // Whole-file read and full parse per file: title, turn count, and updatedAt all require
      // parsing the entire JSONL (FR-11). Same approach as the claude-code adapter (not
      // separately benchmarked for Pi files); revisit if a home with thousands of sessions
      // makes the listing noticeably slow to users.
      for (const filePath of await sessionFilesIn(home)) {
        const descriptor = await describeFileOnDisk(home, filePath);
        if (descriptor !== null) descriptors.push(descriptor);
      }
      return descriptors.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    searchRoots(): string[] {
      return piSearchRoots();
    },

    findSessions(root: string, query: string): Promise<SessionDescriptor[]> {
      return findPiSessions(root, query);
    },

    describeSession(filePath: string): Promise<SessionDescriptor> {
      return describePiSession(filePath);
    },

    resumeCommand(input): string {
      const argv = ["pi", "--session", input.filePath];
      if (input.prompt !== null && input.prompt !== "") argv.push(input.prompt);
      return resumeCommandLine({ directory: input.directory, argv });
    },

    async loadSession(descriptor: SessionDescriptor): Promise<CanonicalSession> {
      const text = await readFile(descriptor.filePath, "utf8");
      const parsed = parseSessionText(text);
      const resolved = resolveActiveEntries(parsed.entries);
      if (!parsed.header || parsed.truncated || resolved.unreadable !== null) {
        throw new Error(
          `the Pi session file ${descriptor.filePath} cannot be read: it is truncated or not a Pi session`,
        );
      }
      const loaded = entriesToTurns(parsed.entries);
      const startedAt = toIsoUtc(parsed.header.timestamp) ?? descriptor.startedAt;
      return {
        provenance: {
          ref: { agent: "pi", home: descriptor.ref.home, id: parsed.header.id },
          title: descriptor.title,
          startedAt,
          updatedAt: lastTimestamp(resolved.activePath) ?? startedAt,
          repo: {
            // Pi records neither the commit nor the branch of a session.
            commit: null,
            branch: null,
            changedPaths: changedPathsFromEntries(resolved.activePath),
          },
        },
        turns: loaded.turns,
      };
    },

    serialize(
      session: CanonicalSession,
      target: TargetProfile,
      marker: ProvenanceMarker,
      context: SerializationContext,
    ): SerializedSession {
      return serializeSession(session, target, marker, context, deps);
    },

    validate(serialized: SerializedSession): ValidationDefect[] {
      return validateSerialized(serialized);
    },

    async readBack(home: HomePath, sessionId: SessionId): Promise<StoredSessionFacts> {
      const filePath = await findSessionFile(home, sessionId);
      if (!filePath) return { sessionId, itemCount: 0, openable: false };
      let parsed: ReturnType<typeof parseSessionText>;
      try {
        parsed = parseSessionText(await readFile(filePath, "utf8"));
      } catch {
        return { sessionId, itemCount: 0, openable: false };
      }
      return {
        sessionId,
        itemCount: parsed.entries.length,
        openable:
          parsed.header?.id === sessionId &&
          !parsed.truncated &&
          resolveActiveEntries(parsed.entries).unreadable === null,
      };
    },

    async switchTo(
      home: HomePath,
      sessionId: SessionId,
      runtime: AgentRuntime,
    ): Promise<SwitchOutcome> {
      const context = asSwitchContext(runtime);
      const filePath = await findSessionFile(home, sessionId);
      if (!filePath) {
        throw new Error(`the Pi home ${home} holds no session ${sessionId} to switch to`);
      }
      // Called from a Pi command handler only. The deleted design documents claimed a call
      // from an event handler deadlocks; the claim was never tested, so this module only
      // uses the path C-10 proved. `src/host/pi-extension/` guarantees the call site.
      const result = await context.switchSession(filePath, {
        withSession: () => undefined,
      });
      const cancelled = result?.cancelled === true;
      // A cancelled switch is not a failure: the session stays committed and the user opens
      // it later with Pi's own command.
      return { switched: !cancelled, cancelled };
    },
  };
}
