# Canonical Session Model

**Path**: src/session/ — the module's code is everything in this folder and its transparent subfolders
**Parent**: `src/` (root)
**Submodules**: none (leaf)

## Purpose

This module owns the neutral vocabulary in which a coding session is expressed once it has left its
source agent and before it reaches its target agent. Every rule of requirement sections C to I runs
on these types and on nothing else.

Without it the tool would need a converter for each direction of the scope table — one per
ordered pair of agents, sixteen at the four the tool ships — and
FR-6 ("every rule applies to every direction") and FR-60 ("an adapter cannot change the rules")
would be unenforceable. With it, an adapter's whole job is to translate in and out of this vocabulary,
and every rule is written once.

## Functional Responsibilities

- Define how a session is identified: agent, home, session ID (FR-1).
- Define the row of the selection list: what the user sees before choosing (FR-11).
- Define a turn: who spoke, why the turn exists, and its visible text (FR-22).
- Define a tool call record: name, arguments, and one line of outcome — and **no result body**
  (FR-23, FR-24, FR-27).
- Define the repository state carried with a session (FR-36).
- Define the target profile: where an import is going and how much room it has (FR-18, FR-29).
- Define the provenance marker the user sees after landing (FR-47, FR-48).

This module implements no behaviour. It is types and the invariants that go with them.

## Subdomain Classification

**Core.** The shape of these types _is_ the transfer policy. What has a field crosses over; what has
no field cannot. Volatility is **high**: every change to what a session carries lands here first, and
the agent list in `AgentId` grows with every new adapter (FR-57).

Because this is shared **model coupling** at high volatility, its maximum balanced distance is 2.
That threshold is what caps the whole tree at depth 2.

## Encapsulated Knowledge

- **What a session is, reduced to essentials.** The decision that a session is provenance plus an
  ordered list of turns, and nothing else.
- **The absence of a result-body field.** This is the load-bearing decision of the whole design, and
  it lives here. FR-24 ("the tool drops every tool result body") and FR-60 ("a new adapter cannot
  keep a tool result body, because the rules run before it") are enforced by the shape of
  `ToolCallRecord`, not by anyone's discipline.
- **The absence of fields for excluded content.** There is no field for hidden reasoning, system
  prompts, tokens, passwords, environment values, or vendor model state. FR-28, NG-7 and NG-8 are
  structural.
- **The turn taxonomy.** That a turn is a message, a summary, or a tool call — and that this
  three-way split is what the pinning rules of FR-32 and the drop order of FR-31 key on.
- **What no other module may know.** No module may add a field to these types to smuggle
  agent-specific data through the pipeline. Agent-specific knowledge belongs inside one adapter
  folder.

## Public Contract

Every block in this section is the normative home of the types it defines. No block here is restated
from elsewhere: this module depends on nothing.

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

```ts
/** Where the import is going, and how much room it has (FR-18, FR-29). */
interface TargetProfile {
  agent: AgentId;
  home: HomePath;
  /** Context window of the target, in tokens. */
  windowTokens: number;
}
```

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

## Integrations

**None.** This module depends on no other module. It is the leaf of the dependency graph and the
root of the vocabulary: `src/adapters/`, `src/import/*`, `src/host/*` and `src/platform/config/`
all depend on it, and it depends on none of them.

That direction is deliberate. If this module knew anything about an adapter, a rule, or a host, the
model coupling would become two-way and every one of those modules would inherit the others'
volatility.

## Change Vectors

Changes that require **only this module** to change are limited by design, because every consumer
restates these types. In practice, only these are local:

- A comment or an invariant is clarified without changing a field.
- A field's documentation is corrected.

Every structural change here is a **tree-wide change**, and that is intended: adding a field to
`CanonicalTurn` or a value to `AgentId` is a decision about what the product carries, and every
module that restates the block must be updated in the same commit. The restatement markers make that
list mechanical to find.

The changes this boundary is designed to absorb:

- A new turn kind — for example a distinct kind for a user-authored plan.
- A new tool-call attribute that is safe to carry, for example the duration of the call.
- A new agent value in `AgentId` (FR-57).

## Constraints and Invariants

- **`ToolCallRecord` must never gain a field that can hold a result body**, in any form: no `output`,
  no `resultText`, no `preview`, no `bytes`. FR-24 and FR-60 depend on this. `outcomeLine` is one
  line and is validated as one line. `resultRecorded` is a boolean presence flag only — it records
  whether a result entry existed, not the result itself.
- **No field may hold a secret.** There is no field for tokens, passwords, environment values,
  hidden reasoning, system prompts or vendor state, and none may be added (FR-28, NG-7, NG-8).
  Adapters preserve their own parsing rules, but pass tool inputs through their local pure redactor
  before constructing `argumentsText` or `outcomeLine`. Sensitive keys and environment maps are
  redacted structurally; recognizable command assignments, auth headers, tokens and private keys
  are redacted in text. Path extraction uses the raw adapter input before this boundary.
- **`CanonicalTurn.index` is the source position, not the position after filtering.** The rules
  report drops by source index (FR-35), so the index must survive filtering unchanged.
- **`CanonicalTurn.text` is empty when `kind` is `"tool-call"`, and `toolCall` is null otherwise.**
  These two fields are mutually exclusive. A turn that violates this is invalid input to every rule.
- **Timestamps are ISO-8601 UTC strings, never local time and never epoch numbers.** Sessions from
  different agents are ordered against each other (FR-14), so one representation is required.
- **`SessionDescriptor.repoPaths` preserves recorded evidence, not filesystem identity.** It is a
  required array of distinct absolute recorded directories in first-appearance order. Keep native
  spelling and missing paths; do not resolve, canonicalize, or infer paths during extraction.
  `repoPath` is always `repoPaths[0] ?? null`, even when the first candidate no longer exists.
- **`SessionDescriptor.startDirectory` is the session's own first directory, not a candidate.** It is
  the absolute directory of the earliest record that is not a sidechain, or null when the format
  records none. Discovery checks it only when no recorded candidate matched and none conflicted, so a
  session that started in this directory stays listed here after its active conversation moved into a
  subdirectory. It never contributes conflicting-identity evidence.
  Claude uses only the active main ancestry, excluding sidechains before extracting metadata.
  Codex and Pi use a singleton header cwd, or an empty array without valid absolute metadata.
  Prose, tool arguments and encoded project directory names never supply candidates. Repository
  acceptance and filesystem identity resolution belong to discovery, not the session vocabulary.
- **`AgentId` values are lowercase kebab-case** and match the folder name under `src/adapters/`. That
  is the whole of the naming convention FR-57 relies on.
- **Nothing in this module performs input or output.** No file access, no network, no clock. A
  timestamp is a value passed in, never `Date.now()` read here — the rules must be reproducible so
  that the preview and the commit of the same request agree.

## Test Specification

This module implements no behaviour, so its tests are of two kinds: compile-time assertions about the
shape of the types, and assertions on the **reference fixtures** — one canonical session used by
every module's tests, so the whole tree exercises the same vocabulary.

The fixtures are **not** shipped by this module. They live in `test/fixtures/`, outside `src/`, so
they add no module to the design tree and no module reaches into another's folder to use them. This
module owns the _invariants_ the fixtures must satisfy, and asserts them.

### Unit Tests

**T-SES-1 — a tool call record has no field for a result body**
- Scenario: a compile-time assertion lists the keys of `ToolCallRecord`.
- Expected behavior: the key set is exactly `toolName`, `argumentsText`, `outcomeLine`, `effect`,
  `bodyDropped`, `resultRecorded`. Adding any other key fails the build. This is the mechanical
  guard on FR-24 and FR-60. `resultRecorded` is a presence flag (boolean), not a content field,
  so it cannot hold a result body.

**T-SES-2 — no type carries excluded content**
- Scenario: a compile-time assertion lists the keys of every type in the Public Contract.
- Expected behavior: no key matches `reasoning`, `thinking`, `systemPrompt`, `developerPrompt`,
  `token`, `apiKey`, `env`, `telemetry`, or `vendorState` (FR-28, NG-7, NG-8).

**T-SES-3 — a message turn carries no tool call**
- Scenario: the fixture's message turns are inspected.
- Expected behavior: every turn with `kind` `"message"` or `"summary"` has `toolCall` null and
  non-empty `text`.

**T-SES-4 — a tool-call turn carries no text**
- Scenario: the fixture's tool-call turns are inspected.
- Expected behavior: every turn with `kind` `"tool-call"` has an empty `text` and a non-null
  `toolCall`.

**T-SES-5 — outcome lines are one line**
- Scenario: every `ToolCallRecord` in the fixture is inspected.
- Expected behavior: `outcomeLine` contains no line break (FR-23).

**T-SES-6 — indexes are the source order**
- Scenario: the fixture's turns are read in order.
- Expected behavior: `index` starts at 0 and increases by 1, with no gaps and no repeats.

**T-SES-7 — timestamps are ISO-8601 UTC**
- Scenario: every non-null `timestamp`, `startedAt`, `updatedAt` and `importedAt` in the fixtures.
- Expected behavior: each parses as ISO-8601 and ends in `Z`. A local-time or epoch value fails.

### Integration Contract Tests

**T-SES-8 — the reference fixture is complete**
- Scenario: the fixture session is loaded.
- Expected behavior: it contains at least one user message, one agent answer, one summary, one
  read-only tool call, one mutating tool call, and one call whose `bodyDropped` is true — so every
  downstream module can exercise every branch of the rules against it.

**T-SES-9 — `AgentId` values match the adapter folder names**
- Scenario: the values of `AgentId` are compared with the folder names under `src/adapters/`.
- Expected behavior: they are equal as sets. This is the naming convention FR-57 depends on, and it
  is the test that catches a half-added agent.

**T-SES-10 — a session reference identifies a session**
- Scenario: two fixture sessions in different homes with the same agent and the same session ID.
- Expected behavior: their `SessionRef` values differ, because `home` differs (FR-1, FR-4).

### Boundary Tests

**T-SES-11 — an empty session is representable**
- Scenario: a `CanonicalSession` with provenance and zero turns.
- Expected behavior: it satisfies every invariant. An empty import is a valid input to the rules, not
  an error state.

**T-SES-12 — a repository snapshot with nothing known is representable**
- Scenario: a `RepoSnapshot` with null `commit`, null `branch` and an empty `changedPaths`.
- Expected behavior: valid. This is the documented FR-36 gap and it must not be an error.

**T-SES-13 — a descriptor with no repository is representable**
- Scenario: a `SessionDescriptor` with null `repoPath` and empty `repoPaths`.
- Expected behavior: valid, and documented as out of scope for the listing (FR-13).

**T-SES-14 — the provenance marker has every fact FR-47 requires**
- Scenario: a fixture `ProvenanceMarker` is inspected.
- Expected behavior: it states the source agent, the source home, the source session ID, the import
  time, and what was dropped.

### Behavior Tests

**T-SES-15 — the vocabulary is agent-independent**
- Scenario: three fixture sessions, one produced from each agent's format.
- Expected behavior: all three are the same type, with no agent-specific field and no field that is
  populated for one agent only. A reader of a canonical session cannot tell which agent produced it
  except through `provenance.ref.agent`.

_T-SES-16 was moved to `src/import/` as T-IMP-25. It passes the fixture through the rules, the
preview and an adapter's serialize, all of which compose above this module — a module cannot own a
test of collaborators that do not exist when it is implemented._
