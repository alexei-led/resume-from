# Agent Adapters

**Path**: src/adapters/ — the module's code is everything in this folder and its transparent subfolders, excluding the submodule folders `pi/`, `codex/`, `claude-code/`, `kimi-code/`
**Parent**: `src/` (root)
**Submodules**: `pi/`, `codex/`, `claude-code/`, `kimi-code/`

## Purpose

This module owns the port between the tool's neutral vocabulary and the private session format of one
agent. It defines what an adapter must provide, what an adapter is allowed to declare about its
agent's abilities, and — just as importantly — what an adapter may never do.

Without the port, every rule would need a branch per agent and FR-60 ("the rules of sections C to I
are the same for every adapter; an adapter cannot change them") would be unenforceable. With it, the
rules are written once against `src/session/`, and each agent's quirks stay inside one folder.

## Functional Responsibilities

- Define `AgentAdapter`: read an agent's sessions, load one into the canonical model, serialize a
  canonical session into the agent's format, validate the result, read it back, and — where the agent
  allows it — move the user into it.
- Define `AgentCapabilities`: what the rest of the system may know about an agent's abilities, namely
  its roles (FR-59), its selection level (FR-9, FR-10, FR-58), its landing level (FR-42, FR-58), how
  it can show a provenance marker outside the model context (FR-47, FR-48), its default home (FR-3),
  and its assumed context window (FR-18).
- Hold the rules every adapter obeys, so that adding an agent is one new folder and one line in
  `src/host/` (FR-57).

This module implements no adapter. Each submodule implements one.

## Subdomain Classification

**Supporting, conformist to an upstream nobody controls.** The plumbing gives the product no
competitive advantage, and no off-the-shelf solution exists — but the volatility is **high**, and
externally driven: C-7 to C-11 pin exact versions of undocumented internal formats (codex-cli
0.146.0, Claude Code 2.1.220, Pi 0.83.0). Those formats will drift under the tool.

That is why the port is a strict contract rather than a loose convention, and why every fact about
an agent that a rule might want to branch on is a **field of `AgentCapabilities`** instead. A rule
that switches on `AgentId` is a defect; a rule that reads a capability is correct.

## Encapsulated Knowledge

- **The shape of the port.** What an adapter is asked for, in what order, and with what guarantees.
- **The capability vocabulary.** That "can this agent open its own picker" and "can this agent move
  the user" are two independent axes, each with its own enum, and that neither is inferable from the
  agent's name.
- **The prohibition on writing.** That an adapter produces `PendingFile` values and never touches the
  filesystem to create them. This is where FR-49 and FR-53 stop being adapter discipline and become
  structure.
- **The prohibition on translating.** That tool names cross unchanged (FR-27), so no adapter holds a
  name mapping.
- **The read-only guarantee on sources.** That `listSessions` and `loadSession` open source files for
  reading only (FR-8, NG-1, AC-4).

What is **not** here: any knowledge of one agent's file format. That belongs to the submodule for
that agent, and no other module may hold it.

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

The blocks below are the normative home of the types they define.

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

```ts
/**
 * An opaque handle supplied by the host of the same agent, for example Pi's
 * command context. Nothing outside the adapter of that agent inspects it.
 */
type AgentRuntime = unknown;
```

```ts
/** A structural defect found before placement (FR-50). */
interface ValidationDefect {
  /** Pointer into the offending item, for example "items/3/usage". */
  path: string;
  /** What is missing or malformed, and why the agent would fail on it. */
  message: string;
}

/** The host-supplied absolute destination, preserving native subdirectory and symlink spelling. */
interface SerializationContext {
  cwd: string;
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

## Integrations

- **Counterpart**: `src/session/`
- **Direction**: `src/adapters/` depends on `src/session/`
- **Strength**: model — the port's signatures are written in the canonical vocabulary
- **LCA / Rank / Distance**: LCA `src/`, rank 1, distance 1
- **Volatility**: high on both sides — `src/session/` is core, and this module is conformist to
  drifting upstream formats
- **Balanced?**: yes — model coupling tolerates distance 2 and these are siblings at distance 1
- **Shared knowledge**: the six restated blocks in the Public Contract section above. That is the
  whole vocabulary an adapter speaks.

---

- **Counterpart**: `src/platform/store/`
- **Direction**: `src/adapters/` depends on `src/platform/store/` for the file type only. It never
  calls it.
- **Strength**: contract
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: low — the file type is two fields and has no reason to change
- **Balanced?**: yes — contract coupling tolerates any distance
- **Shared knowledge**: the restated `Bytes` and `PendingFile` block in the Public Contract section
  above. The direction is deliberate: the low-volatility store owns the type, and the high-volatility
  adapters restate it. The reverse would push adapter volatility into the only module that writes
  files.

---

- **Counterpart**: `src/adapters/pi/`, `src/adapters/codex/`, `src/adapters/claude-code/`
- **Direction**: each submodule implements this module's contract
- **Strength**: contract
- **LCA / Rank / Distance**: LCA `src/adapters/`, rank 1, distance 1 for each
- **Volatility**: high — each tracks a drifting upstream format
- **Balanced?**: yes
- **Shared knowledge**: `AgentAdapter` and everything it references, restated in each submodule's
  document.

## Internal Design

### How the submodules compose

They do not compose; they are alternatives. Exactly one adapter is chosen as the source of an import
and exactly one as the target, and the two may be the same adapter with different homes (the diagonal
cells of the scope table, FR-4). Nothing in this folder chooses between them: `src/host/` holds the
list and picks.

| Submodule      | Roles          | Selection          | Landing           | Provenance           | The fact that shapes it                                                                                     |
| -------------- | -------------- | ------------------ | ----------------- | -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pi/`          | source, target | interactive-picker | create-and-switch | out-of-context-entry | `ctx.switchSession` works from a command handler (C-10); a missing `usage` object crashes Pi (C-11)         |
| `codex/`       | source, target | numbered-list      | create-only       | host-output-only | the picker and transcript are built from `event_msg` entries; provenance is printed by the CLI because Codex has no verified out-of-context entry (C-7, C-8) |
| `claude-code/` | source, target | numbered-list      | create-only       | out-of-context-entry | two entry types are enough, `user` and `assistant`; the store has ten and eight were unnecessary (C-3, C-9) |
| `kimi-code/`   | source, target | numbered-list      | create-only       | host-output-only | a session is a `state.json` plus a `wire.jsonl`; the import writes the message-based shape Kimi Code's own migration writes (C-14, C-15) |

### The order the port is called in

1. `capabilities()` — cheap, synchronous, and called before anything else. `src/host/` uses it to
   choose the selection level; `src/import/` uses it to build the target profile.
2. `listSessions(home)` — once per home, for every adapter with the `source` role.
3. `loadSession(descriptor)` — once, on the session the user chose.
4. `serialize(session, target, marker, context)` — once, on the target adapter, after the rules have run and
   the user has confirmed.
5. `validate(serialized)` — immediately after, before any byte reaches the disk (FR-50).
6. `readBack(home, sessionId)` — after the commit, to compare item counts (FR-52).
7. `switchTo(home, sessionId, runtime)` — only when `capabilities().landing` is `"create-and-switch"`
   (FR-43).

Steps 1 to 3 are the source role. Steps 4 to 7 are the target role. An adapter that declares only one
role implements only that half (FR-59); the other half rejects with an error naming the missing role.

### What this folder itself ships

Types and tests, and no runtime code. The Public Contract declares no factory, and Change Vectors
says adding an agent does not change this module — so a file in this folder holding the list of
adapters would contradict both. `src/host/` builds each adapter from its submodule's `index.js`;
this folder ships `contract.ts` and the conformance suite that every adapter must pass. That is why
it has no `index.ts`: there is nothing here to construct.

### Why capabilities are data, not behaviour

FR-58 says an adapter declares what its agent can do, and FR-60 says an adapter cannot change the
rules. Those two together mean the declaration must be **data the rules read**, never a hook the rules
call. `AgentCapabilities` has no functions for that reason. An adapter cannot influence what crosses
over, what is pinned, or what the preview says — it can only state facts about its agent, and the
rules decide what to do about them.

### Adding an agent

1. Create `src/adapters/<agent>/` with a `module.md` and an implementation of `AgentAdapter`.
2. Add the agent's value to `AgentId` in `src/session/`.
3. Add one line to the list in `src/host/`.

Nothing in `src/import/` changes. That is the test of FR-57.

## Change Vectors

Changes that require **only this module** to change:

- A new capability axis is added — for example whether an agent can show a banner before the first
  turn, or whether it supports a session title.
- A new port method is added that every adapter must provide, for example a cheap existence check
  before a full `listSessions`.
- The order the port is called in changes.
- A capability gains a value — for example a third selection level for an agent that can open a
  picker but not filter it.

Adding an agent does **not** change this module. Changing one agent's format does **not** change this
module.

## Constraints and Invariants

- **Source descriptors preserve recorded directory candidates.** `repoPaths` contains distinct absolute metadata paths in first-appearance order; `repoPath` equals `repoPaths[0] ?? null`. Missing paths remain recorded evidence. Never derive candidates from prose, tool arguments or encoded directory names; filesystem identity and repository acceptance belong to discovery.

- **Import serialization requires `SerializationContext`.** Its absolute `cwd` is the destination agent’s native working directory, including subdirectory and symlink spelling. Writers must not fall back to process cwd, factory cwd, a checkout root, or source provenance.

- **An adapter never creates, renames, or removes a file.** `serialize` returns `PendingFile` values
  and `src/import/landing/` commits them through `src/platform/store/` (FR-49, FR-53, C-3).
- **An adapter never opens a source file for writing** (NG-1, AC-4). Every source session file is
  byte-identical after an import.
- **An adapter never calls a model, and never opens a network connection** (FR-8). Everything is read
  from disk, so an import works when the source agent is stopped or out of quota.
- **An adapter never translates a tool name** (FR-27). A `Read` from Claude Code stays `Read` in
  Codex.
- **An adapter never carries a result body across** (FR-24). There is no field for one, and
  `loadSession` sets `bodyDropped` instead (FR-25).
- **An adapter never carries hidden reasoning, a system prompt, a token, a password, an environment
  value, or vendor state** (FR-28, NG-7, NG-8). C-4 makes this unavoidable for Codex reasoning
  traces; it is a rule for every adapter regardless.
- **Credential redaction covers message and summary turn text, not only tool inputs.** A credential
  that the user typed as a chat message (for example `curl -H "Authorization: Bearer sk-..."`) would
  otherwise cross to a different model vendor when the session is resumed there. Each adapter applies
  `redactSensitiveText` to every non-empty turn text at the point of construction, so no turn that
  reaches `CanonicalSession.turns` can carry a recognizable credential in its `text` field.
- **The four adapter copies of `redaction.ts` are byte-identical by design.** Consolidating into a
  shared module is blocked: `src/adapters/contract.ts` is types-only (no behaviour), and importing
  behaviour from `src/platform/` would violate T-ROO-7 (cross-module imports must go through
  `/contract.js`, which can export only types). The byte-equality invariant is enforced by
  `src/adapters/boundary.test.ts`; a fix in one copy must be applied to all four.
- **Redaction takes each value whole, and the key name is bounded.** A key and its value are matched
  as one span and the value is replaced in full, so no credential is ever left partly in place: a
  quoted key of any length, a URL-encoded or `~`-bearing token, a 4200-character JWT on a `token:`
  line, and a value another pass has already shortened all come out whole (FR-28). Bounding the
  *value* scan instead cost a tail of a credential three times, which review caught each time, so the
  value is unbounded. The one real hazard was the *name*: an unbounded name made the engine backtrack
  over the whole run at every start position, so 50 KB of one word took 11.8 s and 100 KB never
  finished, which hung the listing and the import on a pasted blob or a long unbroken line. A quoted
  name is matched whole and an unquoted one up to 64 characters; a longer unquoted run still matches
  through its last 64 characters, and `isSensitiveKey` decides by the name's tail as well as by its
  whole text, so the verdict matches the unbounded pattern's. Measured over 190,778 real recorded
  texts (1.28 GB): 65 s in total with a worst single text of 0.29 s, where the unbounded name took
  84 s with a 4.2 s worst text, and the 32,236 comparable texts (77.9 MB) redact byte-for-byte as
  before. Short unbroken lines stay cheap (200 KB of one word in 0.05 s) and a separator-dense line
  costs about a millisecond per 130 KB. Upgrade trigger: a measured credential that a >64-character
  unquoted key name hides, or whole-file redaction becoming noticeable — both would call for a
  scanner that visits each position once rather than layered patterns.
- **`capabilities()` is pure and synchronous**- **`capabilities()` is pure and synchronous** and returns the same value every time. The rules read
  it more than once per import.
- **`serialize` is deterministic given the same session, target, marker and serialization context**, except for the session
  ID it mints. The preview and the commit of one request must agree on everything the user was shown.
- **`serialize` mints a session ID that does not exist in the target home.** A collision is a
  refusal, never an overwrite (FR-49).
- **`validate` returns every defect it finds, not the first.** FR-50 exists because C-11 showed one
  missing field crashing the agent; an implementer fixing one defect at a time is a bad loop.
- **`readBack` never repairs.** It reports what the target holds. FR-52 is a comparison, and a
  difference is an error the caller acts on.
- **`switchTo` is called from a command handler, never from an event handler** (C-10). The deleted
  design documents claimed an event handler deadlocks; that claim was never tested, so the safe
  order is the one that was.
- **An adapter declares a capability it actually has.** Declaring `"create-and-switch"` without a
  working `switchTo` breaks FR-43, and the failure surfaces after the session is already committed.
- **The conformance suite's fake adapter lives outside `src/`.** Several tests across the tree add a
  invented agent to prove that a capability decides behaviour and that FR-57 costs one folder
  and one line (T-ADA-21, T-ADA-22, T-HOS-10, T-HOS-18, T-IMP-24, T-CLI-23, T-ROO-20). That fixture
  adapter lives at `test/fixtures/fixture-agent/`, declares the agent id `"fixture-agent"`, and is
  registered only by the test that uses it. It is **not** a module of the design tree: it has no
  `module.md`, it is not under `src/adapters/`, and `src/host/`'s agent list never holds it. That is
  what keeps T-SES-9 true — the values of `AgentId` equal the folder names under `src/adapters/` —
  while still letting the tests exercise an agent nobody wrote a rule for.

## Test Specification

This module ships a **conformance suite**: one parameterized test body that every adapter must pass,
run once per entry in the agent list. That suite is the mechanical form of FR-60 — the rules are the
same for every adapter because the same tests run against every adapter. A new agent adds one line to
the suite's parameter list and nothing else (FR-57).

### Unit Tests

**T-ADA-1 — capabilities are pure and stable**
- Scenario: `capabilities()` is called 100 times on each adapter.
- Expected behavior: every call returns an equal value, synchronously.

**T-ADA-2 — the declared agent matches the folder**
- Scenario: for each adapter, `capabilities().agent` is compared with its folder name under
  `src/adapters/`.
- Expected behavior: equal. This is the naming convention FR-57 relies on.

**T-ADA-3 — the declared default home is absolute**
- Scenario: `capabilities().defaultHome` for each adapter.
- Expected behavior: an absolute, resolved path (FR-3).

**T-ADA-4 — the declared window is positive**
- Scenario: `capabilities().defaultWindowTokens` for each adapter.
- Expected behavior: greater than 0, so the budget of FR-29 is computable without configuration.

**T-ADA-5 — at least one role is declared**
- Scenario: `capabilities().roles` for each adapter.
- Expected behavior: non-empty, and every value is `"source"` or `"target"` (FR-59).

### Integration Contract Tests

These run against every adapter in the list.

**T-ADA-6 — a declared capability is a capability the adapter has**
- Scenario: for each adapter declaring `"create-and-switch"`, `switchTo` is called with a valid
  runtime handle; for each adapter declaring `"create-only"`, it is called with `null`.
- Expected behavior: the first group performs a switch or reports a cancel; the second rejects with
  an error naming the missing capability. A declared ability that does not work fails here rather
  than after a session is committed (FR-43).

**T-ADA-7 — a source adapter lists and loads**
- Scenario: an adapter with the `source` role, pointed at a fixture home holding three sessions.
- Expected behavior: `listSessions` returns three descriptors with every field of `SessionDescriptor`
  populated, and `loadSession` on each returns a `CanonicalSession` whose turn count is consistent
  with the descriptor.

**T-ADA-8 — a target adapter serializes, validates and reads back**
- Scenario: an adapter with the `target` role is given the reference session fixture.
- Expected behavior: `serialize` returns at least one `PendingFile` and a positive `itemCount`;
  `validate` returns no defect; after the files are committed, `readBack` reports the same
  `itemCount` and `openable` true (FR-51, FR-52).

**T-ADA-9 — the round trip preserves what must cross**
- Scenario: for every ordered pair of adapters, including each adapter with itself — every cell
  of the scope table, sixteen directions at the four shipped agents — the reference session is loaded by the source adapter, serialized
  by the target adapter, committed, and loaded back by the target adapter acting as a source.
- Expected behavior: the visible user messages, the agent answers, the summaries, and the tool names
  survive unchanged. This one parameterized test covers AC-1.

**T-ADA-10 — no result body survives any direction**
- Scenario: the same every-direction run, with a source session whose tool results contain the marker
  string `SECRET-BODY-CONTENT`.
- Expected behavior: the string does not appear anywhere in the committed files (FR-24), including
  the diagonal cells where the source and target agent are the same (the explicit FR-24 test).

**T-ADA-11 — every dropped body is marked**
- Scenario: every direction, with a source session containing a `Read` whose result was 400
  lines.
- Expected behavior: the record reads `Read('src/auth.ts') → 400 lines` and carries
  `(content dropped: imported session, may be stale)` (FR-23, FR-25).

**T-ADA-12 — tool names are not translated**
- Scenario: every direction, with tool names `Read`, `Edit`, `shell`, and an invented
  `Frobnicate`.
- Expected behavior: each name appears unchanged in the target's file (FR-27).

### Boundary Tests

**T-ADA-13 — no adapter writes a file**
- Scenario: for every adapter, the target home is checksummed, `serialize` and `validate` are called,
  and it is checksummed again.
- Expected behavior: identical. Serializing produces bytes and nothing else (FR-49, FR-53).

**T-ADA-14 — every source file is byte-identical after an import**
- Scenario: every direction; every file in the source home is checksummed before and after.
- Expected behavior: identical, including modification times where the platform preserves them
  (NG-1, AC-4).

**T-ADA-15 — no adapter opens a network connection**
- Scenario: the conformance suite runs with the network stubbed to fail on any use.
- Expected behavior: every test passes. The whole tool works with the source agent stopped (FR-8).

**T-ADA-16 — validation catches a missing required field**
- Scenario: for each adapter, a serialized session is damaged by removing a field that agent
  requires — for Pi, the `usage` object of an assistant message (C-11).
- Expected behavior: `validate` returns at least one `ValidationDefect` naming the path, and the
  landing stops before placement (FR-50).

**T-ADA-17 — validation reports every defect**
- Scenario: a serialized session with three separate defects.
- Expected behavior: three defects are returned, not one.

**T-ADA-18 — a minted session ID does not collide**
- Scenario: `serialize` is called 1000 times against a home that already holds 100 sessions.
- Expected behavior: every path is new, and no two of the 1000 collide (FR-49).

**T-ADA-19 — excluded content never crosses**
- Scenario: source sessions containing reasoning traces, a system prompt, an environment block with
  `OPENAI_API_KEY`, and telemetry.
- Expected behavior: none of it appears in the canonical session or in the target's files (FR-28,
  NG-7, NG-8, C-4).

**T-ADA-20 — a corrupt source session is reported, not guessed**
- Scenario: two halves, both run against every adapter — a session file truncated mid-entry, and a
  session file holding an entry type the adapter does not know.
- Expected behavior: the truncated file never becomes a shorter session. `loadSession` rejects with
  a message naming the file, whether the listing flags the row as unreadable or leaves it out. The
  unknown entry type is not fatal: the session still lists and still loads, the strange entry
  produces no turn, and nothing it holds reaches the canonical session.
- ⚠️ _Corrected while implementing this module._ The original text expected an unknown entry type to
  be reported as unreadable as well. Every submodule's own document says the opposite and its tests
  assert it — T-PI-14, T-COD-14 and T-CC-15 all skip an entry type they do not know and count the
  skip so the preview can warn. Guessing is what this test forbids; skipping a strange entry and
  reporting the skip is not guessing, and refusing the whole session over one strange entry would
  make an import fail on a format that merely grew a field.

### Behavior Tests

**T-ADA-21 — a capability decides behaviour, an agent name never does**
- Scenario: a fake adapter is added to the suite declaring `"numbered-list"` and `"create-only"`,
  with a format unlike any of the real agents.
- Expected behavior: it gets the numbered list (FR-58's test) and the handover message (FR-45),
  purely from its declaration. No rule, no preview and no other adapter is edited to make it work —
  which is the test of FR-57 and FR-60 together.

**T-ADA-22 — an adapter with one role only**
- Scenario: a fake adapter declaring `["source"]`.
- Expected behavior: it appears in the listing and never as an import target; asking to target it
  fails with a message naming the missing role (FR-59).

**T-ADA-23 — a mutating call cannot be replayed**
- Scenario: a source session containing an `Edit`; it is imported into every target.
- Expected behavior: the target starts no edit, requests no approval, and holds the call as text
  only (FR-26, NG-6).
