// GENERATED from src/platform/repo/module.md — the Public Contract section is the normative home.
// Declarations only: no behaviour, no defaults. If this file and module.md disagree,
// the document wins and this file is corrected.

/** The repository the command runs in (FR-13). */
export interface RepoIdentity {
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

/** How far the tree moved since the source session ran (FR-38). */
export interface CommitDistance {
  /** False when the source commit is unknown, or absent from this repository. */
  known: boolean;
  /** Commits on HEAD that the source commit does not have. */
  ahead: number;
  /** Commits the source commit has that HEAD does not. */
  behind: number;
}

/** Process controls applied to every git command issued by one reader. */
export interface RepoReaderOptions {
  /** Maximum duration of one git command. Defaults to a finite module-owned limit. */
  timeoutMs?: number | undefined;
  /** Cancels the current command and every later command issued by this reader. */
  signal?: AbortSignal | undefined;
}

/** Reads git state. It never writes to the repository. */
export interface RepoReader {
  /** Throws AbortError with the signal reason as cause when cancelled; performs no I/O. */
  checkCancellation(): void;
  identify(cwd: string): Promise<RepoIdentity>;
  /** Compares HEAD with a commit of a source session (FR-37). */
  distanceFrom(cwd: string, sourceCommit: string): Promise<CommitDistance>;
}

/** Where the recorded directory of a session is (FR-61). */
export type PlaceState = "present" | "recoverable" | "unrecoverable";

/** What a session recorded about where it ran. */
export interface PlaceRequest {
  /** The recorded directory: `startDirectory ?? repoPath`. */
  directory: string;
  branch: string | null;
  commit: string | null;
}

/** One git command a recovery would run, with its display form. */
export interface RecoveryCommand {
  cwd: string;
  /** Arguments after `git -C <cwd>`, each separate. */
  argv: string[];
  /** The POSIX display form the user is shown. */
  display: string;
}

/** How a missing directory would be recreated (FR-61). */
export interface RecoverySteps {
  directory: string;
  /** In order; a prune precedes the add when the directory is a stale registration. */
  commands: RecoveryCommand[];
  /** Every note about the chosen branch or commit, printed as an `⚠` line. */
  warnings: string[];
}

/** Where a session's directory is, and what it would take to bring it back. */
export interface Place {
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
export interface RecoveryResult {
  ok: boolean;
  stderr: string;
  /** git's own message, or the refusal reason. */
  message: string | null;
}

/** Resolves a session's place and runs its recovery plan. It never forces, fetches or deletes. */
export interface WorktreeRecovery {
  /** Throws AbortError with the signal reason as cause when cancelled; performs no I/O. */
  checkCancellation(): void;
  place(request: PlaceRequest): Promise<Place>;
  recover(plan: RecoverySteps): Promise<RecoveryResult>;
}
