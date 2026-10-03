# Kimi Code Adapter

**Path**: src/adapters/kimi-code/ — the module's code is everything in this folder and its transparent subfolders
**Parent**: `src/adapters/`
**Submodules**: none (leaf)

## Purpose

This module is everything the tool knows about Kimi Code: how it stores a session, how to read one
into the neutral vocabulary, and how to write a new session directory that Kimi Code's session
index lists and its own resume replays as native turns.

The measured facts of C-14 and C-15 are the reason this module exists in the shape it does. A Kimi
Code session is two files — a `state.json` the session index reads and a `wire.jsonl` the resume
replay folds into context — so this module produces two `PendingFile` values where the other
adapters produce one, and orders them so that an interrupted landing leaves nothing the agent
would list. The conversation shape it writes is the one Kimi Code's own kimi-cli migration writes
and its users resume every day; this module follows that path instead of inventing a leaner file.

## Functional Responsibilities

- Declare Kimi Code's capabilities: both roles, a numbered list, create-only landing, host-output-only
  provenance, the default home, and the assumed context window.
- List the sessions in a Kimi Code home, with the fields the selection list needs (FR-11).
- Load one session into the canonical vocabulary, dropping every result body (FR-24) and every
  think part (FR-28).
- Serialize a canonical session into a new session directory — a `wire.jsonl` of
  `context.append_message` records plus the `state.json` the index lists it by — so the imported
  turns are native Kimi Code turns.
- Validate both files before placement (FR-50).
- Read the committed session back and report how many items Kimi Code stored (FR-52) and whether
  Kimi Code can open it (FR-51).
- Report that it cannot switch, so the landing returns the command the user runs instead (FR-45).

## Subdomain Classification

**Supporting, conformist to Kimi Code.** No competitive advantage lives here, and no off-the-shelf
solution exists. Volatility is **high** and externally driven: C-14 and C-15 were measured against
the installed Kimi Code (wire protocol 1.5, session metadata version 2), and both the wire record
set and the metadata schema are internal details that will drift under the tool.

Kimi Code's session index silently skips a directory whose `state.json` is missing or malformed —
it does not report it. That is the reason FR-52 exists and the reason this module's `readBack` is
not optional: the only evidence of what was stored is what can be read back off the disk.

## Encapsulated Knowledge

- **Which record types carry the dialogue.** `context.append_message` records carry user,
  assistant and tool messages; `context.append_loop_event` records carry the same dialogue as
  `content.part`, `tool.call` and `tool.result` events; `context.apply_compaction` carries a
  compaction summary. Everything else — the prompt lifecycle, usage, permissions, token counting —
  is understood and carries no turn.
- **That the replay fold decides the reader's semantics.** `context.undo` removes back to a count
  of real user turns and stops at a compaction summary; `context.clear` empties the history; a
  `tool.result` with no open call is ignored. The reader mirrors the fold
  (`packages/agent-core-v2/src/agent/replayBuilder/fold.ts`), so the session this module lists is
  the session Kimi Code would resume.
- **Which conversation shape an import writes.** The message-based shape — `metadata`, one
  synthesized `turn.prompt` per conversation turn, `context.append_message` records, one
  `turn.ended` per turn with assistant content — is the one Kimi Code's kimi-cli migration writes
  and its users resume daily. A tool call crosses as the call's one-line outcome in an assistant
  text message, never as a replayable `toolCalls` structure (FR-26, NG-6).
- **That a session is two files, and the order is part of the format.** The landing commits
  `SerializedSession.files` one at a time, first to last. This module lists the `wire.jsonl`
  before the `state.json`: without `state.json` the directory is invisible to Kimi Code's session
  index and its resume command, so an interrupted landing leaves at most a file no agent reads —
  the same guarantee the store gives its one-file commits.
- **The workspace key derivation.** `encodeWorkDirKey` — the slug of the working directory's base
  name plus the first 12 hex characters of the SHA-256 of the normalized path — decides which
  `wd_*` directory a session belongs to, restated from Kimi Code's own workdir-slug so an import
  lands where Kimi Code itself would have put it.
- **That Kimi Code cannot host our picker and cannot move the user.** It is a TUI agent; nothing
  outside a running Kimi Code process can switch the user into a session. The landing prints the
  `kimi --resume <id>` command instead (FR-45).
- **Kimi Code's default home**, its sessions layout, and how a non-default home is recognised
  (FR-2, FR-3): the `KIMI_CODE_HOME` variable, exactly as Kimi Code reads it.
- **That the format records no git state.** A source session contributes `changedPaths` from its
  mutating tool calls (FR-36); `commit` and `branch` are always null.

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
interface KimiCodeSerializeDeps {
  /** Produces the new session's UUID, without the `session_` prefix. Injected so two calls with the same deps are byte-equal. */
  newSessionId(): string;
}

/** Builds the Kimi Code adapter. The only export of this module (FR-57). */
interface KimiCodeAdapterFactory {
  create(overrides?: Partial<KimiCodeSerializeDeps>): AgentAdapter;
}
```

## Integrations

- **Counterpart**: `src/adapters/`
- **Direction**: `src/adapters/kimi-code/` implements the contract of `src/adapters/`
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
- **Direction**: `src/adapters/kimi-code/` depends on `src/session/`
- **Strength**: model
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: high (core)
- **Balanced?**: yes — model coupling tolerates distance 2, and this is exactly 2
- **Shared knowledge**: the six restated session blocks in the Public Contract section above.

This module integrates with no host. Kimi Code cannot host our picker and cannot move the user, so
there is no Kimi Code counterpart to `src/host/pi-extension/`.

## Change Vectors

Changes that require **only this module** to change:

- Kimi Code changes its wire record set, its metadata schema, or the fields the session index reads.
- Kimi Code gains a command surface that can host a picker, changing the declared selection level.
- Kimi Code gains an API that can move the user, changing the declared landing level to
  `"create-and-switch"`.
- Kimi Code's default home moves, its workspace key derivation changes, or its assumed context
  window changes.

None of these touch a rule, a preview, another adapter, or the host.

## Constraints and Invariants

- **Directory candidates come only from the session's `state.json` `cwd`.** Emit `repoPaths` as a
  singleton for a valid absolute cwd, otherwise `[]`; `repoPath = repoPaths[0] ?? null`. Preserve
  missing paths without filesystem lookup. Wire records, tool arguments, prose and storage-directory
  names never supply candidates. `startDirectory` is that same cwd: the format records no earlier
  directory.

- **The required serialization context supplies `state.json` `cwd`.** Preserve its native absolute
  subdirectory and symlink spelling; it also decides the `wd_*` workspace directory through
  `encodeWorkDirKey`. Factory deps supply IDs, never cwd.

- **The files of one session are ordered wire first, state last.** The landing commits them one at
  a time; every prefix must be invisible to the agent, so an interrupted landing leaves at most a
  file no agent reads. Without `state.json`, Kimi Code's session index never lists the directory
  and `kimi --resume` cannot resolve it — the wire alone is inert.

- **`serialize` writes the message-based conversation shape.** One `metadata` record, one
  synthesized `turn.prompt` per conversation turn, `context.append_message` records, one
  `turn.ended` per turn with assistant content. This is the shape Kimi Code's own kimi-cli
  migration writes and its users resume; it is verified by Kimi Code itself, not reinvented here.
- **`serialize` writes tool calls as text.** A canonical tool-call turn crosses as one assistant
  text message holding the call's one-line outcome — never as a `toolCalls` structure the resume
  replay would hand back to the model as a live call (FR-26, NG-6), and never with the result
  body the outcome line replaced (FR-24).
- **The provenance marker is printed by the host, not written as a Kimi Code conversation
  message** (FR-47, FR-48). Writing it as a message would make imported metadata look like
  conversation and could send it back to the model on resume, so this module declares
  `provenance: "host-output-only"`.
- **The reader mirrors the replay fold.** `context.undo` removes back to the recorded count of
  real user turns and stops at a compaction summary; `context.clear` empties the history; a
  `tool.result` or `tool` message with no open call is ignored; a record type outside the known set
  is skipped and counted, never guessed at. The session this module lists is the session Kimi Code
  would resume.
- **Think parts and reasoning are never read and never written** (FR-28, NG-8). Their absence in a
  source session is normal, not a defect.
- **Credential redaction applies to message and summary turn text, not only tool arguments.** The
  reader applies `redactSensitiveText` to every non-empty turn text and `redactSensitiveArgumentsText`
  to every argument string before a turn reaches `CanonicalSession`, so no turn that crosses can
  carry a recognizable credential (FR-28).
- **This module never writes a file.** `serialize` returns `PendingFile` values; `src/import/landing/`
  commits them (FR-49, FR-53).
- **This module never opens a source file for writing** (NG-1, AC-4).
- **This module never calls Kimi Code's model, and never opens a network connection** (FR-8).
  Everything is read from and written to disk.
- **Tool names cross unchanged** (FR-27), inside the outcome line that names them.
- **`readBack` is mandatory, not an optimisation.** Kimi Code's session index silently skips a
  directory whose `state.json` is missing or malformed, so the only evidence of what was stored is
  what can be read back (FR-52).
- **`readBack` reports `openable: false` rather than throwing** when the session is absent from the
  home. FR-51 is a fact the landing acts on, not an exception.
- **`switchTo` rejects with an error naming the missing capability.** Kimi Code declares
  `"create-only"`, and the landing returns the `kimi --resume <id>` command that opens the session
  instead (FR-43, FR-45).
- **A listing never holds a wire file whole, and never builds a turn.** `listSessions` streams each
  `wire.jsonl` through `classifyRecord` — the same classifier the loader uses — and keeps only
  counts, the title of the first user message and the timestamps.

## Test Specification

This adapter runs the whole conformance suite of `src/adapters/` in addition to the tests below.
Tests marked **live** require an installed `kimi` and a throwaway home; they exist because the
session index silently skips malformed state, so nothing here may be inferred from the absence of
an error.

### Unit Tests

**T-KIMI-1 — capabilities are as designed**
- Scenario: `capabilities()`.
- Expected behavior: agent `kimi-code`; roles `source` and `target`; selection `numbered-list`;
  landing `create-only`; provenance `host-output-only`; an absolute default home; a positive
  window (C-14, C-15).

**T-KIMI-2 — a native wire file becomes canonical turns**
- Scenario: a fixture wire file in the native loop-event shape — a `metadata` record, a
  `profile.bind`, `turn.prompt`, user `context.append_message` records, `step.begin`/`step.end`
  pairs, `content.part` think and text parts, `tool.call`/`tool.result` pairs, a
  `context.apply_compaction`, a `context.undo` and a `turn.ended`.
- Expected behavior: canonical turns for the user messages, the agent text parts and the calls, in
  source order. Think parts produce no turn (FR-28); the undo removes what it removes; the
  compaction records a summary turn.

**T-KIMI-3 — tool results become one outcome line**
- Scenario: a `tool.call` with a 400-line result.
- Expected behavior: `outcomeLine` is one line naming the measured shape, `bodyDropped` is true,
  and no fragment of the output survives (FR-23, FR-24, FR-25).

**T-KIMI-4 — a broken tail stays visible**
- Scenario: a `tool.call` whose `tool.result` never arrived.
- Expected behavior: the call's turn keeps `resultRecorded: false` and an unanswered outcome line
  (FR-54).

**T-KIMI-5 — serialization writes the migration-proven shape**
- Scenario: the reference session is serialized.
- Expected behavior: the wire holds one `metadata` record, one `turn.prompt` per conversation
  turn, one `context.append_message` per non-empty turn, a `turn.ended` per turn with assistant
  content, and tool calls as assistant text holding the outcome line — no `toolCalls` structure
  anywhere in the file.

**T-KIMI-6 — serialization writes the metadata the index needs**
- Scenario: the serialized output is inspected.
- Expected behavior: `state.json` carries the metadata schema version, an absolute `cwd` from the
  serialization context, a title, `agents.main.homedir` pointing at the session's own
  `agents/main`, and the wire is listed before the state in `files`.

### Integration Contract Tests

**T-KIMI-7 — read-back is the only evidence**
- Scenario: a serialized session is committed, then `readBack` runs; and a second case where the
  `state.json` is replaced by a malformed document before the read-back.
- Expected behavior: the first reports the expected `itemCount` and `openable` true; the second
  reports `openable` false (FR-52). The index would have skipped the second in silence.

**T-KIMI-8 — a missing session reports rather than throws**
- Scenario: `readBack` for a session ID that is not in the home.
- Expected behavior: `openable` false, `itemCount` 0. No exception (FR-51).

**T-KIMI-9 — the switch is refused with a named capability**
- Scenario: `switchTo` is called.
- Expected behavior: rejects with an error naming `create-only` and spelling the
  `kimi --resume <id>` handover command (FR-43, FR-45).

### Boundary Tests

**T-KIMI-10 — the module never writes**
- Scenario: the home is checksummed around `serialize` and `validate`.
- Expected behavior: identical (FR-49, FR-53).

**T-KIMI-11 — source sessions are byte-identical**
- Scenario: a Kimi Code session is a source for an import into every agent.
- Expected behavior: every file of the source home is byte-identical afterwards (NG-1, AC-4).

**T-KIMI-12 — think parts are never read**
- Scenario: a source wire file holding `content.part` think parts.
- Expected behavior: they produce no turn and appear nowhere in the canonical session (FR-28,
  NG-8).

**T-KIMI-13 — a truncated or unknown-typed wire file**
- Scenario: parameterized — a wire file cut mid-record; a wire file with an unknown record type.
- Expected behavior: the first is reported unreadable; the second loads the records it understands
  and reports that records were skipped.

### Behavior Tests

**T-KIMI-14 — Kimi Code to Kimi Code across homes**
- Scenario: a session in one Kimi Code home is imported into a second Kimi Code home.
- Expected behavior: both exist afterwards, the target lists and opens, and no tool output body
  crossed (FR-4, FR-24).

**T-KIMI-15 — serialize is deterministic and never reads the clock**
- Scenario (a): serialize is called twice with identical serialization context (`cwd`) and fixed
  deps (`newSessionId`).
  Expected: the two outputs are byte-equal and the paths match.
- Scenario (b): the serialization context cwd decides the workspace directory.
- Scenario (fallback): `marker.importedAt` and every provenance stamp are unparsable.
  Expected: the stamps are the Unix epoch — serialize stays deterministic with no clock read.

**T-KIMI-16 — live: the default home is what Kimi Code uses**
- Scenario: an installed Kimi Code writes a session; the declared default home is compared with
  where it landed.
- Expected behavior: the same directory.
