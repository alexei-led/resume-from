/**
 * The Codex adapter: everything the tool knows about Codex, behind the one contract every
 * adapter implements (FR-57).
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resumeCommandLine } from "../shell.js";
import type { AgentAdapter, AgentCapabilities, CodexAdapterFactory } from "./contract.js";
import {
  describeCodexSession,
  findCodexSessions,
  listCodexSessions,
  loadCodexSession,
} from "./read.js";
import { readBackCodex, switchToCodex } from "./readback.js";
import {
  ARCHIVED_SESSIONS_DIR,
  CODEX_HOME_ENV,
  searchRoots as codexSearchRoots,
  defaultCodexHome,
  sessionsRoot,
} from "./rollout.js";
import { type CodexSerializeDeps, serializeCodex, validateCodex } from "./write.js";

/** Codex's own default for the models it ships with. Configuration overrides it (FR-18). */
const CODEX_WINDOW_TOKENS = 258_400;

const DEFAULT_DEPS: CodexSerializeDeps = {
  newSessionId: () => randomUUID(),
};

function codexCapabilities(): AgentCapabilities {
  return {
    agent: "codex",
    roles: ["source", "target"],
    // C-1: Codex cannot host our picker, so the user picks from a numbered list we print.
    selection: "numbered-list",
    // C-2: Codex cannot move the user, so the landing hands back the command (FR-45).
    landing: "create-only",
    // Codex has no verified durable, out-of-context entry shape. The CLI prints
    // provenance after landing instead of writing it as a conversation turn.
    provenance: "host-output-only",
    defaultHome: defaultCodexHome(),
    defaultWindowTokens: CODEX_WINDOW_TOKENS,
    // UUIDv7 is Codex's own shape; a v4 or custom query is searched here later (FR-61).
    idLookup: { v4: 1, v7: 0, other: 1 },
  };
}

export const codexAdapterFactory: CodexAdapterFactory = {
  create(overrides: Partial<CodexSerializeDeps> = {}): AgentAdapter {
    const deps: CodexSerializeDeps = { ...DEFAULT_DEPS, ...overrides };
    return {
      capabilities: codexCapabilities,
      listSessions: listCodexSessions,
      loadSession: loadCodexSession,
      searchRoots(home?: string): string[] {
        return home === undefined
          ? codexSearchRoots()
          : [sessionsRoot(home), join(home, ARCHIVED_SESSIONS_DIR)];
      },
      findSessions: findCodexSessions,
      describeSession: describeCodexSession,
      inPlaceCommand(sessionId: string): string | null {
        // Codex's own /resume opens a session of the active home from any directory.
        return `/resume ${sessionId}`;
      },

      resumeCommand(input): string {
        return resumeCommandLine({
          directory: input.directory,
          argv: ["codex", "resume", input.sessionId],
          env:
            input.home === codexCapabilities().defaultHome
              ? null
              : { name: CODEX_HOME_ENV, value: input.home },
          prompt: input.prompt,
        });
      },
      serialize: (session, target, marker, context) =>
        serializeCodex(session, target, marker, context, deps),
      validate: validateCodex,
      readBack: readBackCodex,
      switchTo: switchToCodex,
    };
  },
};
