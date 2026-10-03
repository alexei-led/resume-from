# Codex Adapter

**Path**: src/adapters/codex/ — the module's code is everything in this folder and its transparent subfolders
**Parent**: `src/adapters/`
**Submodules**: none (leaf)

## Purpose

This module is everything the tool knows about Codex: how Codex stores a thread, how to read one into
the neutral vocabulary, and how to write a new thread file that Codex's own picker lists and Codex's
own resume shows as native turns.

The measured facts of C-7 and C-8 are the reason this module exists in the shape it does. The
injection API fills the model history only and produces a thread the picker never shows; a new file
with `event_msg` entries produces a thread that is listed, resumable, and visible. This module writes
files. It does not inject.

## Functional Responsibilities

- Declare Codex's capabilities: both roles, a numbered list, create-only landing, host-output-only
  provenance, the default home, and the assumed context window.
- List the threads in a Codex home, with the fields the selection list needs (FR-11).
- Load one Codex thread into the canonical vocabulary, dropping every result body (FR-24) and every
  reasoning trace (FR-28, C-4).
- Serialize a canonical session into a new thread file with the metadata the picker needs and one
  `event_msg` entry per turn, so the imported turns are native Codex turns (FR-41, C-8).
- Validate that file before placement (FR-50).
- Read the committed thread back and report how many items Codex stored (FR-52) and whether Codex can
  open it (FR-51).
- Report that it cannot switch, so the landing returns the command the user runs instead (FR-45).

## Subdomain Classification

**Supporting, conformist to Codex.** No competitive advantage lives here, and no off-the-shelf
solution exists. Volatility is **high** and externally driven: C-7, C-8 and C-12 were measured
against codex-cli 0.146.0, 0.151.0-alpha and 0.159.2, and the rollout format is an internal detail.

C-6 raises the volatility further: Codex stores an injected item without validating it and drops an
unknown item type in silence. A format change would therefore fail quietly. That is the reason FR-52
exists, and the reason this module's `readBack` is not optional.

## Encapsulated Knowledge

- **Which entry type the user interface reads.** Codex builds the visible history from
  `event_msg` entries — `user_message` and `agent_message` — and a thread without them shows zero
  turns even when the model history is full (C-7). Codex has no verified durable entry that is both
  visible and excluded from resumed model context, so provenance is printed by the CLI only.
- **That there are two dialogue schemas, and one file can carry both.** The older schema is C-7's:
  `user_message`/`agent_message` `event_msg` entries carry the dialogue, and `response_item`
  `function_call`/`custom_tool_call` entries carry the calls. The newer schema is C-12's: every turn
  — user text, agent text and every tool-like action — is one `item_completed` `event_msg` whose
  `payload.item.type` says which kind of turn it is, and no `user_message`/`agent_message` entry
  exists at all. Every measured client writes the newer one, so a reader of the older names alone
  reads every current session as zero dialogue. The kinds this module carries are `UserMessage`,
  `AgentMessage`, `CommandExecution`, `FileChange`, `McpToolCall`, `Extension`, `ImageView` and
  `CollabAgentToolCall`; `Reasoning`, `ContextCompaction` and `SubAgentActivity` are understood and
  carry no turn. That client repeats the same actions in `response_item` at a coarser granularity —
  one outer call can run several commands — so those repeats are not read as turns. Dialogue is
  never gated by schema: a thread that a newer client resumed carries the dialogue of both eras, and
  the calls it made before its first item turn are the only record of that work, so they are read
  while the calls after it are not.
- **Which entry type the picker reads.** That `thread/list` shows a thread only when it has session
  metadata **and** a preview, and that the preview comes from an `event_msg` entry. A thread without
  one is invisible even though the file exists (C-7).
- **That the injection API is the wrong tool.** `thread/inject_items` is accepted, writes
  `response_item` entries, and produces a thread `thread/read` and `thread/resume` report as zero
  turns (C-7). This module writes a file instead (C-8).
- **That Codex validates nothing and fails silently.** An unknown item type is dropped without a
  message (C-6). Every guarantee about what Codex stored comes from reading the thread back, never
  from the absence of an error.
- **That reasoning cannot move.** Codex reasoning traces are encrypted and locked to the provider
  (C-4). This module does not attempt to carry them, and does not treat their absence as a defect.
- **Codex's default home**, its thread file location and naming, and how a non-default home is
  recognised (FR-2, FR-3).
- **That a rollout can be larger than one string, and a home can hold thousands of them.**
  C-13: one 635 MB rollout made the whole home unreadable with `RangeError: Invalid string length`
  while listing read every file whole, and a 2023-file home cost about 41 s. This module lists a home
  by streaming each file and building nothing but a row (C-13), and it caps a single line at 16 MB.
  Listing and loading classify entries with one function, so a row cannot disagree with the session
  it opens; the import path still reads a whole file, because it builds every turn from it.

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

The two blocks below are the normative home of the types they define.

```ts
/** The injectable seam that keeps serialize pure (no ambient process state). */
interface CodexSerializeDeps {
  /** Produces the new thread's UUID. Injected so two calls with the same deps are byte-equal. */
  newSessionId(): string;
}
```

```ts
/** Builds the Codex adapter. The only export of this module (FR-57). */
interface CodexAdapterFactory {
  create(overrides?: Partial<CodexSerializeDeps>): AgentAdapter;
}
```

## Integrations

- **Counterpart**: `src/adapters/`
- **Direction**: `src/adapters/codex/` implements the contract of `src/adapters/`
- **Strength**: contract
- **LCA / Rank / Distance**: LCA `src/adapters/`, rank 1, distance 1
- **Volatility**: high
- **Balanced?**: yes
- **Shared knowledge**: `AgentAdapter`, `AgentCapabilities` and the four capability enums,
  `AgentRuntime`, `ValidationDefect`, `SerializedSession`, `StoredSessionFacts`, `SwitchOutcome`, and
  `PendingFile` with `Bytes` — all restated in the Public Contract section above. `PendingFile` and
  `Bytes` reach this module through the port; their ultimate normative home is
  `src/platform/store/module.md`.

---

- **Counterpart**: `src/session/`
- **Direction**: `src/adapters/codex/` depends on `src/session/`
- **Strength**: model
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: high (core)
- **Balanced?**: yes — model coupling tolerates distance 2, and this is exactly 2
- **Shared knowledge**: the six restated session blocks in the Public Contract section above.

This module integrates with no host. Codex cannot host our picker and cannot move the user (C-1,
C-2), so there is no Codex counterpart to `src/host/pi-extension/`. The Codex shim is a prompt file
that calls the shared command binary, and it belongs to `src/host/cli/`.

## Change Vectors

Changes that require **only this module** to change:

- Codex changes its rollout format, its entry names, or the fields the picker reads.
- Codex starts validating injected items, or stops dropping unknown types in silence (C-6).
- Codex gains an API that can move the user, changing the declared landing level to
  `"create-and-switch"`.
- Codex gains a command surface that can host a picker, changing the declared selection level.
- Codex's default home moves, or its assumed context window changes.

None of these touch a rule, a preview, another adapter, or the host.

## Constraints and Invariants

- **Directory candidates come only from the session metadata header cwd.** Emit `repoPaths` as a singleton for a valid absolute cwd, otherwise `[]`; `repoPath = repoPaths[0] ?? null`. Preserve missing paths without filesystem lookup. Body entries, tool arguments, prose and storage-directory names never supply candidates. `startDirectory` is that same header cwd: a Codex thread records no earlier directory.

- **The required serialization context supplies `session_meta.cwd`.** Preserve its native absolute subdirectory and symlink spelling. Rollout placement remains under the target profile’s dated sessions directory; factory deps supply IDs, never cwd.

- **`serialize` writes `event_msg` entries.** A thread without them is invisible to `thread/list` and
  shows zero turns on resume (C-7). Writing only model-history items is the failure C-7 measured, and
  it must not be repeated.
- **`serialize` writes the session metadata the picker needs, including a preview.** C-7 showed a
  thread with a missing or empty preview does not appear in the default filter at all, while 25 of
  861 real threads did.
- **`serialize` never calls `thread/inject_items`.** The injection API is accepted, silent, and
  useless for this purpose (C-7). This module produces a file.
- **`response_item` entries are not written unless a read-back check proves they are needed.** C-8
  showed `event_msg` entries alone give a listed, resumable thread with the imported text in the
  answer. Anything beyond that is unverified and stays out.
- **A listing never holds a rollout whole, and never builds a turn.** `listCodexSessions` streams
  each file through `classifyEntry` — the same function `toCanonicalTurns` uses — and keeps only
  counts, the title of the first user message and the timestamps. A line longer than any Codex entry
  is damage: it is dropped, the file counts as truncated and reading continues. This is what keeps
  one huge rollout from failing a whole home (C-13).
- **One unreadable rollout is skipped; a home with nothing readable reports a failure.** A rollout
  that cannot be read (permissions, a broken mount) must not hide the sessions beside it, and a home
  that yielded nothing while failing must not look empty (C-13). A partial skip is silent today
  because the adapter port has no per-session failure channel; if it gains one, partial skips must be
  reported through it.
- **`readBack` is mandatory, not an optimisation.** Codex drops an unknown item type in silence
  (C-6), so the only evidence of what was stored is what can be read back (FR-52).
- **`readBack` reports `openable: false` rather than throwing** when the thread is absent from the
  listing. FR-51 is a fact the landing acts on, not an exception.
- **`switchTo` rejects with an error naming the missing capability.** Codex declares `"create-only"`
  (C-2), and the landing returns the command that opens the thread instead (FR-45).
- **Reasoning traces are never read and never written** (C-4, FR-28, NG-8). Their absence in a source
  thread is normal, not a defect.
- **Credential redaction applies to message and summary turn text, not only tool arguments.** A
  credential typed by the user as a chat message must not cross to a different model vendor. The
  reader applies `redactSensitiveText` to every `event_msg` message body and every `compacted`
  summary before pushing a turn, so no turn in the loaded session can carry a recognizable
  credential in its `text` field.
- **This module never writes a file.** `serialize` returns `PendingFile` values; `src/import/landing/`
  commits them (FR-49, FR-53).
- **This module never opens a Codex source thread for writing** (NG-1, AC-4).
- **This module never calls Codex's model, and never opens a network connection** (FR-8). Everything
  is read from and written to disk.
- **Tool names cross unchanged** (FR-27), and the effect of a structured item is read from the item
  kind itself, never guessed from a tool name (FR-26). The newer schema records no tool name: a
  `CommandExecution` is reported as `exec` and a `FileChange` as `apply_patch`, the names the same
  client uses for those actions in the older schema. A `McpToolCall` is named `server.tool`, the
  only name the record holds. An `Extension.kind` settles `read-only` only when the kind is a
  measured read (`web.search`); any other kind, and every `McpToolCall` and `CollabAgentToolCall`,
  stays `unknown`, because a kind that does not say cannot be made to say.
- **Repeated actions are dropped, dialogue never is** (C-12). A rollout that records turns as
  `item_completed` items repeats them coarsely in `response_item`, so those repeats are not read as
  turns. The dialogue of both eras is always read, and in a file that mixes them the older calls
  made before the first item turn are kept: they are not repeats of anything. Which calls to read is
  decided per file from the file itself (`legacyCallScope`).
- **A `FileChange` patch is a tool argument, not a result body.** FR-24 protects the result, and the
  older schema's `apply_patch` call already carries the patch text it was given; the newer schema's
  `FileChange` item is the same kind of argument, so its content crosses.
- **No result body is carried into `CanonicalTurn`** (FR-24). C-5 measured tool calls and outputs at
  about 49% of one Codex session file and reasoning at about 41%; dropping both is what makes an
  import fit a budget at all.
- **The provenance marker is printed by the host CLI, not written as a Codex conversation event**
  (FR-47, FR-48). Writing it as an `agent_message` would make metadata look like conversation and
  could send it back to the model on resume, so this module declares `provenance: "host-output-only"`.
- **Facts about Codex are verified against the installed version, never assumed.** The default home,
  the thread file location, and the exact entry names are confirmed by the boundary tests of this
  module against codex-cli 0.146.0 or later. C-4 to C-8 and C-12 are the only facts this design
  treats as established.

## Test Specification

This adapter runs the whole conformance suite of `src/adapters/` in addition to the tests below.
Tests marked **live** require an installed codex-cli and a throwaway home; they exist because C-6
says Codex fails silently, so nothing here may be inferred from the absence of an error.

### Unit Tests

**T-COD-1 — capabilities are as designed**
- Scenario: `capabilities()`.
- Expected behavior: agent `codex`; roles `source` and `target`; selection `numbered-list`; landing
  `create-only`; provenance `host-output-only`; an absolute default home; a positive window
  (C-1, C-2).

**T-COD-2 — a rollout file becomes canonical turns**
- Scenario: a fixture Codex thread with user messages, agent messages, tool calls, tool outputs and
  reasoning items.
- Expected behavior: canonical turns for the messages and the calls, in source order. Reasoning
  produces no turn (C-4, FR-28).

**T-COD-3 — tool outputs become one outcome line**
- Scenario: a Codex tool call with a large output.
- Expected behavior: `outcomeLine` is one line, `bodyDropped` is true, and no fragment of the output
  survives (FR-23, FR-24, FR-25).

**T-COD-4 — serialization writes event_msg entries without a provenance turn**
- Scenario: the reference session is serialized.
- Expected behavior: the file holds one `user_message` or `agent_message` `event_msg` entry per
  canonical turn, and no provenance text in any event. This is the difference between C-7's
  invisible thread and C-8's working one without turning metadata into conversation.

**T-COD-5 — serialization writes the metadata the picker needs**
- Scenario: the serialized output is inspected.
- Expected behavior: it holds session metadata and a non-empty preview taken from the first imported
  message. C-7 showed a thread without one does not appear in the default filter at all.

**T-COD-6 — no response_item entries are written**
- Scenario: the serialized output is inspected.
- Expected behavior: no `response_item` entry, unless a live read-back test has been added that
  proves one is needed. C-8 worked without them, and unverified additions stay out.

### Integration Contract Tests

**T-COD-7 — read-back is the only evidence**
- Scenario: a serialized session is committed, then `readBack` runs; and a second case where one
  entry is replaced by an unknown item type before the commit.
- Expected behavior: the first reports the expected `itemCount` and `openable` true; the second
  reports a lower `itemCount`, which the landing turns into an error (FR-52). The write itself
  reports success in both cases — C-6.

**T-COD-8 — a missing thread reports rather than throws**
- Scenario: `readBack` for a session ID that is not in the home.
- Expected behavior: `openable` false, `itemCount` 0. No exception (FR-51).

**T-COD-9 — the switch is refused with a named capability**
- Scenario: `switchTo` is called.
- Expected behavior: rejects with an error naming `create-only` and pointing at the handover
  (FR-43, FR-45, C-2).

### Boundary Tests

**T-COD-10 — the module never writes**
- Scenario: the Codex home is checksummed around `serialize` and `validate`.
- Expected behavior: identical (FR-49, FR-53).

**T-COD-11 — source threads are byte-identical**
- Scenario: a Codex thread is used as a source for an import into each of the shipped agents.
- Expected behavior: every file of the source home is byte-identical afterwards (NG-1, AC-4).

**T-COD-12 — the injection API is never called**
- Scenario: a static check of this module's calls, plus a runtime stub that fails on
  `thread/inject_items`.
- Expected behavior: no call site exists and no test triggers one. C-7 measured that path as useless
  for this purpose.

**T-COD-13 — encrypted reasoning is never read**
- Scenario: a source thread holding encrypted reasoning traces.
- Expected behavior: they produce no turn and appear nowhere in the canonical session (C-4, NG-8).

**T-COD-14 — a truncated or unknown-typed thread**
- Scenario: parameterized — a thread cut mid-entry; a thread with an unknown item type.
- Expected behavior: the first is reported unreadable; the second loads the entries it understands
  and reports that entries were skipped.

**T-COD-21 — the item_completed dialogue schema**
- Scenario: a rollout recorded with the newer schema (C-12) — `item_completed` user and agent
  messages, a `CommandExecution`, a `FileChange`, a `McpToolCall`, an `Extension`, an `ImageView`, a
  `CollabAgentToolCall`, a `SubAgentActivity`, a `Reasoning` and a `ContextCompaction`, with no
  `user_message`/`agent_message` entry and a duplicated `response_item` stream.
- Expected behavior: the messages and the tool-like items become canonical turns in source order;
  the command, server and extension result bodies are dropped while their arguments cross; the
  server call is named `server.tool` and the other-agent call carries the agents it addressed; the
  `FileChange` patch crosses as a tool argument and its paths reach `changedPaths`; reasoning,
  compaction and activity markers produce no turn and are not counted as skipped; the duplicated
  `response_item` stream is not read as a second set of turns; an extension kind that is not a
  measured read keeps effect `unknown`; and a rollout whose `item_completed` carries no dialogue is
  still read as the older schema.

**T-COD-22 — the selection list reads a rollout without holding it (C-13)**
- Scenario: a rollout whose message line exceeds the entry cap, and a home holding one readable
  rollout beside one that cannot be read (a `0o000` file, skipped under root).
- Expected behavior: the listing keeps the readable session, reports a home with nothing readable as
  a failure rather than an empty listing, drops the capped line while still reading the entries after
  it, and gives every row the same title and turn count as the session that row opens.

**T-COD-15 — live: the default home is what Codex uses**
- Scenario: an installed Codex writes a thread; the declared default home is compared with where it
  landed.
- Expected behavior: the same directory.

### Behavior Tests

**T-COD-16 — live: the C-8 scenario**
- Scenario: a canonical session with two turns is serialized into a throwaway Codex home and
  committed; then `thread/list` with the default filter, then `codex resume <id>`.
- Expected behavior: the thread is listed with the first imported message as its preview; the resume
  reports one turn with the imported text; the screen shows a native user turn and a native agent
  turn — exactly C-8's measured results, including the two example lines.

**T-COD-17 — live: the C-7 failure is not reproduced**
- Scenario: the committed thread from T-COD-16 is checked against every symptom C-7 listed.
- Expected behavior: it is in `thread/list`, its preview is not empty, and `thread/read` reports more
  than zero turns. Any one of these failing means the adapter has drifted back to the injection
  shape.

**T-COD-18 — Codex to Codex across homes**
- Scenario: a thread in one Codex home is imported into a second Codex home.
- Expected behavior: both exist afterwards, the target lists and opens, and no tool output body
  crossed (FR-4, FR-24).

**T-COD-19 — a large session still fits**
- Scenario: a real Codex session where, as C-5 measured, visible conversation is about 10% of the
  file, reasoning about 41%, and tool calls and outputs about 49%.
- Expected behavior: the import fits the budget and leaves room to work (AC-5), because the 90% that
  is reasoning and result bodies never crosses.

**T-COD-20 — serialize is deterministic and never reads the clock**
- Scenario (a): serialize is called twice with identical serialization context (`cwd`) and fixed deps (`newSessionId`).
  Expected: the two output buffers are byte-equal and the paths match.
- Scenario (b): serialization context `cwd` is supplied as `/fixed/repo`. Expected: `session_meta.cwd === "/fixed/repo"`,
  not whatever `process.cwd()` returns.
- Scenario (fallback): `marker.importedAt` is not a valid date string, but
  `session.provenance.updatedAt` is. Expected: the stamp in the rollout equals
  `provenance.updatedAt`, never the result of `new Date()`.
- Scenario (terminal fallback): `importedAt`, `updatedAt`, and `startedAt` are all unparsable.
  Expected: the stamp is the Unix epoch — serialize stays deterministic with no clock read.
