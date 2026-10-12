# Claude Code Adapter

**Path**: src/adapters/claude-code/ — the module's code is everything in this folder and its transparent subfolders
**Parent**: `src/adapters/`
**Submodules**: none (leaf)

## Purpose

This module is everything the tool knows about Claude Code: how it stores a session, how to read one
into the neutral vocabulary, and how to write a new session file that Claude Code's own resume list
shows and its own resume command opens as native turns.

C-3 makes this the most dangerous target in the system: the session store is an internal application
database with ten entry types, and a bad write can damage the real sessions of the user. C-9 makes it
tractable: a new file with two entry types — one `user`, one `assistant` — was listed and resumed
correctly. This module writes exactly that, and only into paths that do not exist.

## Functional Responsibilities

- Declare Claude Code's capabilities: both roles, a numbered list, create-only landing, an
  out-of-context provenance entry, the default home, and the assumed context window.
- List the sessions in a Claude Code home, with the fields the selection list needs (FR-11), across
  the profile directories a home can hold (FR-2, FR-4).
- Load one session into the canonical vocabulary, dropping every result body (FR-24) and every
  excluded item (FR-28).
- Serialize a canonical session into a new session file, using the smallest set of entry types that
  works (C-9), so the imported turns are native turns (FR-41).
- Validate that file before placement (FR-50).
- Read the committed session back and report how many items were stored (FR-52) and whether the
  native resume list shows it (FR-51).
- Report that it cannot switch, so the landing returns the command the user runs instead (FR-45).

## Subdomain Classification

**Supporting, conformist to Claude Code.** No competitive advantage lives here, and no off-the-shelf
solution exists. Volatility is **high** and externally driven: C-9 was measured against Claude Code
2.1.220, against a throwaway configuration directory holding one session.

The risk profile is higher than the other two adapters. C-9 explicitly states that its test does not
show a write into the real store of the user is safe, and that C-3 still holds. This module therefore
treats every guarantee as conditional on the add-only commit path and on reading the result back.

## Encapsulated Knowledge

- **Which entry types are enough.** That `user` and `assistant` entries produce a session the native
  resume list shows with time, branch and size, and that `claude --resume <id>` puts the turns on the
  screen (C-9). Eight of the ten entry types of C-3 were not necessary, and this module does not
  write them.
- **The danger of the store.** That the store is an internal application database with ten entry
  types and a bad write can damage real sessions (C-3), and that C-9's throwaway-directory test does
  not lift that risk.
- **Where sessions live inside a home**, how a home is laid out per project, and how a non-default
  home such as `~/.claude-team` is recognised (FR-2, FR-4).
- **How a session is keyed to a repository**, so that FR-13's filter can work and so a session written
  for one repository never appears under another.
- **How Claude Code shows a marker the model does not read** (FR-47, FR-48).

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

The block below is the normative home of the type it defines.

```ts
/** Builds the Claude Code adapter. The only export of this module (FR-57). */
interface ClaudeCodeAdapterFactory {
  create(): AgentAdapter;
}
```

## Integrations

- **Counterpart**: `src/adapters/`
- **Direction**: `src/adapters/claude-code/` implements the contract of `src/adapters/`
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
- **Direction**: `src/adapters/claude-code/` depends on `src/session/`
- **Strength**: model
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: high (core)
- **Balanced?**: yes — model coupling tolerates distance 2, and this is exactly 2
- **Shared knowledge**: the six restated session blocks in the Public Contract section above.

This module integrates with no host. Claude Code cannot host our picker and cannot move the user
(C-1, C-2), so the Claude Code shim is a slash-command file that calls the shared command binary, and
it belongs to `src/host/cli/`.

## Change Vectors

Changes that require **only this module** to change:

- Claude Code changes its session file layout or the fields the resume list reads.
- The two entry types of C-9 stop being enough and a third becomes necessary.
- Claude Code gains an API that can move the user, changing the declared landing level.
- The per-project layout inside a home changes.
- The default home moves, or the assumed context window changes.

None of these touch a rule, a preview, another adapter, or the host.

## Constraints and Invariants

- **Directory metadata comes only from the active main ancestry.** Resolve the active parent path and exclude sidechains before extracting cwd. Emit each distinct absolute cwd in first-appearance order as `repoPaths`, with `repoPath = repoPaths[0] ?? null`. Preserve missing paths and unrelated repository candidates; ignore relative/invalid cwd, discarded ancestry, prose, tool arguments and encoded project directory names. Extraction does not decide repository membership.
- **The start directory comes from the whole file, not the active chain.** `startDirectory` is the earliest non-sidechain absolute `cwd` in the file, which is what Claude's own project directory is derived from. It is deliberately not merged into `repoPaths`: a session resumed in a subdirectory keeps the directory it started in, and its active directories stay exactly the evidence they were (issue #5).

- **The required serialization context supplies destination cwd.** Preserve that native absolute path in transcript cwd and encoded project placement, including subdirectories and symlink spelling; no process or factory cwd fallback is allowed.

- **Only new paths are ever produced.** C-3 is the reason: the store is an internal application
  database and a bad write can damage the real sessions of the user. `serialize` mints a session ID
  that does not exist in the target home, and `src/import/landing/` refuses the commit if any path
  exists (FR-49).
- **Nothing that exists is opened for writing, in any circumstance** — not an index, not a
  configuration file, not a project record. If Claude Code needs a session to be registered somewhere
  before it appears, and that registration would modify an existing file, this module declares the
  limitation rather than performing the write. AC-4 and FR-49 outrank convenience.
- **Verified inert project records do not block an add-only import.** Session sidecar directories,
  `memory/`, `sessions-index.json`, and `.session-aliases` are recognized but never modified.
- **`serialize` writes the smallest set of entry types that works.** C-9 proved `user` and
  `assistant` are enough; the other eight of C-3 are not written. Fewer entry types means fewer ways
  to corrupt the store.
- **`validate` runs before placement and returns every defect** (FR-50).
- **`readBack` reports what the store holds** (FR-52) and whether the native resume list shows the
  session (FR-51). C-9's own caution — a throwaway directory with one session does not prove a real
  store is safe — is why this check is not optional. Openability requires matching embedded session
  identity, valid turn envelopes, and an intact active parent graph.
- **`switchTo` rejects with an error naming the missing capability.** Claude Code declares
  `"create-only"` (C-2), and the landing returns `claude --resume <id>` instead (FR-45).
- **This module never writes a file.** `serialize` returns `PendingFile` values; `src/import/landing/`
  commits them (FR-49, FR-53).
- **This module never opens a Claude Code source session for writing** (NG-1, AC-4).
- **This module never calls Claude Code's model, and never opens a network connection** (FR-8).
- **Tool names cross unchanged** (FR-27). A `Read` from Claude Code stays `Read` everywhere else, and
  a foreign tool name arriving from Codex or Pi is written as it came.
- **Only the active non-sidechain transcript crosses.** The last non-sidechain UUID record is the
  active leaf and `parentUuid` selects its ancestry; malformed graphs are unreadable. Current
  `isCompactSummary` user records and legacy `summary` records both become canonical summaries.
- **No result body is carried into `CanonicalTurn`** (FR-24), and each dropped body is marked in text
  the model can read (FR-25).
- **No system prompt, developer prompt, token, password, environment value or vendor state is read
  into the canonical model** (FR-28, NG-7, NG-8), whatever the session file contains.
- **Credential redaction applies to message and summary turn text, not only tool inputs.** A bearer
  token or API key typed by the user as a chat message must not reach a different model vendor. The
  reader applies `redactSensitiveText` to every non-empty turn text in the `push` helper, so no
  turn in the loaded session can carry a recognizable credential in its `text` field.
- **The provenance marker is written as an entry Claude Code shows but does not send to the model**
  (FR-47, FR-48). If the installed version has no such entry, this module declares
  `provenance: "host-output-only"` rather than putting the marker into the model context.
- **Facts about Claude Code are verified against the installed version, never assumed.** The default
  home, the per-project layout, the session file naming and the entry field names are confirmed by
  the boundary tests of this module against Claude Code 2.1.220 or later. C-3 and C-9 are the only
  facts this design treats as established.

## Test Specification

This adapter runs the whole conformance suite of `src/adapters/` in addition to the tests below.
Tests marked **live** require an installed Claude Code and a throwaway `CLAUDE_CONFIG_DIR`. **No test
in this suite ever runs against a real store**: C-3 says a bad write can damage the user's sessions,
and C-9 explicitly states its throwaway-directory result does not lift that risk.

A live test needs one thing a fresh directory cannot give it: an account. A fresh `CLAUDE_CONFIG_DIR`
holds no account reference, so the CLI answers `Not logged in · Please run /login` and exits 1. The
resolution is the one docs/tech-stack.md rules, and that document is normative here: the live tests
read `RESUME_FROM_LIVE_CLAUDE_HOME` (default `$HOME/.resume-from-live-home`), use that home when it
exists and answers a trivial `claude -p`, and **skip with a message naming the one-time login** when
it does not. They never create it, never log in, and never read a credential store — not
`~/.claude.json`, not the Keychain, not an account reference copied from anywhere. The home is still
a throwaway rather than the user's `~/.claude`, so C-3 holds unchanged; because it now persists
between runs, T-CC-17 checks T-CC-11's discipline against it as well.

### Unit Tests

**T-CC-1 — capabilities are as designed**
- Scenario: `capabilities()`.
- Expected behavior: agent `claude-code`; roles `source` and `target`; selection `numbered-list`;
  landing `create-only`; provenance `out-of-context-entry`; an absolute default home; a positive
  window (C-1, C-2).

**T-CC-2 — a session file becomes canonical turns**
- Scenario: a fixture session with user entries, assistant entries, tool calls, tool results and a
  compaction summary.
- Expected behavior: canonical turns for the messages, the summary and the calls, in source order.

**T-CC-3 — tool results become one outcome line**
- Scenario: a `Read` whose result is 400 lines.
- Expected behavior: `outcomeLine` is `Read('src/auth.ts') → 400 lines`, `bodyDropped` is true, and
  no line of the file survives (FR-23, FR-24, FR-25).

**T-CC-4 — serialization writes two entry types and no more**
- Scenario: the reference session is serialized.
- Expected behavior: every entry is a `user` entry or an `assistant` entry. None of the other eight
  entry types of C-3 is written — fewer types, fewer ways to corrupt the store.

**T-CC-5 — the session is keyed to the right repository**
- Scenario: the reference session is serialized for a target home, for a repository at a known path.
- Expected behavior: the file path places the session under that repository's record, so FR-13's
  filter finds it and no other repository does.

### Integration Contract Tests

**T-CC-6 — read-back reports what the store holds**
- Scenario: a session is committed into a throwaway home, then `readBack` runs.
- Expected behavior: `itemCount` equals what `serialize` reported, and `openable` is true (FR-51,
  FR-52).

**T-CC-7 — a missing session reports rather than throws**
- Scenario: `readBack` for a session ID that is not in the home.
- Expected behavior: `openable` false, `itemCount` 0. No exception.

**T-CC-8 — the switch is refused with a named capability**
- Scenario: `switchTo` is called.
- Expected behavior: rejects with an error naming `create-only` and pointing at the handover command
  `claude --resume <id>` (FR-43, FR-45, C-2).

**T-CC-9 — validation catches a damaged entry**
- Scenario: parameterized — an assistant entry missing a required field; an entry with a malformed
  timestamp; an entry with a null message body.
- Expected behavior: each returns a `ValidationDefect` naming the path, and the landing stops before
  placement (FR-50).

### Boundary Tests

**T-CC-10 — the module never writes**
- Scenario: the home is checksummed around `serialize` and `validate`.
- Expected behavior: identical (FR-49, FR-53).

**T-CC-11 — nothing that exists is opened for writing**
- Scenario: a throwaway home populated with 50 sessions, a project record and a settings file, all
  checksummed; a full import runs; the home is checksummed again.
- Expected behavior: every pre-existing file is byte-identical, and only new paths appear. C-3 is the
  reason this test is the strictest in the suite.

**T-CC-12 — an import that would need to modify an existing file is refused**
- Scenario: the adapter is placed in a home where the new session would only be listed if an existing
  index file were edited.
- Expected behavior: the adapter declares the limitation and the import fails with a message, rather
  than performing the edit. FR-49 outranks convenience.

**T-CC-13 — source sessions are byte-identical**
- Scenario: a Claude Code session is used as a source for an import into each of the shipped agents.
- Expected behavior: every file of the source home is byte-identical afterwards (NG-1, AC-4).

**T-CC-14 — excluded content never crosses**
- Scenario: a source session holding a system prompt, a developer prompt, an environment block with
  a token, and telemetry.
- Expected behavior: none of it appears in the canonical session or the target's files (FR-28, NG-7).

**T-CC-15 — a truncated or unknown-typed session**
- Scenario: parameterized — a session cut mid-entry; a session using entry types this adapter does
  not read.
- Expected behavior: the first is reported unreadable; the second loads what it understands and
  reports that entries were skipped.

**T-CC-16 — live: the default home and the per-project layout are what Claude Code uses**
- Scenario: an installed Claude Code writes a session in a known repository, inside the live home;
  the declared default home and the computed session path are compared with where it landed. Only
  the session files this run added count, because the home persists between runs.
- Expected behavior: the same directory and the same layout. This is the test that stops the layout
  from being an assumption.

### Behavior Tests

**T-CC-17 — live: the C-9 scenario**
- Scenario: a canonical session with two turns is serialized into the live `CLAUDE_CONFIG_DIR` and
  committed; the home is checksummed around the commit; then `claude --resume <id>`, then the
  `claude --resume` picker.
- Expected behavior: the turns are on the screen as a native user turn and a native agent turn; the
  picker lists the session with its time, branch and size — exactly C-9's measured results, including
  the two example lines. The commit added the session file and changed nothing the home already
  held, which is T-CC-11's discipline against a home that is not deleted afterwards.

**T-CC-18 — live: the imported turns are native**
- Scenario: after T-CC-17, scrollback and the native resume list are used on the imported turns.
- Expected behavior: both work (FR-41, AC-2).

**T-CC-19 — a work profile import**
- Scenario: a session from `~/.claude` is imported into `~/.claude-team`.
- Expected behavior: the new session opens under the work profile, and the original session in
  `~/.claude` is untouched (FR-4, AC-6).

**T-CC-20 — a file changed after the source session**
- Scenario: a source session read `src/auth.ts`; the file is then changed; the session is imported
  and the target is asked to continue.
- Expected behavior: the target reads the file again rather than editing it blind, because the record
  carries `(content dropped: imported session, may be stale)` and no content (AC-3).
