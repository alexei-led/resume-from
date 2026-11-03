/**
 * The Claude Code session file: one JSON object per line.
 *
 * The store holds ten entry types (C-3). This module reads the few that carry turns and writes
 * exactly two, `user` and `assistant` (C-9) — fewer types, fewer ways to corrupt the store.
 */

import { asString } from "../json.js";

export { asArray, asRecord as asObject, asString } from "../json.js";

export const ENTRY_TYPE_USER = "user";
export const ENTRY_TYPE_ASSISTANT = "assistant";
export const ENTRY_TYPE_SUMMARY = "summary";
/** The marker entry type Claude Code shows but excludes from model context (FR-47). */
export const ENTRY_TYPE_SYSTEM = "system";

/** The entry types `serialize` writes: the marker, then turns (C-9, FR-47). */
export const WRITTEN_ENTRY_TYPES: readonly string[] = [
  ENTRY_TYPE_SYSTEM,
  ENTRY_TYPE_USER,
  ENTRY_TYPE_ASSISTANT,
];

export type RawEntry = Record<string, unknown>;

export interface JsonlParse {
  entries: RawEntry[];
  /** Set when a line is not a complete entry — the file is cut mid-entry. */
  unreadable: string | null;
}

export interface ActiveEntryPath {
  entries: RawEntry[];
  unreadable: string | null;
}

/** Parse a session file. A line that is not a complete entry makes the whole file unreadable. */
export function parseJsonl(text: string): JsonlParse {
  const entries: RawEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return { entries, unreadable: `line ${i + 1} is not a complete entry` };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { entries, unreadable: `line ${i + 1} is not an entry object` };
    }
    entries.push(value as RawEntry);
  }
  return { entries, unreadable: null };
}

/** Follow the last non-sidechain UUID record to the root of Claude's active transcript. */
export function resolveActiveEntryPath(entries: RawEntry[]): ActiveEntryPath {
  const byUuid = new Map<string, RawEntry>();
  const mainEntries: RawEntry[] = [];
  for (const entry of entries) {
    if (entry.isSidechain === true || entry.uuid === undefined) continue;
    const uuid = asString(entry.uuid);
    if (uuid === null) return { entries: [], unreadable: "entry has a malformed uuid" };
    if (byUuid.has(uuid)) {
      return { entries: [], unreadable: `duplicate entry uuid ${uuid}` };
    }
    if (entry.parentUuid !== null && typeof entry.parentUuid !== "string") {
      return {
        entries: [],
        unreadable: `entry ${uuid} has a malformed parentUuid`,
      };
    }
    byUuid.set(uuid, entry);
    mainEntries.push(entry);
  }
  const leaf = mainEntries[mainEntries.length - 1];
  if (leaf === undefined) return { entries: [], unreadable: null };

  const reversed: RawEntry[] = [];
  const visited = new Set<string>();
  let current: RawEntry | undefined = leaf;
  while (current !== undefined) {
    const uuid = asString(current.uuid);
    if (uuid === null) return { entries: [], unreadable: "active entry has no uuid" };
    if (visited.has(uuid)) {
      return {
        entries: [],
        unreadable: `entry graph contains a cycle at ${uuid}`,
      };
    }
    visited.add(uuid);
    reversed.push(current);
    if (current.parentUuid === null) break;
    const parent: RawEntry | undefined = byUuid.get(current.parentUuid as string);
    if (parent === undefined) {
      return {
        entries: [],
        unreadable: `entry ${uuid} refers to missing parent ${String(current.parentUuid)}`,
      };
    }
    current = parent;
  }
  return { entries: reversed.reverse(), unreadable: null };
}

/** ISO-8601 UTC, the vocabulary every timestamp of the canonical model uses. */
export function toIsoUtc(value: unknown): string | null {
  const text = asString(value);
  if (text === null) return null;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}
