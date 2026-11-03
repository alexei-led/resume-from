/**
 * The Claude Code adapter: the port of `src/adapters/`, filled in with what this module knows
 * about Claude Code.
 */

import { homedir } from "node:os";
import { resumeCommandLine } from "../shell.js";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentRuntime,
  CanonicalSession,
  ClaudeCodeAdapterFactory,
  HomePath,
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
  CONFIG_DIR_ENV,
  searchRoots as claudeSearchRoots,
  projectsDir,
  resolveDefaultHome,
} from "./layout.js";
import { readBack } from "./readback.js";
import { describeSession, findSessions, listSessions, loadSession } from "./reader.js";
import { serialize, validate } from "./writer.js";

/** Claude Code's context window, used when configuration overrides none (FR-18). */
export const DEFAULT_WINDOW_TOKENS = 200_000;
/** The command the landing hands back, because Claude Code cannot move the user (C-2, FR-45). */
export const HANDOVER_COMMAND = "claude --resume";

export interface ClaudeCodeAdapterDeps {
  env: Record<string, string | undefined>;
  homeDir: string;
}

/**
 * Build the adapter. `deps` exists for the tests of this module: the shipped factory below
 * passes the real process values.
 */
export function createClaudeCodeAdapter(deps: Partial<ClaudeCodeAdapterDeps> = {}): AgentAdapter {
  const env = deps.env ?? process.env;

  // Resolved once: capabilities() is pure, synchronous, and equal on every call.
  const capabilities: AgentCapabilities = Object.freeze({
    agent: "claude-code" as const,
    roles: ["source" as const, "target" as const],
    selection: "numbered-list" as const,
    landing: "create-only" as const,
    provenance: "out-of-context-entry" as const,
    defaultHome:
      deps.homeDir === undefined ? resolveDefaultHome(env) : resolveDefaultHome(env, deps.homeDir),
    defaultWindowTokens: DEFAULT_WINDOW_TOKENS,
    // UUIDv4 is Claude Code's own shape; a v7 or custom query is searched here last (FR-61).
    idLookup: { v4: 0, v7: 2, other: 2 },
  });

  return {
    capabilities(): AgentCapabilities {
      return capabilities;
    },

    listSessions(home: HomePath): Promise<SessionDescriptor[]> {
      return listSessions(home);
    },

    loadSession(descriptor: SessionDescriptor): Promise<CanonicalSession> {
      return loadSession(descriptor);
    },

    searchRoots(home?: HomePath): string[] {
      return home === undefined
        ? claudeSearchRoots(env, deps.homeDir ?? homedir())
        : [projectsDir(home)];
    },

    findSessions(root: string, query: string): Promise<SessionDescriptor[]> {
      return findSessions(root, query);
    },

    describeSession(filePath: string): Promise<SessionDescriptor> {
      return describeSession(filePath);
    },

    inPlaceCommand(sessionId: string): string | null {
      // Claude Code's own /resume opens a session of the active profile from any directory.
      return `/resume ${sessionId}`;
    },

    resumeCommand(input): string {
      return resumeCommandLine({
        directory: input.directory,
        argv: ["claude", "--resume", input.sessionId],
        env:
          // A new terminal may not inherit the active profile's environment.
          input.home === capabilities.defaultHome &&
          input.home === resolveDefaultHome({}, deps.homeDir)
            ? null
            : { name: CONFIG_DIR_ENV, value: input.home },
        prompt: input.prompt,
      });
    },

    serialize(
      session: CanonicalSession,
      target: TargetProfile,
      marker: ProvenanceMarker,
      context: SerializationContext,
    ): SerializedSession {
      return serialize(session, target, marker, context);
    },

    validate(serialized: SerializedSession): ValidationDefect[] {
      return validate(serialized);
    },

    readBack(home: HomePath, sessionId: SessionId): Promise<StoredSessionFacts> {
      return readBack(home, sessionId);
    },

    switchTo(
      _home: HomePath,
      sessionId: SessionId,
      _runtime: AgentRuntime,
    ): Promise<SwitchOutcome> {
      return Promise.reject(
        new Error(
          'Claude Code declares landing "create-only": it cannot move the user into a session ' +
            `(C-2). Run: ${HANDOVER_COMMAND} ${sessionId}`,
        ),
      );
    },
  };
}

/** The only export of this module (FR-57). */
export const claudeCodeAdapter: ClaudeCodeAdapterFactory = {
  create(): AgentAdapter {
    return createClaudeCodeAdapter();
  },
};
