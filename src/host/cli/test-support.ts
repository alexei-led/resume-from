// Shared stubs for this module's tests. Tests drive CliRunner.run with a stub
// pipeline: no process is spawned and no terminal is required.

import type {
  AgentRuntime,
  CliInvocation,
  HomeFailure,
  ImportPipeline,
  ImportRequest,
  LandingResult,
  Listing,
  ListRequest,
  PreviewReport,
  ProvenanceMarker,
  SessionDescriptor,
} from "./contract.js";

export const REPO_ROOT = "/repo/demo";
export const CONFIRMATION_TOKEN = `v1-sha256-${"0".repeat(64)}`;

export function descriptor(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    ref: { agent: "codex", home: "/Users/me/.codex", id: "sess-1" },
    title: "Fix the parser crash",
    startedAt: "2026-08-05T09:00:00Z",
    updatedAt: "2026-08-05T14:03:00Z",
    turnCount: 12,
    repoPath: REPO_ROOT,
    repoPaths: [REPO_ROOT],
    startDirectory: REPO_ROOT,
    filePath: "/Users/me/.codex/sessions/sess-1.jsonl",
    ...overrides,
  };
}

export function homeFailure(overrides: Partial<HomeFailure> = {}): HomeFailure {
  return {
    home: "/Users/me/.pi",
    agent: "pi",
    message: "permission denied",
    ...overrides,
  };
}

export function listing(overrides: Partial<Listing> = {}): Listing {
  return { rows: [], failures: [], excluded: 0, ...overrides };
}

export function marker(overrides: Partial<ProvenanceMarker> = {}): ProvenanceMarker {
  return {
    sourceAgent: "codex",
    sourceHome: "/Users/me/.codex",
    sourceSessionId: "sess-1",
    importedAt: "2026-08-05T15:00:00Z",
    droppedSummary: "12 older turns dropped",
    lines: ["--- imported from codex ---", "session sess-1", "12 older turns dropped"],
    ...overrides,
  };
}

export function report(overrides: Partial<PreviewReport> = {}): PreviewReport {
  return {
    confirmationToken: CONFIRMATION_TOKEN,
    headerLines: ["From codex sess-1", "To claude-code"],
    budgetLine: "Budget: 34k tokens of a 200k window",
    warnings: [{ kind: "repo-state", line: "The repository moved 3 commits ahead" }],
    dropLines: ["12 older turns dropped"],
    blocked: false,
    blockedReason: null,
    lines: [
      "From codex sess-1",
      "To claude-code",
      "Budget: 34k tokens of a 200k window",
      "The repository moved 3 commits ahead",
      "12 older turns dropped",
    ],
    ...overrides,
  };
}

export function landing(overrides: Partial<LandingResult> = {}): LandingResult {
  return {
    ref: {
      agent: "claude-code",
      home: "/Users/me/.claude",
      id: "new-session-7",
    },
    switched: false,
    handover: {
      sessionId: "new-session-7",
      command: "claude --resume new-session-7",
    },
    itemsSent: 0,
    itemsStored: 24,
    marker: marker(),
    ...overrides,
  };
}

export function invocation(overrides: Partial<CliInvocation> = {}): CliInvocation {
  return {
    argv: [],
    cwd: REPO_ROOT,
    targetAgent: "claude-code",
    targetHome: null,
    ...overrides,
  };
}

export interface PipelineCalls {
  list: ListRequest[];
  preview: ImportRequest[];
  commit: {
    request: ImportRequest;
    runtime: AgentRuntime;
    confirmationToken: string;
  }[];
  /** The call names in the order they were made. */
  order: ("list" | "preview" | "commit")[];
}

export interface StubOptions {
  listing?: Listing;
  report?: PreviewReport;
  landing?: LandingResult;
  listRejects?: unknown;
  previewRejects?: unknown;
  commitRejects?: unknown;
}

export interface StubPipeline {
  pipeline: ImportPipeline;
  calls: PipelineCalls;
}

export function stubPipeline(options: StubOptions = {}): StubPipeline {
  const calls: PipelineCalls = { list: [], preview: [], commit: [], order: [] };
  const pipeline: ImportPipeline = {
    list(request) {
      calls.list.push(request);
      calls.order.push("list");
      if (options.listRejects !== undefined) return Promise.reject(options.listRejects);
      return Promise.resolve(options.listing ?? listing());
    },
    preview(request) {
      calls.preview.push(request);
      calls.order.push("preview");
      if (options.previewRejects !== undefined) return Promise.reject(options.previewRejects);
      return Promise.resolve(options.report ?? report());
    },
    commit(request, runtime, confirmationToken) {
      calls.commit.push({ request, runtime, confirmationToken });
      calls.order.push("commit");
      if (options.commitRejects !== undefined) return Promise.reject(options.commitRejects);
      return Promise.resolve(options.landing ?? landing());
    },
  };
  return { pipeline, calls };
}

/** Lines of a listing that are numbered rows, as printed. */
export function rowLines(stdout: string[]): string[] {
  return stdout.filter((line) => /^\s*\d+\s{2}/.test(line));
}
