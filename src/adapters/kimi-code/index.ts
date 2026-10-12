/**
 * The Kimi Code adapter: everything the tool knows about Kimi Code, behind the one contract
 * every adapter implements (FR-57).
 */

import { randomUUID } from "node:crypto";
import type { AgentAdapter, AgentCapabilities, KimiCodeAdapterFactory } from "./contract.js";
import { defaultKimiCodeHome } from "./layout.js";
import { listKimiCodeSessions, loadKimiCodeSession } from "./read.js";
import { readBackKimiCode, switchToKimiCode } from "./readback.js";
import { type KimiCodeSerializeDeps, serializeKimiCode, validateKimiCode } from "./write.js";

/** The window of the models Kimi Code's default profile ships with. Configuration overrides it (FR-18). */
const KIMI_CODE_WINDOW_TOKENS = 256_000;

const DEFAULT_DEPS: KimiCodeSerializeDeps = {
  newSessionId: () => randomUUID(),
};

function kimiCodeCapabilities(): AgentCapabilities {
  return {
    agent: "kimi-code",
    roles: ["source", "target"],
    // Kimi Code cannot host our picker, so the user picks from a numbered list we print.
    selection: "numbered-list",
    // Only a running Kimi Code process can move the user, so the landing hands back the command (FR-45).
    landing: "create-only",
    // Kimi Code has no verified durable, out-of-context entry shape. The host prints
    // provenance after landing instead of writing it as a conversation turn.
    provenance: "host-output-only",
    defaultHome: defaultKimiCodeHome(),
    defaultWindowTokens: KIMI_CODE_WINDOW_TOKENS,
  };
}

export const kimiCodeAdapterFactory: KimiCodeAdapterFactory = {
  create(overrides: Partial<KimiCodeSerializeDeps> = {}): AgentAdapter {
    const deps: KimiCodeSerializeDeps = { ...DEFAULT_DEPS, ...overrides };
    return {
      capabilities: kimiCodeCapabilities,
      listSessions: listKimiCodeSessions,
      loadSession: loadKimiCodeSession,
      serialize: (session, target, marker, context) =>
        serializeKimiCode(session, target, marker, context, deps),
      validate: validateKimiCode,
      readBack: readBackKimiCode,
      switchTo: switchToKimiCode,
    };
  },
};
