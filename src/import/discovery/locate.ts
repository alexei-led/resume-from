// A global lookup: find one session anywhere on disk, without the repository filter (FR-61).
// The agent owns its file names; this file owns root expansion, ordering, ambiguity and the
// errors the user reads. Only files whose names match are handed to an adapter to parse.

import { glob, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { SessionDescriptor } from "./contract.js";
import { SessionSelectionError } from "./errors.js";
import { canonicalPath, expandHome, isDirectory, type SourceAdapter } from "./homes.js";
import { compareDescriptors } from "./ordering.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type IdShape = "v4" | "v7" | "other";

/** The shape a query names. Only a whole UUID tells its version; anything else is "other". */
function idShape(query: string): IdShape {
  if (UUID_V4.test(query)) return "v4";
  if (UUID_V7.test(query)) return "v7";
  return "other";
}

interface RootSearch {
  adapter: SourceAdapter;
  root: string;
}

interface FoundSession {
  descriptor: SessionDescriptor;
  root: string;
}

/** Expand every adapter's roots, dropping duplicates and non-directories. */
async function expandRoots(adapters: readonly SourceAdapter[]): Promise<RootSearch[]> {
  const seen = new Set<string>();
  const found: RootSearch[] = [];
  for (const adapter of adapters) {
    for (const pattern of adapter.searchRoots()) {
      let matches: string[];
      try {
        matches = [];
        for await (const match of glob(expandHome(pattern))) matches.push(match);
      } catch {
        // A root that cannot be expanded is not searched; a bad mount is never fatal.
        continue;
      }
      matches.sort();
      for (const match of matches) {
        if (!(await isDirectory(match))) continue;
        const root = await canonicalPath(match);
        if (seen.has(root)) continue;
        seen.add(root);
        found.push({ adapter, root });
      }
    }
  }
  return found;
}

/** The adapter order a query's shape prefers (FR-61), ties keeping the supplied order. */
function rankedSources(
  adapters: readonly SourceAdapter[],
  query: string,
): readonly SourceAdapter[] {
  const shape = idShape(query);
  return adapters
    .filter((adapter) => adapter.capabilities().roles.includes("source"))
    .map((adapter, index) => ({ adapter, index, rank: adapter.capabilities().idLookup[shape] }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.adapter);
}

/** One entry per canonical file: a session reached through two root spellings is one session. */
async function dedupeByFile(entries: readonly FoundSession[]): Promise<FoundSession[]> {
  const byFile = new Map<string, FoundSession>();
  for (const entry of entries) {
    const key = await canonicalPath(entry.descriptor.filePath);
    if (!byFile.has(key)) byFile.set(key, entry);
  }
  return [...byFile.values()];
}

/** The directory a candidate lives in, for the ambiguity list. */
function directoryOf(descriptor: SessionDescriptor): string {
  return descriptor.startDirectory ?? descriptor.repoPath ?? "(no recorded directory)";
}

function describeCandidate(entry: FoundSession): string {
  const { descriptor } = entry;
  return (
    `- ${descriptor.ref.agent} ${descriptor.ref.id} · ${descriptor.ref.home} · ` +
    `${directoryOf(descriptor)} · ${descriptor.updatedAt || "(no time)"} · ` +
    `${descriptor.title || "(untitled)"}`
  );
}

function noMatchMessage(query: string, roots: readonly RootSearch[]): string {
  const searched =
    roots.length === 0
      ? "(no search root exists)"
      : [...new Set(roots.map((entry) => entry.root))].join(", ");
  return `No session matches "${query}". Searched: ${searched}.`;
}

function ambiguityMessage(query: string, entries: readonly FoundSession[]): string {
  return (
    `Session "${query}" matches ${entries.length} sessions. ` +
    `Select one by exact file path, or narrow the search with --agent or --home:\n` +
    entries.map(describeCandidate).join("\n")
  );
}

/** True when `filePath` is inside `root`. Both are absolute. */
function isInsidePath(filePath: string, root: string): boolean {
  if (!isAbsolute(filePath) || !isAbsolute(root)) return false;
  const within = relative(root, filePath);
  return within === "" || (!within.startsWith("..") && !isAbsolute(within));
}

/** Finds one session anywhere. It lists nothing it was not asked for and never writes. */
export interface SessionLocator {
  /** Resolves a case-insensitive exact ID, or a prefix of at least six characters (FR-61). */
  byId(query: string): Promise<SessionDescriptor>;
  /** Describes one session file directly, without the repository filter (FR-12, FR-61). */
  byPath(filePath: string): Promise<SessionDescriptor>;
  /** Every search root, fully resolved, in the order a lookup visits them. */
  roots(): Promise<string[]>;
}

export interface LocatorDeps {
  adapters: readonly SourceAdapter[];
}

export function createSessionLocator(deps: LocatorDeps): SessionLocator {
  async function sourcesFor(query: string): Promise<RootSearch[]> {
    return await expandRoots(rankedSources(deps.adapters, query));
  }

  return {
    async byId(query: string): Promise<SessionDescriptor> {
      const wanted = query.trim();
      const roots = await sourcesFor(wanted);
      const found: FoundSession[] = [];
      for (const entry of roots) {
        let rows: SessionDescriptor[];
        try {
          rows = await entry.adapter.findSessions(entry.root, wanted);
        } catch {
          // A root that grew unreadable after expansion is skipped, never fatal.
          continue;
        }
        for (const descriptor of rows) found.push({ descriptor, root: entry.root });
      }

      const unique = await dedupeByFile(found);
      const exact = unique.filter(
        (entry) => entry.descriptor.ref.id.toLowerCase() === wanted.toLowerCase(),
      );
      const candidates = (exact.length > 0 ? exact : unique).sort((left, right) =>
        compareDescriptors(left.descriptor, right.descriptor),
      );
      if (candidates.length === 0) {
        throw new SessionSelectionError(wanted, noMatchMessage(wanted, roots));
      }
      if (candidates.length > 1) {
        throw new SessionSelectionError(wanted, ambiguityMessage(wanted, candidates));
      }
      const only = candidates[0];
      if (only === undefined) {
        throw new SessionSelectionError(wanted, noMatchMessage(wanted, roots));
      }
      return only.descriptor;
    },

    async byPath(filePath: string): Promise<SessionDescriptor> {
      const wanted = await canonicalPath(filePath);
      let isFile = false;
      try {
        isFile = (await stat(wanted)).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) {
        throw new SessionSelectionError(
          filePath,
          `"${filePath}" is not a session file this tool can read.`,
        );
      }

      // The root decides the agent; only when no root contains the file does trying each
      // adapter decide it. A contained root's adapter comes first.
      const ordered = rankedSources(deps.adapters, "");
      const roots = await expandRoots(ordered);
      const containing = new Set(
        roots
          .filter((entry) => isInsidePath(wanted, entry.root))
          .map((entry) => entry.adapter.capabilities().agent),
      );
      const attempts = [
        ...ordered.filter((adapter) => containing.has(adapter.capabilities().agent)),
        ...ordered.filter((adapter) => !containing.has(adapter.capabilities().agent)),
      ];
      for (const adapter of attempts) {
        try {
          return await adapter.describeSession(wanted);
        } catch {
          // The next adapter may know the format. Only the last failure becomes the error.
        }
      }
      throw new SessionSelectionError(
        filePath,
        `"${filePath}" is not a session file this tool can read.`,
      );
    },

    async roots(): Promise<string[]> {
      return (await expandRoots(deps.adapters)).map((entry) => entry.root);
    },
  };
}
