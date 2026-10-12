/**
 * Where a Kimi Code home keeps its sessions, and how a working directory maps to the
 * storage key Kimi Code derives from it.
 *
 * Every fact here was confirmed against the Kimi Code source (apps/kimi-code and
 * packages/agent-core-v2) and real session files under a live home: the workspace key is
 * `encodeWorkDirKey`'s `wd_<slug>_<hash>` and the session id is the session directory's
 * name, `session_<uuid>`.
 */

import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HomePath, SessionId } from "./contract.js";

/** Kimi Code reads this variable to find its home; so does this adapter (FR-2, FR-3). */
export const KIMI_CODE_HOME_ENV = "KIMI_CODE_HOME";

/** The wire protocol version current Kimi Code writes; an imported session declares it. */
export const KIMI_WIRE_PROTOCOL_VERSION = "1.5";

/** The session metadata schema version current Kimi Code writes (SESSION_META_VERSION). */
export const KIMI_SESSION_META_VERSION = 2;

/** The main agent every session carries. */
export const KIMI_MAIN_AGENT_ID = "main";

/** Always absolute: a HomePath is an absolute path, whatever the environment holds (FR-2). */
export function defaultKimiCodeHome(): HomePath {
  const configured = process.env[KIMI_CODE_HOME_ENV];
  return configured !== undefined && configured !== ""
    ? resolve(configured)
    : join(homedir(), ".kimi-code");
}

export function sessionsRoot(home: HomePath): string {
  return join(home, "sessions");
}

const MAX_WORKDIR_SLUG_LENGTH = 40;
const WORKDIR_KEY_PREFIX = "wd_";
const HASH_LENGTH = 12;

function slugifyWorkDirName(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, MAX_WORKDIR_SLUG_LENGTH)
    .replaceAll(/^-+|-+$/g, "");
  return slug === "" || slug === "." || slug === ".." ? "workspace" : slug;
}

/**
 * The workspace key Kimi Code computes from a working directory: the slug of the base
 * name plus the first 12 hex characters of the SHA-256 of the normalized path. This is
 * `encodeWorkDirKey` from Kimi Code's own workdir-slug, restated so an import lands in
 * the workspace directory Kimi Code itself would have chosen.
 */
export function encodeWorkDirKey(workDir: string): string {
  const normalized = workDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = normalized.split("/").pop() ?? normalized;
  const slug = slugifyWorkDirName(base);
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, HASH_LENGTH);
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash}`;
}

/** `<root>/wd_<slug>_<hash>/session_<uuid>` — the directory one session owns. */
export function sessionDirPath(root: string, workDir: string, sessionId: SessionId): string {
  return join(root, encodeWorkDirKey(workDir), sessionId);
}

/** The session record directory Kimi Code's `Session.resume()` reads `wire.jsonl` from. */
export function agentDirPath(sessionDir: string): string {
  return join(sessionDir, "agents", KIMI_MAIN_AGENT_ID);
}

export function stateFilePath(sessionDir: string): string {
  return join(sessionDir, "state.json");
}

export function wireFilePath(sessionDir: string): string {
  return join(agentDirPath(sessionDir), "wire.jsonl");
}

/** True when the directory name is a session directory Kimi Code would own. */
export function isSessionDirName(name: string): boolean {
  return name.startsWith("session_");
}

/**
 * Session directories below one sessions root, without following symlinks or hiding I/O
 * failures. Returns the directory path of each session; the workspace key it sits under
 * is recovered from its `state.json`, never from the directory spelling.
 */
export async function listSessionDirs(root: string): Promise<string[]> {
  const rootInfo = await lstat(root).catch((error: unknown) => {
    if (isNotFoundError(error)) return null;
    throw error;
  });
  if (rootInfo === null) return [];
  if (rootInfo.isSymbolicLink()) return [];
  if (!rootInfo.isDirectory())
    throw new Error(`Kimi Code sessions root is not a directory: ${root}`);

  const found: string[] = [];
  for (const workspace of (await readdir(root, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!workspace.isDirectory() || workspace.isSymbolicLink()) continue;
    if (!workspace.name.startsWith(WORKDIR_KEY_PREFIX)) continue;
    const workspaceDir = join(root, workspace.name);
    for (const session of (await readdir(workspaceDir, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      if (!session.isDirectory() || session.isSymbolicLink()) continue;
      if (isSessionDirName(session.name)) found.push(join(workspaceDir, session.name));
    }
  }
  return found;
}

export function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** ISO-8601 UTC from milliseconds since the epoch, or null when the source recorded none. */
export function msToIsoUtc(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}
