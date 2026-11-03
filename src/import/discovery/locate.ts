// A global lookup: find one session anywhere on disk, without the repository filter (FR-61).
// The agent owns its file names; this file owns root expansion, ordering, ambiguity and the
// errors the user reads. Only files whose names match are handed to an adapter to parse.

import { glob, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { ImportConfig, SessionDescriptor, SessionLocator } from "./contract.js";
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

/**
 * Expand every adapter's roots, dropping duplicates and non-directories. With `home`, only the
 * roots inside that one home are searched, so `--home` reaches a home outside the configuration.
 * Without one, a configured extra home of the adapter is searched as well (FR-5, FR-61).
 */
async function expandRoots(
  adapters: readonly SourceAdapter[],
  home: string | null = null,
  extraHomes: ImportConfig["extraHomes"] = [],
): Promise<RootSearch[]> {
  const seen = new Set<string>();
  const found: RootSearch[] = [];
  for (const adapter of adapters) {
    const agent = adapter.capabilities().agent;
    const extra =
      home === null
        ? extraHomes
            .filter((entry) => entry.agent === agent)
            .flatMap((entry) => adapter.searchRoots(entry.home))
        : [];
    const patterns =
      home === null ? [...adapter.searchRoots(), ...extra] : adapter.searchRoots(home);
    for (const pattern of patterns) {
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

/** ISO-8601 UTC shortened to the minute, the same form the list and the summary print. */
function shortTime(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  return match === null ? value : `${match[1]} ${match[2]}Z`;
}

function describeCandidate(entry: FoundSession): string {
  const { descriptor } = entry;
  return (
    `- ${descriptor.ref.agent} ${descriptor.ref.id} · ${descriptor.ref.home} · ` +
    `${directoryOf(descriptor)} · ${shortTime(descriptor.updatedAt) || "(no time)"} · ` +
    `${descriptor.title || "(untitled)"}\n  ${descriptor.filePath}`
  );
}

/** The shortest prefix the spec allows (FR-61). */
const MIN_PREFIX = 6;

function noMatchMessage(query: string, roots: readonly RootSearch[]): string {
  const searched =
    roots.length === 0
      ? "(no search root exists)"
      : [...new Set(roots.map((entry) => entry.root))].join(", ");
  // A short query is the one case a user can fix without a wider search: say so.
  const hint =
    query.length < MIN_PREFIX
      ? ` A prefix needs at least ${MIN_PREFIX} characters; use the full ID or a longer prefix.`
      : "";
  return `No session matches "${query}".${hint} Searched: ${searched}.`;
}

function ambiguityMessage(query: string, entries: readonly FoundSession[]): string {
  // Suggest only the flags that can actually narrow this set.
  const narrow: string[] = [];
  if (new Set(entries.map((entry) => entry.descriptor.ref.agent)).size > 1) narrow.push("--agent");
  if (new Set(entries.map((entry) => entry.descriptor.ref.home)).size > 1) narrow.push("--home");
  const hint = narrow.length === 0 ? "" : `, or narrow the search with ${narrow.join(" or ")}`;
  return (
    `Session "${query}" matches ${entries.length} sessions. ` +
    `Select one by exact file path${hint}:\n` +
    entries.map(describeCandidate).join("\n")
  );
}

/** True when `filePath` is inside `root`. Both are absolute. */
function isInsidePath(filePath: string, root: string): boolean {
  if (!isAbsolute(filePath) || !isAbsolute(root)) return false;
  const within = relative(root, filePath);
  return within === "" || (!within.startsWith("..") && !isAbsolute(within));
}

export interface LocatorDeps {
  adapters: readonly SourceAdapter[];
  /** Configured homes an adapter also searches, beyond the ones its environment names (FR-5). */
  config?: Pick<ImportConfig, "extraHomes">;
}

type Accept = (descriptor: SessionDescriptor) => boolean | Promise<boolean>;

const acceptAll: Accept = () => true;

/** Finds one session anywhere. It lists nothing it was not asked for and never writes. */
export function createSessionLocator(deps: LocatorDeps): SessionLocator {
  async function sourcesFor(query: string, home: string | null): Promise<RootSearch[]> {
    return await expandRoots(
      rankedSources(deps.adapters, query),
      home,
      deps.config?.extraHomes ?? [],
    );
  }

  return {
    async byId(
      query: string,
      accept: Accept = acceptAll,
      home: string | null = null,
    ): Promise<SessionDescriptor> {
      const wanted = query.trim();
      const roots = await sourcesFor(wanted, home);
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
      const allowed: FoundSession[] = [];
      for (const entry of unique) {
        if (await accept(entry.descriptor)) allowed.push(entry);
      }
      const exact = allowed.filter(
        (entry) => entry.descriptor.ref.id.toLowerCase() === wanted.toLowerCase(),
      );
      const candidates = (exact.length > 0 ? exact : allowed).sort((left, right) =>
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

    async byPath(filePath: string, accept: Accept = acceptAll): Promise<SessionDescriptor> {
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

      // The root decides the agent. When a root contains the file, only that root's adapter
      // is tried: another adapter accepting the bytes would mislabel the session. Only a file
      // outside every root is offered to each adapter in turn.
      const ordered = rankedSources(deps.adapters, "");
      const roots = await expandRoots(ordered, null, deps.config?.extraHomes ?? []);
      const containing = new Set(
        roots
          .filter((entry) => isInsidePath(wanted, entry.root))
          .map((entry) => entry.adapter.capabilities().agent),
      );
      const attempts =
        containing.size > 0
          ? ordered.filter((adapter) => containing.has(adapter.capabilities().agent))
          : ordered;
      for (const adapter of attempts) {
        try {
          const descriptor = await adapter.describeSession(wanted);
          if (await accept(descriptor)) return descriptor;
        } catch {
          // The next adapter may know the format. Only the last failure becomes the error.
        }
      }
      throw new SessionSelectionError(
        filePath,
        `"${filePath}" is not a session file this tool can read.`,
      );
    },
  };
}
