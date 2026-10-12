# Host

**Path**: src/host/ — the module's code is everything in this folder and its transparent subfolders, excluding the submodule folders `cli/`, `pi-extension/`
**Parent**: `src/` (root)
**Submodules**: `cli/`, `pi-extension/`

## Purpose

This module is where `/resume-from` is typed, and it is the composition root of the whole system. It
owns the agent list — the one line FR-57 talks about — and it builds everything: the configuration,
the platform services, the adapters, and the pipeline they are wired into.

Two entry points sit under it because C-1 forces two mechanisms. Codex and Claude Code cannot host
our command, so they call a command binary. Pi can, and its switch needs a live command context
(C-10), so it loads an extension in-process. Both drive the same pipeline.

## Functional Responsibilities

- Hold the agent list: one entry per adapter, with its roles (FR-57, FR-59).
- Load configuration once, and build the platform services from it.
- Build a `TargetProfile` for the agent the user is in: the home, and the window from the adapter's
  declared default or the user's override (FR-3, FR-18).
- Wire one `ImportPipeline` per import: the finder, the rules, the preview builder and the lander,
  with the adapters and services they need.
- Choose the entry point by the target adapter's declared selection level (FR-43, FR-58): a picker
  when the agent can, a numbered list when it cannot.
- Refuse to start when the agent the user is in has no adapter, or has an adapter without the
  `target` role (FR-59).

## Subdomain Classification

**Supporting.** Wiring is not a competitive advantage. Volatility is **moderate**: the list changes
when an agent is added (FR-57), and the wiring changes when a stage gains a dependency. Neither is
frequent, and neither is hard.

The list being here rather than in `src/adapters/` is a structural decision, not a stylistic one:
see the Internal Design section.

## Encapsulated Knowledge

- **The agent list.** Which adapters exist. Nothing else in the tree holds this.
- **The construction order.** Configuration first, because the platform services and the target
  profile both depend on it; adapters next, because the profile needs their declared defaults; the
  pipeline last.
- **Which entry point runs.** That the selection level of the target adapter decides between the
  picker and the numbered list, and that no other module makes that choice.
- **How a target profile is assembled** from a declared default and a user override.
- **What "the agent I am in" means** for each entry point: the shim states it for the binary, and Pi
  states it for the extension.

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

<!-- contract: AgentRuntime — restated from src/import/module.md -->
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

<!-- contract: ConfigError, ConfigLoader — restated from src/platform/config/module.md -->
```ts
/** Why a configuration was rejected (FR-56). */
interface ConfigError {
  /** The setting at fault, for example "budgetShare". */
  field: string;
  /** What is wrong, and what the user can do next. */
  message: string;
}

/** Loads configuration and fills every missing field with its default. */
interface ConfigLoader {
  /** Rejects for invalid values or unreadable paths. A genuinely missing file is not an error. */
  load(): Promise<ImportConfig>;
}
```

<!-- contract: EstimatorFamily — restated from src/platform/tokens/module.md -->
```ts
/** Which counting rule to use. One value per model family the targets use. */
type EstimatorFamily = "claude" | "gpt" | "generic";
```

<!-- contract: TokenEstimator — restated from src/platform/tokens/module.md -->
```ts
/** Estimates how many tokens a piece of text costs. */
interface TokenEstimator {
  /** Deterministic: the same text always returns the same count. Never negative. */
  estimate(text: string): number;
}
```

<!-- contract: EstimatorFactory — restated from src/platform/tokens/module.md -->
```ts
/** Chooses an estimator. */
interface EstimatorFactory {
  /** Returns the estimator for a family. Falls back to "generic" for an unknown family. */
  forFamily(family: EstimatorFamily): TokenEstimator;
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

<!-- contract: CommitDistance — restated from src/platform/repo/module.md -->
```ts
/** How far the tree moved since the source session ran (FR-38). */
interface CommitDistance {
  /** False when the source commit is unknown, or absent from this repository. */
  known: boolean;
  /** Commits on HEAD that the source commit does not have. */
  ahead: number;
  /** Commits the source commit has that HEAD does not. */
  behind: number;
}
```

<!-- contract: RepoReader — restated from src/platform/repo/module.md -->
```ts
/** Reads git state. It never writes to the repository. */
interface RepoReader {
  /** Throws AbortError with the signal reason as cause when cancelled; performs no I/O. */
  checkCancellation(): void;
  identify(cwd: string): Promise<RepoIdentity>;
  /** Compares HEAD with a commit of a source session (FR-37). */
  distanceFrom(cwd: string, sourceCommit: string): Promise<CommitDistance>;
}
```

<!-- contract: SelectionInput — restated from src/import/module.md -->
```ts
/** How the user named the session to import (FR-12). */
type SelectionInput =
  | { by: "row"; row: number }
  | { by: "session-id"; id: SessionId }
  | { by: "file-path"; path: string };
```

<!-- contract: SelectionError, HomeFailure, Listing — restated from src/import/module.md -->
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

<!-- contract: WarningKind, PreviewWarning — restated from src/import/module.md -->
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

<!-- contract: PreviewReport — restated from src/import/module.md (subset: omits PreviewBuilder) -->
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
```

<!-- contract: HandoverInstruction, LandingResult — restated from src/import/module.md -->
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

<!-- contract: ListRequest, ImportRequest — restated from src/import/module.md -->
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

<!-- contract: ImportPipeline — restated from src/import/module.md -->
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

<!-- contract: CliInvocation, CliExit, CliOutcome, CliRunner — restated from src/host/cli/module.md -->
```ts
/** One invocation of the command binary (FR-10). */
interface CliInvocation {
  /** Arguments after the command name. */
  argv: string[];
  /** The directory the agent is running in. Used to find the repository (FR-13). */
  cwd: string;
  /** The agent the binary is running inside. The shim states it; the binary never guesses. */
  targetAgent: AgentId;
  /** The target home, when the shim knows it. Otherwise the adapter default is used (FR-3). */
  targetHome: HomePath | null;
}

/** 0 success, 1 refused, 2 error (FR-56). */
type CliExit = 0 | 1 | 2;

/** What one invocation produced. */
interface CliOutcome {
  stdout: string[];
  stderr: string[];
  exitCode: CliExit;
}

/** Runs one invocation of the command binary. */
interface CliRunner {
  run(invocation: CliInvocation, pipeline: ImportPipeline): Promise<CliOutcome>;
}
```

<!-- contract: PiSwitchOptions, PiSwitchResult, PiSwitchContext — restated from src/host/pi-extension/module.md -->
```ts
/** The options Pi's switchSession takes (C-10). */
interface PiSwitchOptions {
  /** Pi calls this once the new session is active. */
  withSession: () => void;
}

/** What Pi's switchSession returns (C-10). */
interface PiSwitchResult {
  cancelled: boolean;
}

/**
 * The part of Pi's command context this module uses. `src/host/pi-extension/`
 * supplies it as the AgentRuntime handle; nothing else may construct one (C-10).
 */
interface PiSwitchContext {
  switchSession(
    path: string,
    options: PiSwitchOptions,
  ): Promise<PiSwitchResult>;
}
```

<!-- contract: PiCommandContext, PiResumeFromCommand — restated from src/host/pi-extension/module.md -->
```ts
/** Pi's command context, as this module needs it. */
interface PiCommandContext extends PiSwitchContext {
  /** The directory Pi is running in. Used to find the repository (FR-13). */
  cwd: string;
  /** The Pi home the user is running, which is the import target (FR-1, FR-2). */
  home: HomePath;
}

/** The /resume-from command inside Pi (FR-7, FR-9, FR-44). */
interface PiResumeFromCommand {
  /**
   * Pi calls this when the user types /resume-from.
   * It is a command handler, which is the only call site C-10 proved safe for switchSession.
   */
  run(
    ctx: PiCommandContext,
    args: string[],
    pipeline: ImportPipeline,
  ): Promise<void>;
}
```

The blocks below are the normative home of the types they define.

```ts
/** The agent list. Adding an agent adds one line here (FR-57). */
interface AgentRegistry {
  /** Every adapter, in the order they were listed. */
  all(): AgentAdapter[];
  /** Rejects when the agent has no adapter (FR-56). */
  get(agent: AgentId): AgentAdapter;
  /** Adapters whose roles include "source" (FR-59). */
  sources(): AgentAdapter[];
  /** Adapters whose roles include "target" (FR-59). */
  targets(): AgentAdapter[];
}
```

```ts
/** Builds one pipeline for one target agent. */
interface HostWiring {
  registry(): AgentRegistry;
  pipelineFor(target: TargetProfile): Promise<ImportPipeline>;
}
```

```ts
/** Builds the target profile for the agent the user is in (FR-3, FR-18). */
interface TargetProfileBuilder {
  /**
   * Uses the adapter's declared default home when home is null (FR-3),
   * and the user's window override when there is one (FR-18).
   */
  build(
    agent: AgentId,
    home: HomePath | null,
    config: ImportConfig,
  ): TargetProfile;
}
```

## Integrations

- **Counterpart**: `src/import/`
- **Direction**: `src/host/` depends on `src/import/`
- **Strength**: contract
- **LCA / Rank / Distance**: LCA `src/`, rank 1, distance 1
- **Volatility**: moderate
- **Balanced?**: yes
- **Shared knowledge**: `ImportPipeline` and its request and result types, restated in the Public
  Contract section above.

---

- **Counterpart**: `src/adapters/`
- **Direction**: `src/host/` depends on `src/adapters/` — it holds every constructed adapter as an
  `AgentAdapter` and reads `AgentCapabilities` to choose the entry point and build the profile
- **Strength**: contract
- **LCA / Rank / Distance**: LCA `src/`, rank 1, distance 1
- **Volatility**: high — the port grows when an agent needs a new capability axis
- **Balanced?**: yes
- **Shared knowledge**: `AgentAdapter`, `AgentCapabilities` and the four capability enums,
  `AgentRuntime`, `ValidationDefect`, `SerializedSession`, `StoredSessionFacts` and `SwitchOutcome`,
  restated in the Public Contract section above. This is the port contract; the entry below is the
  separate dependency on the concrete implementations.

---

- **Counterpart**: `src/adapters/pi/`, `src/adapters/codex/`, `src/adapters/claude-code/`,
  `src/adapters/kimi-code/`
- **Direction**: `src/host/` depends on all of them — it constructs them for the list
- **Strength**: contract — it builds them through their factories and holds them as `AgentAdapter`
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2 for each
- **Volatility**: high on the adapter side
- **Balanced?**: yes — contract coupling tolerates any distance
- **Shared knowledge**: only each adapter's factory. The types come from the port, one entry above.
  This module knows the adapters exist and how to construct them; it knows nothing about any agent's
  format.

---

- **Counterpart**: `src/platform/config/`, `src/platform/tokens/`, `src/platform/store/`,
  `src/platform/repo/`
- **Direction**: `src/host/` depends on all four — it constructs the services
- **Strength**: contract
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2 for each
- **Volatility**: low
- **Balanced?**: yes
- **Shared knowledge**: `ConfigLoader` with `ImportConfig`, `EstimatorFactory` with `TokenEstimator`
  and `EstimatorFamily`, `FileCommitter` with `PendingFile`, and `RepoReader` with `RepoIdentity` and
  `CommitDistance` — all restated in the Public Contract section above.

---

- **Counterpart**: `src/session/`
- **Direction**: `src/host/` depends on `src/session/`
- **Strength**: model — it builds `TargetProfile` values and passes canonical types through
- **LCA / Rank / Distance**: LCA `src/`, rank 1, distance 1
- **Volatility**: high (core)
- **Balanced?**: yes
- **Shared knowledge**: the six restated session blocks in the Public Contract section above.

---

- **Counterpart**: `src/host/cli/`, `src/host/pi-extension/`
- **Direction**: this module builds and starts them
- **Strength**: contract
- **LCA / Rank / Distance**: LCA `src/host/`, rank 1, distance 1 for each
- **Volatility**: moderate
- **Balanced?**: yes
- **Shared knowledge**: `CliRunner` with its invocation and outcome types, and
  `PiResumeFromCommand` with `PiCommandContext` — restated in the Public Contract section above.

## Internal Design

### How the submodules compose

They do not call each other. Exactly one of them runs per process: the command binary when the user
is in Codex or Claude Code, the extension when the user is in Pi. This module decides which, by
reading the target adapter's declared `selection` level (FR-58) — never by name.

| Submodule       | Runs when                             | Landing it can reach     | Why it is separate                                     |
| --------------- | ------------------------------------- | ------------------------ | ------------------------------------------------------ |
| `cli/`          | `selection` is `"numbered-list"`      | create-only (C-2)        | Separate process; prints to standard output            |
| `pi-extension/` | `selection` is `"interactive-picker"` | create-and-switch (C-10) | In-process; holds the command context the switch needs |

### Construction order

1. **Configuration.** `ConfigLoader.load` runs once. Everything downstream reads from the result, and
   the defaults of FR-30 and FR-32 are applied here and nowhere else.
2. **Platform services.** The estimator factory, the repository reader, and the committer.
3. **Adapters.** Every adapter in the list is constructed. `capabilities()` is cheap and pure, so it
   can be called immediately.
4. **Target profile.** `TargetProfileBuilder.build` takes the agent the entry point is running in,
   the home it reported, and the configuration, and produces the profile (FR-3, FR-18).
5. **Pipeline.** `pipelineFor(target)` wires the finder, the rules, the preview builder and the
   lander with the services and the registry. It also chooses the estimator: the budget is a
   share of the _target_ window (FR-30), so the counting rule belongs to the target agent. No
   capability declares one, so each entry of the list names its own family beside its factory —
   which keeps adding an agent a one-line change rather than two.
6. **Entry point.** The picker or the command binary runs, driving the pipeline.

The two starts are not symmetrical, and that is the design rather than an omission. The binary is
handed an invocation and answers with an outcome, so a configuration error reaches the user as an
exit code (FR-56). The extension is handed the live command context C-10 proved the switch needs,
and answers by registering a command; it has no exit code, so it refuses by rejecting. Each start
reads the target adapter's declared `selection` level and refuses an agent the other one hosts.

### Why the agent list lives here

If `src/adapters/` held the list and the Pi entry point lived under `src/adapters/pi/`, the module
graph would cycle: list → `adapters/pi` → `import` → adapter port. Putting the list in the
composition root breaks the cycle, because nothing depends on the composition root.

It also keeps FR-57 literal. Adding an agent is:

1. a new folder under `src/adapters/`,
2. a new value in `AgentId`,
3. **one line here**.

### Why hosts are separated from adapters

Reading and writing an agent's session files is data work. Hosting `/resume-from` inside that agent
is process and user-interface work. They change for different reasons — a format change and an
extension API change are unrelated events — and C-1 forces two different host mechanisms for three
agents. Keeping them apart means an adapter carries no user-interface knowledge and a host carries no
format knowledge. `AgentCapabilities` is the only channel between them.

The single exception is `src/host/pi-extension/` depending on `src/adapters/pi/` for
`PiSwitchContext`. That is unavoidable: the runtime handle has a shape, and exactly one adapter
understands it. It is contract coupling at distance 2, and it carries nothing but the switch
signature.

## Change Vectors

Changes that require **only this module** to change:

- An agent is added to or removed from the list (FR-57, together with a new adapter folder).
- The construction order changes, for example configuration becomes lazy.
- A stage gains a dependency and the wiring passes it through.
- The target profile gains a source, for example reading the window from the agent's own settings.
- A third entry point is added for an agent that needs neither the binary nor an in-process
  extension.

## Constraints and Invariants

- **Destination is request-scoped, not host-scoped.** A long-lived host may serve different directories. Neither adapter factories nor repository reader construction supply an import cwd.

- **This module holds no rule of requirement sections C to I** (FR-60). It constructs and starts;
  it does not decide what crosses over.
- **The entry point is chosen by declared capability, never by agent name** (FR-43, FR-58). A
  `switch` on `AgentId` here would make FR-57's "one line" false.
- **Only adapters with the `target` role may be an import target, and only adapters with the
  `source` role are searched** (FR-59). A target without the role is refused with a message naming
  the missing role (FR-56).
- **An agent with no adapter is refused, not defaulted.** `AgentRegistry.get` rejects.
- **Configuration is loaded once per process.** Two stages reading different configurations would
  make the preview and the commit disagree.
- **The registry is the only list of adapters in the tree.** A second list anywhere is a defect.
- **The runtime handle is supplied only by the entry point of the same agent.** The command binary
  passes `null`; the Pi extension passes Pi's context. This module never constructs one.
- **This module never writes a file** and never reads a session. It builds the things that do.
- **A configuration error stops the command before anything is listed** (FR-56), with the field and
  what to change.

## Test Specification

### Unit Tests

**T-HOS-1 — the registry holds every adapter**
- Scenario: `registry().all()`.
- Expected behavior: one entry per folder under `src/adapters/`, and the set of declared agents
  equals the values of `AgentId`.

**T-HOS-2 — lookup by agent**
- Scenario: `get` for each of the shipped agents.
- Expected behavior: the matching adapter each time.

**T-HOS-3 — an unknown agent rejects**
- Scenario: `get` with an agent that has no adapter.
- Expected behavior: rejects with a message naming the agent (FR-56). It does not return a default.

**T-HOS-4 — roles filter the registry**
- Scenario: a fake adapter declaring `["source"]` and another declaring `["target"]` are added.
- Expected behavior: `sources()` holds the first and not the second; `targets()` the reverse
  (FR-59).

**T-HOS-5 — the default home is used when none is named**
- Scenario: `TargetProfileBuilder.build` with a null home.
- Expected behavior: the profile's home is the adapter's declared `defaultHome` (FR-3).

**T-HOS-6 — a named home wins over the default**
- Scenario: `build` with `~/.claude-team`.
- Expected behavior: the profile's home is the resolved absolute form of that path (FR-2).

**T-HOS-7 — a window override wins over the adapter default**
- Scenario: parameterized — no override; an override for this agent; an override for a different
  agent.
- Expected behavior: the adapter default in the first and third cases, the override in the second
  (FR-18).

### Integration Contract Tests

**T-HOS-8 — the construction order holds**
- Scenario: `createHost` then `pipelineFor`, with recording stubs.
- Expected behavior: configuration is loaded first, then the platform services, then the adapters,
  then the profile, then the pipeline.

**T-HOS-9 — configuration is loaded once**
- Scenario: `pipelineFor` is called three times on one host.
- Expected behavior: `ConfigLoader.load` ran once. Two stages reading different configurations would
  make the preview and the commit disagree.

**T-HOS-10 — the entry point follows the declared selection level**
- Scenario: parameterized — an adapter declaring `"interactive-picker"`; one declaring
  `"numbered-list"`; a fake fourth agent declaring `"numbered-list"`.
- Expected behavior: the picker in the first case, the command binary in the other two — chosen from
  the declaration, never from the name (FR-43, FR-58).

**T-HOS-11 — a target without the target role is refused**
- Scenario: `pipelineFor` a profile whose agent declares only `["source"]`.
- Expected behavior: rejects with the missing role named (FR-59, FR-56).

**T-HOS-12 — a configuration error stops before anything is listed**
- Scenario: `ConfigLoader.load` rejects with a `ConfigError`.
- Expected behavior: `createHost` rejects with the field and what to change; no adapter is
  constructed and no home is read (FR-56).

### Boundary Tests

**T-HOS-13 — there is exactly one agent list**
- Scenario: a repository-wide search for a collection of adapter constructions.
- Expected behavior: one, in this module. A second list anywhere is a defect.

**T-HOS-14 — no agent name appears outside the list**
- Scenario: a search for the literals `"pi"`, `"codex"` and `"claude-code"` across `src/`.
- Expected behavior: they appear only in `src/session/` (the `AgentId` values), in each adapter's own
  folder, and in the list here. A match inside `src/import/` is an FR-60 violation.

**T-HOS-15 — this module never writes and never reads a session**
- Scenario: a static check of its calls.
- Expected behavior: no file creation, no session parsing. It constructs the things that do.

**T-HOS-16 — the runtime handle is never constructed here**
- Scenario: a static check.
- Expected behavior: `AgentRuntime` values originate only in `src/host/pi-extension/` (Pi's context)
  and as `null` in `src/host/cli/`.

**T-HOS-17 — the module graph has no cycle**
- Scenario: the import graph over `src/`.
- Expected behavior: acyclic, and nothing imports `src/host/`. This is the property that putting the
  agent list here was chosen to guarantee.

### Behavior Tests

**T-HOS-18 — adding an agent costs one folder and one line**
- Scenario: a fake fourth agent is added: a new folder under `src/adapters/`, a new value in
  `AgentId`, one line here.
- Expected behavior: it reaches both roles and all 16 directions run. No file in `src/import/`,
  `src/host/cli/`, `src/host/pi-extension/` or `src/platform/` is edited (FR-57, AC-7).

**T-HOS-19 — the profile is right for every agent**
- Scenario: `createHost` then `pipelineFor` for each of the shipped agents, with and without
  configuration overrides.
- Expected behavior: each profile carries the right home and a positive window, so the budget line
  of FR-18 is correct in every case.

**T-HOS-20 — two homes of one agent are two targets**
- Scenario: `pipelineFor` for `claude-code` at `~/.claude`, then at `~/.claude-team`.
- Expected behavior: two distinct profiles; an import into one does not touch the other (FR-4,
  AC-6).
