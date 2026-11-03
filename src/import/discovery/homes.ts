// Which homes are searched, and in what form. A home reached twice is searched once,
// and two spellings of the same directory are one home.

import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentAdapter, AgentId, HomePath, ImportConfig, SearchScope } from "./contract.js";

/**
 * The source-role subset of `AgentAdapter` this module uses. The target-role methods
 * exist on the port but are never called here (module.md, Public Contract).
 */
export type SourceAdapter = Pick<
  AgentAdapter,
  | "capabilities"
  | "listSessions"
  | "loadSession"
  | "searchRoots"
  | "findSessions"
  | "describeSession"
>;

/** One home to search, with the adapter that can read it. */
export interface SearchTarget {
  agent: AgentId;
  /** Resolved absolute path. */
  home: HomePath;
  adapter: SourceAdapter;
  /** Set when the user named this home and no configuration lists it (FR-2). */
  named?: boolean;
}

/** True when the path exists and is a directory. Symlinks are followed. */
export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** Expands a leading `~` and makes the path absolute. */
export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith(`~${path.sep}`)) {
    return path.resolve(homedir(), value.slice(2));
  }
  return path.resolve(value);
}

/** Absolute path with symlinks resolved. A path that does not exist keeps its expanded form. */
export async function canonicalPath(value: string): Promise<string> {
  const expanded = expandHome(value);
  try {
    return await realpath(expanded);
  } catch {
    return expanded;
  }
}

/** Every source adapter's default home (FR-3), plus every configured extra home (FR-5). */
export async function buildSearchList(
  adapters: readonly SourceAdapter[],
  config: Pick<ImportConfig, "extraHomes">,
  scope: SearchScope,
): Promise<SearchTarget[]> {
  const sources = new Map<AgentId, SourceAdapter>();
  const candidates: Array<{
    agent: AgentId;
    home: HomePath;
    adapter: SourceAdapter;
  }> = [];

  for (const adapter of adapters) {
    const capabilities = adapter.capabilities();
    if (!capabilities.roles.includes("source")) continue; // FR-59
    if (sources.has(capabilities.agent)) continue;
    sources.set(capabilities.agent, adapter);
    candidates.push({
      agent: capabilities.agent,
      home: capabilities.defaultHome,
      adapter,
    });
  }

  for (const entry of config.extraHomes) {
    const adapter = sources.get(entry.agent);
    if (!adapter) continue; // no source adapter for that agent: nothing could read the home
    candidates.push({ agent: entry.agent, home: entry.home, adapter });
  }

  const onlyHome = scope.onlyHome === null ? null : await canonicalPath(scope.onlyHome);
  const seen = new Set<string>();
  const targets: SearchTarget[] = [];
  for (const candidate of candidates) {
    if (scope.onlyAgent !== null && candidate.agent !== scope.onlyAgent) continue; // FR-15
    const home = await canonicalPath(candidate.home);
    if (onlyHome !== null && home !== onlyHome) continue; // FR-2
    const key = `${candidate.agent}\u0000${home}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ agent: candidate.agent, home, adapter: candidate.adapter });
  }

  // FR-2 names a home, not a filter: a home outside the defaults and extraHomes would
  // otherwise silently empty the list. Every source adapter (narrowed by FR-15) searches
  // it; an adapter whose layout is absent there simply finds no sessions.
  if (onlyHome !== null && targets.length === 0) {
    for (const [agent, adapter] of sources) {
      if (scope.onlyAgent !== null && agent !== scope.onlyAgent) continue;
      targets.push({ agent, home: onlyHome, adapter, named: true });
    }
  }
  return targets;
}
