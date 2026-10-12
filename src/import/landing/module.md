# Session Landing

**Path**: src/import/landing/ — the module's code is everything in this folder and its transparent subfolders
**Parent**: `src/import/`
**Submodules**: none (leaf)

## Purpose

This module turns a confirmed plan into a real session in the target home, and it is the only place
in the system where a write happens. It asks the target adapter to serialize the plan, checks the
result before placing it, commits the files atomically, reads the session back to see what the target
actually stored, and then either moves the user in or tells them the command that opens it.

Requirement section H is entirely this module's responsibility, and section I's "nothing remains" is
its failure contract. C-3 is the reason both are enforced here rather than in each adapter: a bad
write can damage the real sessions of the user, so the guard must exist once and cover every agent —
including agents that do not exist yet.

## Functional Responsibilities

- Build the provenance marker from the plan: source agent, source home, source session ID, the time
  of the import, and what was dropped (FR-47).
- Ask the target adapter to serialize the plan into its own format (FR-40, FR-41).
- Validate the serialized session before it reaches the target home (FR-50).
- Commit the adapter's file output one file at a time, add-only and atomically published per file (FR-49, FR-53).
- Read the session back and compare the number of items sent with the number stored (FR-52), and
  check the target can open it (FR-51).
- If reconciliation or openability fails after commit, preserve the published paths and report them
  exactly for manual inspection (FR-53).
- Use the highest landing level the adapter declares (FR-43): move the user in when the adapter can
  (FR-44), otherwise return the session ID and the command that opens it (FR-45).
- Leave the target idle: no message is sent, no tool is run (FR-46).

## Subdomain Classification

**Supporting, with core-level risk.** Placing a file is not a competitive advantage, but this is
where the tool can do damage. Volatility is **low to moderate**: the sequence is fixed by
requirements and changes only when a capability level is added.

The low volatility is deliberate and worth protecting. Everything version-specific — how a session is
serialized, what "valid" means for an agent, how to switch — is delegated to the adapter through the
port. This module holds the order and the guarantees, not the formats.

## Encapsulated Knowledge

- **The landing sequence.** Serialize, validate, commit, read back, reconcile, switch or hand over —
  in that order, with created-path reporting attached to every failure after commit.
- **Post-commit preservation.** A failed reconciliation keeps and reports the published paths because
  pathname rollback could delete a concurrent replacement.
- **The provenance marker composition.** Which facts go into it and in what order (FR-47).
- **The handover command.** That when an adapter cannot switch, the user is told the session ID and
  the exact command (FR-45).
- **That the target must stay idle** after landing (FR-46). Nothing here sends a message or triggers
  a tool.

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

<!-- contract: AgentAdapter — restated from src/adapters/module.md (subset: omits the source-role methods listSessions and loadSession) -->
```ts
/** What every agent adapter provides. One folder per agent implements it (FR-57). */
interface AgentAdapter {
  capabilities(): AgentCapabilities;

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

The blocks below are the normative home of the types they define.

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

## Integrations

- **Counterpart**: `src/import/transfer/`
- **Direction**: `src/import/landing/` depends on `src/import/transfer/`
- **Strength**: model — `TransferPlan` embeds canonical turns and the pin and drop records
- **LCA / Rank / Distance**: LCA `src/import/`, rank 1, distance 1
- **Volatility**: high (core)
- **Balanced?**: yes — model coupling at distance 1
- **Shared knowledge**: the restated `TransferPlan`, `TurnPin`, `TurnDrop`, `PinReason` and
  `DropReason` blocks in the Public Contract section above.

---

- **Counterpart**: `src/session/`
- **Direction**: `src/import/landing/` depends on `src/session/`
- **Strength**: model — it builds a `ProvenanceMarker` and passes canonical turns to the adapter
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: high (core)
- **Balanced?**: yes — model coupling tolerates distance 2, and this is exactly 2
- **Shared knowledge**: the five restated session blocks in the Public Contract section above.

---

- **Counterpart**: `src/adapters/`
- **Direction**: `src/import/landing/` depends on `src/adapters/`
- **Strength**: contract — it calls the target half of the port and reads capability data
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: high on the adapter side
- **Balanced?**: yes — contract coupling tolerates any distance
- **Shared knowledge**: the restated `AgentCapabilities`, `AgentRuntime`, `ValidationDefect`,
  `SerializedSession`, `StoredSessionFacts`, `SwitchOutcome` blocks and the target-role subset of
  `AgentAdapter` in the Public Contract section above. This module never touches a concrete adapter
  folder — the adapter arrives as an argument.

---

- **Counterpart**: `src/platform/store/`
- **Direction**: `src/import/landing/` depends on `src/platform/store/`
- **Strength**: contract
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: low
- **Balanced?**: yes
- **Shared knowledge**: the restated `Bytes`, `PendingFile`, `CommitRefusal`, `CommitHandle`,
  `CommitError` and `FileCommitter` blocks in the Public Contract section above. This is the only
  module in the tree that calls a committer.

## Change Vectors

Changes that require **only this module** to change:

- A third landing level is added — for example "create and offer to switch".
- The post-commit preservation message changes.
- The reconciliation becomes stricter, for example comparing per-item checksums rather than counts.
- The provenance marker gains a fact, for example the budget that was applied.
- The handover message changes.

None of these touch a rule, a preview, or an adapter.

## Constraints and Invariants

- **Serialization context is required.** Pass its host-supplied absolute cwd unchanged to the target writer, including native symlink and subdirectory spelling. Neither source provenance nor process/factory cwd supplies the destination.

- **Nothing that existed before landing is ever rewritten or removed** (FR-49). Every path in a
  `SerializedSession` is new and the committer refuses if any exists.
- **Validation runs before placement** (FR-50). A missing field must never reach the agent — C-11
  showed one crashing Pi outright. A non-empty `ValidationDefect[]` stops the landing with stage
  `"validate"` and nothing is written.
- **A failed landing after commit preserves and reports the published paths** (FR-53). Safe automatic
  pathname removal is not portable, so `LandingError.rolledBack` is always false and the message lists
  exact `createdPaths` for manual inspection.
- **Read-back must identify the exact serialized session.** A different session ID is a failed
  reconciliation even when its item count matches.
- **`itemsSent` and `itemsStored` are compared, and a difference is an error** (FR-52). C-6 states
  Codex drops an unknown item type in silence, so a successful write is not evidence of a stored
  session.
- **The highest declared landing level is used** (FR-43), read from `AgentCapabilities.landing`. This
  module never branches on `AgentId`.
- **A cancelled switch is not a failure.** The session stays committed and `LandingResult.switched`
  is false; the user opens it later with the native command. Rolling back a valid session because the
  user declined a move would destroy work.
- **When the adapter cannot switch, the result carries the session ID and the exact command**
  (FR-45). A landing that ends with "create-only" and no `handover` is incomplete.
- **After landing, nothing is sent and nothing is run** (FR-46). This module returns; it does not
  prompt the target, and it does not trigger a tool.
- **The marker is built here and passed to the adapter** (FR-47). Whether the marker can live outside
  the model context is the adapter's declared capability (FR-48); when it cannot, the marker is
  returned in `LandingResult` for the host to print instead of being written into the context.
- **`importedAt` is passed in, not read from a clock.** This module has no clock, so a landing is
  reproducible in tests.
- **A plan with a non-null `blockedReason` is refused before serialization** (FR-33). The preview
  should already have stopped it; this is the second gate.
- **One session serializes to one ordered list of files, committed one at a time.** Zero files is
  refused before validation or placement: it produces vacuous success and confusing read-back
  results. Each file goes through the store separately, so the store's one-file atomicity stays
  untouched; the adapter must order its files so that no prefix forms a session the target agent
  would list or open, and an interrupted multi-file landing then leaves at most files no agent
  reads — the same guarantee the store gives its temporary names. Kimi Code's adapter lists its
  `wire.jsonl` before its `state.json` for that reason: without `state.json` the directory is
  invisible to Kimi Code's session index and its resume command.
- **Errors name the stage and the next step** (FR-56). "Write failed" alone is not an acceptable
  message.

## Test Specification

Tests use stub adapters and a real committer over a temporary directory, so the add-only and
all-or-nothing guarantees are exercised against a real filesystem without any agent installed.

### Unit Tests

**T-LAN-1 — the stages run in order**
- Scenario: a recording stub adapter and committer.
- Expected behavior: the call order is `serialize`, `validate`, `commit`, `readBack`, then `switchTo`
  when the capability allows it. No stage is skipped and none runs twice.

**T-LAN-2 — the marker carries every fact FR-47 requires**
- Scenario: a plan from a Codex session with 12 dropped turns.
- Expected behavior: the marker states the source agent, the source home, the source session ID, the
  import time, and one line about what was dropped.

**T-LAN-3 — the import time is the value passed in**
- Scenario: `land` is called with a fixed `importedAt`.
- Expected behavior: `marker.importedAt` is that value. This module reads no clock, so a landing is
  reproducible.

**T-LAN-4 — a create-and-switch adapter switches**
- Scenario: an adapter declaring `"create-and-switch"`, whose `switchTo` succeeds.
- Expected behavior: `switched` true, `handover` null (FR-43, FR-44).

**T-LAN-5 — a create-only adapter hands over**
- Scenario: an adapter declaring `"create-only"`.
- Expected behavior: `switchTo` is never called; `switched` false; `handover` carries the session ID
  and the exact command (FR-43, FR-45).

**T-LAN-6 — item counts are reported**
- Scenario: a successful landing of a session with 24 items.
- Expected behavior: `itemsSent` and `itemsStored` are both 24 (FR-52).

### Integration Contract Tests

**T-LAN-7 — a validation defect stops before any write**
- Scenario: a stub adapter whose `validate` returns two defects; the target directory is checksummed
  before and after.
- Expected behavior: rejects with stage `"validate"` and both defects; the directory is unchanged;
  `rolledBack` is false because nothing was committed (FR-50).

**T-LAN-8 — a read-back mismatch preserves and reports the session**
- Scenario: `readBack` reports 23 items where 24 were sent, or reports a different session ID.
- Expected behavior: rejects with stage `"read-back"`, `rolledBack` false, preserves the committed
  file, and reports its exact path for inspection (FR-52, FR-53).

**T-LAN-9 — a session the target cannot open is preserved and reported**
- Scenario: `readBack` reports matching counts but `openable` false.
- Expected behavior: rejects with `rolledBack` false, preserves the committed file, and names both the
  openability failure and the exact path (FR-51).

**T-LAN-10 — a commit refusal is reported, not worked around**
- Scenario: the committer rejects with `"path-exists"`.
- Expected behavior: rejects with stage `"commit"` and a message naming the path. No retry with a
  different name, and no overwrite (FR-49, FR-56).

**T-LAN-11 — every error names the stage and the next step**
- Scenario: parameterized over failures in all five stages.
- Expected behavior: each `LandingError` carries the right `stage`, a message stating what failed and
  what the user can do, and `rolledBack` false (FR-56).

### Boundary Tests

**T-LAN-12 — a blocked plan is refused before serialization**
- Scenario: a plan whose `blockedReason` is set.
- Expected behavior: rejects; `serialize` is never called (FR-33).

**T-LAN-13 — the target home is never damaged**
- Scenario: a target directory holding 50 files is checksummed; every failure case of T-LAN-11 runs;
  it is checksummed again after each.
- Expected behavior: every pre-existing path is identical. Failures before commit add nothing;
  failures after commit preserve and report the newly published file (FR-49, FR-53).

**T-LAN-14 — a cancelled switch keeps the session**
- Scenario: `switchTo` resolves with `cancelled` true.
- Expected behavior: `switched` false, the committed files remain, and `handover` gives
  the command to open the session later. A valid session is never destroyed because the user declined
  a move.

**T-LAN-15 — a switch failure after a valid commit**
- Scenario: `switchTo` rejects with an error.
- Expected behavior: rejects with stage `"switch"` and `rolledBack` false — the session is valid and
  is kept — and the message states the command that opens it.

**T-LAN-16 — a post-commit failure reports preserved paths**
- Scenario: the read-back mismatch of T-LAN-8 after a successful commit.
- Expected behavior: the landing rejects with `rolledBack` false and names both the mismatch and the
  exact preserved paths. Silence here would leave a partial session the user cannot find.

**T-LAN-17 — no clock, no network**
- Scenario: the suite runs with the clock and the network stubbed to throw.
- Expected behavior: every test passes.

**T-LAN-18 — no branch on the agent**
- Scenario: the same plan landed through four stub adapters that differ only in declared
  capabilities, including a fake fourth agent.
- Expected behavior: behaviour follows the capability in every case. There is no agent name in this
  module's code (FR-60).

### Behavior Tests

**T-LAN-19 — nothing is sent after landing**
- Scenario: a successful landing through a recording stub.
- Expected behavior: no message is sent and no tool is triggered. The prompt is left empty (FR-46).

**T-LAN-20 — the marker costs no tokens**
- Scenario: a landing into an adapter declaring `"out-of-context-entry"`.
- Expected behavior: the marker is written where the agent shows it and not where the model reads it
  (FR-48). For an adapter declaring `"host-output-only"`, the marker is returned in `LandingResult`
  and nothing is written into the context.

**T-LAN-21 — an interrupted landing leaves nothing**
- Scenario: the process is killed between the commit and the read-back.
- Expected behavior: on the next run, the target holds either the complete session or nothing — never
  a partial session. A stub adapter that returns multiple files is refused before placement (FR-53).

**T-LAN-22 — a create-only landing tells the user exactly what to type**
- Scenario: a landing into Claude Code.
- Expected behavior: `handover.command` is the native command with the real session ID substituted,
  ready to copy (FR-45).
