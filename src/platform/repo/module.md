# Repository Reader

**Path**: src/platform/repo/ — the module's code is everything in this folder and its transparent subfolders
**Parent**: `src/platform/`
**Submodules**: none (leaf)

## Purpose

This module reads the state of the git repository the command is running in: where its root is, what
HEAD points at, which canonical Git common directory identifies it across linked worktrees, and how
far HEAD has moved from the commit a source session ran at.

Two requirements depend on it. FR-13 keeps the listing to sessions of the current repository, which
needs repository identity separately from the checkout root. FR-37 and FR-38 warn the user that the tree has moved since the source
session, which needs the commit distance.

## Functional Responsibilities

- Identify the repository containing a directory: checkout root, canonical common directory, bare
  status, HEAD commit, current branch (FR-13).
- Report how far HEAD is from a given commit, in commits ahead and behind (FR-37, FR-38).
- Report "not known" rather than guessing when the working directory is not a repository, when the
  repository has no commits, or when the source commit is absent from this repository.
- Resolve a session's recorded directory into a place: present, recoverable through a parent
  repository, or unrecoverable (FR-61).
- Plan a worktree recovery in a fixed order of fallbacks, and execute only that plan with the same
  Git environment, timeout and cancellation rules as every other command here.

## Subdomain Classification

**Generic.** Reading git state is a solved problem. Functional volatility is **low**: the questions
never change. Implementation volatility is **low to moderate** — running the `git` binary could be
replaced by a library, but the switch is unlikely and the contract is small enough to make it cheap
either way.

## Encapsulated Knowledge

- **How git is reached.** Whether the `git` binary is spawned or a library is linked, which
  subcommands are used, and how their output is parsed.
- **Failure translation.** Completed nonzero Git results leave the requested facts unresolved, not
  necessarily outside Git. Localized stderr is not classified. Missing filesystem paths (ENOENT)
  are absent evidence; other filesystem failures and Git operational failures reject.
- **Worktree and submodule details.** Which directory counts as the root when the command runs inside
  a worktree or a submodule.

Nothing here knows what a session is, what an agent is, or what a warning looks like. It reports
facts; `src/import/preview/` decides what to say about them.

## Public Contract

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

```ts
/** Process controls applied to every git command issued by one reader. */
interface RepoReaderOptions {
  /** Maximum duration of one git command. Defaults to a finite module-owned limit. */
  timeoutMs?: number;
  /** Cancels the current command and every later command issued by this reader. */
  signal?: AbortSignal;
}
```

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

```ts
/** Where the recorded directory of a session is (FR-61). */
type PlaceState = "present" | "recoverable" | "unrecoverable";

/** What a session recorded about where it ran. */
interface PlaceRequest {
  /** The recorded directory: `startDirectory ?? repoPath`. */
  directory: string;
  branch: string | null;
  commit: string | null;
}

/** One git command a recovery would run, with its display form. */
interface RecoveryCommand {
  cwd: string;
  /** Arguments after `git -C <cwd>`, each separate. */
  argv: string[];
  /** The POSIX display form the user is shown. */
  display: string;
}

/** How a missing directory would be recreated (FR-61). */
interface RecoverySteps {
  repoRoot: string;
  directory: string;
  /** In order; a prune precedes the add when the directory is a stale registration. */
  commands: RecoveryCommand[];
  warnings: string[];
  /** A note about the chosen branch or commit, when one applies. */
  note: string | null;
}

/** Where a session's directory is, and what it would take to bring it back. */
interface Place {
  state: PlaceState;
  directory: string;
  /** The checkout's current branch when the directory is present. */
  branch: string | null;
  warnings: string[];
  /** Set only when recoverable. */
  recovery: RecoverySteps | null;
  /** Why the directory cannot be recovered, when unrecoverable. */
  reason: string | null;
}

/** What running a recovery plan produced. */
interface RecoveryResult {
  ok: boolean;
  /** The display form of the command that failed, when one did. */
  failedCommand: string | null;
  stdout: string;
  stderr: string;
  /** git's own message, or the refusal reason. */
  message: string | null;
}

/** Resolves a session's place and runs its recovery plan. It never forces, fetches or deletes. */
interface WorktreeRecovery {
  /** Throws AbortError with the signal reason as cause when cancelled; performs no I/O. */
  checkCancellation(): void;
  place(request: PlaceRequest): Promise<Place>;
  recover(plan: RecoverySteps): Promise<RecoveryResult>;
}
```

## Integrations

**None.** This module depends on no other module. `src/import/discovery/` and
`src/import/preview/` call it; it calls nobody.

## Change Vectors

Changes that require **only this module** to change:

- The `git` binary is replaced by a library, or the other way round.
- Worktree or submodule handling is refined.
- A new fact is reported, for example whether the working tree is currently dirty.
- The distance calculation changes, for example to use the merge base explicitly.

## Constraints and Invariants

- **Every lookup names its directory explicitly.** `distanceFrom(cwd, sourceCommit)` compares against that directory’s HEAD. `createRepoReader` takes process options only, with no ambient or factory-bound cwd.

- **The reader never writes to the repository.** No commit, no checkout, no stash, no index change,
  no configuration write. It is read-only against the user's work (AC-4 in spirit).
- **A recovery executes only the plan it produced.** The plan may add one worktree into a directory
  that does not exist, and prune a stale registration of that same directory. It never fetches,
  forces, deletes, checks out an existing tree, or writes configuration; an existing path is
  refused before any command runs, and every command is an argument array, never a shell string.
- **Expected absences are return values.** Missing paths and completed nonzero identity queries
  return an unresolved identity (`root`, `commonDir`, `head`, `branch` null; `isBare` false).
  HEAD/branch queries may independently be unresolved without losing repository identity. Git
  spawn, timeout, cancellation, and non-ENOENT filesystem failures reject rather than becoming
  absence. Cancellation also rejects when the requested path is missing.
- **`RepoIdentity.root` and `commonDir` are absolute and fully resolved**, including symlinks.
  Canonicalize the existing input directory first, query `rev-parse --git-common-dir`, resolve any
  relative output against that exact command directory, then apply filesystem realpath. Resolve
  `--show-toplevel` separately: `root` always remains the checkout, never a metadata directory.
  No parent search from missing paths, path-prefix rules, remote comparison, or shared-object
  heuristics are used. Identity works without a commit or branch, and Git selects the nearest
  repository, keeping nested repositories, submodules and independent clones distinct.
- **Bare repositories have identity but no checkout.** `isBare` is true and `root` null for a bare
  repository; callers must not use it as an import destination. Its linked working trees report
  their own checkout roots and `isBare: false`, while sharing its `commonDir`.
- **Inherited Git location overrides are excluded.** `GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE`
  and `GIT_INDEX_FILE` are removed from the subprocess environment. Execution uses argument arrays,
  not shell strings; common-directory lookup does not require `--path-format` support.
- **`distanceFrom` is safe with any string.** A malformed or attacker-supplied revision returns
  `known: false`; it is never interpolated into a shell.
- **Results are read at the moment of the call.** No caching across calls, because the preview and
  the commit of one import may straddle a change in the tree, and the second call must see it.
- **Every git subprocess has a finite timeout and supports cancellation.** A timeout or abort rejects
  with a message that distinguishes it from an expected non-zero git exit.
- **`known: false` implies `ahead` and `behind` are 0.** Callers must not read them as real numbers.

## Test Specification

Tests build real, disposable git repositories in a temporary directory. Nothing runs against the
user's repository.

### Unit Tests

**T-REP-1 — a repository is identified**
- Scenario: a repository with one commit on branch `main`; `identify` is called with the root.
- Expected behavior: `root` is the resolved absolute root, `head` is the commit, `branch` is `main`.

**T-REP-2 — identification works from a subdirectory**
- Scenario: `identify` called with a nested directory of the same repository.
- Expected behavior: `root` is the repository root, not the directory passed in.

**T-REP-3 — a directory outside a repository**
- Scenario: `identify` on a plain temporary directory.
- Expected behavior: `root`, `commonDir`, `head` and `branch` are null, `isBare` is false. It does not throw.

**T-REP-4 — a repository with no commits**
- Scenario: `git init` and nothing else.
- Expected behavior: `root` is set, `head` is null, and it does not throw.

**T-REP-5 — commit distance ahead**
- Scenario: a repository where HEAD is 14 commits after the source commit.
- Expected behavior: `known` true, `ahead` 14, `behind` 0. These are the numbers FR-38's warning
  prints.

**T-REP-6 — commit distance behind and diverged**
- Scenario: parameterized — HEAD behind by 3; HEAD and source diverged by 2 and 5.
- Expected behavior: `known` true with the exact ahead and behind counts in each case.

**T-REP-7 — the same commit**
- Scenario: the source commit equals HEAD.
- Expected behavior: `known` true, `ahead` 0, `behind` 0 — which the preview renders as no warning
  (FR-38 fires only on a difference).

### Integration Contract Tests

**T-REP-8 — an unknown revision is reported, not thrown**
- Scenario: `distanceFrom` with a commit that does not exist in this repository.
- Expected behavior: `known` false, `ahead` 0, `behind` 0. No exception.

**T-REP-9 — `known: false` implies zero counts**
- Scenario: every case that yields `known` false.
- Expected behavior: `ahead` and `behind` are both 0, so a caller cannot print a fabricated distance.

**T-REP-10 — the root is fully resolved**
- Scenario: the repository is reached through a symlinked path.
- Expected behavior: `root` is the real path. This is what makes the FR-13 filter compare locations
  rather than spellings.

### Boundary Tests

**T-REP-11 — a hostile revision string is safe**
- Scenario: `distanceFrom` with `"; rm -rf /"`, `"--upload-pack=touch pwned"`, a 10 kB string, and an
  empty string.
- Expected behavior: each returns `known` false. No file is created, no shell is invoked, no error
  escapes.

**T-REP-12 — the repository is never modified**
- Scenario: the repository directory is checksummed before and after every method of this module.
- Expected behavior: identical, including `.git`. No index write, no config write, no lock file left
  behind.

**T-REP-13 — no caching between calls**
- Scenario: `identify` is called, a commit is made, `identify` is called again.
- Expected behavior: the second call reports the new HEAD. The preview and the commit of one import
  may straddle a change, and the second must see it.

**T-REP-14 — the module knows nothing about sessions**
- Scenario: a static check of this module's imports.
- Expected behavior: no import from `src/session/`, `src/adapters/`, `src/import/` or `src/host/`.

### Behavior Tests

**T-REP-15 — the FR-38 scenario end to end**
- Scenario: a session ran at commit `3f2a1bc`; the tree is now at `9d81e04`, 14 commits later.
- Expected behavior: `distanceFrom(cwd, "3f2a1bc")` gives `known` true, `ahead` 14, `behind` 0 — exactly
  the facts the requirement's example warning states.

**T-REP-16 — a session from another repository**
- Scenario: a source session recorded a commit from an unrelated repository.
- Expected behavior: `known` false. The preview then says the source commit is not known here, rather
  than warning about a distance that has no meaning.

**T-REP-17 — git execution is bounded**
- Scenario: a git subprocess that waits for standard input, with a short `timeoutMs`.
- Expected behavior: it is stopped and rejects with the configured duration in the message. The
  factory rejects non-positive or non-finite timeout values.

**T-REP-18 — git execution is cancellable**
- Scenario: a reader created with an aborted `AbortSignal` attempts to identify a repository.
- Expected behavior: it rejects with an abort message before returning repository facts.

**T-REP-19 — common-directory identity across checkout layouts** (`identity.test.ts`)
- Scenario: real nested, sibling and external linked worktrees; source/destination subdirectories;
  spaces and symlink aliases; detached and unborn HEAD; separate Git directories and bare-hosted
  worktrees.
- Expected behavior: each checkout retains its own root, HEAD and branch while related worktrees
  share one canonical `commonDir`. Bare repositories alone have no checkout root and are marked bare.

**T-REP-20 — independent repositories stay distinct** (`identity.test.ts`)
- Scenario: nested independent repositories, submodules, same-remote clones and shared-object clones.
- Expected behavior: their common-directory identities differ even when commits or objects match.

**T-REP-21 — identity lookup boundaries** (`reader.test.ts`, `identity.test.ts`)
- Scenario: relative Git output; inherited Git directory/index overrides; missing input/metadata;
  completed nonzero Git queries; filesystem permission/I/O errors; Git operational errors and abort.
- Expected behavior: resolve output against the canonical command directory; ignore inherited
  overrides; never infer identity from a missing path's parent; leave nonzero lookups unresolved
  without classifying stderr; propagate operational errors and cancellation.

**T-REP-22 — a place is present, recoverable or unrecoverable** (`worktree.test.ts`)
- Scenario: an existing checkout on the recorded branch and on a different branch; a missing
  directory below each known worktree layout; a missing directory with no matching repository.
- Expected behavior: present reports the branch and warns on a difference; recoverable carries a
  plan; unrecoverable names the directory and why (FR-62).

**T-REP-23 — the recovery order is fixed** (`worktree.test.ts`)
- Scenario: a local branch, an `origin/<branch>` only, a recorded commit with no branch, and
  neither; with a stale registration of the same directory.
- Expected behavior: the plan is local branch, then `--track -b`, then `--detach <commit>`, then
  `--detach HEAD` with a warning; a prune precedes the add when the registration is prunable. Each
  plan executes in a real temporary repository (FR-63).

**T-REP-24 — a recovery never damages what exists** (`worktree.test.ts`)
- Scenario: a plan whose directory exists; a plan containing a command other than `worktree add`
  or `prune`; a git command that fails.
- Expected behavior: an existing path and a forbidden command are refused before git runs, and a
  failure reports git's own message and stops (FR-63).

### Cancellation error contract

Both `identify` and `distanceFrom` reject cancellation with an `Error` named `AbortError`.
Pre/post checks retain the original `AbortSignal.reason` as `cause`, including custom Error or
non-Error values; an in-flight Git abort retains the subprocess abort error as `cause`.
Checks run even for missing-directory and invalid-revision short circuits, so cancellation cannot
become unresolved identity or unknown distance. Timeout, spawn and filesystem operational failures
remain ordinary errors, not `AbortError`; completed nonzero exits remain unresolved results.
Tests cover default/custom/string reasons, in-flight aborts and fast-return/post-check paths.
