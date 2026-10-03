# Configuration

**Path**: src/platform/config/ — the module's code is everything in this folder and its transparent subfolders
**Parent**: `src/platform/`
**Submodules**: none (leaf)

## Purpose

This module loads the user's settings and fills every missing one with its default. Three
requirements let the user change a value: the list of extra homes to search (FR-5), the share of the
target window one import may use (FR-30), and the number of recent turns pinned word for word
(FR-32).

Without it, those numbers would be literals inside the rules, and the two open questions of the
requirements (Q-1 and Q-2) could not be answered by changing a setting.

## Functional Responsibilities

- Load settings from the user's configuration file, and return defaults when there is none.
- Own the default values: 0.30 for the budget share (FR-30, Q-1), 5 for the pinned recent turns
  (FR-32, Q-2), an empty list of extra homes.
- Validate every value and reject a configuration that cannot be used, with a message that says what
  is wrong (FR-56).
- Let the user override the assumed context window of an agent, so FR-18's budget line can be correct
  for a model the adapter default does not match.

## Subdomain Classification

**Generic.** Reading a settings file is a solved problem. Functional volatility is **low**: settings
are added occasionally, and each addition is a new field with a default. Implementation volatility is
**low to moderate** — the file location and format may change.

The classification is generic, but this module still restates `AgentId` and `HomePath`, because
settings are keyed by agent. That is model coupling at distance 2 against a low-volatility
counterpart, and it is balanced.

## Encapsulated Knowledge

- **Where the configuration lives** and in what format. No other module knows the path or the syntax.
- **The default values.** 0.30 and 5 appear in this module and nowhere else. `src/import/transfer/`
  reads them from `ImportConfig` and never hard-codes them.
- **Merge order.** How a user file, an environment variable, and a command-line flag combine when
  more than one sets the same value.
- **Validation rules.** That a share must be greater than 0 and at most 1, that a pinned-turn count
  must be a non-negative whole number, and that a home path must be absolute.

## Public Contract

<!-- contract: AgentId, HomePath — restated from src/session/module.md (subset: omits SessionId and SessionRef) -->
```ts
/** Which agent produced or receives a session. Adding an agent adds one value (FR-57). */
type AgentId = "pi" | "codex" | "claude-code" | "kimi-code";

/** Absolute path of an agent profile directory, for example "/Users/me/.claude-team" (FR-2). */
type HomePath = string;
```

```ts
/** One extra home the user added to the search list (FR-5). */
interface HomeEntry {
  agent: AgentId;
  home: HomePath;
}

/** A context window the user set for one agent, overriding the adapter default (FR-18). */
interface WindowOverride {
  agent: AgentId;
  windowTokens: number;
}
```

```ts
/** User configuration. Every field has a default (FR-5, FR-30, FR-32). */
interface ImportConfig {
  /** Homes searched in addition to every adapter's default home. Default empty (FR-5). */
  extraHomes: HomeEntry[];
  /** Share of the target window one import may use. Default 0.30 (FR-30, Q-1). */
  budgetShare: number;
  /** Recent turns kept word for word. Default 5 (FR-32, Q-2). */
  pinnedRecentTurns: number;
  /** Context windows the user set explicitly. Default empty. */
  windowOverrides: WindowOverride[];
}
```

```ts
/** Why a configuration was rejected (FR-56). */
interface ConfigError {
  /** The setting at fault, for example "budgetShare". */
  field: string;
  /** What is wrong, and what the user can do next. */
  message: string;
}

/** Loads configuration and fills every missing field with its default. */
interface ConfigLoader {
  /** Rejects for invalid values or unreadable paths. A genuinely missing file is not an error. */
  load(): Promise<ImportConfig>;
}
```

## Integrations

- **Counterpart**: `src/session/`
- **Direction**: `src/platform/config/` depends on `src/session/`
- **Strength**: model — settings are keyed by `AgentId`, which is part of the shared vocabulary
- **LCA / Rank / Distance**: LCA `src/`, rank 2, distance 2
- **Volatility**: low on this side; `AgentId` changes only when an agent is added (FR-57)
- **Balanced?**: yes — model coupling tolerates distance 2, and this is exactly 2
- **Shared knowledge**: only the two identity types, restated in the Public Contract section above.
  This module knows nothing about turns, sessions, or provenance.

## Change Vectors

Changes that require **only this module** to change:

- The default budget share changes when Q-1 is answered.
- The default pinned-turn count changes when Q-2 is answered.
- A new setting is added with a default.
- The configuration file moves, changes format, or gains an environment-variable override.
- Validation is tightened, for example to reject a home path that does not exist.

## Constraints and Invariants

- **A missing configuration file is not an error.** It yields the defaults. A present invalid file
  or an unreadable path rejects. A path obstructed by a non-directory component is unreadable, not
  missing, and rejects instead of silently using defaults.
- **An empty file is a missing file.** A file that holds only whitespace sets nothing, so it yields
  the defaults. It is not a parse error — T-CFG-6 lists an empty file among the cases that must return
  every field, and T-CFG-9 is about a file that says something the loader cannot read.
- **An unknown setting rejects, naming the key.** A misspelled setting that the tool ignored is the
  same failure as a file the tool ignored: the user changed a number and nothing happened.
- **Every field is always present in the returned `ImportConfig`.** Callers never handle undefined
  and never apply their own default.
- **`budgetShare` is greater than 0 and at most 1.** A share of 0 would make every import blocked by
  FR-33, which is a configuration mistake and is refused at load time.
- **`pinnedRecentTurns` is a whole number and at least 0.** Zero is legal: it means only the first
  request, the summaries, and the changed-file list are pinned (FR-32).
- **`HomeEntry.home` is absolute and fully resolved.** A relative or unresolved path would make the
  duplicate check in `src/import/discovery/` compare spellings instead of locations.
- **A duplicate home is not an error.** The same home may appear in `extraHomes` and as an adapter
  default; the search deduplicates. This module does not deduplicate across values it never sees.
- **This module never writes configuration.** The tool reads settings; the user edits them.
- **The default values live here and nowhere else.** A default repeated in another module is a
  defect, because FR-30 and FR-32 must be answerable by changing one number.

## Test Specification

### Unit Tests

**T-CFG-1 — a missing file yields the defaults**
- Scenario: no configuration file exists.
- Expected behavior: resolves with `extraHomes` empty, `budgetShare` 0.30, `pinnedRecentTurns` 5,
  `windowOverrides` empty. It does not reject (FR-5, FR-30, FR-32).

**T-CFG-2 — a partial file is completed with defaults**
- Scenario: a file that sets only `budgetShare` to 0.5.
- Expected behavior: `budgetShare` is 0.5 and every other field holds its default. No field is
  undefined.

**T-CFG-3 — extra homes are read**
- Scenario: a file listing `~/.claude-team` for `claude-code` and a second Pi home.
- Expected behavior: both appear in `extraHomes`, each with its agent (FR-5).

**T-CFG-4 — home paths are resolved to absolute**
- Scenario: parameterized — a path with `~`, a relative path, a path with `..`, a symlinked path.
- Expected behavior: each becomes a resolved absolute path, so the deduplication in
  `src/import/discovery/` compares locations rather than spellings.

**T-CFG-5 — window overrides are read**
- Scenario: a file setting a 500000-token window for `claude-code`.
- Expected behavior: it appears in `windowOverrides` and is keyed by agent (FR-18).

### Integration Contract Tests

**T-CFG-6 — every field is always present**
- Scenario: parameterized over an absent file, an empty file, and a file with every field set.
- Expected behavior: in all three, all four fields of `ImportConfig` are present and correctly typed.
  A consumer never applies its own default.

**T-CFG-7 — an invalid value rejects with the field named**
- Scenario: a table — `budgetShare` 0, `budgetShare` 1.5, `budgetShare` -0.1, `budgetShare` as a
  string, `pinnedRecentTurns` -1, `pinnedRecentTurns` 2.5, an extra home with an unknown agent.
- Expected behavior: each rejects with a `ConfigError` naming the field and stating what to change
  (FR-56). No case silently falls back to a default.

**T-CFG-8 — the defaults live here and nowhere else**
- Scenario: a search of the production sources outside this module — every `.ts` file under
  `src/import/`, `src/adapters/` and `src/host/` except `*.test.ts` and the test-support and
  fixture helpers — for the literals `0.30` and `0.3` and for a bare `5` used as a turn count.
- Expected behavior: no match. FR-30 and FR-32 must be answerable by changing one number.
- Why production only: T-CFG-14 expects the suite to keep passing "except the assertions that name
  the number", so an assertion is allowed to name `0.3`. The property protected here is that the
  default has one home to edit, not that the digits appear once. A test that passes `0.3` as an
  input — such as FR-30's own worked example, a 200k window giving a 60k budget — states no
  default.

### Boundary Tests

**T-CFG-9 — a malformed file rejects**
- Scenario: a file that is not parsable, or a configuration path obstructed by a file where a
  directory is required.
- Expected behavior: rejects with a `ConfigError` naming the path and the parse or read problem. It
  does not fall back to defaults, because a configuration the tool ignored is worse than an error.

**T-CFG-10 — `budgetShare` of exactly 1 is accepted**
- Scenario: `budgetShare` set to 1.
- Expected behavior: accepted. The whole window is a legal, if unwise, choice; 0 is not.

**T-CFG-11 — `pinnedRecentTurns` of 0 is accepted**
- Scenario: `pinnedRecentTurns` set to 0.
- Expected behavior: accepted. The first request, the summaries and the changed-file list are still
  pinned (FR-32).

**T-CFG-12 — duplicate homes are not an error**
- Scenario: the same home listed twice, and a home that equals an adapter's default.
- Expected behavior: accepted unchanged. Deduplication belongs to the search, not to the loader.

**T-CFG-13 — this module never writes**
- Scenario: the configuration directory is checksummed before and after a load, including the case
  where no file exists.
- Expected behavior: identical. No file is created, not even an empty default.

### Behavior Tests

**T-CFG-14 — answering Q-1 changes one number**
- Scenario: the default `budgetShare` is changed from 0.30 to 0.25 in this module only.
- Expected behavior: the whole test suite still passes except the assertions that name the number,
  and the budget of every import changes. Nothing outside this module is edited.

_T-CFG-15 was moved to `src/import/` as T-IMP-27. It asserts that both Claude Code profiles appear in
one listing, which needs the finder and an adapter — both compose above this module. What stays here
is that the setting is read and resolved correctly (T-CFG-3, T-CFG-4)._
