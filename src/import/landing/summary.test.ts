import { describe, expect, it } from "vitest";
import type { Place } from "../../platform/repo/contract.js";
import type { SessionDescriptor } from "../../session/contract.js";
import type { TransferPlan } from "./contract.js";
import { buildMarker, formatTime, shortenPath, summariseDrops, summaryLines } from "./summary.js";

const DESCRIPTOR: SessionDescriptor = {
  ref: {
    agent: "claude-code",
    home: "/home/me/.claude",
    id: "dc601a22-64e3-410b-9321-bb8f86bdc5ad",
  },
  title: "Fix the parser crash",
  startedAt: "2026-11-03T10:00:00.000Z",
  updatedAt: "2026-11-03T10:04:00.000Z",
  turnCount: 4,
  repoPath: "/home/me/work/app",
  repoPaths: ["/home/me/work/app"],
  startDirectory: "/home/me/work/app",
  filePath: "/home/me/.claude/projects/x/dc601a22.jsonl",
};

function presentPlace(over: Partial<Place> = {}): Place {
  return {
    state: "present",
    directory: "/home/me/work/app",
    branch: "master",
    warnings: [],
    recovery: null,
    reason: null,
    ...over,
  };
}

function plan(over: Partial<TransferPlan> = {}): TransferPlan {
  return {
    target: { agent: "codex", home: "/home/me/.codex", windowTokens: 200_000 },
    provenance: {
      ref: DESCRIPTOR.ref,
      title: DESCRIPTOR.title,
      startedAt: DESCRIPTOR.startedAt,
      updatedAt: DESCRIPTOR.updatedAt,
      repo: { commit: null, branch: "master", changedPaths: [] },
    },
    turns: [],
    pins: [],
    drops: [],
    keptTurnCount: 4,
    droppedTurnCount: 0,
    bodiesDropped: 2,
    estimatedTokens: 10,
    budgetTokens: 1000,
    brokenTailDropped: false,
    blockedReason: null,
    ...over,
  };
}

describe("restore summary", () => {
  it("renders the two native lines with shortened home and directory", () => {
    expect(summaryLines(DESCRIPTOR, presentPlace(), "/home/me")).toEqual([
      "↻ claude-code dc601a22 · ~/.claude · 2026-11-03 10:04Z · Fix the parser crash",
      "  ~/work/app · master",
    ]);
  });

  it("names a missing directory and its state", () => {
    const lines = summaryLines(DESCRIPTOR, presentPlace({ state: "recoverable" }), "/home/me");
    expect(lines[1]).toBe("  ~/work/app · master · directory missing; it can be recreated");
  });

  it("builds the three-line provenance marker", () => {
    const marker = buildMarker(plan(), "2026-11-03T10:04:00.000Z", "/home/me/work/app", "/home/me");
    expect(marker.lines).toEqual([
      "↻ Restored from claude-code dc601a22 (~/.claude) · 2026-11-03 10:04Z",
      "  ~/work/app · master",
      "4 turns kept · Dropped on import: 2 tool result bodies.",
    ]);
    expect(marker.droppedSummary).toBe("Dropped on import: 2 tool result bodies.");
  });

  it("says so when nothing was dropped", () => {
    expect(summariseDrops(plan({ bodiesDropped: 0 }))).toBe(
      "Nothing was dropped: the whole session crossed over.",
    );
  });

  it("shortens only paths under the home and formats ISO stamps to the minute", () => {
    expect(shortenPath("/home/me", "/home/me")).toBe("~");
    expect(shortenPath("/home/me/work/app", "/home/me")).toBe("~/work/app");
    expect(shortenPath("/elsewhere/app", "/home/me")).toBe("/elsewhere/app");
    expect(formatTime("2026-11-03T10:04:12.000Z")).toBe("2026-11-03 10:04Z");
    expect(formatTime("not-a-time")).toBe("not-a-time");
  });
});
