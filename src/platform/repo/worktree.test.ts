// T-REP-22 — place resolution and the ordered recovery plan (FR-61).
// Every repository here is disposable and lives in a temporary directory.

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { RecoverySteps } from "./contract.js";
import {
  cleanupTempDirs,
  commitFile,
  git,
  headOf,
  repoWithOneCommit,
  tempDir,
} from "./test-support.js";
import { createWorktreeRecovery } from "./worktree.js";

afterEach(async () => {
  await cleanupTempDirs();
});
afterAll(async () => {
  await cleanupTempDirs();
});

async function repoWithBranch(branch: string): Promise<{ dir: string; name: string }> {
  const { dir } = await repoWithOneCommit();
  await git(dir, ["checkout", "-q", "-b", branch]);
  await commitFile(dir, `${branch}-work`);
  await git(dir, ["checkout", "-q", "main"]);
  return { dir, name: branch };
}

describe("place", () => {
  it("reports a present directory, and warns when the branch differs", async () => {
    const { dir } = await repoWithOneCommit();
    const planner = createWorktreeRecovery();

    const present = await planner.place({ directory: dir, branch: "main", commit: null });
    expect(present.state).toBe("present");
    expect(present.branch).toBe("main");
    expect(present.warnings).toEqual([]);

    const differs = await planner.place({ directory: dir, branch: "feature", commit: null });
    expect(differs.state).toBe("present");
    expect(differs.warnings.join(" ")).toContain("feature");
    expect(differs.warnings.join(" ")).toContain("main");
  });

  it("reports an unrecoverable directory when no parent repository matches", async () => {
    const base = await tempDir();
    const missing = join(base, "gone", "worktree");
    const place = await createWorktreeRecovery().place({
      directory: missing,
      branch: "main",
      commit: null,
    });
    expect(place.state).toBe("unrecoverable");
    expect(place.recovery).toBeNull();
    expect(place.reason).toContain(missing);
  });
});

describe("recovery planning and execution", () => {
  async function planFor(
    repo: string,
    name: string,
    branch: string | null,
    commit: string | null,
  ): Promise<{ directory: string; plan: RecoverySteps }> {
    const directory = join(`${repo}.worktrees`, name);
    const place = await createWorktreeRecovery().place({ directory, branch, commit });
    expect(place.state).toBe("recoverable");
    if (place.recovery === null) throw new Error("no recovery plan");
    return { directory, plan: place.recovery };
  }

  it("adds a worktree for a local branch", async () => {
    const { dir } = await repoWithBranch("feature");
    const { directory, plan } = await planFor(dir, "feature", "feature", null);
    expect(plan.commands.map((command) => command.argv)).toEqual([
      ["worktree", "add", directory, "feature"],
    ]);

    const result = await createWorktreeRecovery().recover(plan);
    expect(result.ok).toBe(true);
    expect(existsSync(directory)).toBe(true);
    expect(await git(directory, ["symbolic-ref", "--short", "HEAD"])).toBe("feature");
  });

  it("tracks an origin-only branch", async () => {
    const { dir } = await repoWithOneCommit();
    const head = await headOf(dir);
    // A configured remote, so `--track` can resolve `origin/remote-feature` (no fetch is run).
    await git(dir, ["remote", "add", "origin", dir]);
    await git(dir, ["update-ref", "refs/remotes/origin/remote-feature", head]);
    const { directory, plan } = await planFor(dir, "remote", "remote-feature", null);
    expect(plan.commands.map((command) => command.argv)).toEqual([
      ["worktree", "add", "--track", "-b", "remote-feature", directory, "origin/remote-feature"],
    ]);
    expect((await createWorktreeRecovery().recover(plan)).ok).toBe(true);
    expect(existsSync(directory)).toBe(true);
  });

  it("detaches at the recorded commit when the branch no longer exists", async () => {
    const { dir } = await repoWithOneCommit();
    const head = await headOf(dir);
    const { directory, plan } = await planFor(dir, "detached", "gone", head);
    expect(plan.commands.map((command) => command.argv)).toEqual([
      ["worktree", "add", "--detach", directory, head],
    ]);
    expect(plan.note).toContain("branch gone no longer exists");
    expect((await createWorktreeRecovery().recover(plan)).ok).toBe(true);
    expect(await git(directory, ["rev-parse", "HEAD"])).toBe(head);
  });

  it("falls back to HEAD with a warning when neither branch nor commit exists", async () => {
    const { dir } = await repoWithOneCommit();
    const head = await headOf(dir);
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const { directory, plan } = await planFor(dir, "head", "gone", missing);
    expect(plan.commands.map((command) => command.argv)).toEqual([
      ["worktree", "add", "--detach", directory, "HEAD"],
    ]);
    expect(plan.warnings.join(" ")).toContain("HEAD");
    expect((await createWorktreeRecovery().recover(plan)).ok).toBe(true);
    expect(await git(directory, ["rev-parse", "HEAD"])).toBe(head);
  });

  it("prunes a stale registration of the same directory first", async () => {
    const { dir } = await repoWithBranch("feature");
    const other = join(`${dir}.worktrees`, "other");
    await git(dir, ["worktree", "add", "-q", other, "feature"]);
    await rm(other, { recursive: true, force: true });

    const { plan } = await planFor(dir, "other", "feature", null);
    expect(plan.commands.map((command) => command.argv)).toEqual([
      ["worktree", "prune"],
      ["worktree", "add", join(`${dir}.worktrees`, "other"), "feature"],
    ]);
    expect((await createWorktreeRecovery().recover(plan)).ok).toBe(true);
  });

  it("does not take a branch already checked out in another worktree", async () => {
    const { dir } = await repoWithBranch("feature");
    const other = join(`${dir}.worktrees`, "existing");
    await git(dir, ["worktree", "add", "-q", other, "feature"]);

    const { plan } = await planFor(dir, "second", "feature", null);
    // The branch is busy, no commit was recorded, so the safe plan is HEAD.
    expect(plan.commands.map((command) => command.argv)).toEqual([
      ["worktree", "add", "--detach", join(`${dir}.worktrees`, "second"), "HEAD"],
    ]);
  });

  it("refuses to recover into an existing path", async () => {
    const { dir } = await repoWithBranch("feature");
    const { plan } = await planFor(dir, "exists", "feature", null);
    await git(dir, ["worktree", "add", "-q", plan.directory, "feature"]);

    const result = await createWorktreeRecovery().recover(plan);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("refusing to recover into existing path");
  });

  it("refuses a plan that is not a worktree add or prune", async () => {
    const { dir } = await repoWithOneCommit();
    const planner = createWorktreeRecovery();
    const plan: RecoverySteps = {
      repoRoot: dir,
      directory: join(dir, "new"),
      commands: [{ cwd: dir, argv: ["fetch", "origin"], display: "git -C x fetch origin" }],
      warnings: [],
      note: null,
    };
    const result = await planner.recover(plan);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not a worktree add or prune");
  });

  it("reports git's own message and stops at the first failure", async () => {
    const { dir } = await repoWithOneCommit();
    const target = join(`${dir}.worktrees`, "bad");
    const plan: RecoverySteps = {
      repoRoot: dir,
      directory: target,
      commands: [
        {
          cwd: dir,
          argv: ["worktree", "add", target, "no-such-branch"],
          display: "git -C repo worktree add target no-such-branch",
        },
      ],
      warnings: [],
      note: null,
    };
    const result = await createWorktreeRecovery().recover(plan);
    expect(result.ok).toBe(false);
    expect(result.failedCommand).toContain("no-such-branch");
    expect(result.message?.length).toBeGreaterThan(0);
  });
});

describe("cancellation", () => {
  it("rejects before doing any I/O when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const planner = createWorktreeRecovery({ signal: controller.signal });
    await expect(
      planner.place({ directory: "/nowhere", branch: null, commit: null }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
