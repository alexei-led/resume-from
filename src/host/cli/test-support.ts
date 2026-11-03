// Shared stubs for this module's tests. Tests drive CliRunner.run with a stub
// pipeline: no process is spawned and no terminal is required.

import type {
  AgentRuntime,
  CliInvocation,
  HomeFailure,
  ImportDestination,
  ImportPipeline,
  ImportRequest,
  LandingResult,
  Listing,
  ListRequest,
  Place,
  PreviewReport,
  ProvenanceMarker,
  RecoveryResult,
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
  return { rows: [], failures: [], ...overrides };
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
  order: ("list" | "preview" | "commit" | "locate" | "place" | "recover")[];
}

export interface StubOptions {
  listing?: Listing;
  report?: PreviewReport;
  landing?: LandingResult;
  /** The descriptor a locate returns; defaults to the standard fixture. */
  located?: SessionDescriptor;
  /** Where the located session's directory is; defaults to present at REPO_ROOT. */
  place?: Place;
  destination?: ImportDestination;
  contextLines?: string[];
  listRejects?: unknown;
  locateRejects?: unknown;
  previewRejects?: unknown;
  commitRejects?: unknown;
  /** The token a recoverable place is bound to; null means no plan. */
  recoveryToken?: string | null;
  destinationRejects?: unknown;
}

export function presentPlace(overrides: Partial<Place> = {}): Place {
  return {
    state: "present",
    directory: REPO_ROOT,
    branch: "main",
    warnings: [],
    recovery: null,
    reason: null,
    ...overrides,
  };
}

export interface StubPipeline {
  pipeline: ImportPipeline;
  calls: PipelineCalls;
}

export function stubPipeline(options: StubOptions = {}): StubPipeline {
  const calls: PipelineCalls = { list: [], preview: [], commit: [], order: [] };
  const located = options.located ?? descriptor();
  const place = options.place ?? presentPlace();
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
    async locate() {
      calls.order.push("locate");
      if (options.locateRejects !== undefined) return Promise.reject(options.locateRejects);
      return located;
    },
    async place() {
      calls.order.push("place");
      return place;
    },
    summary(targetSession, targetPlace) {
      return [
        `↻ ${targetSession.ref.agent} ${targetSession.ref.id.slice(0, 8)} · ${targetSession.ref.home} · ${targetSession.updatedAt} · ${targetSession.title}`,
        `  ${targetPlace.directory === "" ? "(no recorded directory)" : targetPlace.directory} · ${targetPlace.branch ?? "no branch"}`,
      ];
    },
    recoveryToken() {
      return options.recoveryToken ?? null;
    },
    async recover(): Promise<RecoveryResult> {
      calls.order.push("recover");
      return {
        ok: false,
        stderr: "",
        message: "this stub has no recovery",
      };
    },
    async destinationFor(_descriptor, to): Promise<ImportDestination> {
      if (options.destinationRejects !== undefined)
        return Promise.reject(options.destinationRejects);
      return (
        options.destination ?? {
          directory: to ?? located.startDirectory ?? located.repoPath ?? REPO_ROOT,
          warning: null,
        }
      );
    },
    resumeCommand(target, directory, prompt) {
      const suffix = prompt === null || prompt === "" ? "" : ` ${prompt}`;
      return `cd ${directory} && ${target.ref.agent} resume ${target.ref.id}${suffix}`;
    },
    async context() {
      return options.contextLines ?? ["User: hello", "Agent: hi"];
    },
    async switchTo() {
      return { switched: true, cancelled: false };
    },
  };
  return { pipeline, calls };
}

/** Lines of a listing that are numbered rows, as printed. */
export function rowLines(stdout: string[]): string[] {
  return stdout.filter((line) => /^\s*\d+\s{2}/.test(line));
}
