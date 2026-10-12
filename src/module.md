# resume-from

**Path**: src/ — the module's code is everything in this folder and its transparent subfolders, excluding the submodule folders `session/`, `adapters/`, `import/`, `host/`, `platform/`
**Parent**: none (root)
**Submodules**: `session/`, `adapters/`, `import/`, `host/`, `platform/`

## Purpose

`resume-from` continues a coding session in a different agent, or in a different profile of the same
agent. The user types `/resume-from` in the agent they want to land in, picks a session another agent
already wrote, confirms a preview, and keeps working. Nothing is explained twice.

Without this module there is no package: no entry point, no agent list, and no wiring that turns five
independent branches into one working tool. This document is also the architecture overview of the
whole system — the module map, the flows, the complete coupling assessment, and the decisions that
shaped the tree.

## Functional Responsibilities

- Expose the package entry point that builds a working host (`createHost`).
- Own the composition order: configuration first, then the agent list, then the pipeline, then the
  host that the user talks to.
- Guarantee that the rules of requirement sections C to I run in one place for all nine directions
  (FR-6, FR-60), whatever the source agent and the target agent are.
- Hold the architecture: which module owns which knowledge, and why the tree has this shape.

## Subdomain Classification

**Core.** The system as a whole is the product's competitive advantage: moving a working session
between agents without losing the thread. Volatility is **high** — the transfer policy has two
undecided constants (Q-1 budget share, Q-2 pinned turn count) and the agent list grows (FR-57).

The high volatility of the root is the reason the tree is flat: every module that shares the
canonical session vocabulary must stay within the model-coupling distance threshold.

## Encapsulated Knowledge

- **The composition order.** Which module is built from which, and in what order. No submodule knows
  how the whole is assembled.
- **The agent list is not here.** It lives in `src/host/`. The root knows only that a host exists.
- **The architecture rationale.** Why depth is capped at 2, why adapters never write files, and why
  the registry sits in the host. Submodules state their own constraints; only this file states the
  reasons that span the tree.

## Public Contract

```ts
/** The package entry point (FR-57: adding an agent never changes this file). */
interface ResumeFrom {
  /**
   * Loads configuration, builds the agent list, and returns the host wiring.
   * Called once by the command binary and once by the Pi extension.
   */
  createHost(): Promise<HostWiring>;
}
```

<!-- contract: HostWiring — restated from src/host/module.md (subset: omits registry) -->
```ts
/** Builds one pipeline for one target agent. */
interface HostWiring {
  pipelineFor(target: TargetProfile): Promise<ImportPipeline>;
}
```

<!-- contract: TargetProfile — restated from src/host/module.md -->
```ts
/** Where the import is going, and how much room it has (FR-18, FR-29). */
interface TargetProfile {
  agent: AgentId;
  home: HomePath;
  /** Context window of the target, in tokens. */
  windowTokens: number;
}
```

<!-- contract: AgentId, HomePath, SessionId, SessionRef — restated from src/host/module.md -->
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

<!-- contract: ImportPipeline — restated from src/host/module.md (subset: omits list and preview) -->
```ts
/** One import, from listing to landing. Every host drives these three calls. */
interface ImportPipeline {
  /** Runs only after the user confirmed the preview (FR-20). */
  commit(
    request: ImportRequest,
    runtime: AgentRuntime,
    confirmationToken: string,
  ): Promise<LandingResult>;
}
```

<!-- contract: ImportRequest — restated from src/host/module.md (subset: omits ListRequest) -->
```ts
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

<!-- contract: SelectionInput — restated from src/host/module.md -->
```ts
/** How the user named the session to import (FR-12). */
type SelectionInput =
  | { by: "row"; row: number }
  | { by: "session-id"; id: SessionId }
  | { by: "file-path"; path: string };
```

<!-- contract: AgentRuntime — restated from src/host/module.md -->
```ts
/**
 * An opaque handle supplied by the host of the same agent, for example Pi's
 * command context. Nothing outside the adapter of that agent inspects it.
 */
type AgentRuntime = unknown;
```

<!-- contract: HandoverInstruction, LandingResult — restated from src/host/module.md (subset: omits marker) -->
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
}
```

## Integrations

- **Counterpart**: `src/host/`
- **Direction**: `src/` depends on `src/host/`
- **Strength**: contract
- **LCA / Rank / Distance**: LCA `src/`, rank 1, distance 1
- **Volatility**: moderate — the host changes when an agent is added (FR-57)
- **Balanced?**: yes (contract tolerates any distance)
- **Shared knowledge**: the root calls `pipelineFor` and nothing else. The restated `HostWiring`,
  `TargetProfile`, `AgentId`, `HomePath`, `SessionId`, `SessionRef`, `ImportPipeline`,
  `ImportRequest`, `SelectionInput`, `AgentRuntime`, `HandoverInstruction` and `LandingResult`
  blocks in the Public Contract section above are the whole of it. Every one of them is restated
  from `src/host/module.md`, which re-publishes them. Only `HostWiring` and `AgentRegistry` are
  owned there; the rest originate deeper in the tree and reach the root through the host façade.
  Markers cite the host because the host is the module this one integrates with.

The root does not integrate with `session/`, `adapters/`, `import/` or `platform/` directly. It
reaches them only through `src/host/`. That is deliberate: it keeps the composition order in one
place and stops the entry point from growing a second wiring path.

## Internal Design

### Module map

```text
src/                            resume-from — the system
├── session/                    canonical session model (the neutral vocabulary)
├── adapters/                   agent adapter port and capability model
│   ├── pi/                     Pi format, capabilities, in-process switch
│   ├── codex/                  Codex format — event_msg entries (C-7, C-8)
│   └── claude-code/            Claude Code format — two entry types (C-9)
├── import/                     the import pipeline
│   ├── discovery/              find, filter to the repository, resolve, load
│   ├── transfer/               what crosses over and how much — the core rules
│   ├── preview/                the plan the user confirms
│   └── landing/                validate, commit, reconcile, hand over
├── host/                       where /resume-from is typed; owns the agent list
│   ├── cli/                    numbered list and preview on stdout
│   └── pi-extension/           in-process; supplies Pi's context for the switch
└── platform/                   generic services, each behind a contract
    ├── config/                 extra homes, budget share, pinned turn count
    ├── repo/                   git: repository identity and commit distance
    ├── tokens/                 token estimation
    └── store/                  atomic, add-only commit into a target home
```

### What each submodule contributes

| Submodule   | Contribution                                                                           |
| ----------- | -------------------------------------------------------------------------------------- |
| `session/`  | The one neutral vocabulary every rule runs on. Nothing else defines a turn.            |
| `adapters/` | The port: read an agent's sessions, serialize into its format, declare what it can do. |
| `import/`   | The pipeline: list, preview, commit. It owns the order of the four stages.             |
| `host/`     | The agent list and the two entry points. It is the composition root.                   |
| `platform/` | Git, tokens, configuration, and the guarded write path. All replaceable.               |

### The root's own files

Two, and both are doors rather than machinery:

| File       | What it is                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts` | The package entry point. It re-exports `createHost`, the command-binary start and the Pi activation from `src/host/`, and builds nothing itself.      |
| `bin.ts`   | The command binary. It reads the two facts only the caller knows — which agent it is running inside, and which home — and hands the rest to the host. |

`bin.ts` is here rather than in `src/host/cli/`, even though that module _is_ the command binary,
because a process entry point must reach the composition root and `src/host/cli/` may not: its own
boundary rule allows a cross-module import only to a `contract.js` (T-CLI-20), and an import of its
parent would make the module graph cyclic (T-HOS-17, T-ROO-7). The root is the one module the
design already lets depend on `src/host/`, so the shebang lives here and the binary's whole
behaviour stays in `src/host/`. Nothing else moves.

### Key functional flows

**Flow 1 — list (FR-7 to FR-15).** The host reads configuration, asks every source adapter for the
sessions in its default home and in every extra home, keeps only the sessions of the current
repository, orders them newest first, and renders them as a picker (Pi) or a numbered list (Codex,
Claude Code).

**Flow 2 — preview (FR-16 to FR-21, FR-29 to FR-39).** The host resolves the user's choice to one
descriptor, `discovery` loads it into the canonical model through the source adapter, `transfer`
applies the content rules and the budget, `preview` adds the repository warning and renders the
lines. Nothing is written.

**Flow 3 — commit (FR-40 to FR-53).** The same request runs again. `landing` asks the target adapter
to serialize the plan, validates the result before placement, commits the files atomically through
`platform/store`, reads the session back and compares item counts, then either switches the user in
or returns the command that opens the session.

**Flow 4 — failure (FR-53 to FR-56).** Any failure after the commit rolls the commit back, so the
target holds either a complete session or nothing.

The nine directions of the scope table are the same three flows. The source agent changes which
adapter `discovery` calls; the target agent changes which adapter `landing` calls. No rule between
those two points knows either name.

### Complete coupling assessment

| Integration                                | Strength | LCA          | Rank | Distance | Volatility  | Balanced?          | Action |
| ------------------------------------------ | -------- | ------------ | ---- | -------- | ----------- | ------------------ | ------ |
| src → src/host                             | Contract | src          | 1    | 1        | Moderate    | Yes                | —      |
| src/adapters → src/session                 | Model    | src          | 1    | 1        | High (core) | Yes                | —      |
| src/adapters → src/platform/store          | Contract | src          | 2    | 2        | Low         | Yes                | —      |
| src/adapters/pi → src/session              | Model    | src          | 2    | 2        | High (core) | Yes (at threshold) | —      |
| src/adapters/codex → src/session           | Model    | src          | 2    | 2        | High (core) | Yes (at threshold) | —      |
| src/adapters/claude-code → src/session     | Model    | src          | 2    | 2        | High (core) | Yes (at threshold) | —      |
| src/adapters/kimi-code → src/session       | Model    | src          | 2    | 2        | High (core) | Yes (at threshold) | —      |
| src/adapters/pi → src/adapters             | Contract | src/adapters | 1    | 1        | High        | Yes                | —      |
| src/adapters/codex → src/adapters          | Contract | src/adapters | 1    | 1        | High        | Yes                | —      |
| src/adapters/claude-code → src/adapters    | Contract | src/adapters | 1    | 1        | High        | Yes                | —      |
| src/adapters/kimi-code → src/adapters      | Contract | src/adapters | 1    | 1        | High        | Yes                | —      |
| src/import → src/import/discovery          | Contract | src/import   | 1    | 1        | High        | Yes                | —      |
| src/import → src/import/transfer           | Contract | src/import   | 1    | 1        | High        | Yes                | —      |
| src/import → src/import/preview            | Contract | src/import   | 1    | 1        | High        | Yes                | —      |
| src/import → src/import/landing            | Contract | src/import   | 1    | 1        | High        | Yes                | —      |
| src/import → src/session                   | Model    | src          | 1    | 1        | High (core) | Yes                | —      |
| src/import → src/adapters                  | Contract | src          | 1    | 1        | High        | Yes                | —      |
| src/import → src/platform/config           | Contract | src          | 2    | 2        | Low         | Yes                | —      |
| src/import → src/platform/tokens           | Contract | src          | 2    | 2        | Low         | Yes                | —      |
| src/import → src/platform/store            | Contract | src          | 2    | 2        | Low         | Yes                | —      |
| src/import/discovery → src/session         | Model    | src          | 2    | 2        | High (core) | Yes (at threshold) | —      |
| src/import/transfer → src/session          | Model    | src          | 2    | 2        | High (core) | Yes (at threshold) | —      |
| src/import/preview → src/session           | Model    | src          | 2    | 2        | High (core) | Yes (at threshold) | —      |
| src/import/landing → src/session           | Model    | src          | 2    | 2        | High (core) | Yes (at threshold) | —      |
| src/import/preview → src/import/transfer   | Model    | src/import   | 1    | 1        | High (core) | Yes                | —      |
| src/import/landing → src/import/transfer   | Model    | src/import   | 1    | 1        | High (core) | Yes                | —      |
| src/import/discovery → src/adapters        | Contract | src          | 2    | 2        | High        | Yes                | —      |
| src/import/landing → src/adapters          | Contract | src          | 2    | 2        | High        | Yes                | —      |
| src/import/discovery → src/platform/repo   | Contract | src          | 2    | 2        | Low         | Yes                | —      |
| src/import/discovery → src/platform/config | Contract | src          | 2    | 2        | Low         | Yes                | —      |
| src/import/transfer → src/platform/tokens  | Contract | src          | 2    | 2        | Low         | Yes                | —      |
| src/import/transfer → src/platform/config  | Contract | src          | 2    | 2        | Low         | Yes                | —      |
| src/import/preview → src/platform/repo     | Contract | src          | 2    | 2        | Low         | Yes                | —      |
| src/import/landing → src/platform/store    | Contract | src          | 2    | 2        | Low         | Yes                | —      |
| src/platform → src/platform/config         | Contract | src/platform | 1    | 1        | Low         | Yes                | —      |
| src/platform → src/platform/repo           | Contract | src/platform | 1    | 1        | Low         | Yes                | —      |
| src/platform → src/platform/tokens         | Contract | src/platform | 1    | 1        | Low         | Yes                | —      |
| src/platform → src/platform/store          | Contract | src/platform | 1    | 1        | Low         | Yes                | —      |
| src/platform/config → src/session          | Model    | src          | 2    | 2        | Low         | Yes (at threshold) | —      |
| src/host → src/adapters                    | Contract | src          | 1    | 1        | High        | Yes                | —      |
| src/host → src/adapters/pi                 | Contract | src          | 2    | 2        | High        | Yes                | —      |
| src/host → src/adapters/codex              | Contract | src          | 2    | 2        | High        | Yes                | —      |
| src/host → src/adapters/claude-code        | Contract | src          | 2    | 2        | High        | Yes                | —      |
| src/host → src/adapters/kimi-code          | Contract | src          | 2    | 2        | High        | Yes                | —      |
| src/host → src/import                      | Contract | src          | 1    | 1        | Moderate    | Yes                | —      |
| src/host → src/platform/config             | Contract | src          | 2    | 2        | Low         | Yes                | —      |
| src/host → src/platform/repo               | Contract | src          | 2    | 2        | Low         | Yes                | —      |
| src/host → src/platform/tokens             | Contract | src          | 2    | 2        | Low         | Yes                | —      |
| src/host → src/platform/store              | Contract | src          | 2    | 2        | Low         | Yes                | —      |
| src/host → src/session                     | Model    | src          | 1    | 1        | High (core) | Yes                | —      |
| src/host → src/host/cli                    | Contract | src/host     | 1    | 1        | Moderate    | Yes                | —      |
| src/host → src/host/pi-extension           | Contract | src/host     | 1    | 1        | Moderate    | Yes                | —      |
| src/host/cli → src/import                  | Contract | src          | 2    | 2        | Moderate    | Yes                | —      |
| src/host/cli → src/session                 | Model    | src          | 2    | 2        | High (core) | Yes (at threshold) | —      |
| src/host/pi-extension → src/import         | Contract | src          | 2    | 2        | Moderate    | Yes                | —      |
| src/host/pi-extension → src/session        | Model    | src          | 2    | 2        | High (core) | Yes (at threshold) | —      |
| src/host/pi-extension → src/adapters/pi    | Contract | src          | 2    | 2        | High        | Yes                | —      |

Each edge appears once, in the direction of the dependency: a parent-and-submodule pair is listed as
`child → parent` where the child implements the parent's contract, and as `parent → child` where the
parent composes the children. Every edge is documented by at least one of its two modules, and most
by only one — the side that depends. Where both counterparts document an edge, they state the same
computed values.

No integration exceeds its threshold. Model coupling is capped at distance 2 everywhere; contract
coupling tolerates any distance; there is no functional or intrusive coupling across any folder
boundary.

**T-ROO-6 is the fitness function for this table.** It recomputes the lowest common ancestor, the
rank and the distance of every documented integration from the folder tree, checks them against the
balance thresholds, and checks that this table's row set equals the union of the entries in the 19
Integrations sections. A hand-edited number that drifts from the tree fails that test.

### Major design decisions

**Decision 1 — one canonical session model, and the tree is flat because of it.**
FR-6 ("every rule applies to all nine directions") and FR-60 ("an adapter cannot change the rules of
sections C to I") cannot be satisfied by pairwise conversion between agents. Every rule runs on one
neutral model, owned by `src/session/`. Sharing a domain model is **model coupling**, whose maximum
balanced distance is 2. Every module holding canonical types therefore sits at rank 2 or less from
`src/session/`, which caps the tree at depth 2.

_Trade-off:_ `src/import/transfer/` carries FR-22 to FR-35 and FR-54 in a single module. Splitting it
into `transfer/content/` and `transfer/budget/` would put both at depth 3, giving distance 3 against
a model-coupled, high-volatility counterpart — a Critical imbalance. The module stays whole. It is
one coherent decision (what crosses over, and how much), and the pinning rules of FR-32 cannot be
reasoned about apart from the content rules of FR-22 to FR-28 anyway.

**Decision 2 — the rules are structural, not disciplinary.**
`ToolCallRecord` has an outcome line and no field for a result body. FR-24 and FR-60 are therefore
enforced by the type, not by adapter behaviour: the test of FR-60 ("a new adapter cannot keep a tool
result body") holds because there is nowhere to put one. The same reasoning gives adapters no write
path: they return files, and `src/import/landing/` commits them through `src/platform/store/`, so
FR-49 (add only) and FR-53 (all or nothing) are enforced once for every present and future agent.

_Trade-off:_ an adapter that genuinely needed to write a lock file or a sidecar index would have to
route it through the same committer, or the port would have to grow. That is the intended cost.

**Decision 3 — the agent list lives in the host, not in `adapters/`.**
If `src/adapters/` held the list and the Pi entry point lived under `src/adapters/pi/`, the module
graph would cycle: list → pi → import → adapter port. Putting the list in the composition root breaks
the cycle. FR-57 still reads literally: one new folder under `src/adapters/`, one line in
`src/host/`.

_Trade-off:_ "one new adapter file" is one new _folder_ with a `module.md`, not one loose file.

**Decision 4 — hosts are separated from adapters.**
Reading and writing an agent's session files is data work; hosting `/resume-from` inside that agent
is process and user-interface work. C-1 forces two different mechanisms — a shared command binary for
Codex and Claude Code, an in-process extension for Pi, because C-10 needs a live command context to
switch. Keeping them in `src/host/` leaves the adapters free of any user-interface knowledge and
keeps FR-58's capability declaration as the only channel between the two.

**Decision 5 — `platform/` is a module, not a grouping folder.**
Its four children are generic subdomains with real switching risk: a different tokenizer, a git
library instead of the git binary, a different configuration location. A shared parent gives them one
place to state the rule they all obey — no service in `platform/` may know a session, an agent, or a
rule. The one exception is `platform/config/`, which restates `AgentId` and `HomePath` because
configuration is keyed by agent; that is model coupling at distance 2 against a low-volatility
counterpart, and it is balanced.

## Change Vectors

Changes that require **only this module** to change:

- The package exposes a second entry point, for example a programmatic API for another tool.
- The composition order changes — for example configuration becomes lazy, or the agent list is built
  after the pipeline.
- The architecture record changes: a new decision, a revised coupling assessment, a new module map.

Everything else lands in a submodule. Adding an agent touches `src/adapters/` and `src/host/`.
Changing what crosses over touches `src/import/transfer/`. Changing the preview wording touches
`src/import/preview/`.

## Constraints and Invariants

- **Requests have one destination: `destinationCwd`.** Hosts preserve its absolute native spelling for import writes. Canonical destination and Git common-directory identity bind preview confirmation; source provenance never carries destination data.

- **The source is never modified.** No module in this tree opens a source session file for writing
  (NG-1, AC-4). The only write path in the system is `src/platform/store/`.
- **The model of the source agent is never called.** Everything is read from disk (FR-8). No module
  in this tree makes a network call to a model provider.
- **Nothing is written before confirmation** (FR-3 of the summary table, FR-16, FR-20). `list` and
  `preview` are read-only by construction; only `commit` reaches the write path.
- **One new agent costs one new adapter folder and one line in `src/host/`** (FR-57). Any change that
  would make a new agent touch a third place is a design defect.
- **Requirement sections C to I are agent-independent** (FR-60). A rule that needs to know which
  agent it is running for belongs in a capability field of `AgentCapabilities`, never in a branch on
  `AgentId` inside a rule.
- **Secrets never cross.** Tokens, passwords, environment values, hidden reasoning, system prompts
  and vendor state have no representation in the canonical model (FR-28, NG-7, NG-8). There is no
  field to carry them.
- **Error messages state what failed and what to do next** (FR-56). An error that only names an
  exception is incomplete.
- **Known limitation (Minor).** FR-36 asks for the files that were dirty when the source session ran.
  No agent records that. `RepoSnapshot.changedPaths` is derived from the source session's own
  mutating tool calls, and `RepoSnapshot.commit` is null when the source format does not carry it.
  The preview says "unknown" rather than guessing. This is a documented gap, not a defect.

### Minor issues recorded by the modularity review

These were found by the review, judged not worth restructuring for, and are recorded here so a later
reader does not rediscover them as surprises.

- **M-1 — two host modules name a concrete adapter at rank 2.** `src/host/` constructs
  `src/adapters/pi/`, `src/adapters/codex/` and `src/adapters/claude-code/`, and
  `src/host/pi-extension/` names `src/adapters/pi/` for `PiSwitchContext`. Both cross into the
  `adapters/` branch below its own façade. Both are unavoidable: a composition root must construct
  implementations, and the Pi runtime handle has a shape that exactly one adapter understands. Both
  are contract coupling at distance 2 against a documented public contract, not intrusive coupling
  against an internal — and each carries only a factory or a switch signature.
- **M-2 — the import stages integrate with `src/platform/` children directly.**
  `src/import/discovery/`, `src/import/transfer/`, `src/import/preview/` and `src/import/landing/`
  each depend on the platform submodule whose service they call, rather than on a `platform/`
  façade. This is deliberate and documented in `src/platform/module.md`: that module publishes no
  types, because a façade over four contracts that hide nothing from the tree would add restatement
  without adding encapsulation. Contract coupling at distance 2 throughout.
- **M-3 — `src/import/transfer/` is the largest leaf in the tree.** It carries FR-22 to FR-35 and
  FR-54. The cognitive load is real. Splitting it is the wrong fix, for the reason given in Decision
  1: both halves would sit at depth 3 and break the model-coupling threshold against the
  highest-volatility module in the system. If it must be split later, `src/session/` has to move
  with it.

## Test Specification

The root's own code is one factory. Its tests are therefore of two kinds: the factory itself, and the
**system-wide invariants** that no single submodule can check alone. The second kind is the more
important: these are the tests that fail when the architecture erodes.

### Unit Tests

**T-ROO-1 — `createHost` returns a usable host**
- Scenario: `createHost` in a temporary environment with no configuration file.
- Expected behavior: a `HostWiring` whose registry holds every adapter and whose `pipelineFor`
  produces a working pipeline.

**T-ROO-2 — a configuration error surfaces from `createHost`**
- Scenario: an invalid configuration file.
- Expected behavior: rejects with the field and what to change (FR-56). No partially built host is
  returned.

**T-ROO-3 — the root has one entry point**
- Scenario: a static check of what the package exports.
- Expected behavior: `createHost`, the command binary, and the Pi extension entry. No second wiring
  path.

### Integration Contract Tests

**T-ROO-4 — the design tree matches the source tree**
- Scenario: every folder under `src/` is checked for a `module.md`, and every `module.md` is checked
  against the module template.
- Expected behavior: 19 modules, each with every template section, and the metadata lines naming the
  real parent and the real submodules.

**T-ROO-5 — every restatement matches its normative home**
- Scenario: the project-owned TypeScript validator reads every contract marker in the design tree.
- Expected behavior: every marker immediately precedes its code fence, resolves its owner, and names
  declarations that are verbatim or a declared subset of the declarations it cites. Failures name
  the document, line and declaration without relying on a personal plugin, Python, or a subprocess.

**T-ROO-6 — the coupling assessment is still true**
- Scenario: for every integration documented in any `module.md`, the lowest common ancestor, the rank
  and the distance are recomputed from the folder tree, and checked against the balance thresholds.
- Expected behavior: the computed values equal the documented ones, and no integration exceeds its
  threshold. Model coupling never exceeds distance 2; there is no functional or intrusive coupling
  across a folder boundary. The row set of the coupling table in this document equals the union of
  the entries in the 19 Integrations sections, so the table cannot fall behind a module document.

**T-ROO-7 — the module graph is acyclic and layered**
- Scenario: the import graph over `src/`.
- Expected behavior: acyclic; nothing imports `src/host/`; `src/session/` imports nothing; no module
  in `src/platform/` imports the product's vocabulary except the documented `AgentId` and `HomePath`
  exception in `src/platform/config/`.

### Boundary Tests

**T-ROO-8 — there is exactly one write path**
- Scenario: every call to a file-creating primitive across all of `src/`.
- Expected behavior: every one is inside `src/platform/store/` (FR-49, FR-53, C-3).

**T-ROO-9 — there is no field for a tool result body**
- Scenario: a static check of the canonical model.
- Expected behavior: `ToolCallRecord` has no field that can hold one. FR-24 and FR-60 are enforced by
  the type, so no adapter can violate them.

**T-ROO-10 — no rule branches on an agent name**
- Scenario: a search for the `AgentId` literals across `src/import/`.
- Expected behavior: no match. A rule that needs a per-agent fact reads a capability (FR-60).

**T-ROO-11 — no model is ever called**
- Scenario: the whole suite runs with every network call throwing.
- Expected behavior: every test outside the live adapter suites passes (FR-8).

**T-ROO-12 — no secret has a representation**
- Scenario: a static check of every type in the canonical model and the adapter port.
- Expected behavior: no field for a token, a password, an environment value, a system prompt, hidden
  reasoning, or vendor state (FR-28, NG-7, NG-8).

### Behavior Tests

**T-ROO-13 — the acceptance test**
- Scenario: the requirements' own single test. Work in a real Codex session until it holds file
  reads, edits and 20 or more turns. Start Pi in the same repository. Run `/resume-from`, select that
  session, confirm the preview, type the next instruction.
- Expected behavior: the agent continues the task and the user explains nothing again.

**T-ROO-14 — AC-1: every direction of the scope table**
- Scenario: the same test for every cell of the scope table — every ordered pair of shipped agents —
  including the diagonal cells that move a session between two homes of one agent.
- Expected behavior: all pass.

**T-ROO-15 — AC-2: the imported turns are native**
- Scenario: after each landing, the target's own scrollback and resume list are used.
- Expected behavior: both work on the imported turns. Compaction is not asserted — the requirements
  state it needs a real turn first, and that is recorded as untested, not as passing.

**T-ROO-16 — AC-3: a stale file is read again, not edited blind**
- Scenario: a source session read a file; the file is then changed; the session is imported and the
  target is asked to continue the work.
- Expected behavior: the target reads the file again. The record carried no content and said the
  content may be stale (FR-25).

**T-ROO-17 — AC-4: every source file is byte-identical**
- Scenario: a checksum of every file in every source home before and after every direction.
- Expected behavior: identical (NG-1).

**T-ROO-18 — AC-5: a very large session leaves room to work**
- Scenario: a source session several times the target window.
- Expected behavior: the import fits the budget, the preview said what was dropped, and the target
  has room for the next turns.

**T-ROO-19 — AC-6: a work profile**
- Scenario: a `~/.claude` session imported into `~/.claude-team`.
- Expected behavior: it opens under the work profile, and both sessions exist afterwards.

**T-ROO-20 — AC-7: a new adapter reaches both roles with one new folder**
- Scenario: a fake agent is added — one folder under `src/adapters/`, one value in `AgentId`,
  one line in `src/host/`.
- Expected behavior: it works as a source and as a target, every direction of the grown table runs,
  and no rule, no preview and no other adapter was edited (FR-57, FR-60).

**T-ROO-21 — nothing is written before confirmation, anywhere**
- Scenario: every host, every direction, cancelled at every cancellation point.
- Expected behavior: no new session exists in any target home, in any case (FR-16, FR-20).

**T-ROO-22 — a platform service can be replaced without touching a consumer** _(moved from
`src/platform/`, was the end-to-end half of T-PLA-9)_

- Scenario: parameterized over the four services of `src/platform/`. Each is replaced by a stub with
  different behaviour: a fixed token count, a repository reader that reports nothing known, a
  committer that records calls instead of writing, a loader returning non-default settings.
- Expected behavior: the whole pipeline still runs end to end in every case, and no file outside
  `src/platform/` is edited to make it work. This is the switching-risk claim of the generic
  subdomain classification, tested rather than asserted — and it lives here because it needs
  `src/import/` and `src/host/`, which are siblings of `src/platform/` and therefore not guaranteed
  to exist when that module is implemented.
