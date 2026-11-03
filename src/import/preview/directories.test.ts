import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createPreviewBuilder } from "./builder.js";
import type { TransferPlan } from "./contract.js";
import { makePlan, stubRepo, summaryFor } from "./fixtures.js";

/** A builder that receives the shared header the pipeline would hand it. */
function previewer(...args: Parameters<typeof createPreviewBuilder>) {
  const builder = createPreviewBuilder(...args);
  return { build: (plan: TransferPlan) => builder.build(plan, summaryFor(plan)) };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test.each(["same", "alias", "subdirectory", "mixed", "missing", "empty"] as const)(
  "recorded source directory warning: %s",
  async (scenario) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "resume-preview-directories-")));
    roots.push(root);
    const subdirectory = join(root, "subdirectory");
    await mkdir(subdirectory);
    const alias = join(root, "alias");
    await symlink(root, alias);
    const missing = join(root, "removed-worktree");
    const candidates = {
      same: [root],
      alias: [alias],
      subdirectory: [subdirectory],
      mixed: [missing, root, subdirectory],
      missing: [missing, root],
      empty: [],
    }[scenario];
    const report = await previewer(stubRepo(), root, root, undefined, candidates).build(makePlan());
    const warnings = report.warnings.filter((warning) =>
      warning.line.includes("different directory"),
    );
    expect(warnings).toHaveLength(scenario === "subdirectory" || scenario === "mixed" ? 1 : 0);
    for (const warning of warnings) {
      expect(warning.kind).toBe("repo-state");
      expect(warning.line).toContain(
        "does not transfer uncommitted work, switch branches, or recreate removed worktrees",
      );
      expect(warning.line).not.toContain("different repository");
      expect(warning.line).not.toContain("different checkout");
      expect(report.lines).toContain(warning.line);
    }
    expect(report.blocked).toBe(false);
  },
);
