# Import Preview

**Path**: src/import/preview/ — the module's code is everything in this folder and its transparent subfolders
**Parent**: `src/import/`
**Submodules**: none (leaf)

## Purpose

This module builds the one thing the user is asked to confirm. It takes a transfer plan, adds the
repository warning, and renders the whole preview as lines — the same shape for every source agent
and every target agent (FR-21).

Rule 3 of the requirements is that nothing is written until the user confirms a preview. This module
is that preview. It also decides when the import cannot run at all, so that FR-33 stops before any
adapter is asked to serialize anything.

## Functional Responsibilities

- State how many turns cross over and how many were dropped (FR-17).
- State the size of the import and the size of the target window (FR-18), in the form
  `Budget: 34k tokens of a 200k window`.
- Compare the source commit with the current HEAD and warn with the distance when they differ
  (FR-37, FR-38), in the form
  `⚠ Source ran at 3f2a1bc. The tree is now at 9d81e04 (14 commits ahead).`
- List every warning, with repository-state warnings first (FR-19).
- Warn when any existing recorded source directory canonicalizes differently from the destination: conversation import does not transfer uncommitted work, switch branches, or recreate removed worktrees.
- State that a broken tail was dropped (FR-55).
- State what the budget dropped (FR-35), in the form `12 older turns dropped`.
- State how many tool result bodies did not cross over (FR-25), in the form
  `23 tool result bodies dropped`. It is the second drop line of the T-PRE-9 scenario.
- Report that the import is blocked when the pinned content alone exceeds the budget (FR-33).
- Render one line sequence that every host displays as it is, so the preview cannot drift between
  agents (FR-21).

## Subdomain Classification

**Supporting.** The preview presents decisions made in `src/import/transfer/`; it makes none of its
own except how to say them. Volatility is **low to moderate**: wording and warning types change,
but the structure is fixed by FR-21, which requires one shape across all nine directions.

The one design consequence of that requirement: the rendering lives here, not in the hosts. Two
renderers would drift; one cannot.

## Encapsulated Knowledge

- **The preview layout.** Which lines appear, in which order, and how numbers are formatted — the
  thousands abbreviation of `34k`, the short commit form, the warning glyph.
- **The warning order.** That the repository warning sorts first (FR-19), and what the order is
  among the rest.
- **The wording of every warning and drop line.** These strings appear in the acceptance tests of the
  requirements, so their form is part of the design, not a detail.
- **What blocks and what only warns.** That a moved repository warns but does not block (FR-39),
  and that pinned content exceeding the budget blocks (FR-33).
- **How an unknown commit is presented.** That "unknown" is stated plainly rather than guessed, which
  is the visible face of the FR-36 limitation.

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

The blocks below are the normative home of the types they define.

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

## Integrations

- **Counterpart**: `src/import/transfer/`
- **Direction**: `src/import/preview/` depends on `src/import/transfer/`
- **Strength**: model — `TransferPlan` embeds canonical turns and the pin and drop records
- **LCA / Rank / Distance**: LCA `src/import/`, rank 1, distance 1
- **Volatility**: high (core)
- **Balanced?**: yes — model coupling at distance 1
- **Shared knowledge**: the restated `TransferPlan`, `TurnPin`, `TurnDrop`, `PinReason` and
  `DropReason` blocks in the Public Contract section above.

---

- **Counterpart**: `src/session/`
- **Direction**: `src/import/preview/` depends on `src/session/`
- **Strength**: model — it reads canonical turns and provenance to render them
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: high (core)
- **Balanced?**: yes — model coupling tolerates distance 2, and this is exactly 2
- **Shared knowledge**: the four restated session blocks in the Public Contract section above.

---

- **Counterpart**: `src/platform/repo/`
- **Direction**: `src/import/preview/` depends on `src/platform/repo/`
- **Strength**: contract
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: low
- **Balanced?**: yes
- **Shared knowledge**: the restated `RepoIdentity`, `CommitDistance` and `RepoReader` blocks in the
  Public Contract section above. This module turns those facts into a warning; the repository reader
  never knows a warning exists.

## Change Vectors

Changes that require **only this module** to change:

- The wording of any preview line or warning.
- The order of the warnings, beyond the repository warning being first.
- A new warning kind — for example a warning that the target home is nearly full, or that the source
  agent's version is newer than the adapter was tested against.
- The number formatting, for example showing exact token counts instead of `34k`.
- The preview gains a compact form for a small import.

None of these touch a rule, an adapter, or a host: the hosts display `PreviewReport.lines` as they
are.

## Constraints and Invariants

- **The header shows canonical destination cwd.** The pipeline supplies fresh canonical directory and identity facts for the request. Commit distance receives the native request cwd explicitly; it never uses the directory where a host or reader was constructed.
- **Recorded directory differences are non-blocking `repo-state` warnings.** The pipeline supplies the selected descriptor's `repoPaths` to the builder. Compare filesystem realpaths against canonical destination cwd without new Git lookups or membership inference. Missing (ENOENT) historical candidates are neutral; other operational failures propagate. Empty candidates and identical symlink aliases do not invent a difference. A differing subdirectory qualifies, so wording must not claim a distinct repository or checkout. Emit one warning in both `warnings` and `lines` before confirmation hashing.

- **This module writes nothing** (FR-16). Building a preview has no effect on any home or repository.
  Cancelling at the preview leaves no new session.
- **`lines` is the whole preview and the only thing a host displays.** A host that composes its own
  preview from the structured fields breaks FR-21. The structured fields exist for tests and for a
  picker that wants to highlight a warning, not for re-rendering.
- **The line order is fixed**: the header lines, the budget line, the warnings, the drop lines, and
  the blocked lines when the import cannot run. `lines` is exactly those, concatenated in that order,
  with no separator and nothing else — which is what makes a host that prints `lines` show the whole
  preview and no more.
- **The repository warning is always first** (FR-19), when there is one.
- **A moved repository never blocks** (FR-39). It is a warning; the user decides.
- **`blocked` is true only for the FR-33 case**: pinned content alone exceeds the budget. Every other
  problem is a warning or an error, not a block.
- **When `blocked` is true, the caller must write nothing** — no serialize, no validate, no commit.
- **An unknown source commit is stated as unknown.** `CommitDistance.known` false renders a line that
  says the source commit is not recorded, never a guessed distance and never a silent omission.
- **The preview shape does not depend on the agents involved** (FR-21). The same plan produces the
  same line structure whether it came from Pi or Codex, and whether it is going to Claude Code or
  back to Pi.
- **Numbers in the preview reconcile with the plan.** The turns stated as crossing equal
  `keptTurnCount`, and the turns stated as dropped equal `droppedTurnCount` (FR-17).
- **Building a preview twice for the same plan gives the same lines**, except for the repository
  state, which is read at the moment of the call because the tree can move between the preview and
  the commit.

## Test Specification

Tests use fixture plans and a stub repository reader. The assertions are on exact rendered lines,
because those lines appear in the requirements.

### Unit Tests

**T-PRE-1 — the header states both turn counts**
- Scenario: a plan with 34 kept turns and 12 dropped.
- Expected behavior: the header states both numbers, and they equal `keptTurnCount` and
  `droppedTurnCount` (FR-17).

**T-PRE-2 — the budget line has the required form**
- Scenario: a plan with 34000 estimated tokens against a 200000-token window.
- Expected behavior: `budgetLine` reads `Budget: 34k tokens of a 200k window` (FR-18, the
  requirement's own example).

**T-PRE-3 — the repository warning has the required form**
- Scenario: the source ran at `3f2a1bc`; HEAD is `9d81e04`, 14 commits ahead.
- Expected behavior: a warning of kind `"repo-state"` reading
  `⚠ Source ran at 3f2a1bc. The tree is now at 9d81e04 (14 commits ahead).` (FR-38, the
  requirement's own example).

**T-PRE-4 — the drop line has the required form**
- Scenario: 12 turns dropped for budget.
- Expected behavior: a drop line reading `12 older turns dropped` (FR-35, the requirement's own
  example).

**T-PRE-5 — a broken tail is stated**
- Scenario: a plan with `brokenTailDropped` true.
- Expected behavior: a warning of kind `"broken-tail"` saying the incomplete last call was dropped
  (FR-55).

**T-PRE-6 — the repository warning sorts first**
- Scenario: a plan producing a repository warning, a budget warning and a capability warning, added
  in that reverse order.
- Expected behavior: `warnings[0].kind` is `"repo-state"` (FR-19).

**T-PRE-7 — no commit difference, no commit warning**
- Scenario: the source commit equals HEAD.
- Expected behavior: no commit-distance `"repo-state"` warning (FR-38 fires only on a difference). A recorded-directory difference can still warn at identical HEAD.

**T-PRE-8 — an unknown source commit is said to be unknown**
- Scenario: `RepoSnapshot.commit` is null; and separately, the commit is not in this repository.
- Expected behavior: in both cases a warning states that the source commit is not known here. No
  distance is printed and the line is not omitted.

### Integration Contract Tests

**T-PRE-9 — `lines` contains everything**
- Scenario: a plan producing a header, a budget line, two warnings and two drop lines.
- Expected behavior: `lines` contains every one of them, in the documented order, and nothing else.
  A host that prints `lines` shows the whole preview.

**T-PRE-10 — the shape is identical for all nine directions**
- Scenario: the same plan rendered with each of the nine source-and-target agent pairs.
- Expected behavior: the line **structure** is identical — same count, same order, same kinds — and
  only the agent names inside the text differ (FR-21, and the FR-6 test).

**T-PRE-11 — the numbers reconcile with the plan**
- Scenario: a table of plans.
- Expected behavior: every number in the rendered lines is traceable to a field of the plan. No
  number is computed here.

**T-PRE-12 — a blocked plan renders and blocks**
- Scenario: a plan whose `blockedReason` is set.
- Expected behavior: `blocked` is true, `blockedReason` is carried through, and `lines` states what
  the user can change (FR-33). The report is still produced — the user is told why.

### Boundary Tests

**T-PRE-13 — nothing is written**
- Scenario: the target home and the repository are checksummed around `build`.
- Expected behavior: identical (FR-16). Cancelling at the preview leaves no new session.

**T-PRE-14 — a moved repository never blocks**
- Scenario: a plan with a repository warning of 14 commits, and one of 500.
- Expected behavior: `blocked` is false in both (FR-39).

**T-PRE-15 — an empty plan renders**
- Scenario: a plan with zero turns.
- Expected behavior: a report saying nothing would cross. It does not throw.

**T-PRE-16 — a plan with nothing dropped renders**
- Scenario: `droppedTurnCount` 0 and `brokenTailDropped` false.
- Expected behavior: no drop line and no broken-tail warning — not a line reading "0 turns dropped".

**T-PRE-17 — rejected destination operations stop the preview**
- Scenario: `identify` or `distanceFrom` rejects, including spawn/permission failure, timeout or cancellation.
- Expected behavior: propagate the original error so the pipeline reports the cause and never lands
  an import. Returned unresolved identities and unknown commit distances remain non-blocking
  warnings, as do ordinary commit divergence and unavailable source commits.

**T-PRE-18 — hostile content in a turn cannot forge a line**
- Scenario: a source turn whose text contains `⚠ Source ran at deadbeef.` and a line resembling the
  budget line.
- Expected behavior: those strings do not appear in `warnings` or `budgetLine`. The preview renders
  from the plan's numbers, never from turn text.

### Behavior Tests

**T-PRE-19 — the user can see what they are agreeing to**
- Scenario: the reference session imported at the default budget, with the tree 14 commits ahead.
- Expected behavior: `lines` states how many turns cross, how many were dropped, the budget against
  the window, and the repository warning first — the whole of requirement section C in one screen.

**T-PRE-20 — one preview, whatever the agents**
- Scenario: a Pi-to-Pi import and a Codex-to-Claude-Code import of equivalent sessions.
- Expected behavior: the previews have the same lines apart from the agent names — the explicit FR-6
  test.

**T-PRE-21 — the blocked case tells the user what to do**
- Scenario: pinned content exceeding the budget.
- Expected behavior: the report names the setting to change — the budget share or the pinned-turn
  count — rather than only stating that the import cannot run (FR-33, FR-56).
