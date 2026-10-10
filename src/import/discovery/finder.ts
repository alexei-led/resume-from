// The source side of the tool: find the sessions of this repository, order them, resolve the
// user's choice, and load it. It never writes and never calls a model (NG-1, AC-4, FR-8).

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  CanonicalSession,
  DiscoveryDestination,
  HomeFailure,
  ImportConfig,
  Listing,
  RepoIdentity,
  RepoReader,
  SearchScope,
  SelectionInput,
  SessionDescriptor,
  SessionFinder,
} from "./contract.js";
import { SessionSelectionError } from "./errors.js";
import {
  buildSearchList,
  canonicalPath,
  isDirectory,
  type SearchTarget,
  type SourceAdapter,
} from "./homes.js";
import { compareDescriptors } from "./ordering.js";

export type { SourceAdapter };

/** Everything the finder needs. The adapter list arrives from `src/import/`; it holds none. */
export interface DiscoveryDeps {
  adapters: readonly SourceAdapter[];
  /** Only `extraHomes` is read. */
  config: Pick<ImportConfig, "extraHomes">;
  repo: Pick<RepoReader, "identify" | "checkCancellation">;
}

const NEXT_STEP = "Run the list again to see the sessions available in this repository.";

function reasonLine(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : String(reason);
  return text.split("\n")[0] ?? "unknown error";
}

interface DirectoryEvidence {
  directory: string;
  commonDir: string | null;
}

type Lookup = (directory: string) => Promise<DirectoryEvidence | null>;

/** One recorded directory against this destination: the same directory, or the same repository. */
function isMatch(evidence: DirectoryEvidence, destination: DirectoryEvidence | null): boolean {
  return (
    evidence.directory === destination?.directory ||
    (evidence.commonDir !== null && evidence.commonDir === destination?.commonDir)
  );
}

function isCancellation(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "AbortError";
}

export function createSessionFinder(deps: DiscoveryDeps): SessionFinder {
  async function collect(
    target: SearchTarget,
    destination: DirectoryEvidence | null,
    lookup: Lookup,
  ): Promise<Listing> {
    deps.repo.checkCancellation();
    // A home the user named must never fail silently: adapters swallow a missing
    // directory (an absent default home is normal), but a typo'd --home is not (FR-2).
    if (target.named === true && !(await isDirectory(target.home))) {
      deps.repo.checkCancellation();
      return {
        rows: [],
        failures: [
          {
            home: target.home,
            agent: target.agent,
            message: "home not searched: no such directory",
          },
        ],
        excluded: 0,
      };
    }
    let found: SessionDescriptor[];
    try {
      deps.repo.checkCancellation();
      found = await target.adapter.listSessions(target.home);
      deps.repo.checkCancellation();
    } catch (reason) {
      deps.repo.checkCancellation();
      if (isCancellation(reason)) throw reason;
      // One bad home never empties the listing.
      return {
        rows: [],
        failures: [
          {
            home: target.home,
            agent: target.agent,
            message: `home not searched: ${reasonLine(reason)}`,
          },
        ],
        excluded: 0,
      };
    }

    const rows: SessionDescriptor[] = [];
    const failures: HomeFailure[] = [];
    let excluded = 0;
    for (const descriptor of found) {
      deps.repo.checkCancellation();
      let diagnostic: string | null = null;
      try {
        let matched = false;
        let conflictingGitIdentity = false;
        // Do not accept early: a later candidate can disprove the membership.
        for (const candidate of descriptor.repoPaths) {
          const evidence = await lookup(candidate);
          if (evidence === null) continue;
          matched ||= isMatch(evidence, destination);
          if (evidence.commonDir !== null) {
            conflictingGitIdentity ||= evidence.commonDir !== destination?.commonDir;
          }
        }
        // The primary decision (FR-13): a match includes, a conflict excludes, and a match never
        // overrides a conflict.
        const matchedHere = matched && !conflictingGitIdentity;
        // The start directory is a last resort: it settles the case where no recorded candidate
        // matched at all, and it never overrides a match or a conflict (issue #5).
        const startDirectory = descriptor.startDirectory;
        // A start directory that is already a recorded candidate adds nothing: the loop above looked
        // it up with the same rule. Skipping it keeps the fallback from spending a second lookup on
        // every session it cannot list (adapters whose header directory is their only candidate).
        const startIsCandidate =
          startDirectory !== null && descriptor.repoPaths.includes(startDirectory);
        const startEvidence =
          matchedHere || conflictingGitIdentity || startDirectory === null || startIsCandidate
            ? null
            : await lookup(startDirectory);
        const startedHere = startEvidence !== null && isMatch(startEvidence, destination);

        if (matchedHere || startedHere) {
          rows.push(descriptor);
        } else if (descriptor.repoPaths.length === 0) {
          diagnostic = "records no repository, so it cannot be listed here";
        } else if (matched && conflictingGitIdentity) {
          // A conflict is a contradiction only when some candidate positively matched: part of
          // the session ran here, part elsewhere. Without a match, a foreign git identity
          // merely means the session belongs to another repository — the normal FR-13
          // exclusion, counted below like every other non-member.
          diagnostic =
            "has conflicting repository identity evidence; its recorded directories cannot unambiguously belong to this destination";
        } else {
          // The session does not belong here: every surviving candidate resolved elsewhere,
          // every recorded directory is gone, or both. A deleted worktree of this repository
          // is indistinguishable from a deleted foreign one, and neither can be imported —
          // so non-membership in all its forms is the normal product of searching a whole
          // home (FR-13): counted, not narrated row by row.
          excluded += 1;
        }
      } catch (reason) {
        deps.repo.checkCancellation();
        if (isCancellation(reason)) throw reason;
        diagnostic = `repository lookup failed: ${reasonLine(reason)}`;
      }
      if (diagnostic !== null) {
        failures.push({
          home: target.home,
          agent: target.agent,
          message: `session ${descriptor.ref.id} ${diagnostic}`,
        });
      }
    }
    return { rows, failures, excluded };
  }

  /** The single listing both `list` and `resolve` use, so the two always agree (FR-10). */
  async function buildListing(
    scope: SearchScope,
    supplied?: DiscoveryDestination,
  ): Promise<Listing> {
    deps.repo.checkCancellation();
    // Both caches live for this listing only. The spelling cache shares missing paths and
    // filesystem failures; the canonical cache also shares Git lookups through symlink aliases.
    const directories = new Map<string, Promise<DirectoryEvidence | null>>();
    const identities = new Map<string, Promise<RepoIdentity>>();
    const lookup: Lookup = async (directory) => {
      deps.repo.checkCancellation();
      const absolute = resolve(directory);
      let pending = directories.get(absolute);
      if (!pending) {
        pending = (async () => {
          let canonical: string;
          try {
            canonical = await realpath(absolute);
            deps.repo.checkCancellation();
          } catch (reason) {
            if ((reason as NodeJS.ErrnoException).code === "ENOENT") {
              // The reader still observes cancellation on missing-path short circuits.
              await deps.repo.identify(absolute);
              return null;
            }
            throw reason;
          }
          let identity = identities.get(canonical);
          if (!identity) {
            identity = Promise.resolve().then(() => deps.repo.identify(canonical));
            identities.set(canonical, identity);
          }
          return { directory: canonical, commonDir: (await identity).commonDir };
        })();
        directories.set(absolute, pending);
      }
      const evidence = await pending;
      deps.repo.checkCancellation();
      return evidence;
    };
    let destination: DirectoryEvidence | null;
    try {
      if (supplied !== undefined) {
        const canonical = await realpath(scope.repoRoot);
        deps.repo.checkCancellation();
        if (canonical !== supplied.canonicalCwd) {
          throw new Error("Destination evidence does not match the requested directory");
        }
        identities.set(canonical, Promise.resolve(supplied.identity));
        directories.set(
          resolve(scope.repoRoot),
          Promise.resolve({
            directory: canonical,
            commonDir: supplied.identity.commonDir,
          }),
        );
      }
      destination = await lookup(scope.repoRoot);
    } catch (reason) {
      deps.repo.checkCancellation();
      if (isCancellation(reason)) throw reason;
      throw new Error(`Destination repository lookup failed: ${reasonLine(reason)}`, {
        cause: reason,
      });
    }
    const targets = await buildSearchList(deps.adapters, deps.config, scope);
    deps.repo.checkCancellation();
    const collected = await Promise.all(
      targets.map((target) => collect(target, destination, lookup)),
    );
    deps.repo.checkCancellation();

    const rows: SessionDescriptor[] = [];
    const failures: HomeFailure[] = [];
    let excluded = 0;
    for (const part of collected) {
      rows.push(...part.rows);
      failures.push(...part.failures);
      excluded += part.excluded;
    }
    rows.sort(compareDescriptors);
    return { rows, failures, excluded };
  }

  async function resolveRow(
    rows: SessionDescriptor[],
    row: number,
    diagnostics: string,
  ): Promise<SessionDescriptor> {
    const chosen = Number.isInteger(row) && row >= 1 ? rows[row - 1] : undefined;
    if (!chosen) {
      throw new SessionSelectionError(
        String(row),
        `Row ${row} is not in this repository's session list, which has ${rows.length} row(s). ${NEXT_STEP}${diagnostics}`,
      );
    }
    return chosen;
  }

  return {
    async list(scope: SearchScope, destination?: DiscoveryDestination): Promise<Listing> {
      return await buildListing(scope, destination);
    },

    async resolve(
      scope: SearchScope,
      input: SelectionInput,
      destination?: DiscoveryDestination,
    ): Promise<SessionDescriptor> {
      const { rows, failures } = await buildListing(scope, destination);
      const diagnostics =
        failures.length === 0
          ? ""
          : ` Skipped: ${failures.map((failure) => `${failure.agent} at "${failure.home}": ${failure.message}`).join("; ")}.`;
      switch (input.by) {
        case "row":
          return await resolveRow(rows, input.row, diagnostics);
        case "session-id": {
          const matches = rows.filter((row) => row.ref.id === input.id);
          const found = matches[0];
          if (!found) {
            throw new SessionSelectionError(
              input.id,
              `No session "${input.id}" belongs to this repository. ${NEXT_STEP}${diagnostics}`,
            );
          }
          if (matches.length > 1) {
            const locations = matches
              .map((row) => `${row.ref.agent} at "${row.ref.home}" (${row.filePath})`)
              .join("; ");
            throw new SessionSelectionError(
              input.id,
              `Session ID "${input.id}" matches ${matches.length} sessions: ${locations}. ` +
                "Select a numbered row or exact file path, or narrow the search with an agent and --home.",
            );
          }
          return found;
        }
        case "file-path": {
          const wanted = await canonicalPath(input.path);
          deps.repo.checkCancellation();
          for (const row of rows) {
            const filePath = await canonicalPath(row.filePath);
            deps.repo.checkCancellation();
            if (filePath === wanted) return row;
          }
          // Selection by path is a convenience, not a way around the repository filter (NG-9).
          throw new SessionSelectionError(
            input.path,
            `"${input.path}" is not a session of this repository. ${NEXT_STEP}${diagnostics}`,
          );
        }
      }
    },

    async load(descriptor: SessionDescriptor): Promise<CanonicalSession> {
      deps.repo.checkCancellation();
      const adapter = deps.adapters.find((candidate) => {
        const capabilities = candidate.capabilities();
        return capabilities.agent === descriptor.ref.agent && capabilities.roles.includes("source");
      });
      if (!adapter) {
        throw new Error(`no source adapter for agent "${descriptor.ref.agent}"`);
      }
      // Returned unchanged: the rules of sections D and E belong to src/import/transfer/.
      try {
        return await adapter.loadSession(descriptor);
      } finally {
        deps.repo.checkCancellation();
      }
    },
  };
}
