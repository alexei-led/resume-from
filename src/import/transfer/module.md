# Transfer Rules

**Path**: src/import/transfer/ — the module's code is everything in this folder and its transparent subfolders
**Parent**: `src/import/`
**Submodules**: none (leaf)

## Purpose

This module decides **what crosses over and how much**. It takes a source session in the neutral
vocabulary and a target profile, and produces a plan: the turns that will land, the turns that were
dropped and why, the tool result bodies that were removed, and the token arithmetic behind it.

It is the core of the product. Requirement sections D and E live here in full, and FR-60 says no
adapter may change them. Keeping the rules in one module, written against one vocabulary, is what
makes that promise checkable: there is exactly one place where the answer to "what crosses over" is
computed, for all nine directions.

## Functional Responsibilities

The module applies the rules in this order. The order matters and is part of the contract.

1. **Drop a broken tail.** If the last tool call of the source has no result, drop that call and
   record it (FR-54, FR-55).
2. **Select content.** Keep visible user messages, visible agent answers, and the summaries the
   source made when it compacted (FR-22). Reduce every tool call to a record: name, arguments, and
   one line about the outcome (FR-23). Drop every result body and mark the record (FR-24, FR-25).
   Keep the original tool name (FR-27). Drop hidden reasoning, system and developer prompts, tokens,
   passwords, environment values, telemetry and vendor state (FR-28).
3. **Compute the budget.** `budgetTokens` = `budgetShare` × `TargetProfile.windowTokens` (FR-29,
   FR-30).
4. **Pin.** Mark as pinned the first request of the user, the last `pinnedRecentTurns` turns word for
   word, every summary and decision the source made, and the list of files the source changed
   (FR-32).
5. **Stop if the pinned content alone exceeds the budget.** Set `blockedReason` and write nothing
   (FR-33).
6. **Drop to fit.** Charge each turn a fixed positive framing cost in addition to its visible
   content. While the estimate exceeds the budget, drop the oldest unpinned turn (FR-31).
   Never drop one half of a call and its result — drop both or keep both (FR-34).
7. **Report.** Record every drop with its reason, the counts, and the token arithmetic, so the
   preview can state what the budget removed (FR-17, FR-18, FR-35).

It trusts the adapter-produced `RepoSnapshot.changedPaths`, because only an adapter understands its
native structured tool arguments. This module removes empty entries and duplicates without guessing
paths from arbitrary argument text.

## Subdomain Classification

**Core.** This is the product's competitive advantage: whether the target can continue the work
without the user repeating anything is decided entirely by these rules. Volatility is the **highest
in the system** — two constants are explicitly undecided (Q-1, the 30% share; Q-2, the 5 pinned
turns), and the definition of "what is worth carrying" will be tuned for as long as the tool is used.

That volatility is the reason this module sits at distance 2 from `src/session/` and at distance 1
from `src/import/preview/` and `src/import/landing/`, its two model-coupled consumers. It is also the
reason the module was not split further: `transfer/content/` and `transfer/budget/` would sit at
depth 3, giving distance 3 against a model-coupled, high-volatility counterpart — an unbalanced,
Critical integration.

## Encapsulated Knowledge

- **What crosses over.** The full content of requirement section D, as executable rules.
- **How much crosses over.** The full content of requirement section E: the budget formula, the drop
  order, the pin set, and the pair rule.
- **The order the rules run in.** That the broken tail is dropped before the budget is computed, and
  that pinning happens before dropping. A different order gives different output for the same input.
- **What a tool call becomes.** How a call is reduced to a name, arguments, and one outcome line, and
  what that line says when the source recorded no outcome.
- **The drop marker text.** That a dropped body is marked in text the model can read, in the form
  `(content dropped: imported session, may be stale)` (FR-25).
- **How the changed-file list is normalized.** Adapter-derived paths keep their source order; empty
  entries and later duplicates are removed.
- **That the rules are pure.** No clock, no file access, no randomness — because the preview and the
  commit of one request must produce the same plan.

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

<!-- contract: ImportConfig — restated from src/platform/config/module.md (subset: omits extraHomes and windowOverrides) -->
```ts
/** User configuration. Every field has a default (FR-5, FR-30, FR-32). */
interface ImportConfig {
  /** Share of the target window one import may use. Default 0.30 (FR-30, Q-1). */
  budgetShare: number;
  /** Recent turns kept word for word. Default 5 (FR-32, Q-2). */
  pinnedRecentTurns: number;
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

The blocks below are the normative home of the types they define.

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

## Integrations

- **Counterpart**: `src/session/`
- **Direction**: `src/import/transfer/` depends on `src/session/`
- **Strength**: model — the rules are written in the canonical vocabulary and produce it
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: high (core) on both sides
- **Balanced?**: yes — model coupling tolerates distance 2, and this is exactly 2. This pair is the
  binding constraint on the shape of the whole tree.
- **Shared knowledge**: the four restated session blocks in the Public Contract section above.

---

- **Counterpart**: `src/platform/config/`
- **Direction**: `src/import/transfer/` depends on `src/platform/config/`
- **Strength**: contract
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: low
- **Balanced?**: yes
- **Shared knowledge**: the two settings this module reads, restated as a declared subset of
  `ImportConfig` in the Public Contract section above. The defaults 0.30 and 5 live in
  `src/platform/config/` and are never repeated here as literals.

---

- **Counterpart**: `src/platform/tokens/`
- **Direction**: `src/import/transfer/` depends on `src/platform/tokens/`
- **Strength**: contract — a string goes in, a number comes out
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: low functional, moderate implementation
- **Balanced?**: yes
- **Shared knowledge**: the restated `TokenEstimator` block in the Public Contract section above.
  The estimator is passed in, never constructed here, so a different tokenizer changes nothing in
  this module.

---

- **Counterpart**: `src/import/preview/` and `src/import/landing/`
- **Direction**: both depend on this module for `TransferPlan`
- **Strength**: model — `TransferPlan` embeds canonical turns and the pin and drop records
- **LCA / Rank / Distance**: LCA `src/import/`, rank 1, distance 1 for each
- **Volatility**: high (core)
- **Balanced?**: yes — model coupling at distance 1 is the strongest balance available, and it is
  why these three are siblings
- **Shared knowledge**: `TransferPlan`, `TurnPin`, `TurnDrop`, `PinReason` and `DropReason`, whose
  normative home is this module. Both consumers restate them.

## Change Vectors

Changes that require **only this module** to change:

- The answer to Q-1 or Q-2 changes the **default**, which lives in `src/platform/config/`; changing
  how the share is _applied_ — for example a floor in absolute tokens — changes only this module.
- The pin set grows or shrinks: a new `PinReason`, or dropping "recent turns" in favour of a
  relevance rule.
- The drop order changes: oldest-first becomes lowest-value-first.
- The outcome line format changes.
- The dropped-body marker text changes (FR-25).
- The broken-tail rule extends to more than the last call.
- The changed-file derivation improves.

None of these touch an adapter, a host, or the preview's shape.

## Constraints and Invariants

- **`apply` is pure.** No file access, no network, no clock, no randomness. FR-16 and FR-20 make the
  user confirm a preview and then run a second invocation; both invocations must compute the same
  plan from the same input, or the user confirmed something else.
- **No tool result body is ever carried.** `CanonicalTurn` and `ToolCallRecord` have no field for
  one, and this module never invents a way to smuggle one into `text` or `argumentsText` (FR-24,
  FR-60). This holds for all nine directions, including a move between two homes of one agent.
- **Every dropped body is marked in text the model can read** (FR-25), in the form
  `(content dropped: imported session, may be stale)`.
- **A call that changed the repository crosses as a record only** (FR-26). `ToolEffect` is carried so
  the target can display it, but nothing in the plan can be executed, because a record is text.
- **Tool names are never translated** (FR-27).
- **Pinned content is never dropped** (FR-32). If the pins alone exceed the budget, `blockedReason`
  is set and the caller writes nothing (FR-33). The rules never "almost fit" by dropping a pin.
- **A call and its result are never split** (FR-34). They are dropped together or kept together, and
  the pair is counted as one unit when the budget is computed.
- **`estimatedTokens` never exceeds `budgetTokens` when `blockedReason` is null.** That is the
  post-condition of step 6.
- **`keptTurnCount` plus `droppedTurnCount` equals the source turn count** after the broken tail is
  removed, and `drops` has exactly `droppedTurnCount` entries. The preview shows these numbers to the
  user (FR-17), so they must reconcile.
- **Indexes in `pins` and `drops` are source indexes**, not positions in `turns`. FR-35 reports drops
  in terms the user can map back to the source.
- **The rules never branch on `AgentId`** (FR-60). A rule that needs a per-agent fact reads a field
  of `TargetProfile`, which the caller built from the adapter's declared capabilities. There is no
  other legal channel.
- **The rules never read a home, a file, or a repository.** Everything arrives as arguments. That is
  what makes them testable without any agent installed.
- **A session with zero turns produces a plan with zero turns and no error.** The caller decides
  whether an empty import is worth confirming.
- **The estimate is treated as authoritative but is known to be approximate** — FR-29 gives the
  import a share of the window, not all of it, so the margin absorbs the error.

## Test Specification

Every test is a pure function call: a session in, a plan out. No filesystem, no agent, no clock. This
is the largest and most detailed suite in the tree, because these rules are the product.

### Unit Tests

**T-TRA-1 — visible content always crosses**
- Scenario: a session with a user message, an agent answer, and a compaction summary, well inside the
  budget.
- Expected behavior: all three are in `turns`, in source order, with their text unchanged (FR-22).

**T-TRA-2 — a tool call becomes a record**
- Scenario: a `Read('src/auth.ts')` whose result was 400 lines.
- Expected behavior: one turn of kind `"tool-call"` with `toolName` `Read`, `argumentsText`
  `'src/auth.ts'`, and `outcomeLine` opening with `Read('src/auth.ts') → 400 lines` (FR-23). The
  outcome the source recorded is carried word for word; FR-25's marker is appended after it, so the
  line reads in full only when no body was dropped. T-TRA-3 owns the marker.

**T-TRA-3 — every result body is dropped and marked**
- Scenario: a session whose tool results contain `SECRET-BODY-CONTENT`.
- Expected behavior: the string appears nowhere in the plan; `bodyDropped` is true on each record;
  each record carries `(content dropped: imported session, may be stale)`; `bodiesDropped` counts
  them (FR-24, FR-25).

**T-TRA-4 — tool names are not translated**
- Scenario: a table of names — `Read`, `Edit`, `shell`, `apply_patch`, `Frobnicate`.
- Expected behavior: each appears unchanged (FR-27).

**T-TRA-5 — a mutating call is marked and carries no instruction to run**
- Scenario: a session containing an `Edit`.
- Expected behavior: `effect` is `"mutating"`, the record is text only, and nothing in the plan is
  executable (FR-26, NG-6).

**T-TRA-6 — excluded content never crosses**
- Scenario: a session carrying hidden reasoning, a system prompt, a developer prompt, an environment
  block with `OPENAI_API_KEY`, telemetry, and vendor model state.
- Expected behavior: none of it appears anywhere in the plan (FR-28, NG-7, NG-8).

**T-TRA-7 — the budget is the share of the window**
- Scenario: a table — a 200000-token window at 0.30; at 0.25; at 1; a 50000-token window at 0.30.
- Expected behavior: `budgetTokens` is the product rounded down: 60000, 50000, 200000, 15000 (FR-29,
  FR-30, and the requirement's own example).

**T-TRA-8 — the first request is pinned**
- Scenario: a long session where the oldest turn is the user's first request.
- Expected behavior: it is in `pins` with reason `"first-request"` and is never in `drops` (FR-32).

**T-TRA-9 — the last N turns are pinned**
- Scenario: parameterized over `pinnedRecentTurns` of 0, 1, 5 and 50 on a 20-turn session.
- Expected behavior: exactly the last N turns (or all of them when N exceeds the length) are pinned
  with reason `"recent-turn"` (FR-32, Q-2).

**T-TRA-10 — summaries and the changed-file list are pinned**
- Scenario: a session with two compaction summaries and three mutating calls.
- Expected behavior: both summaries are pinned with reason `"summary"`; the changed-file list is
  pinned with reason `"changed-files"` and holds the three paths (FR-32).

**T-TRA-11 — the oldest unpinned turns are dropped first**
- Scenario: a session that exceeds the budget by a known amount.
- Expected behavior: `drops` holds the lowest source indexes among the unpinned turns, in ascending
  order, and stops as soon as the plan fits (FR-31).

**T-TRA-12 — a call and its result are never split**
- Scenario: the budget cuts exactly at a tool call. In the canonical vocabulary the call and its
  outcome are one turn, so the cut cannot fall between them — the shape of `ToolCallRecord` is what
  enforces FR-34, and the test states it.
- Expected behavior: the turn is dropped whole or kept whole. A kept record never has its outcome
  stripped, and `drops` never names half of one (FR-34).

**T-TRA-13 — a broken tail is dropped**
- Scenario: a session whose last tool call has no result, as an agent that crashed would leave.
- Expected behavior: that call is in `drops` with reason `"broken-tail"`, `brokenTailDropped` is
  true, and the plan ends at the last complete turn (FR-54, FR-55).

**T-TRA-14 — pinned content over budget blocks**
- Scenario: a 1000-token budget with 5000 tokens of pinned content.
- Expected behavior: `blockedReason` is set and states what to change; no pin is dropped to make it
  fit (FR-32, FR-33).

**T-TRA-15 — the changed-file list comes from adapter provenance**
- Scenario: adapter provenance records `a.ts`, `b.ts`, duplicates and an empty entry, while arbitrary
  mutating tool arguments contain other strings.
- Expected behavior: `provenance.repo.changedPaths` holds only `a.ts` and `b.ts`, in order. Argument
  text is not parsed as a path.

**T-TRA-33 — every kept turn has a fixed framing cost**
- Scenario: one agent message whose visible text is empty.
- Expected behavior: `estimatedTokens` is positive because target formats add delimiters and message
  framing even when the content estimator returns zero.

### Integration Contract Tests

**T-TRA-16 — the counts reconcile**
- Scenario: a table of sessions of 0, 1, 20 and 500 turns at several budgets.
- Expected behavior: in every case `keptTurnCount` equals the length of `turns`,
  `keptTurnCount + droppedTurnCount` equals the source turn count after the broken tail is removed,
  and `drops` has exactly `droppedTurnCount` entries. The preview shows these numbers (FR-17).

**T-TRA-17 — the plan fits the budget when it is not blocked**
- Scenario: the same table.
- Expected behavior: whenever `blockedReason` is null, `estimatedTokens` is at most `budgetTokens`.

**T-TRA-18 — indexes are source indexes**
- Scenario: a session where turns 3, 4 and 5 are dropped.
- Expected behavior: `drops` names 3, 4 and 5, and the kept turns keep their original indexes — not
  a renumbering (FR-35).

**T-TRA-19 — the rules are pure**
- Scenario: `apply` is called 100 times with identical arguments, and from two separately constructed
  instances.
- Expected behavior: every plan is deeply equal. This is what lets `preview` and `commit` run in two
  processes and agree (FR-16, FR-20).

**T-TRA-20 — the rules never branch on the agent**
- Scenario: the same session and budget, with `TargetProfile.agent` set to each of the three values,
  and to a fake fourth value.
- Expected behavior: the plans are identical except for `target`. A different result for a different
  agent is a direct FR-60 violation.

### Boundary Tests

**T-TRA-21 — an empty session**
- Scenario: a session with zero turns.
- Expected behavior: a plan with zero turns, zero drops, no error and no block.

**T-TRA-22 — a session of only pinned turns, within budget**
- Scenario: three turns, all pinned, well inside the budget.
- Expected behavior: nothing is dropped and nothing is blocked.

**T-TRA-23 — a budget of exactly the estimate**
- Scenario: the estimate equals `budgetTokens` exactly.
- Expected behavior: nothing is dropped. The comparison is "at most", not "less than".

**T-TRA-24 — one turn larger than the whole budget**
- Scenario: a single unpinned turn whose estimate exceeds the budget; and the same turn pinned.
- Expected behavior: unpinned, it is dropped and the plan fits; pinned, the plan is blocked. A turn
  is never truncated to fit — FR-32 says word for word.

**T-TRA-25 — a tool call with no recorded outcome**
- Scenario: a call whose result the source did not record, but which is not the last turn.
- Expected behavior: `outcomeLine` states that the outcome was not recorded, in one line. It is not
  the broken-tail case, which applies only to the last call (FR-54).

**T-TRA-26 — an outcome that is many lines is reduced to one**
- Scenario: a source outcome containing line breaks.
- Expected behavior: `outcomeLine` has no line break (FR-23).

**T-TRA-27 — no input or output**
- Scenario: the suite runs with the filesystem, the network and the clock stubbed to throw.
- Expected behavior: every test passes.

**T-TRA-28 — a hostile session does not break the rules**
- Scenario: a turn of 10 MB, a session of 100000 turns, arguments containing null bytes, a tool name
  that is an empty string.
- Expected behavior: a valid plan in every case, within the documented time budget, with no
  exception.

### Behavior Tests

**T-TRA-29 — a large session leaves room to work**
- Scenario: a session resembling C-5's measurement — visible conversation about 10% of the file,
  reasoning about 41%, tool calls and outputs about 49% — against a 200000-token window at the
  default share.
- Expected behavior: the plan fits inside 30% of the window, and the visible conversation survives
  substantially intact, because the 90% that is reasoning and bodies never entered the plan (AC-5).

**T-TRA-30 — the same rules for all nine directions**
- Scenario: the same canonical session with `TargetProfile.agent` set to each of the three agents,
  and provenance from each of the three agents — nine combinations.
- Expected behavior: nine identical plans apart from `target` and `provenance` (FR-6, FR-60).

**T-TRA-31 — the thread survives the budget**
- Scenario: a 60-turn session cut to a 20% budget.
- Expected behavior: the first request, every summary, the changed-file list and the last five turns
  are all present. What was dropped is the middle — which is what makes AC's "the user explains
  nothing again" possible.

**T-TRA-32 — a same-agent move still drops bodies**
- Scenario: a Claude Code session with a `Read` result, planned for a Claude Code target in another
  home.
- Expected behavior: the body is dropped exactly as in a cross-agent import. FR-24 names this case
  explicitly, and NG-5 explains why: a different profile does not make old file contents fresh.
