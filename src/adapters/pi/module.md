# Pi Adapter

**Path**: src/adapters/pi/ — the module's code is everything in this folder and its transparent subfolders
**Parent**: `src/adapters/`
**Submodules**: none (leaf)

## Purpose

This module is everything the tool knows about Pi: how Pi stores a session, how to read one into the
neutral vocabulary, how to write a new one Pi can open, what Pi can do that the other two agents
cannot, and how to move the user into the new session.

Pi is the only one of the shipped agents that can both open its own picker and move the user without a
second command (C-10). Those two abilities are declared here, and the rest of the system reads them
as capability data — it never learns Pi's name.

## Functional Responsibilities

- Declare Pi's capabilities: both roles, an interactive picker, create-and-switch landing, an
  out-of-context provenance entry, the default home, and the assumed context window.
- List the sessions in a Pi home, with the fields the selection list needs (FR-11).
- Load one Pi session into the canonical vocabulary: visible user messages, visible agent answers,
  compaction summaries, and tool calls reduced to records (FR-22, FR-23), with every result body
  dropped and marked (FR-24, FR-25).
- Serialize a canonical session into a new Pi session file: a session header and one message entry
  per turn, so the imported turns are native Pi turns (FR-41).
- Validate that file before placement, with the missing-field check that C-11 makes mandatory
  (FR-50).
- Read the committed session back and report how many items Pi stored (FR-52) and whether Pi can open
  it (FR-51).
- Move the user into the new session through Pi's command context (FR-44).

## Subdomain Classification

**Supporting, conformist to Pi.** No competitive advantage lives here, and no off-the-shelf solution
exists. Volatility is **high** and externally driven: C-10 and C-11 were measured against Pi 0.83.0,
and the file layout is an internal detail of an application that keeps moving.

That is why every fact this module knows about Pi stays inside this folder. When Pi changes, one
folder changes.

## Encapsulated Knowledge

- **Pi's session file layout.** That a session file carries a `session` header entry followed by
  `message` entries, and where those files live inside a Pi home (C-10).
- **The `usage` requirement.** That an assistant message without a `usage` object crashes Pi with
  `TypeError: Cannot read properties of undefined (reading 'input')` (C-11). This single fact is why
  `validate` exists at all, and it is knowledge no other module may hold.
- **Pi's command context.** That `ctx.switchSession(path, { withSession })` moves the user and
  returns an object with a `cancelled` flag, and that it was proven to work from a command handler
  (C-10).
- **The event-handler caution.** That the deleted design documents claimed a call from an event
  handler deadlocks, and that the claim was never tested. This module calls from a command handler
  only, and records why.
- **Pi's default home** and how a non-default home is recognised (FR-2, FR-3).
- **How Pi shows a marker the model does not read** (FR-47, FR-48).

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

<!-- contract: Bytes, PendingFile — restated from src/adapters/module.md -->
```ts
/** Raw file content. */
type Bytes = Buffer;

/** A file to create. Its path must not already exist (FR-49). */
interface PendingFile {
  absolutePath: string;
  bytes: Bytes;
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

The blocks below are the normative home of the types they define.

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

```ts
/** Builds the Pi adapter. The only export of this module (FR-57). */
interface PiAdapterFactory {
  create(): AgentAdapter;
}
```

## Integrations

- **Counterpart**: `src/adapters/`
- **Direction**: `src/adapters/pi/` implements the contract of `src/adapters/`
- **Strength**: contract
- **LCA / Rank / Distance**: LCA `src/adapters/`, rank 1, distance 1
- **Volatility**: high — the port grows when an agent needs a new capability axis
- **Balanced?**: yes
- **Shared knowledge**: `AgentAdapter`, `AgentCapabilities` and the four capability enums,
  `AgentRuntime`, `ValidationDefect`, `SerializedSession`, `StoredSessionFacts`, `SwitchOutcome`, and
  `PendingFile` with `Bytes` — all restated in the Public Contract section above. `PendingFile` and
  `Bytes` reach this module through the port; their ultimate normative home is
  `src/platform/store/module.md`.

---

- **Counterpart**: `src/session/`
- **Direction**: `src/adapters/pi/` depends on `src/session/`
- **Strength**: model — translating into the canonical vocabulary means holding it, not passing it
  through
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: high (core)
- **Balanced?**: yes — model coupling tolerates distance 2, and this is exactly 2
- **Shared knowledge**: the six restated session blocks in the Public Contract section above.

---

- **Counterpart**: `src/host/pi-extension/`
- **Direction**: `src/host/pi-extension/` depends on `src/adapters/pi/` — it supplies the
  `PiSwitchContext` this module needs
- **Strength**: contract
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: high — Pi's command API is an internal of a moving application
- **Balanced?**: yes
- **Shared knowledge**: `PiSwitchContext`, `PiSwitchOptions` and `PiSwitchResult`, whose normative
  home is this module. `src/host/pi-extension/` restates them.

## Change Vectors

Changes that require **only this module** to change:

- Pi changes its session file layout, its entry names, or its required fields.
- Pi's crash on a missing `usage` object is fixed upstream, and the check becomes a warning.
- Pi gains or loses the ability to switch sessions, changing the declared landing level.
- Pi's default home moves.
- Pi's assumed context window changes.
- Pi's command context grows a better way to show a marker outside the model context.

None of these touch a rule, a preview, another adapter, or the host.

## Constraints and Invariants

- **Directory candidates come only from the session header cwd.** Emit `repoPaths` as a singleton for a valid absolute cwd, otherwise `[]`; `repoPath = repoPaths[0] ?? null`. Preserve missing paths without filesystem lookup. Body entries, tool arguments, prose and encoded session-directory names never supply candidates. Valid header evidence is retained even for truncated or broken-graph sessions; these keep their unreadable title, zero turns and load refusal. `startDirectory` is that same header cwd, because a Pi session records the directory it opened in.

- **The required serialization context supplies header cwd and session-directory placement.** Preserve its native absolute subdirectory and symlink spelling; never substitute process or factory cwd.

- **`validate` must reject an assistant message without a `usage` object** (C-11, FR-50). Pi stops
  with `TypeError: Cannot read properties of undefined (reading 'input')` when the field is absent,
  and the failure happens after the file is already in the user's home. The check runs before
  placement, not after.
- **`validate` checks every message, not only the first**, and returns every defect it finds.
- **`switchTo` is called from a Pi command handler only** (C-10). The deleted design documents
  claimed a call from an event handler deadlocks; the claim was never tested, so this module only
  uses the path that was proven to work. `src/host/pi-extension/` is what guarantees the call site.
- **`switchTo` narrows `AgentRuntime` to `PiSwitchContext` and refuses anything else** with an error
  naming what was expected. It never inspects a runtime handle supplied for a different agent.
- **A cancelled switch is not a failure.** `PiSwitchResult.cancelled` becomes
  `SwitchOutcome.cancelled` and the session stays committed — the user opens it later with Pi's own
  command. Nothing is rolled back, because the session is valid.
- **This module never writes a file.** `serialize` returns `PendingFile` values.
  `src/import/landing/` commits them (FR-49, FR-53).
- **This module never opens a Pi source session for writing** (NG-1, AC-4).
- **This module never calls Pi's model, and never opens a network connection** (FR-8).
- **Tool names cross unchanged** (FR-27).
- **Only Pi's active branch crosses.** The last persisted entry is the active leaf; its `parentId`
  chain is resolved before turns, titles or changed paths are derived. A broken active graph makes
  the session unreadable instead of exposing sibling branches.
- **The latest active compaction defines model history.** Its summary is followed by `retainedTail`
  when present, otherwise by entries from `firstKeptEntryId`, and then by later active descendants.
- **No result body is carried into `CanonicalTurn`** (FR-24). `loadSession` sets
  `ToolCallRecord.bodyDropped` and writes one outcome line instead (FR-23, FR-25).
- **No hidden reasoning, system prompt, token, password, environment value or vendor state is read
  into the canonical model** (FR-28, NG-7, NG-8), even when Pi's file carries it.
- **Credential redaction applies to message and summary turn text, not only tool inputs.** A
  credential typed by the user as a chat message must not cross to a different model vendor. The
  parser applies `redactSensitiveText` to every non-empty turn text in the `push` helper, so no
  turn that reaches `CanonicalSession.turns` can carry a recognizable credential in its `text`
  field. The title derived from the first user message via `titleFromEntries` is also redacted
  before it flows into `SourceProvenance.title`.
- **A session file with an unreadable or unknown entry is skipped, not guessed.** An unparsable
  session is reported as unreadable in the listing rather than silently shortened.
- **The provenance marker is written as an entry Pi shows but does not send to the model** (FR-47,
  FR-48). If no such entry exists in the installed Pi, this module declares
  `provenance: "host-output-only"` instead of writing a marker into the model context.
- **Facts about Pi are verified against the installed version, never assumed.** The default home, the
  exact entry names, and the marker entry type are confirmed by the boundary tests of this module
  against Pi 0.83.0 or later. C-10 and C-11 are the only facts this design treats as established.

## Test Specification

This adapter runs the whole conformance suite of `src/adapters/` in addition to the tests below.
Tests marked **live** require an installed Pi and a throwaway session directory; they are the tests
that keep the design honest about facts nobody may assume.

### Unit Tests

**T-PI-1 — capabilities are as designed**
- Scenario: `capabilities()`.
- Expected behavior: agent `pi`; roles `source` and `target`; selection `interactive-picker`;
  landing `create-and-switch`; provenance `out-of-context-entry`; an absolute default home; a
  positive window (C-10).

**T-PI-2 — a session file becomes canonical turns**
- Scenario: a fixture Pi session file with a session header and message entries: a user message, an
  agent answer, a compaction summary, a read-only tool call, a mutating tool call.
- Expected behavior: five canonical turns with the right `role`, `kind` and `effect`, in source
  order, indexes 0 to 4.

**T-PI-3 — tool results become one outcome line**
- Scenario: a Pi tool call whose result is 400 lines of a file.
- Expected behavior: `outcomeLine` is one line, `bodyDropped` is true, and no line of the file
  appears anywhere in the turn (FR-23, FR-24, FR-25).

**T-PI-4 — serialization produces a header and one entry per turn**
- Scenario: the reference session is serialized.
- Expected behavior: the file holds a session header and one message entry per canonical turn, and
  `itemCount` equals the number of entries.

**T-PI-5 — every assistant message carries a usage object**
- Scenario: the serialized output of T-PI-4 is inspected.
- Expected behavior: every assistant entry has a `usage` object with the numeric fields Pi reads.
  This is the direct consequence of C-11.

### Integration Contract Tests

**T-PI-6 — validation rejects a missing usage object**
- Scenario: a serialized session in which one assistant message has its `usage` object removed.
- Expected behavior: `validate` returns a defect naming that entry. The import stops before
  placement — the explicit FR-50 test, and the reason C-11 exists.

**T-PI-7 — validation is not fooled by a partial usage object**
- Scenario: parameterized — `usage` present but empty, `usage` with a null `input`, `usage` with a
  string where a number belongs.
- Expected behavior: each is a defect. C-11's crash was `reading 'input'` of undefined; a present but
  useless object must fail the same way.

**T-PI-8 — read-back reports what Pi holds**
- Scenario: a session is committed into a throwaway Pi home, then `readBack` runs.
- Expected behavior: `itemCount` equals what `serialize` reported, and `openable` is true (FR-51,
  FR-52).

**T-PI-9 — the switch narrows the runtime handle**
- Scenario: parameterized — a valid `PiSwitchContext`; `null`; an object without `switchSession`; a
  handle intended for another agent.
- Expected behavior: the first switches; the other three reject with an error naming what was
  expected. No handle is inspected beyond the shape this module declares.

**T-PI-10 — a cancelled switch keeps the session**
- Scenario: `switchSession` resolves with `cancelled` true.
- Expected behavior: `SwitchOutcome` reports `switched` false and `cancelled` true; the committed
  session is not rolled back.

### Boundary Tests

**T-PI-11 — the module never writes**
- Scenario: the Pi home is checksummed around `serialize` and `validate`.
- Expected behavior: identical (FR-49, FR-53).

**T-PI-12 — source files are byte-identical**
- Scenario: a Pi session is used as a source for an import into each of the shipped agents.
- Expected behavior: every file of the source home is byte-identical afterwards (NG-1, AC-4).

**T-PI-13 — a truncated session file**
- Scenario: a Pi session file cut in the middle of an entry.
- Expected behavior: reported as unreadable in the listing; `loadSession` rejects with the file name.
  No shortened session is returned.

**T-PI-14 — an unknown entry type is skipped, and the skip is visible**
- Scenario: a session with an entry type this adapter does not know.
- Expected behavior: the entry does not become a turn, and the load reports that entries were
  skipped, so the preview can warn.

**T-PI-15 — live: the default home is what Pi uses**
- Scenario: an installed Pi writes a session; `capabilities().defaultHome` is compared with where it
  landed.
- Expected behavior: the same directory. This is the test that stops the default from being an
  assumption.

**T-PI-16 — live: the marker stays out of the model context**
- Scenario: a session is imported into a throwaway Pi home and opened.
- Expected behavior: the marker is on the screen, and it is not among the entries Pi sends to the
  model (FR-47, FR-48). If Pi has no such entry, the adapter must be declaring
  `provenance: "host-output-only"` — the test asserts the declaration matches reality.

### Behavior Tests

**T-PI-17 — live: the C-10 scenario**
- Scenario: a canonical session with two turns is serialized into a throwaway Pi home, committed, and
  `switchSession` is called from a command handler.
- Expected behavior: the switch returns not-cancelled, the imported turns are on the screen as native
  Pi turns, and the `Resumed session` marker appears — the result C-10 measured.

**T-PI-18 — live: the imported turns are native**
- Scenario: after T-PI-17, Pi's own scrollback and resume list are used.
- Expected behavior: both work on the imported turns (FR-41, AC-2).

**T-PI-19 — Pi to Pi across homes**
- Scenario: a session in one Pi home is imported into a second Pi home.
- Expected behavior: both sessions exist afterwards, the target opens, and no tool result body
  crossed (FR-4, FR-24's explicit same-agent clause).

**T-PI-20 — the switch is only ever called from a command handler**
- Scenario: a static check of the call sites of `switchTo` and of `PiSwitchContext.switchSession`
  across the tree.
- Expected behavior: the only caller is the command handler in `src/host/pi-extension/`. The untested
  deadlock claim of C-10 stays untested because the code never takes that path.
