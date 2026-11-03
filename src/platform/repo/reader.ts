import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { CommitDistance, RepoIdentity, RepoReader, RepoReaderOptions } from "./contract.js";
import { type GitResult, normalizeGitOptions, plausibleRevision, runGit } from "./git.js";

/** Nothing is known: `ahead` and `behind` are 0 so a caller cannot print a fabricated distance. */
function unknownDistance(): CommitDistance {
  return { known: false, ahead: 0, behind: 0 };
}

function unresolvedIdentity(): RepoIdentity {
  return { root: null, commonDir: null, isBare: false, head: null, branch: null };
}

/** A reader with process controls only; every lookup names its directory explicitly. */
export function createRepoReader(options: RepoReaderOptions = {}): RepoReader {
  const processOptions = normalizeGitOptions(options);
  const git = (directory: string, args: readonly string[]) =>
    runGit(directory, args, processOptions);

  const checkCancellation = () => {
    if (processOptions.signal?.aborted) {
      const error = new Error("Repository read aborted", { cause: processOptions.signal.reason });
      error.name = "AbortError";
      throw error;
    }
  };

  return {
    checkCancellation,
    identify: async (directory: string) => {
      checkCancellation();
      const identity = await identify(directory, git);
      checkCancellation();
      return identity;
    },
    distanceFrom: async (cwd: string, sourceCommit: string) => {
      checkCancellation();
      const distance = await distanceFrom(cwd, sourceCommit, git);
      checkCancellation();
      return distance;
    },
  };
}

/** Git terminates path records with LF; all preceding whitespace belongs to the path. */
function pathOutput(stdout: string): string {
  return stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
}

type GitRunner = (cwd: string, args: readonly string[]) => Promise<GitResult>;

async function identify(directory: string, git: GitRunner): Promise<RepoIdentity> {
  // Resolve the input itself: a missing worktree must never inherit its parent's identity.
  const dir = await resolveFully(resolve(directory));
  if (dir === null) return unresolvedIdentity();

  const common = await git(dir, ["rev-parse", "--git-common-dir"]);
  const commonPath = pathOutput(common.stdout);
  if (!common.ok || commonPath === "") return unresolvedIdentity();
  const commonDir = await resolveFully(resolve(dir, commonPath));
  if (commonDir === null) return unresolvedIdentity();

  const bare = await git(dir, ["rev-parse", "--is-bare-repository"]);
  if (!bare.ok) return unresolvedIdentity();
  const isBare = bare.stdout.trim() === "true";

  // Bare repositories have a shared identity but no checkout usable as an import destination.
  let root: string | null = null;
  if (!isBare) {
    const toplevel = await git(dir, ["rev-parse", "--show-toplevel"]);
    const checkoutPath = pathOutput(toplevel.stdout);
    if (!toplevel.ok || checkoutPath === "") return unresolvedIdentity();
    root = await resolveFully(resolve(dir, checkoutPath));
    if (root === null) return unresolvedIdentity();
  }

  return {
    root,
    commonDir,
    isBare,
    head: await commitOf(dir, "HEAD", git),
    branch: await branch(dir, git),
  };
}

async function distanceFrom(
  cwd: string,
  sourceCommit: string,
  git: GitRunner,
): Promise<CommitDistance> {
  const revision = plausibleRevision(sourceCommit);
  if (revision === null) return unknownDistance();

  const dir = resolve(cwd);
  const source = await commitOf(dir, revision, git);
  if (source === null) return unknownDistance();

  const from = await commitOf(dir, "HEAD", git);
  if (from === null) return unknownDistance();

  // Both sides are commits git itself printed, so the range holds no caller input.
  const counts = await git(dir, [
    "rev-list",
    "--left-right",
    "--count",
    `${from}...${source}`,
    "--",
  ]);
  if (!counts.ok) return unknownDistance();

  const parts = counts.stdout.trim().split(/\s+/);
  if (parts.length !== 2) return unknownDistance();
  const ahead = Number(parts[0]);
  const behind = Number(parts[1]);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) return unknownDistance();

  return { known: true, ahead, behind };
}

/** The commit a revision names, or null when this repository does not have it. */
async function commitOf(dir: string, revision: string, git: GitRunner): Promise<string | null> {
  // `--end-of-options` stops git reading the revision as an option, and `^{commit}` rejects a
  // revision that exists but is not a commit.
  const result = await git(dir, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${revision}^{commit}`,
  ]);
  const commit = result.stdout.trim();
  return result.ok && commit !== "" ? commit : null;
}

/** The branch HEAD is on, or null when HEAD is detached. An unborn branch still has a name. */
async function branch(dir: string, git: GitRunner): Promise<string | null> {
  const result = await git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const name = result.stdout.trim();
  return result.ok && name !== "" ? name : null;
}

/** The real path of a directory, following symlinks, so paths compare as locations. */
async function resolveFully(directory: string): Promise<string | null> {
  try {
    return await realpath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
