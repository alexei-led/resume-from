# Command Line Host

**Path**: src/host/cli/ — the module's code is everything in this folder and its transparent subfolders
**Parent**: `src/host/`
**Submodules**: none (leaf)

## Purpose

This module is `/resume-from` for every agent that cannot host a picker of its own. C-1 states that
the command set of Codex and Claude Code is fixed, so our command cannot open an interactive
selection inside them. FR-10 is the answer: print a numbered list, and let the user run the command
again with a number.

The module is a command binary. The Codex prompt file and the Claude Code slash-command file both
call it, and it prints to standard output. It holds no rule — it turns arguments into pipeline calls
and pipeline results into text.

## Functional Responsibilities

- Parse the invocation: no argument, a row number, a session ID, a file path, an agent name, a home
  path (FR-2, FR-10, FR-12, FR-15).
- With no selection: print the numbered list — agent, home, time, title, turn count — newest first
  (FR-11, FR-14), and print skipped entries (homes or sessions) with their diagnostics — and
  the count of sessions that belong to other repositories as one line (FR-13's normal case,
  not one narration per session).
- With a selection and no confirmation: print the preview exactly as `PreviewReport.lines` gives it
  (FR-16, FR-21), and print how to confirm.
- With a confirmation: run the commit and print the outcome — the new session ID and the native
  command that opens it (FR-45), or the provenance marker when the target cannot show one itself
  (FR-47, FR-48).
- Exit with a code the caller can act on: success, refused, or error.
- Print an error that says what failed and what to do next (FR-56).

## Subdomain Classification

**Supporting.** Argument parsing and text output are not a competitive advantage. Volatility is
**moderate**: the wording of the invitation to confirm and the flag names will be adjusted with use,
but the three-step shape is fixed by C-1 and FR-10.

## Encapsulated Knowledge

- **The three-step invocation.** That `/resume-from` lists, `/resume-from <n>` previews, and
  `/resume-from <n> --confirm <token>` commits — and that these are three separate processes with no shared
  state, which is why the pipeline recomputes.
- **The flag and argument grammar**, including how a row number is told apart from a session ID and
  a file path.
- **The row numbering.** That rows are 1-based and match the ordering the pipeline produced, so the
  number the user types in the second invocation means what they saw in the first.
- **The output layout** of the numbered list, and how it stays readable in a terminal the tool does
  not control.
- **The exit codes** and what each means to the shim that called the binary.
- **Which agent it is running inside.** The shim tells it; the binary does not guess.

## Public Contract

<!-- contract: AgentId, HomePath, SessionId, SessionRef — restated from src/session/module.md -->
```ts
/** Which agent produced or receives a session. Adding an agent adds one value (FR-57). */
type AgentId = "pi" | "codex" | "claude-code";

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

<!-- contract: AgentRuntime — restated from src/import/module.md -->
```ts
/**
 * An opaque handle supplied by the host of the same agent, for example Pi's
 * command context. Nothing outside the adapter of that agent inspects it.
 */
type AgentRuntime = unknown;
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
  /** Homes or sessions skipped for a reason the user can act on. Reported, never silent. */
  failures: HomeFailure[];
  /**
   * Sessions that do not belong to this repository (FR-13): no candidate matched, with no
   * contradictory evidence — every surviving candidate resolved elsewhere, every recorded
   * directory is gone, or both. A deleted worktree of this repository is indistinguishable
   * from a deleted foreign one, and neither can be imported. Searching a whole home makes
   * this the normal case, so it is counted, not narrated row by row.
   */
  excluded: number;
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

The blocks below are the normative home of the types they define.

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

## Integrations

- **Counterpart**: `src/import/`
- **Direction**: `src/host/cli/` depends on `src/import/`
- **Strength**: contract — three calls and their results
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: moderate
- **Balanced?**: yes — contract coupling tolerates any distance
- **Shared knowledge**: the restated `ImportPipeline`, `ListRequest`, `ImportRequest`,
  `PreviewReport`, `Listing` and `LandingResult` blocks in the Public Contract section above.

---

- **Counterpart**: `src/session/`
- **Direction**: `src/host/cli/` depends on `src/session/`
- **Strength**: model — it renders `SessionDescriptor` rows and a `ProvenanceMarker`
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: high (core)
- **Balanced?**: yes — model coupling tolerates distance 2, and this is exactly 2
- **Shared knowledge**: the four restated session blocks in the Public Contract section above. The
  row layout of FR-11 needs the descriptor's fields; nothing more of the vocabulary is used here.

This module does not integrate with `src/adapters/` at all. It receives a built pipeline from
`src/host/` and passes `null` as the runtime handle, because neither Codex nor Claude Code can move
the user (C-2).

## Change Vectors

Changes that require **only this module** to change:

- The confirmation flag changes, or confirmation moves to a prompt when the terminal is interactive.
- The numbered-list layout changes: columns, widths, relative times.
- A new argument is added, for example a flag that lists only one agent.
- The exit codes change.
- Colour or width handling is added for terminals that support it.

A new agent that also cannot host a picker needs **no change here**: it gets the numbered list
because its adapter declares `selection: "numbered-list"` (FR-58).

## Constraints and Invariants

- **`destinationCwd` comes from invocation cwd**, unchanged, including subdirectories and symlink spelling. It is the sole destination input on both list and import requests.

- **This module holds no rule of requirement sections C to I** (FR-60). It parses, calls, and prints.
  Any decision it appears to make is a decision the pipeline already made.
- **The preview is printed as `PreviewReport.lines`, unchanged and unreordered** (FR-21). This module
  must not compose its own preview from the structured fields; that is how two hosts drift.
- **Nothing is written without `--confirm`** (FR-16, FR-20). An invocation without it calls `preview`
  and never `commit`.
- **A blocked preview exits 1 and calls nothing further** (FR-33).
- **Row numbers are 1-based and match the order that was printed** (FR-10, FR-14). The binary passes
  the number through as a `SelectionInput`; the pipeline resolves it against the same ordering.
- **The three invocations share no state.** No temporary file, no cache, no environment variable
  carrying a plan. The pipeline recomputes, and that is the only mechanism.
- **The runtime handle is always `null` here** (C-2). A host that can move the user is a different
  module; see `src/host/pi-extension/`.
- **Errors go to standard error and exit non-zero, with what failed and what to do next** (FR-56).
  The list and the preview go to standard output, so a shim can show them to the user as they are.
- **Homes that could not be read are printed, never hidden.** `Listing.failures` is part of the
  output; a shorter list with no explanation is worse than a warning.
- **The binary never resolves which agent it is in by inspecting the environment.** `targetAgent`
  comes from the shim. Guessing would make the same binary behave differently by accident.
- **No interactive prompt is used inside Codex or Claude Code.** C-1 makes it impossible to rely on
  one, and FR-10 defines the alternative.

## Test Specification

Tests drive `CliRunner.run` with a stub pipeline and assert on the returned `CliOutcome`. No process
is spawned and no terminal is required.

### Unit Tests

**T-CLI-1 — no argument lists**
- Scenario: an invocation with an empty `argv`.
- Expected behavior: `pipeline.list` is called, `preview` and `commit` are not, and standard output
  holds one numbered row per session.

**T-CLI-2 — a row shows every field FR-11 requires**
- Scenario: a listing of three sessions across two agents and two homes.
- Expected behavior: each row shows the agent, the home, the time, the title and the turn count.

**T-CLI-3 — rows are numbered from 1, newest first**
- Scenario: a listing of ten sessions.
- Expected behavior: rows are numbered 1 to 10 in the order the pipeline returned them (FR-10,
  FR-14).

**T-CLI-4 — a number previews**
- Scenario: `argv` is `["3"]`.
- Expected behavior: `preview` is called with a `SelectionInput` of `{ by: "row", row: 3 }`, and
  `commit` is not (FR-10).

**T-CLI-5 — a session ID and a file path are told apart**
- Scenario: parameterized — a session ID, an absolute path, a relative path, a bare number.
- Expected behavior: each produces the right `SelectionInput` variant (FR-12).

**T-CLI-6 — the agent and home flags are parsed**
- Scenario: `argv` is `["claude", "--home", "~/.claude-team"]`.
- Expected behavior: `onlyAgent` is `claude-code` and `onlyHome` is the resolved absolute path —
  the requirement's own FR-2 example.

**T-CLI-7 — the confirmation flag commits**
- Scenario: `argv` is `["3", "--confirm", "<token from preview>"]`.
- Expected behavior: `commit` is called with the same request the preview used, and the runtime
  handle is `null`.

### Integration Contract Tests

**T-CLI-8 — the preview is printed verbatim**
- Scenario: a stub returning a `PreviewReport` whose `lines` are known.
- Expected behavior: standard output holds exactly those lines, in that order, with nothing inserted,
  reordered or reformatted (FR-21).

**T-CLI-9 — the preview is never recomposed**
- Scenario: a report whose `lines` deliberately disagree with its structured fields.
- Expected behavior: the output follows `lines`. This test fails if the module ever starts rendering
  from the fields.

**T-CLI-10 — the landing outcome is printed**
- Scenario: a `LandingResult` with `switched` false and a handover.
- Expected behavior: the session ID and the exact command are printed (FR-45), and the marker is
  printed when the target could not show one itself (FR-47, FR-48).

**T-CLI-11 — exit codes**
- Scenario: a table — a successful listing, a successful preview, a successful commit, a blocked
  preview, an unknown row, a landing failure.
- Expected behavior: 0 for the first three, 1 for the blocked preview, 2 for the two failures.

**T-CLI-12 — errors go to standard error with a next step**
- Scenario: every failing case above.
- Expected behavior: standard output is empty, standard error states what failed and what to do next
  (FR-56).

### Boundary Tests

**T-CLI-13 — nothing is written without the confirmation flag**
- Scenario: parameterized over no argument, a row, a session ID and a path — none with `--confirm`.
- Expected behavior: `commit` is never called in any case (FR-16, FR-20).

**T-CLI-14 — a blocked preview cannot be confirmed**
- Scenario: `--confirm` on a request whose preview is blocked.
- Expected behavior: exit 1, nothing committed (FR-33).

**T-CLI-15 — malformed arguments fail with a usage message**
- Scenario: a table — `["0"]`, `["-3"]`, `["3.5"]`, `["--home"]` with no value, an unknown flag, an
  unknown agent name.
- Expected behavior: exit 2 and a message naming the problem and the correct form.

**T-CLI-16 — skipped homes are printed**
- Scenario: a `Listing` with two rows and three failures.
- Expected behavior: both rows and all three failures appear. A short list with no explanation is not
  acceptable.

**T-CLI-17 — an empty listing says so**
- Scenario: `Listing` with no rows and no failures.
- Expected behavior: exit 0 and a line saying no session of this repository was found, with the
  repository named.

**T-CLI-18 — the target agent is never guessed**
- Scenario: the invocation's `targetAgent` is set to each of the three agents while the environment
  is made to suggest a different one.
- Expected behavior: the request always names the agent the shim stated. No environment variable is
  consulted.

**T-CLI-19 — the runtime handle is always null**
- Scenario: every `commit` in this suite.
- Expected behavior: the handle is `null` (C-2).

**T-CLI-20 — no rule lives here**
- Scenario: a static check of this module's imports.
- Expected behavior: it imports no rule from `src/import/transfer/` and no adapter. Only the pipeline
  contract and the session vocabulary (FR-60).

### Behavior Tests

**T-CLI-21 — the FR-10 sequence**
- Scenario: `/resume-from` prints ten rows; `/resume-from 3` opens the preview of row 3;
  `/resume-from 3 --confirm <token>` lands it — three separate runs with no shared state.
- Expected behavior: exactly the requirement's own test, and the session landed is the one shown on
  row 3.

**T-CLI-22 — the same shape from Codex and from Claude Code**
- Scenario: the same request run with `targetAgent` `codex` and then `claude-code`.
- Expected behavior: the same output structure. Only the handover command differs, because it comes
  from the adapter (FR-21, FR-45).

**T-CLI-23 — a new numbered-list agent needs no change here**
- Scenario: a fake fourth agent declaring `"numbered-list"` is used as the target.
- Expected behavior: it gets the numbered list and the handover with no edit to this module (FR-58,
  AC-7).

**T-CLI-24 — the shim home is resolved before reaching the pipeline**
- Scenario: `createCliRunner` is given a `TargetProfile` whose `home` is the resolved form of
  `invocation.targetHome` (e.g. `~/alt-home` resolved to `/Users/me/alt-home` by the profile
  builder). The invocation carries the raw tilde path.
- Expected behavior: the pipeline receives the resolved absolute home, not the raw string. Proves
  that preferring `fallback?.home` over `invocation.targetHome` is the correct precedence (FR-3).
