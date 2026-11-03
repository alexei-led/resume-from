// Test fixtures for this module only. Module-local, so they stay out of test/fixtures/
// (which is for fixtures shared across modules).

import type { SessionDescriptor } from "../../session/contract.js";
import { summaryLines } from "../landing/summary.js";
import type {
  AgentId,
  CanonicalTurn,
  CommitDistance,
  RepoIdentity,
  RepoReader,
  TransferPlan,
  TurnDrop,
} from "./contract.js";

export const SOURCE_COMMIT = "3f2a1bc";
export const HEAD_COMMIT = "9d81e04";

export function homeOf(agent: AgentId): string {
  return `/homes/${agent}`;
}

export function makeTurns(count: number, from = 0): CanonicalTurn[] {
  return Array.from({ length: count }, (_, i) => ({
    index: from + i,
    role: i % 2 === 0 ? ("user" as const) : ("agent" as const),
    kind: "message" as const,
    text: `turn ${from + i}`,
    toolCall: null,
    timestamp: null,
  }));
}

export function makeDrops(count: number, reason: TurnDrop["reason"], from = 0): TurnDrop[] {
  return Array.from({ length: count }, (_, i) => ({ index: from + i, reason }));
}

export interface PlanOverrides extends Partial<Omit<TransferPlan, "target" | "provenance">> {
  sourceAgent?: AgentId;
  targetAgent?: AgentId;
  targetHome?: string;
  title?: string;
  sourceCommit?: string | null;
  windowTokens?: number;
}

/** A plan with sensible defaults. Every field a test cares about is overridable. */
export function makePlan(overrides: PlanOverrides = {}): TransferPlan {
  const {
    sourceAgent = "pi",
    targetAgent = "claude-code",
    targetHome,
    title = "Fix the flaky retry test",
    sourceCommit = SOURCE_COMMIT,
    windowTokens = 200000,
    ...planFields
  } = overrides;

  const base: TransferPlan = {
    target: { agent: targetAgent, home: targetHome ?? homeOf(targetAgent), windowTokens },
    provenance: {
      ref: { agent: sourceAgent, home: homeOf(sourceAgent), id: "session-1" },
      title,
      startedAt: "2026-08-01T09:00:00.000Z",
      updatedAt: "2026-08-01T11:30:00.000Z",
      repo: { commit: sourceCommit, branch: "main", changedPaths: [] },
    },
    turns: makeTurns(34),
    pins: [],
    drops: [],
    keptTurnCount: 34,
    droppedTurnCount: 0,
    bodiesDropped: 0,
    estimatedTokens: 34000,
    budgetTokens: 60000,
    brokenTailDropped: false,
    blockedReason: null,
  };

  return { ...base, ...planFields };
}

/**
 * The shared restore header the pipeline hands the builder, rendered from the same plan.
 * Tests use it so a preview is always built the way a host builds one.
 */
export function summaryFor(
  plan: TransferPlan,
  directory = "/repo",
  branch: string | null = null,
): string[] {
  const descriptor: SessionDescriptor = {
    ref: plan.provenance.ref,
    title: plan.provenance.title,
    startedAt: plan.provenance.startedAt,
    updatedAt: plan.provenance.updatedAt,
    turnCount: plan.keptTurnCount,
    repoPath: null,
    repoPaths: [],
    startDirectory: null,
    filePath: "",
  };
  return summaryLines(descriptor, {
    state: "present",
    directory,
    branch,
    warnings: [],
    recovery: null,
    reason: null,
  });
}

export interface StubRepoOptions {
  identity?: RepoIdentity | Error;
  distance?: CommitDistance | Error;
}

export interface StubRepo extends RepoReader {
  identifyCalls: string[];
  distanceCalls: { cwd: string; sourceCommit: string }[];
}

/** A repository reader that answers from fixed values. It touches no repository. */
export function stubRepo(options: StubRepoOptions = {}): StubRepo {
  const identity = options.identity ?? {
    root: "/repo",
    commonDir: "/repo/.git",
    isBare: false,
    head: HEAD_COMMIT,
    branch: "main",
  };
  const distance = options.distance ?? { known: true, ahead: 14, behind: 0 };
  const identifyCalls: string[] = [];
  const distanceCalls: { cwd: string; sourceCommit: string }[] = [];

  return {
    identifyCalls,
    distanceCalls,
    checkCancellation() {},
    async identify(cwd: string): Promise<RepoIdentity> {
      identifyCalls.push(cwd);
      if (identity instanceof Error) throw identity;
      return identity;
    },
    async distanceFrom(cwd: string, sourceCommit: string): Promise<CommitDistance> {
      distanceCalls.push({ cwd, sourceCommit });
      if (distance instanceof Error) throw distance;
      return distance;
    },
  };
}
