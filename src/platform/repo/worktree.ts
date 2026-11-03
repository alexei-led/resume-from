// Where a recorded directory is, and the one recovery this tool may perform: recreate a removed
// worktree. Nothing here fetches, forces or deletes. Every command is an argument array, and it
// runs through the same Git environment, timeout and cancellation rules as every other command.

import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type {
  Place,
  PlaceRequest,
  RecoveryCommand,
  RecoveryResult,
  RecoverySteps,
  RepoReaderOptions,
  WorktreeRecovery,
} from "./contract.js";
import {
  createCancellationCheck,
  currentBranch,
  type GitResult,
  normalizeGitOptions,
  plausibleRevision,
  runGit,
} from "./git.js";

/** Characters that need no quoting in a POSIX display command. */
const SAFE_ARGUMENT = /^[A-Za-z0-9_./:=+-]+$/;

function quoteArgument(value: string): string {
  if (value !== "" && SAFE_ARGUMENT.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function command(cwd: string, argv: string[]): RecoveryCommand {
  return {
    cwd,
    argv,
    display: ["git", "-C", quoteArgument(cwd), ...argv.map(quoteArgument)].join(" "),
  };
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** True for any file, directory or link: a recovery never writes into an existing path. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** One checkout record from `git worktree list --porcelain`. */
interface WorktreeEntry {
  path: string;
  branch: string | null;
  prunable: boolean;
}

function parseWorktrees(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current !== null) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: null, prunable: false };
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
    if (line.startsWith("prunable")) current.prunable = true;
  }
  if (current !== null) entries.push(current);
  return entries;
}

/**
 * The repositories a missing directory could belong to, from the worktree layouts this tool
 * knows: `<repo>.worktrees/<name>`, `<repo>/.worktrees/<name>`, `<repo>/.claude/worktrees/<name>`.
 */
function parentRepositoryCandidates(directory: string): string[] {
  const parent = dirname(directory);
  const parentName = basename(parent);
  const candidates = new Set<string>();

  if (parentName.endsWith(".worktrees")) {
    const repo = parent.slice(0, -".worktrees".length);
    if (repo !== "") candidates.add(repo);
  }
  if (parentName === ".worktrees") candidates.add(dirname(parent));
  if (parentName === "worktrees" && basename(dirname(parent)) === ".claude") {
    candidates.add(dirname(dirname(parent)));
  }
  return [...candidates];
}

/** The only commands a recovery may ever run. */
function isAllowedRecoveryCommand(argv: readonly string[]): boolean {
  if (argv[0] !== "worktree") return false;
  if (argv[1] !== "add" && argv[1] !== "prune") return false;
  return !argv.some((argument) => argument === "--force" || argument === "-f");
}

export function createWorktreeRecovery(options: RepoReaderOptions = {}): WorktreeRecovery {
  const processOptions = normalizeGitOptions(options);
  const git = (cwd: string, argv: readonly string[]): Promise<GitResult> =>
    runGit(cwd, argv, processOptions);

  const checkCancellation = createCancellationCheck(processOptions);

  async function worktrees(repoRoot: string): Promise<WorktreeEntry[]> {
    const result = await git(repoRoot, ["worktree", "list", "--porcelain"]);
    return result.ok ? parseWorktrees(result.stdout) : [];
  }

  async function refExists(repoRoot: string, ref: string): Promise<boolean> {
    const result = await git(repoRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      ref,
    ]);
    return result.ok && result.stdout.trim() !== "";
  }

  async function commitExists(repoRoot: string, commit: string): Promise<boolean> {
    const revision = plausibleRevision(commit);
    return revision === null ? false : await refExists(repoRoot, `${revision}^{commit}`);
  }

  async function parentRepository(directory: string): Promise<string | null> {
    for (const candidate of parentRepositoryCandidates(directory)) {
      if (!(await isDirectory(candidate))) continue;
      const common = await git(candidate, ["rev-parse", "--git-common-dir"]);
      if (common.ok && common.stdout.trim() !== "") return candidate;
    }
    return null;
  }

  function isPrunableRegistration(entries: readonly WorktreeEntry[], directory: string): boolean {
    return entries.some((entry) => entry.prunable && resolve(entry.path) === resolve(directory));
  }

  function branchCheckedOutElsewhere(
    entries: readonly WorktreeEntry[],
    branch: string,
    directory: string,
  ): boolean {
    return entries.some(
      (entry) => entry.branch === branch && resolve(entry.path) !== resolve(directory),
    );
  }

  async function stepsFor(
    repoRoot: string,
    directory: string,
    branch: string | null,
    commit: string | null,
  ): Promise<RecoverySteps> {
    const entries = await worktrees(repoRoot);
    const commands: RecoveryCommand[] = [];
    const warnings: string[] = [];

    // A stale registration of this exact directory blocks `worktree add`; prune it first.
    if (isPrunableRegistration(entries, directory)) {
      commands.push(command(repoRoot, ["worktree", "prune"]));
    }

    const headFallback = (): void => {
      commands.push(command(repoRoot, ["worktree", "add", "--detach", directory, "HEAD"]));
      warnings.push("recorded branch/commit not found; worktree starts at the repository's HEAD");
    };

    if (branch !== null) {
      const local = await refExists(repoRoot, `refs/heads/${branch}`);
      const checkedOutElsewhere = local && branchCheckedOutElsewhere(entries, branch, directory);
      if (checkedOutElsewhere) {
        warnings.push(
          `recorded branch ${branch} is already checked out in another worktree; it is not reused`,
        );
      }
      const remote = !local && (await refExists(repoRoot, `refs/remotes/origin/${branch}`));
      if (local && !checkedOutElsewhere) {
        commands.push(command(repoRoot, ["worktree", "add", directory, branch]));
      } else if (remote) {
        commands.push(
          command(repoRoot, [
            "worktree",
            "add",
            "--track",
            "-b",
            branch,
            directory,
            `origin/${branch}`,
          ]),
        );
      } else if (commit !== null && (await commitExists(repoRoot, commit))) {
        commands.push(command(repoRoot, ["worktree", "add", "--detach", directory, commit]));
        if (!local) warnings.push(`branch ${branch} no longer exists`);
      } else {
        headFallback();
      }
    } else if (commit !== null && (await commitExists(repoRoot, commit))) {
      commands.push(command(repoRoot, ["worktree", "add", "--detach", directory, commit]));
    } else {
      headFallback();
    }

    return { directory, commands, warnings };
  }

  return {
    checkCancellation,

    async place(request: PlaceRequest): Promise<Place> {
      checkCancellation();
      const directory = resolve(request.directory);
      const warnings: string[] = [];

      if (await isDirectory(directory)) {
        const branch = await currentBranch(directory, git);
        if (request.branch !== null && branch !== request.branch) {
          warnings.push(
            `${directory} ${branch === null ? "is not on a branch" : `is on branch ${branch}`}, ` +
              `but the session recorded ${request.branch}`,
          );
        }
        checkCancellation();
        return {
          state: "present",
          directory,
          branch,
          warnings,
          recovery: null,
          reason: null,
        };
      }

      const repoRoot = await parentRepository(directory);
      checkCancellation();
      if (repoRoot === null) {
        return {
          state: "unrecoverable",
          directory,
          branch: null,
          warnings,
          recovery: null,
          reason: `no repository was found for ${directory}`,
        };
      }

      const recovery = await stepsFor(
        repoRoot,
        directory,
        request.branch?.trim() ? request.branch.trim() : null,
        request.commit?.trim() ? request.commit.trim() : null,
      );
      checkCancellation();
      return {
        state: "recoverable",
        directory,
        branch: null,
        warnings: [...warnings, ...recovery.warnings],
        recovery,
        reason: null,
      };
    },

    async recover(plan: RecoverySteps): Promise<RecoveryResult> {
      checkCancellation();
      // Never write into an existing path, whatever the plan says.
      if (await pathExists(plan.directory)) {
        return {
          ok: false,
          stderr: "",
          message: `refusing to recover into existing path ${plan.directory}`,
        };
      }

      let stderr = "";
      for (const planned of plan.commands) {
        if (!isAllowedRecoveryCommand(planned.argv)) {
          return {
            ok: false,
            stderr,
            message: `refusing to run a command that is not a worktree add or prune: ${planned.display}`,
          };
        }
        const result = await git(planned.cwd, planned.argv);
        checkCancellation();
        stderr += result.stderr;
        if (!result.ok) {
          return {
            ok: false,
            stderr,
            message: result.stderr.trim() || result.stdout.trim() || "git failed without a message",
          };
        }
      }
      return { ok: true, stderr, message: null };
    },
  };
}
