/**
 * The target role's landing support: reading a committed session back (FR-51, FR-52) and
 * reporting that this adapter cannot move the user (FR-45).
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type {
  AgentRuntime,
  HomePath,
  SessionId,
  StoredSessionFacts,
  SwitchOutcome,
  ValidationDefect,
} from "./contract.js";
import {
  isNotFoundError,
  listSessionDirs,
  sessionsRoot,
  stateFilePath,
  wireFilePath,
} from "./layout.js";
import { readSessionState } from "./read.js";
import { inspectKimiState, inspectKimiWire } from "./validation.js";

export async function readBackKimiCode(
  home: HomePath,
  sessionId: SessionId,
): Promise<StoredSessionFacts> {
  const absent: StoredSessionFacts = { sessionId, itemCount: 0, openable: false };
  const sessionDir = await findSessionDir(sessionsRoot(home), sessionId);
  if (sessionDir === null) return absent;

  let wireText: string;
  try {
    wireText = await readFile(wireFilePath(sessionDir), "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return absent;
    throw error;
  }
  const inspection = inspectKimiWire(wireText);

  let stateText: string | null = null;
  try {
    stateText = await readFile(stateFilePath(sessionDir), "utf8");
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  const stateInspection =
    stateText === null
      ? {
          itemCount: 0,
          defects: [{ path: "state", message: "state.json is missing" } satisfies ValidationDefect],
        }
      : inspectKimiState(stateText, sessionId, null);

  return {
    sessionId,
    itemCount: inspection.itemCount,
    openable: inspection.defects.length === 0 && stateInspection.defects.length === 0,
  };
}

/**
 * Kimi Code declares "create-only": nothing outside a running Kimi Code process can move the
 * user into a session. The landing hands the command back instead (FR-45), spelled the way
 * Kimi Code's own session list spells it: from the session's working directory.
 */
export async function switchToKimiCode(
  home: HomePath,
  sessionId: SessionId,
  _runtime: AgentRuntime,
): Promise<SwitchOutcome> {
  let cwd: string | null = null;
  const sessionDir = await findSessionDir(sessionsRoot(home), sessionId);
  if (sessionDir !== null) {
    cwd = (await readSessionState(sessionDir))?.cwd ?? null;
  }
  const command =
    cwd !== null
      ? `cd ${shellQuote(cwd)} && kimi --resume ${sessionId}`
      : `kimi --resume ${sessionId}`;
  throw new Error(
    `Kimi Code landing is "create-only": this adapter cannot move the user into a session. Run: ${command}`,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** FR-51 is a fact, not an exception: a session that is not there reports as not openable. */
async function findSessionDir(root: string, sessionId: SessionId): Promise<string | null> {
  for (const dir of await listSessionDirs(root)) {
    if (basename(dir) === sessionId) return dir;
  }
  return null;
}
