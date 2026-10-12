# Import Pipeline

**Path**: src/import/ — the module's code is everything in this folder and its transparent subfolders, excluding the submodule folders `discovery/`, `transfer/`, `preview/`, `landing/`
**Parent**: `src/` (root)
**Submodules**: `discovery/`, `transfer/`, `preview/`, `landing/`

## Purpose

This module is the import itself. It owns the order of the four stages — find, rule, preview, land —
and it is the only thing a host talks to. Hosts differ (a picker in Pi, a numbered list in Codex and
Claude Code); the pipeline behind them does not.

This is also where FR-6 and FR-60 are kept honest. Every one of the nine directions runs the same
three calls in the same order, against the same rules. The source agent changes which adapter
`discovery` reads with; the target agent changes which adapter `landing` writes with. Nothing between
those two points knows either name.

## Functional Responsibilities

- Expose three operations to every host: `list`, `preview`, `commit` (FR-7, FR-16, FR-20).
- Hold the stage order and pass each stage's output to the next.
- Recompute the plan on `commit` from the same request that produced the preview, so the two
  invocations of a numbered-list host agree (FR-10, FR-20).
- Refuse to commit when the source session changed between the preview and the commit.
- Refuse to commit a blocked plan (FR-33).
- Choose the source adapter from the chosen session's agent and the target adapter from the target
  profile's agent — and nothing else in the tree makes that choice.
- Turn a stage failure into one error that says what failed and what to do next (FR-56).

## Subdomain Classification

**Core, by composition.** The pipeline holds no rule of its own, but it owns the order, and the order
is part of the product's promise: nothing is written before a preview, and a preview is always
possible without writing. Volatility is **moderate** — the three-call shape is fixed by FR-16 and
FR-20; what changes is what the stages return.

## Encapsulated Knowledge

- **The stage order** and what each stage is allowed to do. `list` and `preview` never write;
  `commit` writes exactly once.
- **The re-computation rule.** That `commit` re-runs discovery and the rules rather than trusting a
  plan handed back by a host, because the numbered-list hosts of FR-10 are separate processes and a
  plan cannot travel between them.
- **The freshness check.** That `commit` compares the source session's `updatedAt` with what the
  preview saw and refuses when it moved, so the user confirms what actually lands.
- **Adapter selection.** That the source adapter comes from `SessionDescriptor.ref.agent` and the
  target adapter from `TargetProfile.agent`, and that this is the only place the two are picked.
- **Error consolidation.** How a discovery failure, a blocked plan, and a landing failure become one
  error shape for every host.

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

<!-- contract: TargetProfile — restated from src/session/module.md -->
```ts
/** Where the import is going, and how much room it has (FR-18, FR-29). */
interface TargetProfile {
  agent: AgentId;
  home: HomePath;
  /** Context window of the target, in tokens. */
  windowTokens: number;
}
```

<!-- contract: ProvenanceMarker — restated from src/session/module.md -->
```ts
/** The import marker the user sees. It never enters the model context (FR-47, FR-48). */
interface ProvenanceMarker {
  sourceAgent: AgentId;
  sourceHome: HomePath;
  sourceSessionId: SessionId;
  /** ISO-8601 UTC. */
  importedAt: string;
  /** One line naming what the rules dropped. */
  droppedSummary: string;
  /** The rendered marker, in the order it must be shown. */
  lines: string[];
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

<!-- contract: AgentRuntime — restated from src/adapters/module.md -->
```ts
/**
 * An opaque handle supplied by the host of the same agent, for example Pi's
 * command context. Nothing outside the adapter of that agent inspects it.
 */
type AgentRuntime = unknown;
```

<!-- contract: ValidationDefect, SerializedSession, StoredSessionFacts, SwitchOutcome — restated from src/adapters/module.md -->
```ts
/** A structural defect found before placement (FR-50). */
interface ValidationDefect {
  /** Pointer into the offending item, for example "items/3/usage". */
  path: string;
  /** What is missing or malformed, and why the agent would fail on it. */
  message: string;
}

/** What serializing a canonical session into the target format produced. */
interface SerializedSession {
  sessionId: SessionId;
  /** The files to create. The adapter never writes them itself (FR-49, FR-53). */
  files: PendingFile[];
  /** Items the adapter expects the target to store (FR-52). */
  itemCount: number;
}

/** What the target actually holds, read back after the commit (FR-51, FR-52). */
interface StoredSessionFacts {
  sessionId: SessionId;
  /** Items the target stored. A difference from itemCount is an error (FR-52). */
  itemCount: number;
  /** True when the target's own commands can open the session (FR-51). */
  openable: boolean;
}

/** The outcome of asking the agent to move the user into the new session (FR-44). */
interface SwitchOutcome {
  switched: boolean;
  /** True when the agent asked the user and the user declined. */
  cancelled: boolean;
}
```


<!-- contract: SerializationContext — restated from src/adapters/module.md -->
```ts
/** The host-supplied absolute destination, preserving native subdirectory and symlink spelling. */
interface SerializationContext {
  cwd: string;
}
```

<!-- contract: AgentAdapter — restated from src/adapters/module.md -->
```ts
/** What every agent adapter provides. One folder per agent implements it (FR-57). */
interface AgentAdapter {
  capabilities(): AgentCapabilities;

  /** Source role. Opens source files for reading only (FR-8, NG-1, AC-4). */
  listSessions(home: HomePath): Promise<SessionDescriptor[]>;
  /** Source role. Reads one session into the neutral vocabulary. Drops every result body. */
  loadSession(descriptor: SessionDescriptor): Promise<CanonicalSession>;

  /** Target role. Produces bytes only. It never creates a file (FR-49, FR-53). */
  serialize(
    session: CanonicalSession,
    target: TargetProfile,
    marker: ProvenanceMarker,
    context: SerializationContext,
  ): SerializedSession;
  /** Target role. Checks the structure before placement. Empty means valid (FR-50). */
  validate(serialized: SerializedSession): ValidationDefect[];
  /** Target role. Reads the committed session back, to compare item counts (FR-51, FR-52). */
  readBack(home: HomePath, sessionId: SessionId): Promise<StoredSessionFacts>;

  /** Target role, only when capabilities().landing is "create-and-switch" (FR-43, FR-44). */
  switchTo(
    home: HomePath,
    sessionId: SessionId,
    runtime: AgentRuntime,
  ): Promise<SwitchOutcome>;
}
```

<!-- contract: Bytes, PendingFile — restated from src/platform/store/module.md -->
```ts
/** Raw file content. */
type Bytes = Buffer;

/** A file to create. Its path must not already exist (FR-49). */
interface PendingFile {
  absolutePath: string;
  bytes: Bytes;
}
```

<!-- contract: CommitRefusal, CommitHandle, CommitError, FileCommitter — restated from src/platform/store/module.md -->
```ts
/** Why a commit refused to run, or failed (FR-56). */
type CommitRefusal = "path-exists" | "not-writable" | "write-failed";

/** A commit that succeeded and reports the paths it created (FR-52, FR-53). */
interface CommitHandle {
  createdPaths: string[];
}

/** Raised when a commit refuses to run or fails. Carries an actionable message (FR-56). */
interface CommitError {
  refusal: CommitRefusal;
  /** The path that caused the refusal, when there is one. */
  path: string | null;
  /** What failed, and what the user can do next (FR-56). */
  message: string;
  /** Paths retained for safety or not removed by cleanup, when manual inspection may be required. */
  remainingPaths?: string[];
}

/** Atomically adds zero or one file to a home (FR-49, FR-53). */
interface FileCommitter {
  /**
   * Creates zero or one file. Rejects with a CommitError before filesystem access when more than one
   * file is supplied, or before writing bytes when the destination already exists.
   */
  commit(root: string, files: PendingFile[]): Promise<CommitHandle>;
}
```

<!-- contract: HomeEntry, WindowOverride — restated from src/platform/config/module.md -->
```ts
/** One extra home the user added to the search list (FR-5). */
interface HomeEntry {
  agent: AgentId;
  home: HomePath;
}

/** A context window the user set for one agent, overriding the adapter default (FR-18). */
interface WindowOverride {
  agent: AgentId;
  windowTokens: number;
}
```

<!-- contract: ImportConfig — restated from src/platform/config/module.md -->
```ts
/** User configuration. Every field has a default (FR-5, FR-30, FR-32). */
interface ImportConfig {
  /** Homes searched in addition to every adapter's default home. Default empty (FR-5). */
  extraHomes: HomeEntry[];
  /** Share of the target window one import may use. Default 0.30 (FR-30, Q-1). */
  budgetShare: number;
  /** Recent turns kept word for word. Default 5 (FR-32, Q-2). */
  pinnedRecentTurns: number;
  /** Context windows the user set explicitly. Default empty. */
  windowOverrides: WindowOverride[];
}
```

<!-- contract: TokenEstimator — restated from src/platform/tokens/module.md -->
```ts
/** Estimates how many tokens a piece of text costs. */
interface TokenEstimator {
  /** Deterministic: the same text always returns the same count. Never negative. */
  estimate(text: string): number;
}
```

<!-- contract: SelectionInput — restated from src/import/discovery/module.md -->
```ts
/** How the user named the session to import (FR-12). */
type SelectionInput =
  | { by: "row"; row: number }
  | { by: "session-id"; id: SessionId }
  | { by: "file-path"; path: string };
```

<!-- contract: SearchScope — restated from src/import/discovery/module.md -->
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

<!-- contract: SelectionError, HomeFailure, Listing — restated from src/import/discovery/module.md -->
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

<!-- contract: DiscoveryDestination, SessionFinder — restated from src/import/discovery/module.md -->
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

<!-- contract: DropReason, PinReason, TurnDrop, TurnPin — restated from src/import/transfer/module.md -->
```ts
/** Why a turn did not cross over (FR-31, FR-54). */
type DropReason = "budget" | "broken-tail";

/** Why a turn is kept whatever the budget says (FR-32). */
type PinReason = "first-request" | "recent-turn" | "summary" | "changed-files";

/** One turn the rules removed. */
interface TurnDrop {
  /** The turn's index in the source session. */
  index: number;
  reason: DropReason;
}

/** One turn the rules protected. */
interface TurnPin {
  /** The turn's index in the source session. */
  index: number;
  reason: PinReason;
}
```

<!-- contract: TransferPlan — restated from src/import/transfer/module.md -->
```ts
/** The result of applying requirement sections D and E to one source session. */
interface TransferPlan {
  target: TargetProfile;
  /** The source metadata, unchanged. */
  provenance: SourceProvenance;
  /** Only the turns that cross over, in source order. */
  turns: CanonicalTurn[];
  pins: TurnPin[];
  drops: TurnDrop[];
  keptTurnCount: number;
  droppedTurnCount: number;
  /** Tool result bodies the rules removed (FR-24, FR-25). */
  bodiesDropped: number;
  /** Estimated cost of the kept turns, in tokens. */
  estimatedTokens: number;
  /** budgetShare multiplied by the target window, rounded down (FR-29, FR-30). */
  budgetTokens: number;
  /** True when an incomplete trailing tool call was removed (FR-54, FR-55). */
  brokenTailDropped: boolean;
  /** Set when the pinned content alone exceeds the budget. The import cannot run (FR-33). */
  blockedReason: string | null;
}
```

<!-- contract: TransferRules — restated from src/import/transfer/module.md -->
```ts
/** Applies requirement sections D and E. Pure: the same input always gives the same plan. */
interface TransferRules {
  apply(
    session: CanonicalSession,
    target: TargetProfile,
    config: ImportConfig,
    estimator: TokenEstimator,
  ): TransferPlan;
}
```

<!-- contract: WarningKind, PreviewWarning — restated from src/import/preview/module.md -->
```ts
/** What a warning is about. Repository warnings sort first (FR-19). */
type WarningKind = "repo-state" | "budget" | "broken-tail" | "capability";

/** One warning line of the preview (FR-19). */
interface PreviewWarning {
  kind: WarningKind;
  /** The rendered line, ready to show. */
  line: string;
}
```

<!-- contract: PreviewReport, PreviewContent, PreviewBuilder — restated from src/import/preview/module.md -->
```ts
/** Everything the user sees before confirming (FR-16 to FR-21). */
interface PreviewReport {
  /** Opaque binding that must be returned unchanged to commit this exact preview (FR-20). */
  confirmationToken: string;
  /** Source, target, and the turn counts that cross and are dropped (FR-17). */
  headerLines: string[];
  /** For example "Budget: 34k tokens of a 200k window" (FR-18). */
  budgetLine: string;
  /** Repository warnings first (FR-19). */
  warnings: PreviewWarning[];
  /** For example "12 older turns dropped" (FR-35). */
  dropLines: string[];
  /** True when the import cannot run. Nothing may be written (FR-33). */
  blocked: boolean;
  /** Set when blocked is true. States what to change. */
  blockedReason: string | null;
  /** The whole preview, rendered. The same shape for all nine directions (FR-21). */
  lines: string[];
}

/** Preview content before the pipeline binds it to a confirmation token. */
type PreviewContent = Omit<PreviewReport, "confirmationToken">;

/** Builds the preview from a plan and the current repository state. */
interface PreviewBuilder {
  build(plan: TransferPlan): Promise<PreviewContent>;
}
```

<!-- contract: HandoverInstruction, LandingResult — restated from src/import/landing/module.md -->
```ts
/** What the user must do next when the adapter cannot switch (FR-45). */
interface HandoverInstruction {
  sessionId: SessionId;
  /** The native command that opens the new session, for example "claude --resume <id>". */
  command: string;
}

/** What the landing produced (FR-40 to FR-47, FR-52). */
interface LandingResult {
  ref: SessionRef;
  switched: boolean;
  /** Set when the adapter could only create (FR-43, FR-45). */
  handover: HandoverInstruction | null;
  itemsSent: number;
  itemsStored: number;
  marker: ProvenanceMarker;
}
```

<!-- contract: LandingStage, LandingError, SessionLander — restated from src/import/landing/module.md -->
```ts
/** Which step of the landing failed (FR-56). */
type LandingStage =
  "serialize" | "validate" | "commit" | "read-back" | "switch";

/** A landing that failed. Published paths are preserved after post-commit failures (FR-53). */
interface LandingError {
  stage: LandingStage;
  /** What failed, and what the user can do next (FR-56). */
  message: string;
  /** The structural defects, when the stage is "validate" (FR-50). */
  defects: ValidationDefect[];
  /** Always false because successful commits expose no unsafe pathname rollback operation. */
  rolledBack: boolean;
}

/** Places a plan in the target home without modifying pre-existing paths (FR-49, FR-53). */
interface SessionLander {
  /**
   * Runs after the user confirmed the preview (FR-20).
   * Rejects with a LandingError; post-commit failures preserve and report created paths.
   */
  land(
    plan: TransferPlan,
    adapter: AgentAdapter,
    committer: FileCommitter,
    runtime: AgentRuntime,
    importedAt: string,
    context: SerializationContext,
  ): Promise<LandingResult>;
}
```

The blocks below are the normative home of the types they define.

```ts
/** What to list (FR-10, FR-15). */
interface ListRequest {
  /** Host-supplied absolute working directory; preserve native subdirectory and symlink spelling. */
  destinationCwd: string;
  target: TargetProfile;
  onlyAgent: AgentId | null;
  onlyHome: HomePath | null;
}

/** What to preview, and later what to commit (FR-16, FR-20). */
interface ImportRequest {
  /** Host-supplied absolute working directory; preserve native subdirectory and symlink spelling. */
  destinationCwd: string;
  target: TargetProfile;
  selection: SelectionInput;
  onlyAgent: AgentId | null;
  onlyHome: HomePath | null;
}
```

```ts
/** One import, from listing to landing. Every host drives these three calls. */
interface ImportPipeline {
  list(request: ListRequest): Promise<Listing>;
  /** Writes nothing (FR-16). */
  preview(request: ImportRequest): Promise<PreviewReport>;
  /** Runs only after the user confirmed the preview (FR-20). */
  commit(
    request: ImportRequest,
    runtime: AgentRuntime,
    confirmationToken: string,
  ): Promise<LandingResult>;
}
```

## Integrations

- **Counterpart**: `src/import/discovery/`, `src/import/transfer/`, `src/import/preview/`,
  `src/import/landing/`
- **Direction**: this module calls all four
- **Strength**: contract for the stage interfaces; model for the values that flow between them
- **LCA / Rank / Distance**: LCA `src/import/`, rank 1, distance 1 for each
- **Volatility**: high — `transfer/` is the most volatile module in the system
- **Balanced?**: yes — both contract and model coupling are balanced at distance 1
- **Shared knowledge**: `SessionFinder`, `TransferRules`, `PreviewBuilder`, `SessionLander` and every
  type they exchange, restated in the Public Contract section above.

---

- **Counterpart**: `src/session/`
- **Direction**: `src/import/` depends on `src/session/`
- **Strength**: model — the values that flow between stages are canonical
- **LCA / Rank / Distance**: LCA `src/`, rank 1, distance 1
- **Volatility**: high (core)
- **Balanced?**: yes
- **Shared knowledge**: the six restated session blocks in the Public Contract section above.

---

- **Counterpart**: `src/adapters/`
- **Direction**: `src/import/` depends on `src/adapters/` — it picks the source and target adapters
  and hands them to the stages
- **Strength**: contract
- **LCA / Rank / Distance**: LCA `src/`, rank 1, distance 1
- **Volatility**: high on the adapter side
- **Balanced?**: yes
- **Shared knowledge**: `AgentAdapter`, `AgentCapabilities` and the port's data types, restated in
  the Public Contract section above. This module receives adapters from `src/host/` as data; it never
  imports `src/adapters/pi/`, `src/adapters/codex/` or `src/adapters/claude-code/`.

---

- **Counterpart**: `src/platform/config/`, `src/platform/tokens/`, `src/platform/store/`
- **Direction**: `src/import/` receives a loaded `ImportConfig`, a `TokenEstimator` and a
  `FileCommitter`, and passes them to the stages that need them
- **Strength**: contract
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2 for each
- **Volatility**: low
- **Balanced?**: yes
- **Shared knowledge**: `ImportConfig` with `HomeEntry` and `WindowOverride`, `TokenEstimator`, and
  `FileCommitter` with `PendingFile`, `Bytes`, `CommitHandle`, `CommitError` and `CommitRefusal` —
  all restated in the Public Contract section above. This module constructs none of them.

## Internal Design

### How the four submodules compose

```text
host                                              (picker or numbered list)
  │  list(request)
  ▼
discovery ── list ──► Listing                     FR-13, FR-14, FR-15
  │
  │  preview(request)
  ▼
discovery ── resolve ─► SessionDescriptor         FR-10, FR-12
  │
  └────────── load ───► CanonicalSession          FR-8, FR-22 to FR-28
                 │
                 ▼
            transfer ─► TransferPlan              FR-22 to FR-35, FR-54
                 │
                 ▼
            preview ──► PreviewReport             FR-16 to FR-21, FR-37, FR-38
                 │
        user confirms                             FR-20
                 │
                 ▼
            landing ──► LandingResult             FR-40 to FR-53
```

| Stage | Submodule    | What it contributes                                                         | Writes?   |
| ----- | ------------ | --------------------------------------------------------------------------- | --------- |
| Find  | `discovery/` | Which sessions exist here, which one the user meant, and its canonical form | No        |
| Rule  | `transfer/`  | What crosses over and how much                                              | No        |
| Show  | `preview/`   | The lines the user confirms, and the block decision                         | No        |
| Land  | `landing/`   | The new session, the reconciliation, and the handover                       | Yes, once |

### The three operations

**`list(request)`** builds a `SearchScope` from the request and calls `SessionFinder.list`. It
touches no other stage. It never writes.

**`preview(request)`** calls `SessionFinder.resolve`, then `SessionFinder.load`, then
`TransferRules.apply` with the configuration and the estimator, then `PreviewBuilder.build`. It never
writes. A blocked plan still produces a report — the user is told why the import cannot run (FR-33).

**`commit(request, runtime, confirmationToken)`** repeats the whole of `preview`, refuses unless the
token matches that exact recomputed selection, plan, and report, then refuses if the plan is blocked.
Only then does it call `SessionLander.land` with the target adapter, committer, runtime handle, and
the destination context produced by that same recomputation. The pipeline checks cancellation after
preview construction and immediately before landing, even when no further Git lookup is needed.

### Why `commit` recomputes instead of receiving a plan

FR-10 makes Codex and Claude Code drive the tool in separate invocations: `/resume-from` prints a
list, `/resume-from 3` shows a preview, and a third invocation confirms. A plan cannot survive
between processes, and serializing it into a temporary file would create a second write path — the
opposite of what FR-49 and C-3 ask for.

Recomputation is safe because `TransferRules.apply` is pure. A versioned SHA-256 confirmation token
binds the resolved descriptor, full transfer plan, preview report, canonical destination cwd, and
canonical Git common-directory identity. Symlink aliases of a destination share a token, but different
worktrees do not, even at identical HEAD and branch. A row reorder, source change,
configuration change, destination/identity change, target change, or warning change therefore refuses before serialization. The
descriptor timestamp check remains as an additional diagnostic. The user then previews again.

### Where each adapter is chosen

The source adapter is selected by `SessionDescriptor.ref.agent` after `resolve`. The target adapter
is selected by `ImportRequest.target.agent`. Both come from the registry `src/host/` supplied. The
two may be the same adapter with different homes — that is the diagonal of the scope table (FR-4),
and nothing special happens for it.

### Where the nine directions live

Nowhere. There is no branch on the pair. `discovery` reads through whatever source adapter it was
given, `transfer` never sees an agent name, `preview` renders one shape (FR-21), and `landing` reads
a capability instead of a name. That absence is the design; FR-6 and FR-60 are satisfied by there
being no code to point at.

## Change Vectors

Changes that require **only this module** to change:

- A fourth operation is added, for example `explain` that shows what a session contains without a
  target.
- The freshness check becomes stricter or looser.
- A stage is reordered, for example computing the repository warning before the rules so a moved tree
  can influence the budget.
- Error consolidation changes: a new error shape for the hosts.
- A stage gains a cache within one process, for a host that previews and commits without exiting.

Adding an agent does not change this module. Changing a rule does not change this module.

## Constraints and Invariants

- **The preview receives selected recorded directories separately from provenance.** Internal `previewFor(destination, descriptor)` supplies `descriptor.repoPaths` for canonical source-directory comparison. Directory warnings are included in preview content before hashing and recomputed on confirmation; they do not change repository membership or add destination fields to source provenance.
- **One request destination drives discovery, preview, distance, and landing.** Derive `SearchScope.repoRoot` from `destinationCwd`, not from the checkout root. Resolve canonical cwd and repository identity afresh for each request. Refuse bare repositories with advice to use a linked worktree; destination filesystem and Git operational failures stop the request before writing. `commit` uses its existing `compute()` result, passing the native cwd through landing as required serialization context.

- **`list` and `preview` never write** (FR-16). Only `commit` reaches `SessionLander`, which is the
  only path to `FileCommitter`.
- **`commit` runs only after the user confirmed** (FR-20). This module has no confirmation
  user-interface of its own; the host confirms and then calls `commit`. A host that calls `commit`
  without confirming breaks the rule, and the tests of the hosts check it.
- **`commit` refuses a plan with a non-null `blockedReason`** (FR-33) before any adapter is asked to
  serialize.
- **`commit` refuses when the source session changed since the preview.** The error names the session
  and asks the user to preview again (FR-56).
- **`preview` and `commit` of the same request compute the same plan**, given an unchanged source.
  This follows from `TransferRules.apply` being pure and the finder's ordering being deterministic,
  and it is the reason neither may read a clock: `importedAt` is passed into `land`.
- **No stage is skipped.** A host cannot call `land` directly, because `SessionLander` is not part of
  this module's public contract — `ImportPipeline` is.
- **This module never branches on `AgentId`** (FR-60), except to look an adapter up in the registry
  it was given.
- **Only adapters with the `target` role may be a target, and only adapters with the `source` role
  may be a source** (FR-59). A request naming a target that cannot receive is refused with a message
  naming the missing role.
- **After a successful `commit`, nothing is sent to the target and no tool is run** (FR-46).
- **One failure, one error.** A discovery failure, a blocked plan, and a landing failure all surface
  as an error that states what failed and what to do next (FR-56). No stage error reaches a host in
  its raw form.

## Test Specification

These tests exercise the pipeline as a whole, with stub adapters over fixture homes and a real
committer over a temporary directory. They are where the nine directions are covered end to end
without any agent installed; the live equivalents live in the adapter modules.

### Unit Tests

**T-IMP-1 — `list` touches only discovery**
- Scenario: `list` with recording stubs for all four stages.
- Expected behavior: only the finder is called. The rules, the preview builder and the lander are
  not.

**T-IMP-2 — `preview` runs four steps in order**
- Scenario: `preview` with recording stubs.
- Expected behavior: `resolve`, `load`, `apply`, `build`, in that order, and the lander is never
  called.

**T-IMP-3 — `commit` repeats the preview then lands**
- Scenario: `commit` with recording stubs.
- Expected behavior: `resolve`, `load`, `apply`, `build`, then `land` — and `land` receives the plan
  `apply` produced.

**T-IMP-4 — the source adapter is chosen by the session's agent**
- Scenario: a listing holding sessions from all three agents; each is selected in turn.
- Expected behavior: the adapter matching `SessionDescriptor.ref.agent` is used to load, every time.

**T-IMP-5 — the target adapter is chosen by the target profile**
- Scenario: parameterized over three target agents.
- Expected behavior: the adapter matching `TargetProfile.agent` is used to land, every time.

**T-IMP-6 — the diagonal is not a special case**
- Scenario: source and target are the same agent in two different homes (FR-4).
- Expected behavior: the same call sequence as any other direction. No branch is taken for it.

### Integration Contract Tests

**T-IMP-7 — every direction runs end to end**
- Scenario: for every ordered pair of the shipped agents, including each with itself, the reference
  session is listed, previewed and committed.
- Expected behavior: every landing succeeds — sixteen of them at the four shipped agents. This is
  AC-1 at the pipeline level.

**T-IMP-8 — preview and commit compute the same plan**
- Scenario: `preview` then `commit` for the same request, with the plan captured at both points.
- Expected behavior: deeply equal apart from the repository state, which is read fresh. This is what
  makes the two invocations of FR-10 honest.

**T-IMP-9 — `commit` refuses when the source moved**
- Scenario: `preview` runs; the source session file is then appended to; `commit` runs.
- Expected behavior: rejects with a message naming the session and asking the user to preview again.
  Nothing is written (FR-20 in spirit: the user confirms what actually lands).

**T-IMP-10 — a blocked plan cannot be committed**
- Scenario: a request whose pinned content exceeds the budget.
- Expected behavior: `preview` reports blocked; `commit` rejects before any adapter is asked to
  serialize (FR-33).

**T-IMP-11 — one error shape for every stage**
- Scenario: parameterized over a discovery failure, a blocked plan, a validation defect, a commit
  refusal and a read-back mismatch.
- Expected behavior: each surfaces as an error stating what failed and what to do next. No raw stage
  exception escapes (FR-56).

**T-IMP-12 — role checks are enforced**
- Scenario: a request naming a target whose adapter declares only `["source"]`; and a listing where
  one adapter declares only `["target"]`.
- Expected behavior: the first is refused with the missing role named; the second's sessions never
  appear in the listing (FR-59).

### Boundary Tests

**T-IMP-13 — `list` and `preview` write nothing**
- Scenario: every home and the repository are checksummed around `list` and `preview`, across all
  nine directions.
- Expected behavior: identical every time (FR-16).

**T-IMP-14 — failures preserve existing target data**
- Scenario: parameterized over failures at serialize, validate, commit, read-back and switch.
- Expected behavior: every pre-existing path is byte-identical. Failures before commit add nothing;
  read-back and switch failures preserve the published session and report how to inspect or open it
  (FR-53).

**T-IMP-15 — every source file is byte-identical after every direction**
- Scenario: all nine directions; every file of every source home is checksummed before and after.
- Expected behavior: identical (NG-1, AC-4).

**T-IMP-16 — no stage can be reached around the pipeline**
- Scenario: a static check of what this module exports.
- Expected behavior: `ImportPipeline` and its request types only. `SessionLander` is not exported, so
  a host cannot land without previewing.

**T-IMP-17 — no state is carried between calls**
- Scenario: `preview` runs in one process; `commit` runs in a freshly constructed pipeline in
  another.
- Expected behavior: the commit succeeds and lands the same plan. No temporary file, cache or
  environment variable is involved.

**T-IMP-18 — an unknown target agent is refused**
- Scenario: a `TargetProfile` naming an agent with no adapter.
- Expected behavior: rejects with a message naming the agent (FR-56).

**T-IMP-19 — the whole pipeline runs with the network stubbed to fail**
- Scenario: all nine directions with every network call throwing.
- Expected behavior: all nine succeed (FR-8).

### Behavior Tests

**T-IMP-20 — the acceptance scenario, without a live agent**
- Scenario: a fixture Codex session holding file reads, edits and more than 20 turns; the target is
  Pi in the same repository; `list`, then `preview` on that session, then `commit`.
- Expected behavior: the landed session holds the visible conversation, the tool records with their
  outcome lines, the summaries, the first request and the last five turns — everything needed to
  continue without the user explaining anything again.

**T-IMP-21 — no result body reaches any target, in any direction**
- Scenario: all nine directions with a source session whose results contain
  `SECRET-BODY-CONTENT`.
- Expected behavior: the string appears in no committed file (FR-24, including the same-agent
  diagonal).

**T-IMP-22 — a very large session leaves room to work**
- Scenario: a source session several times the target window, imported at the default budget.
- Expected behavior: the landed session fits inside the budget, and the preview stated what was
  dropped (AC-5).

**T-IMP-23 — the nine directions cannot be told apart**
- Scenario: the preview line structure and the landing call sequence are captured for all nine
  directions.
- Expected behavior: identical structure and identical sequence in all nine. Only names differ
  (FR-6, FR-21, FR-60).

**T-IMP-24 — adding a fake fourth agent changes nothing here**
- Scenario: a fake adapter is registered and used as both source and target.
- Expected behavior: 16 directions now run, and no file in `src/import/` was edited (FR-57, AC-7).

The three tests below were moved here from modules that compose below this one. Each asserts a
property of a collaboration, and a module cannot own a test of collaborators that do not exist when
it is implemented.

**T-IMP-25 — the canonical vocabulary survives a round trip** _(moved from `src/session/`,
was T-SES-16)_

- Scenario: the reference fixture is passed through the rules, the preview, and a stub adapter's
  serialize.
- Expected behavior: no stage needs a field the vocabulary does not have, and no stage adds one.

**T-IMP-26 — swapping the estimator changes only the numbers** _(moved from `src/platform/tokens/`,
was T-TOK-13)_

- Scenario: the pipeline previews one session twice, with two different token estimators.
- Expected behavior: both produce a valid plan with the same structure; only the counts and the
  number of dropped turns differ. No consumer breaks. This is the switching-risk claim of the
  generic classification of `src/platform/tokens/`, tested where both halves exist.

**T-IMP-27 — a work profile is added by configuration alone** _(moved from `src/platform/config/`,
was T-CFG-15)_

- Scenario: `~/.claude-team` is added to `extraHomes` and a listing runs with stub adapters over
  fixture homes.
- Expected behavior: sessions of both Claude Code profiles appear in one listing (the FR-5 test),
  with no code change.
