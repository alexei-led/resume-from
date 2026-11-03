import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createPreviewBuilder } from "./builder.js";
import type { AgentId, PreviewWarning, TransferPlan } from "./contract.js";
import {
  HEAD_COMMIT,
  makeDrops,
  makePlan,
  makeTurns,
  SOURCE_COMMIT,
  stubRepo,
  summaryFor,
} from "./fixtures.js";
import { sortWarnings } from "./warnings.js";

const CWD = "/repo";
const AGENTS: AgentId[] = ["pi", "codex", "claude-code"];

/** A builder that receives the shared header the pipeline would hand it. */
function previewer(...args: Parameters<typeof createPreviewBuilder>) {
  const builder = createPreviewBuilder(...args);
  return { build: (plan: TransferPlan) => builder.build(plan, summaryFor(plan)) };
}

/** Replaces every agent name — and the home paths built from one — with a placeholder. */
function maskAgents(line: string): string {
  return line.replace(/claude-code|codex|pi/g, "AGENT");
}

function kindsOf(warnings: PreviewWarning[]): string[] {
  return warnings.map((w) => w.kind);
}

describe("unit", () => {
  it("T-PRE-1: the header states both turn counts", async () => {
    const plan = makePlan({
      turns: makeTurns(34),
      keptTurnCount: 34,
      droppedTurnCount: 12,
      drops: makeDrops(12, "budget"),
    });
    const report = await previewer(stubRepo(), CWD).build(plan);

    const countLine = report.headerLines.find((line) => line.includes("cross over"));
    expect(countLine).toBe("34 turns cross over, 12 dropped");
    expect(countLine).toContain(String(plan.keptTurnCount));
    expect(countLine).toContain(String(plan.droppedTurnCount));
  });

  it("T-PRE-2: the budget line has the required form", async () => {
    const plan = makePlan({ estimatedTokens: 34000, windowTokens: 200000 });
    const report = await previewer(stubRepo(), CWD).build(plan);

    expect(report.budgetLine).toBe("Budget: 34k tokens of a 200k window");
  });

  it("T-PRE-3: the repository warning has the required form", async () => {
    const plan = makePlan({ sourceCommit: SOURCE_COMMIT });
    const repo = stubRepo({
      identity: {
        root: "/repo",
        commonDir: "/repo/.git",
        isBare: false,
        head: HEAD_COMMIT,
        branch: "main",
      },
      distance: { known: true, ahead: 14, behind: 0 },
    });
    const report = await previewer(repo, CWD).build(plan);

    expect(report.warnings[0]).toEqual({
      kind: "repo-state",
      line: "⚠ Source ran at 3f2a1bc. The tree is now at 9d81e04 (14 commits ahead).",
    });

    const gaps: [{ known: true; ahead: number; behind: number }, string][] = [
      [{ known: true, ahead: 1, behind: 0 }, "(1 commit ahead)"],
      [{ known: true, ahead: 0, behind: 3 }, "(3 commits behind)"],
      [{ known: true, ahead: 14, behind: 3 }, "(14 commits ahead, 3 behind)"],
    ];
    for (const [distance, expected] of gaps) {
      const moved = await previewer(stubRepo({ distance }), CWD).build(plan);
      expect(moved.warnings[0]?.line).toBe(
        `⚠ Source ran at 3f2a1bc. The tree is now at 9d81e04 ${expected}.`,
      );
    }
  });

  it("T-PRE-4: the drop line has the required form", async () => {
    const plan = makePlan({ droppedTurnCount: 12, drops: makeDrops(12, "budget") });
    const report = await previewer(stubRepo(), CWD).build(plan);

    expect(report.dropLines).toContain("12 older turns dropped");
  });

  it("T-PRE-5: a broken tail is stated", async () => {
    const plan = makePlan({
      brokenTailDropped: true,
      droppedTurnCount: 1,
      drops: makeDrops(1, "broken-tail"),
    });
    const report = await previewer(stubRepo(), CWD).build(plan);

    const tail = report.warnings.find((w) => w.kind === "broken-tail");
    expect(tail?.line).toBe("⚠ The last tool call was incomplete and was dropped.");
  });

  it("T-PRE-6: the repository warning sorts first", async () => {
    // The ordering step, given the four kinds added in reverse order.
    const added: PreviewWarning[] = [
      { kind: "capability", line: "c" },
      { kind: "broken-tail", line: "t" },
      { kind: "budget", line: "b" },
      { kind: "repo-state", line: "r" },
    ];
    expect(kindsOf(sortWarnings(added))).toEqual([
      "repo-state",
      "budget",
      "broken-tail",
      "capability",
    ]);

    // And end to end, from a plan that produces a budget and a broken-tail warning too.
    const plan = makePlan({
      estimatedTokens: 70000,
      budgetTokens: 60000,
      brokenTailDropped: true,
    });
    const report = await previewer(stubRepo(), CWD).build(plan);

    expect(kindsOf(report.warnings)).toEqual(["repo-state", "budget", "broken-tail"]);
    expect(report.warnings[0]?.kind).toBe("repo-state");
  });

  it("T-PRE-7: no difference, no warning", async () => {
    const full = "9d81e0489f0e6cbf5c5d0e4e2f6d1a3b7c8e9f01";
    const cases: [string, string][] = [
      [HEAD_COMMIT, HEAD_COMMIT],
      // The source recorded the full commit; git reports the abbreviation, or the reverse.
      [full, HEAD_COMMIT],
      [HEAD_COMMIT, full],
    ];

    for (const [sourceCommit, head] of cases) {
      const repo = stubRepo({
        identity: { root: "/repo", commonDir: "/repo/.git", isBare: false, head, branch: "main" },
      });
      const report = await previewer(repo, CWD).build(makePlan({ sourceCommit }));

      expect(kindsOf(report.warnings)).not.toContain("repo-state");
      expect(repo.distanceCalls).toEqual([]);
    }

    // A prefix shorter than a short commit is not a match: it must not silence the warning.
    const truncated = await previewer(stubRepo(), CWD).build(
      makePlan({ sourceCommit: HEAD_COMMIT.slice(0, 1) }),
    );
    expect(kindsOf(truncated.warnings)).toContain("repo-state");
  });

  it("T-PRE-8: an unknown source commit is said to be unknown", async () => {
    const unrecorded = await previewer(stubRepo(), CWD).build(makePlan({ sourceCommit: null }));
    const absent = await previewer(
      stubRepo({ distance: { known: false, ahead: 0, behind: 0 } }),
      CWD,
    ).build(makePlan({ sourceCommit: SOURCE_COMMIT }));

    for (const report of [unrecorded, absent]) {
      const warning = report.warnings.find((w) => w.kind === "repo-state");
      expect(warning?.line).toContain("not known here");
      // No distance is guessed.
      expect(warning?.line).not.toMatch(/commits? (ahead|behind)/);
    }
    expect(unrecorded.warnings[0]?.line).not.toContain(SOURCE_COMMIT);
    expect(absent.warnings[0]?.line).toContain(SOURCE_COMMIT);
  });
});

describe("integration contract", () => {
  it("starts with the shared restore header and adds only the preview facts", async () => {
    const identity = {
      root: "/repo",
      commonDir: "/repo/.git",
      isBare: false,
      head: HEAD_COMMIT,
      branch: "main",
    };
    const plan = makePlan();
    const report = await createPreviewBuilder(stubRepo({ identity }), CWD, CWD, identity).build(
      plan,
      summaryFor(plan, CWD, "main"),
    );

    expect(report.headerLines).toEqual([
      "↻ pi session- · /homes/pi · 2026-08-01 11:30Z · Fix the flaky retry test",
      "  /repo · main",
      "Target: claude-code (/homes/claude-code)",
      "34 turns cross over",
    ]);
    // The header already shows the source, destination and branch; the preview does not repeat them.
    expect(report.lines.join("\n")).not.toContain("Source:");
    expect(report.lines.join("\n")).not.toContain("Destination:");
  });

  it("T-PRE-2, T-PRE-3, T-PRE-4: the required lines match module.md character for character", async () => {
    // The design document is the authority on these three strings, not a literal typed twice.
    const design = await readFile(new URL("./module.md", import.meta.url), "utf8");
    const quoted = (pattern: RegExp): string => {
      const found = design.match(pattern);
      if (found === null) throw new Error(`module.md no longer states: ${pattern}`);
      return found[0];
    };

    const plan = makePlan({
      estimatedTokens: 34000,
      windowTokens: 200000,
      droppedTurnCount: 12,
      drops: makeDrops(12, "budget"),
    });
    const report = await previewer(stubRepo(), CWD).build(plan);

    expect(report.budgetLine).toBe(quoted(/Budget: 34k tokens of a 200k window/));
    expect(report.warnings[0]?.line).toBe(
      quoted(/⚠ Source ran at 3f2a1bc\. The tree is now at 9d81e04 \(14 commits ahead\)\./),
    );
    expect(report.dropLines[0]).toBe(quoted(/12 older turns dropped/));
  });

  it("T-PRE-9: lines contains everything, in order and nothing else", async () => {
    const plan = makePlan({
      keptTurnCount: 34,
      droppedTurnCount: 12,
      drops: makeDrops(12, "budget"),
      bodiesDropped: 23,
      brokenTailDropped: true,
    });
    const report = await previewer(stubRepo(), CWD).build(plan);

    expect(report.warnings).toHaveLength(2);
    expect(report.dropLines).toHaveLength(2);
    expect(report.lines).toEqual([
      ...report.headerLines,
      report.budgetLine,
      ...report.warnings.map((w) => w.line),
      ...report.dropLines,
    ]);
  });

  it("T-PRE-10: the shape is identical for all nine directions", async () => {
    const masked: string[][] = [];
    for (const source of AGENTS) {
      for (const target of AGENTS) {
        const plan = makePlan({
          sourceAgent: source,
          targetAgent: target,
          droppedTurnCount: 12,
          drops: makeDrops(12, "budget"),
        });
        const report = await previewer(stubRepo(), CWD).build(plan);
        masked.push(report.lines.map(maskAgents));
      }
    }

    expect(masked).toHaveLength(9);
    for (const lines of masked) {
      expect(lines).toEqual(masked[0]);
    }
  });

  it("T-PRE-11: every number in the rendered lines comes from the plan", async () => {
    const plans = [
      makePlan(),
      makePlan({ keptTurnCount: 5, droppedTurnCount: 3, drops: makeDrops(3, "budget") }),
      makePlan({ estimatedTokens: 840, budgetTokens: 1000, windowTokens: 128000 }),
      makePlan({ keptTurnCount: 0, turns: [], estimatedTokens: 0, bodiesDropped: 7 }),
    ];

    for (const plan of plans) {
      const distance = { known: true, ahead: 14, behind: 2 };
      const report = await previewer(stubRepo({ distance }), CWD).build(plan);
      const budgetDrops = plan.drops.filter((d) => d.reason === "budget").length;
      const sources = [
        plan.keptTurnCount,
        plan.droppedTurnCount,
        plan.bodiesDropped,
        plan.estimatedTokens,
        plan.budgetTokens,
        plan.target.windowTokens,
        budgetDrops,
        distance.ahead,
        distance.behind,
      ];
      const allowed = new Set<string>();
      for (const value of sources) {
        allowed.add(String(value));
        allowed.add(value >= 1000 ? `${Math.round(value / 1000)}k` : String(value));
      }
      // The header's time comes from the plan's own updatedAt, so its parts are plan numbers too.
      for (const part of plan.provenance.updatedAt.split(/\D+/)) {
        if (part !== "") allowed.add(part);
      }

      // Standalone numbers only: the digits inside a commit hash are part of a word.
      const printed = report.lines.join("\n").match(/(?<![\w.])\d+k?(?![\w])/g) ?? [];
      for (const number of printed) {
        expect(allowed).toContain(number);
      }
    }
  });

  it("T-PRE-12: a blocked plan renders and blocks", async () => {
    const plan = makePlan({
      blockedReason: "The pinned turns need 82k tokens, more than the 60k budget.",
    });
    const report = await previewer(stubRepo(), CWD).build(plan);

    expect(report.blocked).toBe(true);
    expect(report.blockedReason).toBe(plan.blockedReason);
    expect(report.lines.join("\n")).toContain(plan.blockedReason as string);
    expect(report.budgetLine).toBe("Budget: 34k tokens of a 200k window");
  });
});

describe("behavior", () => {
  it("T-PRE-19: the user can see what they are agreeing to", async () => {
    const plan = makePlan({
      turns: makeTurns(34),
      keptTurnCount: 34,
      droppedTurnCount: 12,
      drops: makeDrops(12, "budget"),
      estimatedTokens: 34000,
      windowTokens: 200000,
    });
    const report = await previewer(stubRepo(), CWD).build(plan);

    expect(report.lines[0]).toContain("pi");
    expect(report.lines).toContain("34 turns cross over, 12 dropped");
    expect(report.lines).toContain("Budget: 34k tokens of a 200k window");
    expect(report.lines).toContain("12 older turns dropped");
    // The repository warning is the first warning, and warnings follow the budget line.
    const warningIndex = report.lines.indexOf(report.warnings[0]?.line as string);
    expect(report.warnings[0]?.kind).toBe("repo-state");
    expect(warningIndex).toBe(report.lines.indexOf(report.budgetLine) + 1);
    expect(report.blocked).toBe(false);
  });

  it("T-PRE-20: one preview, whatever the agents", async () => {
    const build = async (source: AgentId, target: AgentId) => {
      const plan = makePlan({
        sourceAgent: source,
        targetAgent: target,
        droppedTurnCount: 12,
        drops: makeDrops(12, "budget"),
      });
      const report = await previewer(stubRepo(), CWD).build(plan);
      return report.lines;
    };

    const piToPi = await build("pi", "pi");
    const codexToClaude = await build("codex", "claude-code");

    expect(piToPi).not.toEqual(codexToClaude);
    expect(codexToClaude.map(maskAgents)).toEqual(piToPi.map(maskAgents));
  });

  it("T-PRE-21: the blocked case tells the user what to do", async () => {
    // blockedReason now carries the advice inline (builder.ts no longer appends a fixed string).
    const plan = makePlan({
      blockedReason:
        "Pinned content needs 82k tokens, more than the 60k budget. " +
        "Raise the budget share, or lower the number of pinned recent turns.",
      estimatedTokens: 82000,
      budgetTokens: 60000,
    });
    const report = await previewer(stubRepo(), CWD).build(plan);

    const text = report.lines.join("\n");
    expect(text).toContain("budget share");
    expect(text).toContain("pinned");
  });
});
