# Session Discovery

**Path**: src/import/discovery/ — the module's code is everything in this folder and its transparent subfolders
**Parent**: `src/import/`
**Submodules**: none (leaf)

## Purpose

This module answers "which sessions can I continue from here, and which one did the user mean". It
searches every home of every source agent, keeps only the sessions that ran in the current
repository, orders them newest first, resolves the user's choice, and loads the chosen session into
the neutral vocabulary.

It is the whole source side of the tool. Everything downstream — the rules, the preview, the landing
— starts from a `CanonicalSession` this module produced.

## Functional Responsibilities

- Build the search list: the default home of every adapter with the source role (FR-3), plus every
  extra home the user configured (FR-5), minus duplicates.
- Narrow the search when the user named one agent or one home (FR-2, FR-15).
- Ask each adapter for the sessions in each home (FR-8: from disk, never from the source model).
- Keep only sessions that ran in the current repository (FR-13, NG-9).
- Order the result newest first, across agents and homes together (FR-14, FR-15).
- Resolve the user's choice: a row number of that same ordering, a session ID, or a file path
  (FR-10, FR-12). Reject an ID that matches more than one agent or home and tell the user how to
  disambiguate it.
- Load the chosen session into the canonical vocabulary through its source adapter.
- Survive a home that is missing, unreadable, or holds a corrupt session file, without losing the
  rest of the listing.

## Subdomain Classification

**Supporting.** Enumerating, filtering and ordering are straightforward, and no competitive advantage
lives here. Volatility is **low**: the rules of FR-13 and FR-14 are simple and settled, and adding an
agent does not change this module — it changes the list of adapters, which arrives as data.

Low volatility is what makes the several distance-2 contract integrations of this module comfortable.

## Encapsulated Knowledge

- **How the search list is built and deduplicated.** That a home reached twice — once as an adapter
  default, once as a configured extra — is searched once, and that deduplication compares resolved
  absolute paths.
- **The ordering rule.** That the listing is ordered by `updatedAt` descending across every agent and
  home, and that this ordering is deterministic and reproducible, because FR-10 lets the user come
  back in a second invocation and name row 3.
- **The repository filter.** Resolve every recorded `repoPaths` candidate and the destination.
  Membership is `(matchingGitIdentity || sameDirectory) && !conflictingGitIdentity`. When no candidate
  matched at all, and none conflicted, the session's own `startDirectory` is checked as a last
  resort, so a session that started in this directory stays listed here after its active conversation
  moved into a subdirectory (issue #5).
  Git identity is the canonical common directory, not a checkout root or object store. Missing
  candidates and completed nonzero Git lookups are neutral; every cross-directory match needs
  positive common-directory evidence. An exact existing directory remains a fallback, but if the
  destination has no Git identity, no candidate may have a resolved Git identity.
- **Failure tolerance.** That one unreadable home or one corrupt session file removes that item from
  the listing and nothing else.

## Public Contract

<!-- contract: AgentId, HomePath, SessionId, SessionRef — restated from src/session/module.md -->
```ts
/** Which agent produced or receives a session. Adding an agent adds one value (FR-57). */
type AgentId = "pi" | "codex" | "claude-code" | "kimi-code";

/** Absolute path of an agent profile directory, for example "/Users/me/.claude-team" (FR-2). */
type HomePath = string;

/** The agent's own identifier for a session. Unique inside one home. */
type SessionId = string;

/** A session is identified by three values (FR-1). */
interface SessionRef {
  agent: AgentId;
  home: HomePath;
  id: SessionId;
}
```

<!-- contract: SessionDescriptor — restated from src/session/module.md -->
```ts
/** One row of the selection list (FR-11). */
interface SessionDescriptor {
  ref: SessionRef;
  /** Short human title. Derived from the first user message when the format has none. */
  title: string;
  /** ISO-8601 UTC. */
  startedAt: string;
  /** ISO-8601 UTC. Sort key of the listing, newest first (FR-14). */
  updatedAt: string;
  /** Turns the source holds, before any rule of section D or E runs. */
  turnCount: number;
  /** First recorded candidate: repoPaths[0] ?? null, even when that path no longer exists (FR-13). */
  repoPath: string | null;
  /** Distinct absolute recorded directories, ordered by first appearance in the active conversation. */
  repoPaths: string[];
  /**
   * Absolute directory of the session’s earliest non-sidechain record, when the format records one.
   * Discovery matches it as a last resort, so a session that started here is still listed here.
   */
  startDirectory: string | null;
  /** Absolute path of the source file. Lets the user select by path (FR-12). */
  filePath: string;
}
```

<!-- contract: TurnRole, TurnKind, ToolEffect, ToolCallRecord, CanonicalTurn — restated from src/session/module.md -->
```ts
/** Who produced a turn. */
type TurnRole = "user" | "agent";

/** Why the turn exists. Decides pinning and drop order (FR-22, FR-31, FR-32). */
type TurnKind = "message" | "summary" | "tool-call";

/** Did the call change the repository? (FR-26) */
type ToolEffect = "read-only" | "mutating" | "unknown";

/**
 * A tool call that crossed over (FR-23).
 * There is deliberately no field for the result body: FR-24 and FR-60 are
 * enforced by this shape, not by adapter discipline.
 */
interface ToolCallRecord {
  /** The original tool name. Never translated (FR-27). */
  toolName: string;
  /** The source arguments after deterministic credential redaction. */
  argumentsText: string;
  /** Exactly one line about the outcome (FR-23). */
  outcomeLine: string;
  effect: ToolEffect;
  /** True when the source had a result body and it was dropped (FR-25). */
  bodyDropped: boolean;
  /**
   * True when the source recorded any answer to this call (even an empty or error result).
   * False when no result entry exists at all — the broken-tail signal (FR-54).
   * This is a presence flag, not a content field; it cannot hold a result body.
   */
  resultRecorded?: boolean;
}

/** One turn of the canonical session. */
interface CanonicalTurn {
  /** Zero-based position in the source session. Stable across re-reads. */
  index: number;
  role: TurnRole;
  kind: TurnKind;
  /** Visible text. Empty when kind is "tool-call". */
  text: string;
  /** Set when kind is "tool-call", null otherwise. */
  toolCall: ToolCallRecord | null;
  /** ISO-8601 UTC when the source recorded one, null otherwise. */
  timestamp: string | null;
}
```

<!-- contract: RepoSnapshot, SourceProvenance, CanonicalSession — restated from src/session/module.md -->
```ts
/** Repository state of the source session (FR-36). */
interface RepoSnapshot {
  /** Commit the source ran at, or null when the source format does not record it. */
  commit: string | null;
  branch: string | null;
  /** Files the source changed, derived from its mutating tool calls. */
  changedPaths: string[];
}

/** Where a session came from (FR-22 metadata, FR-47 provenance). */
interface SourceProvenance {
  ref: SessionRef;
  title: string;
  startedAt: string;
  updatedAt: string;
  repo: RepoSnapshot;
}

/** A source session in the neutral vocabulary. Every rule of sections D to I runs on this. */
interface CanonicalSession {
  provenance: SourceProvenance;
  turns: CanonicalTurn[];
}
```

<!-- contract: SelectionLevel, LandingLevel, AdapterRole, ProvenanceSupport, AgentCapabilities — restated from src/adapters/module.md -->
```ts
/** How the agent lets the user choose a source session (FR-9, FR-10, FR-58). */
type SelectionLevel = "interactive-picker" | "numbered-list";

/** How far the adapter can take the landing (FR-42). */
type LandingLevel = "create-and-switch" | "create-only";

/** Which roles the adapter fills (FR-59). */
type AdapterRole = "source" | "target";

/** How the agent can show the marker outside the model context (FR-47, FR-48). */
type ProvenanceSupport = "out-of-context-entry" | "host-output-only";

/** Everything the rest of the system may know about one agent (FR-58). */
interface AgentCapabilities {
  agent: AgentId;
  roles: AdapterRole[];
  selection: SelectionLevel;
  landing: LandingLevel;
  provenance: ProvenanceSupport;
  /** Home used when the user names none (FR-3). */
  defaultHome: HomePath;
  /** Context window assumed for this agent when configuration overrides none (FR-18). */
  defaultWindowTokens: number;
}
```

<!-- contract: AgentAdapter — restated from src/adapters/module.md (subset: omits the target-role methods serialize, validate, readBack and switchTo) -->
```ts
/** What every agent adapter provides. One folder per agent implements it (FR-57). */
interface AgentAdapter {
  capabilities(): AgentCapabilities;

  /** Source role. Opens source files for reading only (FR-8, NG-1, AC-4). */
  listSessions(home: HomePath): Promise<SessionDescriptor[]>;
  /** Source role. Reads one session into the neutral vocabulary. Drops every result body. */
  loadSession(descriptor: SessionDescriptor): Promise<CanonicalSession>;
}
```

<!-- contract: HomeEntry — restated from src/platform/config/module.md (subset: omits WindowOverride) -->
```ts
/** One extra home the user added to the search list (FR-5). */
interface HomeEntry {
  agent: AgentId;
  home: HomePath;
}
```

<!-- contract: ImportConfig — restated from src/platform/config/module.md (subset: omits budgetShare, pinnedRecentTurns and windowOverrides) -->
```ts
/** User configuration. Every field has a default (FR-5, FR-30, FR-32). */
interface ImportConfig {
  /** Homes searched in addition to every adapter's default home. Default empty (FR-5). */
  extraHomes: HomeEntry[];
}
```

<!-- contract: RepoIdentity — restated from src/platform/repo/module.md -->
```ts
/** The repository the command runs in (FR-13). */
interface RepoIdentity {
  /** Canonical checkout root, or null when unresolved or bare (not an import destination). */
  root: string | null;
  /** Canonical Git common directory shared by linked worktrees, or null when unresolved. */
  commonDir: string | null;
  /** True only for a resolved bare repository; its linked working trees report false. */
  isBare: boolean;
  /** Current HEAD commit, or null when unresolved or the repository has no commit yet. */
  head: string | null;
  branch: string | null;
}
```

<!-- contract: RepoReader — restated from src/platform/repo/module.md (subset: omits distanceFrom) -->
```ts
/** Reads git state. It never writes to the repository. */
interface RepoReader {
  /** Throws AbortError with the signal reason as cause when cancelled; performs no I/O. */
  checkCancellation(): void;
  identify(cwd: string): Promise<RepoIdentity>;
}
```

The blocks below are the normative home of the types they define.

A caller may supply freshly resolved destination evidence for this listing. Discovery verifies
that its canonical cwd matches the requested directory and seeds the per-listing cache, including
unresolved identities. No evidence is retained across requests. The repository reader's cancellation
check runs before operations and after asynchronous boundaries, including cached/supplied evidence
and empty adapter results; cancellation never becomes a skipped entry.

```ts
/** How the user named the session to import (FR-12). */
type SelectionInput =
  | { by: "row"; row: number }
  | { by: "session-id"; id: SessionId }
  | { by: "file-path"; path: string };
```

```ts
/** Which homes to search (FR-2, FR-5, FR-13, FR-15). */
interface SearchScope {
  /** Absolute path of the repository the listing is filtered to (FR-13). */
  repoRoot: string;
  /** When set, only this agent is searched (FR-15). */
  onlyAgent: AgentId | null;
  /** When set, only this home is searched (FR-2). */
  onlyHome: HomePath | null;
}
```

```ts
/** Why a selection could not be resolved (FR-56). */
interface SelectionError {
  /** What the user gave: the row, the session ID, or the path. */
  input: string;
  /** What failed, and what the user can do next. */
  message: string;
}

/** One home or session that could not be included. The listing continues without it. */
interface HomeFailure {
  home: HomePath;
  agent: AgentId;
  /** Why the home or session was skipped, in one line. */
  message: string;
}

/** What a listing produced, including what it could not read. */
interface Listing {
  /** Newest first, across every agent and home (FR-14, FR-15). */
  rows: SessionDescriptor[];
  /** Homes or sessions that were skipped. Reported to the user, never silent. */
  failures: HomeFailure[];
}
```

```ts
/** Fresh destination facts resolved by the caller for this listing only. */
interface DiscoveryDestination {
  canonicalCwd: string;
  identity: RepoIdentity;
}

/** Finds, filters, orders and loads source sessions. It never writes. */
interface SessionFinder {
  /** Newest first (FR-14), only sessions of the current repository (FR-13). */
  list(scope: SearchScope, destination?: DiscoveryDestination): Promise<Listing>;
  /** Resolves a choice against the same ordering list() produced. Rejects with SelectionError. */
  resolve(
    scope: SearchScope,
    input: SelectionInput,
    destination?: DiscoveryDestination,
  ): Promise<SessionDescriptor>;
  /** Reads one session into the neutral vocabulary, through its source adapter. */
  load(descriptor: SessionDescriptor): Promise<CanonicalSession>;
}
```

## Integrations

- **Counterpart**: `src/session/`
- **Direction**: `src/import/discovery/` depends on `src/session/`
- **Strength**: model — it produces `SessionDescriptor` and `CanonicalSession` values
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: high (core)
- **Balanced?**: yes — model coupling tolerates distance 2, and this is exactly 2
- **Shared knowledge**: the four restated session blocks in the Public Contract section above.

---

- **Counterpart**: `src/adapters/`
- **Direction**: `src/import/discovery/` depends on `src/adapters/`
- **Strength**: contract — it calls the port and reads capability data; it never knows which agent
  it is talking to
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: high on the adapter side
- **Balanced?**: yes — contract coupling tolerates any distance
- **Shared knowledge**: the restated `AgentCapabilities` block and the source-role subset of
  `AgentAdapter` in the Public Contract section above. This module never touches
  `src/adapters/pi/`, `src/adapters/codex/` or `src/adapters/claude-code/` — it receives adapters as
  data from `src/import/`.

---

- **Counterpart**: `src/platform/config/`
- **Direction**: `src/import/discovery/` depends on `src/platform/config/`
- **Strength**: contract
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: low
- **Balanced?**: yes
- **Shared knowledge**: the restated `HomeEntry` block and the `extraHomes` subset of `ImportConfig`
  in the Public Contract section above. This module reads no other setting.

---

- **Counterpart**: `src/platform/repo/`
- **Direction**: `src/import/discovery/` depends on `src/platform/repo/`
- **Strength**: contract
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: low
- **Balanced?**: yes
- **Shared knowledge**: the restated `RepoIdentity` block and the `identify` subset of `RepoReader`
  in the Public Contract section above. The commit distance of FR-38 is not this module's concern;
  it belongs to `src/import/preview/`.

## Change Vectors

Changes that require **only this module** to change:

- The ordering rule changes — for example sessions are grouped by agent before being ordered by time.
- The repository evidence or ambiguity rule changes.
- A fourth way to name a session is added, for example a title prefix.
- Deduplication of homes changes, for example to treat two symlinked homes as one.
- A skipped home is reported differently.

## Constraints and Invariants

- **The pipeline derives `SearchScope.repoRoot` from request `destinationCwd`.** It is an internal search scope, not a second caller-supplied import destination. Repository membership uses canonical Git common-directory identity with exact-directory fallback; it never changes the destination checkout.

- **This module never writes anything**, to any home or any repository (NG-1, AC-4).
- **This module never calls a model** (FR-8). A listing works when the source agent is stopped or out
  of quota, because everything comes from disk.
- **`list` and `resolve` use one ordering.** FR-10 lets the user run the command twice — once to see
  rows, once to name row 3 — and the second run must resolve to the session the first run showed. The
  ordering is therefore a pure function of the descriptors, with a deterministic tie-break on
  `SessionRef` when two sessions share `updatedAt`.
- **Row numbers are 1-based**, because they are shown to a user (FR-10).
- **A session ID must resolve uniquely in the current search scope.** When the same ID appears in
  more than one agent or home, `resolve` rejects and lists the matching locations. The user can then
  select a numbered row or exact file path, or narrow the search by agent and home.
- **A session from another repository is never listed and never resolvable** (FR-13, NG-9), including
  when the user names it by session ID or by file path. Selection by path is a convenience, not a way
  around the filter.
- **All recorded candidates are checked before acceptance.** A matching early candidate cannot
  override a later conflicting identity. Conflicts exclude the session from every selector and
  produce a diagnostic. A missing primary `repoPath` is recoverable only through a surviving
  `repoPaths` candidate, never by walking to a parent or consulting a worktree registry.
- **No usable evidence is explained.** Empty candidate arrays, missing-only paths and unresolved
  candidates without a positive match produce `Listing.failures`. Selection errors include these
  diagnostics when no row/ID/path can be selected. No worktree-name, prefix, remote, object-store,
  ancestor or registry heuristics establish membership.
- **The start directory is a last resort, not a candidate.** It is checked only when no recorded
  candidate matched and none conflicted, so it resolves missing evidence and never overrides a match
  or a conflict. It never joins `repoPaths`, so it cannot create a conflict either, and a directory
  already among the candidates is not looked up again.
- **Lookups are shared only within one listing.** Promise caches keyed by canonical directory share
  repository lookups (including rejections) across sessions/homes and symlink aliases. An additional
  spelling cache shares canonicalization failures and missing paths. The next list or resolve starts
  fresh. Descriptors remain sequential within each home; homes are processed concurrently.
- **Operational errors are not neutral evidence.** Source timeout/spawn/non-ENOENT filesystem errors
  skip only that session with a diagnostic, preserving other sessions and homes. Destination errors
  reject the request with a diagnostic. `AbortError` always propagates, including from source/home
  lookups; cancellation is never classified by message or Git stderr.
- **One bad home never empties the listing.** An unreadable directory, a missing home, or a corrupt
  session file becomes a `HomeFailure` and the rest of the search continues.
- **Only adapters with the `source` role are searched** (FR-59).
- **This module holds no adapter list.** Adapters arrive from `src/import/`, which received them from
  `src/host/`. That is what keeps FR-57 to one line.
- **`load` returns what the adapter produced, unchanged.** No rule of section D or E runs here — that
  is `src/import/transfer/`. Splitting the reading from the ruling is what makes FR-60 checkable.
- **Homes are compared as resolved absolute paths.** Two spellings of the same directory are one
  home.

## Test Specification

Tests use stub adapters over fixture homes and real temporary Git repositories/worktrees for membership. No agent needs to be installed.

### Unit Tests

**T-DIS-1 — the search list is the defaults plus the extras**

- Scenario: three adapters with default homes, and a configuration adding two extra homes.
- Expected behavior: five homes are searched, each exactly once.

**T-DIS-2 — a duplicate home is searched once**

- Scenario: parameterized — an extra home equal to an adapter default; the same home spelled with
  `~`, with `..`, and through a symlink.
- Expected behavior: one search in every case. Deduplication compares resolved absolute paths.

**T-DIS-3 — only source adapters are searched**

- Scenario: one adapter declares `["target"]` only.
- Expected behavior: its home is not searched and none of its sessions appears (FR-59).

**T-DIS-4 — the listing is newest first**

- Scenario: nine sessions across three agents and four homes, with interleaved `updatedAt` values.
- Expected behavior: strictly descending by `updatedAt`, mixed across agents and homes (FR-14,
  FR-15).

**T-DIS-5 — the ordering is deterministic on a tie**

- Scenario: two sessions with an identical `updatedAt`, listed 100 times.
- Expected behavior: the same order every time, broken by `SessionRef`. This is what makes
  `/resume-from 3` mean the same session in a second invocation.

**T-DIS-6 — only sessions of this repository are listed**

- Scenario: sessions from repository A and repository B; the scope names A.
- Expected behavior: only A's sessions appear (FR-13, NG-9).

**T-DIS-7 — a session with no repository is out of scope**

- Scenario: a session whose `repoPath` is null.
- Expected behavior: it is not listed, and it appears in `Listing.failures` with a reason.

**T-DIS-8 — naming one agent narrows the search**

- Scenario: the scope sets `onlyAgent` to `codex`.
- Expected behavior: only Codex homes are searched (FR-15).

**T-DIS-9 — naming one home narrows the search**

- Scenario: the scope sets `onlyHome` to `~/.claude-team`.
- Expected behavior: only that home is searched (FR-2).

**T-DIS-25 — a named home outside every default and extra home is still searched**

- Scenario: the scope sets `onlyHome` to a directory no adapter default and no `extraHomes`
  entry names.
- Expected behavior: every source adapter searches that home; the list is never silently
  empty because the home was unknown to the configuration (FR-2).

**T-DIS-26 — an unlisted named home narrowed by agent searches only that agent**

- Scenario: the scope sets `onlyHome` to an unlisted directory and `onlyAgent` to one agent.
- Expected behavior: only that agent's adapter searches the named home (FR-2, FR-15).

### Integration Contract Tests

**T-DIS-10 — every selection form resolves to the same session**

- Scenario: a fixed listing; the same session is named by row 3, by session ID, and by file path.
- Expected behavior: all three resolve to the identical descriptor (FR-10, FR-12).

**T-DIS-11 — rows are 1-based and match what was listed**

- Scenario: `list` then `resolve` with each row number from 1 to the length.
- Expected behavior: row _n_ resolves to the _n_-th row of the listing, and row 0 fails.

**T-DIS-12 — resolve after a re-listing agrees**

- Scenario: `list` is called, the finder is rebuilt from scratch, and `resolve` with row 3 runs on
  the new instance.
- Expected behavior: the same session. The two invocations of FR-10 are separate processes, and this
  is the property that makes them agree.

**T-DIS-13 — load returns exactly what the adapter produced**

- Scenario: a stub adapter returns a known canonical session.
- Expected behavior: `load` returns it unchanged. No rule of section D or E runs here.

**T-DIS-24 — a duplicate exact session ID must be disambiguated**

- Scenario: the same ID appears in two Pi homes and one Codex home in the current repository.
- Expected behavior: selection by ID rejects, names every matching location, and recommends a
  numbered row, exact file path, or narrower agent/home scope.

### Boundary Tests

**T-DIS-14 — an unknown row, ID or path fails with a message**

- Scenario: parameterized — row 0, row 999, an unknown session ID, a path that does not exist, a
  path that exists but is not a session.
- Expected behavior: each rejects with a `SelectionError` naming what the user gave and what to do
  next (FR-56).

**T-DIS-15 — a session from another repository cannot be reached by ID or path**

- Scenario: `resolve` by session ID and by file path, naming a session of repository B while the
  scope is repository A.
- Expected behavior: both fail. Selection by path is a convenience, not a way around FR-13 (NG-9).

**T-DIS-16 — one bad home does not empty the listing**

- Scenario: parameterized — a home that does not exist; a home with no read permission; a home
  containing one corrupt session file.
- Expected behavior: in each case the other homes still list, and the failure appears in
  `Listing.failures` with the home, the agent and a one-line reason.

**T-DIS-17 — every home failing still returns a listing**

- Scenario: every home is unreadable.
- Expected behavior: `rows` is empty, `failures` has one entry per home. It does not reject — the
  host prints the failures.

**T-DIS-18 — an empty listing is not an error**

- Scenario: readable homes with no sessions for this repository.
- Expected behavior: `rows` empty; no request error. Unresolved or missing evidence is explained in
  `failures`; a home with no descriptors needs no diagnostic.

**T-DIS-19 — nothing is written**

- Scenario: every home and the repository are checksummed around `list`, `resolve` and `load`.
- Expected behavior: identical (NG-1, AC-4).

**T-DIS-20 — no model is called**

- Scenario: the whole suite runs with the network stubbed to fail.
- Expected behavior: every test passes (FR-8).

### Behavior Tests

**T-DIS-21 — the listing works with the source agent stopped**

- Scenario: fixture homes are read while no agent process is running and every network call fails.
- Expected behavior: the full listing is produced — the explicit FR-8 test ("stop the source agent,
  reach its usage limit, the list and the import still work").

**T-DIS-22 — one list, every agent**

- Scenario: the command runs with Pi as the target, and the homes hold Pi, Codex and Claude Code
  sessions for this repository.
- Expected behavior: all three agents appear in one listing, ordered by time (FR-15's test).

**T-DIS-23 — two profiles of one agent appear together**

- Scenario: `~/.claude` and `~/.claude-team` both hold sessions for this repository.
- Expected behavior: both appear, each row naming its home (FR-5, FR-11).


**T-DIS-27 — worktree membership is independent of placement and selector**

- Real nested, sibling and arbitrary external worktrees match in both directions; sibling worktrees,
  checkout subdirectories and symlink aliases match through canonical common-directory evidence.
- List, row, ID and file path agree across default, configured extra and explicitly named homes.
  Source-home filtering, ordering and duplicate-ID disambiguation remain unchanged.

**T-DIS-28 — active candidate evidence and ambiguity**

- Missing-first/surviving-later paths and neutral unresolved candidates work in either order.
- Later conflicting identities reject even after a Git or exact-directory match; unresolved
  destinations permit exact fallback only without any resolved candidate identity.
- Missing-only paths (including removed nested worktrees), independent nested repositories and
  independent shared-object clones never match by inference. Skipped evidence is explained.

**T-DIS-29 — isolated failures and listing-local caches**

- Candidate timeout, spawn and filesystem errors skip that session, not other sessions/homes;
  destination failures reject. Cancellation rejects list and every selector despite matching rows.
- Repeated paths, symlink aliases, unresolved/missing candidates and failures share lookups within
  one listing. Later listings refresh lookups and observe replaced identities or recovered paths.

**T-DIS-30 — a session that started here is still found here**

- Scenario: a session whose recorded candidates are a subdirectory of the destination and whose own
  `startDirectory` is that destination, beside a session whose `startDirectory` is elsewhere.
- Expected behavior: the first is listed and resolvable while the second stays out with its
  diagnostic, and a conflicting candidate identity excludes a session even when its `startDirectory`
  is this directory (issue #5).
