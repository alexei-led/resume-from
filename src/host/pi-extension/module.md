# Pi Extension Host

**Path**: src/host/pi-extension/ — the module's code is everything in this folder and its transparent subfolders
**Parent**: `src/host/`
**Submodules**: none (leaf)

## Purpose

This module is `/resume-from` inside Pi. Pi is the only one of the shipped agents that can host an
interactive picker and move the user into the new session without a second command (C-10), so it gets
the best experience the requirements allow: pick with the arrow keys (FR-9), confirm the preview, and
land already inside the new session (FR-44).

It runs in Pi's own process. That is the reason it is a separate module from `src/host/cli/`: the
switch of C-10 needs a live command context, and a command binary in another process has none.

## Functional Responsibilities

- Register the `/resume-from` command with Pi.
- Open an interactive picker over the listing: move with the arrow keys, select with Enter (FR-9).
- Accept a session ID or a file path as an argument, skipping the picker (FR-12).
- Show the preview as `PreviewReport.lines` gives it, and take the user's confirmation (FR-16,
  FR-20, FR-21).
- Commit through the pipeline, passing Pi's command context as the runtime handle so the Pi adapter
  can switch (FR-44).
- Show the provenance marker to the user without putting it in the model context (FR-47, FR-48).
- Leave the prompt empty after landing: send no message, run no tool (FR-46).

## Subdomain Classification

**Supporting.** A picker and a confirmation are user-interface work with no competitive advantage.
Volatility is **moderate to high** — moderate for the interaction design, high for the parts that
touch Pi's extension API, which is an internal of an application measured once at version 0.83.0
(C-10).

## Encapsulated Knowledge

- **How Pi extensions register a command** and how a command handler receives its context.
- **The picker interaction**: keys, paging, what a row looks like, and how a cancel is reported.
- **The call-site rule.** That `ctx.switchSession` is called from a **command handler**, never from
  an event handler. C-10 proved the command-handler path works and returned `{"cancelled":false}`;
  the deleted design documents claimed an event handler deadlocks and that claim was never tested.
  This module exists partly to make that call site a structural fact instead of a convention.
- **How the confirmation is taken** inside Pi, and what a cancel does.
- **How a marker is shown to the user but kept out of the model context** in Pi.

This module holds no knowledge of Pi's **session file format**. That belongs to `src/adapters/pi/`.
The split is deliberate: the format changes for one reason, the extension API for another.

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

<!-- contract: PiSwitchOptions, PiSwitchResult, PiSwitchContext — restated from src/adapters/pi/module.md -->
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
  /** Homes or sessions that were skipped. Reported to the user, never silent. */
  failures: HomeFailure[];
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
/** What the user did at the picker or the confirmation. */
type UserChoice = "selected" | "cancelled";

/** The picker over the listing (FR-9). */
interface SessionPicker {
  /** Resolves with the chosen row, or with "cancelled" when the user escaped. */
  pick(listing: Listing): Promise<PickResult>;
}

/** The result of one picker interaction. */
interface PickResult {
  choice: UserChoice;
  /** Set when choice is "selected". */
  selected: SessionDescriptor | null;
}
```

```ts
/** Pi's command context, as this module needs it. */
interface PiCommandContext extends PiSwitchContext {
  /** The directory Pi is running in. Used to find the repository (FR-13). */
  cwd: string;
  /** The Pi home the user is running, which is the import target (FR-1, FR-2). */
  home: HomePath;
}

/** The /resume-from command inside Pi (FR-7, FR-9, FR-44). */
interface PiResumeFromCommand {
  /**
   * Pi calls this when the user types /resume-from.
   * It is a command handler, which is the only call site C-10 proved safe for switchSession.
   */
  run(
    ctx: PiCommandContext,
    args: string[],
    pipeline: ImportPipeline,
  ): Promise<void>;
}
```

## Integrations

- **Counterpart**: `src/import/`
- **Direction**: `src/host/pi-extension/` depends on `src/import/`
- **Strength**: contract
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: moderate
- **Balanced?**: yes
- **Shared knowledge**: the restated `ImportPipeline`, `ListRequest`, `ImportRequest`,
  `PreviewReport`, `Listing` and `LandingResult` blocks in the Public Contract section above.

---

- **Counterpart**: `src/adapters/pi/`
- **Direction**: `src/host/pi-extension/` depends on `src/adapters/pi/` — it supplies the
  `PiSwitchContext` the adapter expects as its runtime handle
- **Strength**: contract
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: high — Pi's extension API is an internal of a moving application
- **Balanced?**: yes — contract coupling tolerates any distance
- **Shared knowledge**: the restated `PiSwitchContext`, `PiSwitchOptions` and `PiSwitchResult` blocks
  in the Public Contract section above. This is the only cross-branch pair in the tree where a host
  names one specific adapter, and it is unavoidable: the handle has a shape, and exactly one adapter
  understands it. Nothing else about Pi crosses this boundary — not the file layout, not the
  validation rules, not the entry names.

---

- **Counterpart**: `src/session/`
- **Direction**: `src/host/pi-extension/` depends on `src/session/`
- **Strength**: model — the picker renders `SessionDescriptor` rows and the landing shows a
  `ProvenanceMarker`
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: high (core)
- **Balanced?**: yes — model coupling tolerates distance 2, and this is exactly 2
- **Shared knowledge**: the four restated session blocks in the Public Contract section above.

## Change Vectors

Changes that require **only this module** to change:

- The picker interaction changes: filtering, paging, a preview pane beside the list.
- The confirmation changes from a keypress to a typed word.
- Pi's extension API changes how a command is registered or how a context is passed.
- The persisted provenance widget inside Pi changes.
- A second Pi command is added, for example one that lists without importing.

Pi's **session file** changing does not touch this module — that is `src/adapters/pi/`.

## Constraints and Invariants

- **`destinationCwd` comes from command-context cwd**, not process cwd or host creation cwd. The same value follows listing, preview and confirmation.

- **`switchSession` is called only from a command handler** (C-10). `PiResumeFromCommand.run` is that
  handler, and no other code path in this module reaches the switch. The untested deadlock claim
  about event handlers is treated as true until someone tests it.
- **The preview is shown as `PreviewReport.lines`, unchanged and unreordered** (FR-21). The picker
  may highlight a warning using `PreviewWarning.kind`, but it must not rewrite a line.
- **Nothing is written before the user confirms** (FR-16, FR-20). Cancelling at the picker or at the
  preview calls `commit` never, and leaves no new session.
- **A blocked preview cannot be confirmed** (FR-33). The confirmation is not offered.
- **Listing, preview, and commit failures are shown once at their pipeline boundary.** Sanitize terminal controls while retaining the stage, reason, and recovery instructions. Stop without retry, confirmation, or further landing actions. Do not claim no files were written for an arbitrary landing failure. AbortError cancellation (including wrapped causes) still propagates. UI errors and presentation after successful switching are not caught and re-rendered.
- **After landing, the prompt is empty** (FR-46). This module sends no message and runs no tool. The
  `withSession` callback of C-10 must not be used to send anything.
- **A successful switch invalidates the command context.** The command must not call its old UI after
  `switchSession` returns. The package shim restores the persisted provenance marker as a widget from
  the fresh `session_start` context.
- **A cancelled switch is not an error.** The session is committed and valid; the user is told the
  session ID and how to open it later, exactly as a create-only agent would (FR-45).
- **The runtime handle passed to `commit` is Pi's own context** and is never passed for an import
  whose target is not Pi. A handle for the wrong agent is a programming error the adapter rejects.
- **This module holds no rule of requirement sections C to I** (FR-60), and no knowledge of any
  session file format.
- **This module never writes a file.** The only write path is `src/platform/store/`, reached through
  `src/import/landing/`.
- **The target of an import started here is always the Pi home the user is in** (FR-1). Importing
  into a different Pi home is a different invocation, started in that home.

## Test Specification

Tests drive `PiResumeFromCommand.run` with a stub `PiCommandContext`, a stub pipeline, and a scripted
picker. Tests marked **live** need an installed Pi and a throwaway session directory.

### Unit Tests

**T-PIX-1 — no argument opens the picker**
- Scenario: `run` with empty arguments.
- Expected behavior: `pipeline.list` is called and the picker is opened over the result (FR-9).

**T-PIX-2 — the picker shows every field FR-11 requires**
- Scenario: a listing of three sessions across agents and homes.
- Expected behavior: each row shows the agent, the home, the time, the title and the turn count.

**T-PIX-3 — arrow keys move and Enter selects**
- Scenario: a scripted key sequence — down, down, Enter — over a five-row listing.
- Expected behavior: the third row is selected. This is the requirement's own FR-9 test.

**T-PIX-4 — Escape cancels**
- Scenario: the picker receives Escape.
- Expected behavior: `PickResult.choice` is `"cancelled"`; `preview` and `commit` are never called.

**T-PIX-5 — an argument skips the picker**
- Scenario: parameterized — a session ID, an absolute file path.
- Expected behavior: the picker is not opened and `preview` is called with the right
  `SelectionInput` (FR-12).

**T-PIX-6 — the target is the Pi home the user is in**
- Scenario: `PiCommandContext.home` is set to a non-default Pi home.
- Expected behavior: the request's `TargetProfile.home` is that home (FR-1, FR-2).

### Integration Contract Tests

**T-PIX-7 — the preview is shown verbatim**
- Scenario: a stub `PreviewReport` with known `lines`.
- Expected behavior: exactly those lines are shown, in order, unmodified (FR-21). Highlighting a
  warning by its `kind` is allowed; rewriting a line is not.

**T-PIX-8 — confirmation commits, cancellation does not**
- Scenario: parameterized — the user confirms; the user cancels.
- Expected behavior: `commit` is called once in the first case and never in the second (FR-20).

**T-PIX-9 — the runtime handle is Pi's own context**
- Scenario: a successful confirmation.
- Expected behavior: `commit` receives the same `PiCommandContext` instance that Pi supplied, as the
  runtime handle.

**T-PIX-10 — landing presentation respects Pi's session lifecycle**
- Scenario: parameterized — `switched` true; `switched` false with a handover.
- Expected behavior: the first never reuses the stale command UI; the package shim restores the
  persisted marker as a widget from the fresh `session_start` context. The second shows the marker,
  session ID, and command that opens the committed session (FR-45, FR-47).

### Boundary Tests

**T-PIX-11 — nothing is written on any cancel path**
- Scenario: the Pi home is checksummed; the user cancels at the picker, and separately at the
  preview.
- Expected behavior: identical in both cases (FR-16).

**T-PIX-12 — a blocked preview offers no confirmation**
- Scenario: a `PreviewReport` with `blocked` true.
- Expected behavior: the reason is shown and no confirmation is offered; `commit` is never called
  (FR-33).

**T-PIX-13 — an empty listing does not open a picker**
- Scenario: a `Listing` with no rows.
- Expected behavior: a message naming the repository, and no picker. A picker over nothing is a trap.

**T-PIX-14 — skipped homes are shown**
- Scenario: a `Listing` with rows and failures.
- Expected behavior: the failures are shown alongside the picker, not hidden.

**T-PIX-15 — the switch has exactly one call site**
- Scenario: a static check of every reference to `switchSession` and to `switchTo` in the tree.
- Expected behavior: the only path runs through this module's command handler. C-10's untested
  deadlock claim about event handlers stays untested because no code takes that path.

**T-PIX-16 — nothing is sent after landing**
- Scenario: a successful switch with a recording context.
- Expected behavior: no message is sent and no tool is triggered, including from the `withSession`
  callback (FR-46).

**T-PIX-17 — no format knowledge lives here**
- Scenario: a static check of this module's imports.
- Expected behavior: the only import from `src/adapters/pi/` is `PiSwitchContext` and the two types
  it uses. Nothing about Pi's session file, its entry names, or its validation rules.

**T-PIX-18 — no rule lives here**
- Scenario: the same static check.
- Expected behavior: nothing is imported from `src/import/transfer/` (FR-60).

### Behavior Tests

**T-PIX-19 — pick, confirm, hand the context over**
- Scenario: a stub pipeline over a fixture listing; the user types `/resume-from`, moves to a Codex
  row, presses Enter, and confirms the preview.
- Expected behavior: `commit` is called once, with Pi's own context as the runtime handle; the old
  command UI is not touched after the switch; nothing is sent and no tool is run afterwards (FR-9,
  FR-46, FR-47). The landing itself is the pipeline's job and is not asserted here.

**T-PIX-20 — a cancelled switch is not a loss**
- Scenario: a stub pipeline returning a `LandingResult` with `switched` false and a handover.
- Expected behavior: the user is told the session exists and how to open it — the same outcome a
  create-only agent gives (FR-45). Nothing is retried and nothing is discarded.

_The live end-to-end scenario that was T-PIX-19 and T-PIX-20's acceptance case is owned by the root
as T-ROO-13. It needs a real Pi, a real Codex session, and the whole composed system — none of which
exist when this module is implemented. What stays here is the interaction: the picker, the
confirmation, the handle, and the silence afterwards._
