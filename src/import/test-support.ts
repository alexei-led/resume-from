// Test fixtures for the pipeline: stub agents over real directories, a real committer over a
// temporary directory, and the recorders the stage-order tests need.
//
// Why a committer of its own: `src/platform/store/` owns the real one, but a module may only
// import another module's `contract.js` (docs/tech-stack.md, Isolation conventions), and
// `src/import/` is not the composition root. The committer below is deliberately minimal — it
// creates files or none, and nothing else — because the store's own tests own that behaviour.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { REFERENCE_SESSION } from "../../test/fixtures/reference-session.js";
import type { CommitDistance, RepoIdentity, RepoReader } from "../platform/repo/contract.js";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentId,
  AgentRuntime,
  CanonicalSession,
  CanonicalTurn,
  CommitError,
  CommitHandle,
  CommitRefusal,
  FileCommitter,
  HomePath,
  ImportConfig,
  ImportPipeline,
  ImportRequest,
  LandingLevel,
  LandingResult,
  PendingFile,
  PreviewBuilder,
  PreviewReport,
  ProvenanceMarker,
  ProvenanceSupport,
  SelectionLevel,
  SerializationContext,
  SerializedSession,
  SessionDescriptor,
  SessionId,
  SessionLander,
  SourceProvenance,
  StoredSessionFacts,
  SwitchOutcome,
  TargetProfile,
  TokenEstimator,
  TransferPlan,
  TransferRules,
  ValidationDefect,
} from "./contract.js";
import { createPipelineFromStages, type PipelineStages } from "./pipeline.js";
import { buildStages, type ImportPipelineDeps } from "./wiring.js";

export const SESSIONS_DIR = "sessions";
export const LANDED_DIR = "landed";

/** Preview the exact request, then commit the confirmation token that preview returned. */
export async function commitPreviewed(
  pipeline: ImportPipeline,
  request: ImportRequest,
  runtime: AgentRuntime = null,
): Promise<LandingResult> {
  const report = await pipeline.preview(request);
  return pipeline.commit(request, runtime, report.confirmationToken);
}

/** One token per character: a test can state a budget and know exactly what fits. */
export const charEstimator: TokenEstimator = {
  estimate: (text) => text.length,
};

/** Half a token per character, so the same session costs a different number of tokens. */
export const halfEstimator: TokenEstimator = {
  estimate: (text) => Math.ceil(text.length / 2),
};

export function defaultConfig(overrides: Partial<ImportConfig> = {}): ImportConfig {
  return {
    extraHomes: [],
    budgetShare: 0.3,
    pinnedRecentTurns: 5,
    windowOverrides: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Source fixtures on disk
// ---------------------------------------------------------------------------

export interface SessionSpec {
  id: SessionId;
  title: string;
  startedAt: string;
  repoPath: string | null;
  commit: string | null;
  branch: string | null;
  turns: CanonicalTurn[];
  /**
   * The result bodies the source recorded. The canonical vocabulary has no field
   * for them, so nothing can carry one out of `loadSession` (FR-24).
   */
  bodies?: Record<number, string>;
}

interface HeaderLine {
  kind: "header";
  id: SessionId;
  title: string;
  startedAt: string;
  repoPath: string | null;
  commit: string | null;
  branch: string | null;
}

interface TurnLine {
  kind: "turn";
  turn: CanonicalTurn;
  body?: string;
}

function lastTimestamp(turns: CanonicalTurn[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const stamp = turns[index]?.timestamp;
    if (stamp) return stamp;
  }
  return null;
}

export function sessionFilePath(home: HomePath, id: SessionId): string {
  return path.join(home, SESSIONS_DIR, `${id}.jsonl`);
}

/**
 * Writes one source session, then pins the file's modification time to the timestamp of its
 * last turn. Real adapters report the file time when a session file moved past the content
 * they could read (`src/adapters/claude-code/reader.ts`), and the pipeline's freshness check
 * compares the two. Pinning here is what makes an unchanged fixture commit cleanly — every
 * fixture must go through this function.
 */
export async function writeSession(home: HomePath, spec: SessionSpec): Promise<string> {
  const filePath = sessionFilePath(home, spec.id);
  await mkdir(path.dirname(filePath), { recursive: true });
  const header: HeaderLine = {
    kind: "header",
    id: spec.id,
    title: spec.title,
    startedAt: spec.startedAt,
    repoPath: spec.repoPath,
    commit: spec.commit,
    branch: spec.branch,
  };
  const lines = [JSON.stringify(header)];
  for (const turn of spec.turns) {
    const body = spec.bodies?.[turn.index];
    const line: TurnLine =
      body === undefined ? { kind: "turn", turn } : { kind: "turn", turn, body };
    lines.push(JSON.stringify(line));
  }
  await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  const pinned = new Date(lastTimestamp(spec.turns) ?? spec.startedAt);
  await utimes(filePath, pinned, pinned);
  return filePath;
}

interface ParsedSession {
  header: HeaderLine;
  turns: CanonicalTurn[];
}

/** Skips lines it cannot read, the way a real adapter tolerates a broken tail. */
async function parseSession(filePath: string): Promise<ParsedSession> {
  const text = await readFile(filePath, "utf8");
  let header: HeaderLine | null = null;
  const turns: CanonicalTurn[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: HeaderLine | TurnLine;
    try {
      parsed = JSON.parse(line) as HeaderLine | TurnLine;
    } catch {
      continue;
    }
    if (parsed.kind === "header") header = parsed;
    if (parsed.kind === "turn") turns.push(parsed.turn);
  }
  if (!header) throw new Error(`${filePath} is not a session file`);
  return { header, turns };
}

function provenanceOf(agent: AgentId, home: HomePath, parsed: ParsedSession): SourceProvenance {
  return {
    ref: { agent, home, id: parsed.header.id },
    title: parsed.header.title,
    startedAt: parsed.header.startedAt,
    updatedAt: lastTimestamp(parsed.turns) ?? parsed.header.startedAt,
    repo: {
      commit: parsed.header.commit,
      branch: parsed.header.branch,
      changedPaths: parsed.turns
        .filter((turn) => turn.toolCall?.effect === "mutating")
        .map((turn) => turn.toolCall?.argumentsText.replaceAll("'", "") ?? ""),
    },
  };
}

// ---------------------------------------------------------------------------
// Stub adapters
// ---------------------------------------------------------------------------

interface CapabilityShape {
  selection: SelectionLevel;
  landing: LandingLevel;
  provenance: ProvenanceSupport;
}

/** Mirrors what the three real adapters declare, so the stubs are not more uniform than reality. */
const DECLARED: Record<string, CapabilityShape> = {
  pi: {
    selection: "interactive-picker",
    landing: "create-and-switch",
    provenance: "out-of-context-entry",
  },
  codex: {
    selection: "numbered-list",
    landing: "create-only",
    provenance: "out-of-context-entry",
  },
  "claude-code": {
    selection: "numbered-list",
    landing: "create-only",
    provenance: "out-of-context-entry",
  },
};

const FALLBACK: CapabilityShape = {
  selection: "numbered-list",
  landing: "create-only",
  provenance: "host-output-only",
};

export type StubStage = "serialize" | "validate" | "readBack" | "switchTo";

export interface StubAdapterOptions {
  agent: AgentId;
  home: HomePath;
  /** Shared call log, written as "<agent>.<method>". */
  calls?: string[];
  capabilities?: Partial<AgentCapabilities>;
  /** Structural defects `validate` reports (FR-50). */
  defects?: ValidationDefect[];
  /** Stages that throw instead of running. */
  failAt?: StubStage[];
  /** Added to the item count `readBack` reports, to force a reconciliation failure (FR-52). */
  readBackDelta?: number;
  switchOutcome?: SwitchOutcome;
  windowTokens?: number;
}

export function landedFilePath(home: HomePath, sessionId: SessionId): string {
  return path.join(home, LANDED_DIR, `${sessionId}.json`);
}

export function landedSessionId(sourceSessionId: SessionId): SessionId {
  return `imported-${sourceSessionId}`;
}

export function createStubAdapter(options: StubAdapterOptions): AgentAdapter {
  const calls = options.calls ?? [];
  const failAt = new Set<StubStage>(options.failAt ?? []);
  const record = (method: string) => calls.push(`${options.agent}.${method}`);
  const shape = DECLARED[options.agent] ?? FALLBACK;

  return {
    capabilities(): AgentCapabilities {
      return {
        agent: options.agent,
        roles: ["source", "target"],
        selection: shape.selection,
        landing: shape.landing,
        provenance: shape.provenance,
        defaultHome: options.home,
        defaultWindowTokens: options.windowTokens ?? 200_000,
        ...options.capabilities,
      };
    },

    async listSessions(home: HomePath): Promise<SessionDescriptor[]> {
      record("listSessions");
      const directory = path.join(home, SESSIONS_DIR);
      let names: string[];
      try {
        names = await readdir(directory);
      } catch {
        return [];
      }
      const descriptors: SessionDescriptor[] = [];
      for (const name of names.sort()) {
        if (!name.endsWith(".jsonl")) continue;
        const filePath = path.join(directory, name);
        const parsed = await parseSession(filePath);
        const recorded = lastTimestamp(parsed.turns) ?? parsed.header.startedAt;
        const fileTime = new Date((await stat(filePath)).mtimeMs).toISOString();
        descriptors.push({
          ref: { agent: options.agent, home, id: parsed.header.id },
          title: parsed.header.title,
          startedAt: parsed.header.startedAt,
          // The later of the two: a file touched after its last recorded turn has moved.
          updatedAt: Date.parse(fileTime) > Date.parse(recorded) ? fileTime : recorded,
          turnCount: parsed.turns.length,
          repoPath:
            parsed.header.repoPath !== null && path.isAbsolute(parsed.header.repoPath)
              ? parsed.header.repoPath
              : null,
          repoPaths:
            parsed.header.repoPath !== null && path.isAbsolute(parsed.header.repoPath)
              ? [parsed.header.repoPath]
              : [],
          startDirectory:
            parsed.header.repoPath !== null && path.isAbsolute(parsed.header.repoPath)
              ? parsed.header.repoPath
              : null,
          filePath,
        });
      }
      return descriptors;
    },

    async loadSession(descriptor: SessionDescriptor): Promise<CanonicalSession> {
      record("loadSession");
      const parsed = await parseSession(descriptor.filePath);
      // The result bodies stay in the file: the vocabulary has no field to carry them (FR-24).
      return {
        provenance: provenanceOf(options.agent, descriptor.ref.home, parsed),
        turns: parsed.turns,
      };
    },

    serialize(
      session: CanonicalSession,
      target: TargetProfile,
      marker: ProvenanceMarker,
      context: SerializationContext,
    ): SerializedSession {
      record("serialize");
      if (failAt.has("serialize"))
        throw new Error("the stub adapter cannot serialize this session");
      const sessionId = landedSessionId(marker.sourceSessionId);
      const payload = {
        sessionId,
        marker: marker.lines,
        cwd: context.cwd,
        provenance: session.provenance,
        turns: session.turns,
      };
      return {
        sessionId,
        files: [
          {
            absolutePath: landedFilePath(target.home, sessionId),
            bytes: Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8"),
          },
        ],
        itemCount: session.turns.length,
      };
    },

    validate(_serialized: SerializedSession): ValidationDefect[] {
      record("validate");
      if (failAt.has("validate")) throw new Error("the stub adapter cannot check this session");
      return options.defects ?? [];
    },

    async readBack(home: HomePath, sessionId: SessionId): Promise<StoredSessionFacts> {
      record("readBack");
      if (failAt.has("readBack")) throw new Error("the stub adapter cannot read the session back");
      const text = await readFile(landedFilePath(home, sessionId), "utf8");
      const stored = JSON.parse(text) as { turns: CanonicalTurn[] };
      return {
        sessionId,
        itemCount: stored.turns.length + (options.readBackDelta ?? 0),
        openable: true,
      };
    },

    async switchTo(
      _home: HomePath,
      _sessionId: SessionId,
      _runtime: AgentRuntime,
    ): Promise<SwitchOutcome> {
      record("switchTo");
      if (failAt.has("switchTo")) throw new Error("the stub agent could not switch");
      return options.switchOutcome ?? { switched: true, cancelled: false };
    },
  };
}

// ---------------------------------------------------------------------------
// A real committer, over a temporary directory
// ---------------------------------------------------------------------------

class TestCommitError extends Error implements CommitError {
  readonly refusal: CommitRefusal;
  readonly path: string | null;

  constructor(refusal: CommitRefusal, filePath: string | null, message: string) {
    super(message);
    this.name = "TestCommitError";
    this.refusal = refusal;
    this.path = filePath;
  }
}

/** Creates every file or none and reports the paths it created (FR-49, FR-53). */
export function createTestCommitter(): FileCommitter {
  return {
    async commit(_root: string, files: PendingFile[]): Promise<CommitHandle> {
      for (const file of files) {
        if (existsSync(file.absolutePath)) {
          throw new TestCommitError(
            "path-exists",
            file.absolutePath,
            `${file.absolutePath} already exists`,
          );
        }
      }
      const created: string[] = [];
      try {
        for (const file of files) {
          await mkdir(path.dirname(file.absolutePath), { recursive: true });
          await writeFile(file.absolutePath, file.bytes, { flag: "wx" });
          created.push(file.absolutePath);
        }
      } catch (cause) {
        for (const done of created.reverse()) await unlink(done).catch(() => undefined);
        throw new TestCommitError(
          "write-failed",
          null,
          `writing the new session failed: ${String(cause)}`,
        );
      }
      return { createdPaths: created };
    },
  };
}

// ---------------------------------------------------------------------------
// Repository reader
// ---------------------------------------------------------------------------

export interface StaticRepoOptions {
  identity?: RepoIdentity;
  distance?: CommitDistance;
  fail?: boolean;
}

export function createStaticRepoReader(options: StaticRepoOptions = {}): RepoReader {
  return {
    checkCancellation() {},
    async identify(cwd: string): Promise<RepoIdentity> {
      if (options.fail) throw new Error("git is not available");
      return (
        options.identity ?? { root: cwd, commonDir: null, isBare: false, head: null, branch: null }
      );
    },
    async distanceFrom(_cwd: string, _sourceCommit: string): Promise<CommitDistance> {
      if (options.fail) throw new Error("git is not available");
      return options.distance ?? { known: false, ahead: 0, behind: 0 };
    },
  };
}

// ---------------------------------------------------------------------------
// Temporary trees and checksums
// ---------------------------------------------------------------------------

export async function makeTempRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "resume-from-import-"));
}

export async function removeTree(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

/** Relative path to content hash, for every file below `root`. Absent directories give {}. */
export async function checksumTree(root: string): Promise<Record<string, string>> {
  const sums: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const full = path.join(directory, name);
      const info = await stat(full);
      if (info.isDirectory()) {
        await walk(full);
        continue;
      }
      const bytes = await readFile(full);
      sums[path.relative(root, full)] = createHash("sha256").update(bytes).digest("hex");
    }
  }
  await walk(root);
  return sums;
}

// ---------------------------------------------------------------------------
// Recorders
// ---------------------------------------------------------------------------

export interface StageRecorder {
  calls: string[];
  stages: PipelineStages;
  plans: TransferPlan[];
  landed: TransferPlan[];
}

const EMPTY_REPORT: PreviewReport = {
  confirmationToken: "v1-sha256-0000000000000000000000000000000000000000000000000000000000000000",
  headerLines: [],
  budgetLine: "",
  warnings: [],
  dropLines: [],
  blocked: false,
  blockedReason: null,
  lines: [],
};

/**
 * A stage bundle that records the order it is driven in and nothing else. The stages are
 * stubs: these tests are about which stage runs when, not about what a stage produces.
 */
export function recordingStages(overrides: Partial<PipelineStages> = {}): StageRecorder {
  const calls: string[] = [];
  const plans: TransferPlan[] = [];
  const landed: TransferPlan[] = [];
  const descriptor: SessionDescriptor = {
    ref: { agent: "codex", home: "/homes/codex", id: "session-1" },
    title: "a session",
    startedAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:30:00.000Z",
    turnCount: 1,
    repoPath: "/repo",
    repoPaths: ["/repo"],
    startDirectory: "/repo",
    filePath: "/homes/codex/sessions/session-1.jsonl",
  };
  const session: CanonicalSession = {
    provenance: {
      ref: descriptor.ref,
      title: descriptor.title,
      startedAt: descriptor.startedAt,
      updatedAt: descriptor.updatedAt,
      repo: { commit: null, branch: null, changedPaths: [] },
    },
    turns: [],
  };

  const stages: PipelineStages = {
    checkCancellation() {},
    finder: {
      async list() {
        calls.push("finder.list");
        return { rows: [descriptor], failures: [], excluded: 0 };
      },
      async resolve() {
        calls.push("finder.resolve");
        return descriptor;
      },
      async load() {
        calls.push("finder.load");
        return session;
      },
    },
    rules: {
      apply(loaded: CanonicalSession, target: TargetProfile): TransferPlan {
        calls.push("rules.apply");
        const plan: TransferPlan = {
          target,
          provenance: loaded.provenance,
          turns: loaded.turns,
          pins: [],
          drops: [],
          keptTurnCount: loaded.turns.length,
          droppedTurnCount: 0,
          bodiesDropped: 0,
          estimatedTokens: 0,
          budgetTokens: 1000,
          brokenTailDropped: false,
          blockedReason: null,
        };
        plans.push(plan);
        return plan;
      },
    },
    async destinationFor(cwd) {
      return { cwd, canonicalCwd: cwd, identity: await createStaticRepoReader().identify(cwd) };
    },
    previewFor(): PreviewBuilder {
      return {
        async build(plan: TransferPlan) {
          calls.push("preview.build");
          return {
            ...EMPTY_REPORT,
            blocked: plan.blockedReason !== null,
            blockedReason: plan.blockedReason,
          };
        },
      };
    },
    lander: {
      async land(plan: TransferPlan) {
        calls.push("lander.land");
        landed.push(plan);
        return {
          ref: {
            agent: plan.target.agent,
            home: plan.target.home,
            id: "landed-1",
          },
          switched: false,
          handover: null,
          itemsSent: plan.turns.length,
          itemsStored: plan.turns.length,
          marker: {
            sourceAgent: plan.provenance.ref.agent,
            sourceHome: plan.provenance.ref.home,
            sourceSessionId: plan.provenance.ref.id,
            importedAt: "2026-08-05T00:00:00.000Z",
            droppedSummary: "",
            lines: [],
          },
        };
      },
    },
    // A target adapter must exist for a request to be accepted (FR-59); the recording
    // lander never calls it.
    adapters: [createStubAdapter({ agent: "pi", home: "/homes/pi" })],
    config: defaultConfig(),
    estimator: charEstimator,
    committer: createTestCommitter(),
    now: () => "2026-08-05T00:00:00.000Z",
    ...overrides,
  };

  return { calls, stages, plans, landed };
}

/** Wraps a lander so a test can see the plan the pipeline handed it. */
export function recordingLander(inner: SessionLander, seen: TransferPlan[]): SessionLander {
  return {
    land: (plan, adapter, committer, runtime, importedAt, context) => {
      seen.push(plan);
      return inner.land(plan, adapter, committer, runtime, importedAt, context);
    },
  };
}

/** Wraps the rules so a test can compare the plan a preview and a commit computed. */
export function recordingRules(inner: TransferRules, seen: TransferPlan[]): TransferRules {
  return {
    apply: (session, target, config, estimator) => {
      const plan = inner.apply(session, target, config, estimator);
      seen.push(plan);
      return plan;
    },
  };
}

// ---------------------------------------------------------------------------
// A whole world: homes, a repository, and one stub adapter per agent
// ---------------------------------------------------------------------------

export const AGENTS: AgentId[] = ["pi", "codex", "claude-code"];

export interface World {
  root: string;
  repoRoot: string;
  /** Every adapter call, as "<agent>.<method>", in the order it happened. */
  calls: string[];
  homes: Map<AgentId, HomePath>;
  /** The home an agent's sessions are read from. */
  homeOf(agent: AgentId): HomePath;
  /** The home an import lands in — a second home of the same agent. */
  targetHomeOf(agent: AgentId): HomePath;
  adapters: AgentAdapter[];
  adapterOf(agent: AgentId): AgentAdapter;
  targetFor(agent: AgentId, windowTokens?: number): TargetProfile;
  cleanup(): Promise<void>;
}

export interface WorldOptions {
  agents?: AgentId[];
  /** Extra options for one agent's stub adapter. */
  adapter?: (agent: AgentId) => Partial<StubAdapterOptions>;
}

export async function createWorld(options: WorldOptions = {}): Promise<World> {
  const agents = options.agents ?? AGENTS;
  const root = await makeTempRoot();
  const repoRoot = path.join(root, "repo");
  await mkdir(repoRoot, { recursive: true });

  const calls: string[] = [];
  const homes = new Map<AgentId, HomePath>();
  const targetHomes = new Map<AgentId, HomePath>();
  const adapters: AgentAdapter[] = [];
  for (const agent of agents) {
    const home = path.join(root, "homes", agent);
    await mkdir(path.join(home, SESSIONS_DIR), { recursive: true });
    homes.set(agent, home);
    // A separate home to land in, so the same agent as source and target is the
    // diagonal of the scope table (FR-4) and not one directory playing both parts.
    const targetHome = path.join(root, "targets", agent);
    await mkdir(targetHome, { recursive: true });
    targetHomes.set(agent, targetHome);
    adapters.push(createStubAdapter({ agent, home, calls, ...options.adapter?.(agent) }));
  }

  function homeOf(agent: AgentId): HomePath {
    const home = homes.get(agent);
    if (!home) throw new Error(`no home for ${agent}`);
    return home;
  }

  function targetHomeOf(agent: AgentId): HomePath {
    const home = targetHomes.get(agent);
    if (!home) throw new Error(`no target home for ${agent}`);
    return home;
  }

  return {
    root,
    repoRoot,
    calls,
    homes,
    homeOf,
    targetHomeOf,
    adapters,
    adapterOf(agent: AgentId): AgentAdapter {
      const adapter = adapters.find((candidate) => candidate.capabilities().agent === agent);
      if (!adapter) throw new Error(`no adapter for ${agent}`);
      return adapter;
    },
    targetFor(agent: AgentId, windowTokens = 200_000): TargetProfile {
      return { agent, home: targetHomeOf(agent), windowTokens };
    },
    cleanup: () => removeTree(root),
  };
}

/** The dependencies `src/host/` would supply, over a world's stub adapters. */
export function worldDeps(
  world: World,
  overrides: Partial<ImportPipelineDeps> = {},
): ImportPipelineDeps {
  return {
    adapters: world.adapters,
    config: defaultConfig(),
    estimator: charEstimator,
    committer: createTestCommitter(),
    repo: createStaticRepoReader(),
    now: () => "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

export interface Instrumented {
  pipeline: ImportPipeline;
  /** The stages the pipeline drove, in order. */
  order: string[];
  /** Every plan the rules produced, and every plan the lander received. */
  plans: TransferPlan[];
  landed: TransferPlan[];
}

/** The real stages, wrapped so a test can see the order they ran in. */
export function instrument(deps: ImportPipelineDeps): Instrumented {
  const stages = buildStages(deps);
  const order: string[] = [];
  const plans: TransferPlan[] = [];
  const landed: TransferPlan[] = [];
  const wrapped: PipelineStages = {
    ...stages,
    finder: {
      list: (scope, destination) => {
        order.push("finder.list");
        return stages.finder.list(scope, destination);
      },
      resolve: (scope, input, destination) => {
        order.push("finder.resolve");
        return stages.finder.resolve(scope, input, destination);
      },
      load: (descriptor) => {
        order.push("finder.load");
        return stages.finder.load(descriptor);
      },
    },
    rules: recordingRules(
      {
        apply: (session, target, config, estimator) => {
          order.push("rules.apply");
          return stages.rules.apply(session, target, config, estimator);
        },
      },
      plans,
    ),
    previewFor: (destination, descriptor) => {
      const builder = stages.previewFor(destination, descriptor);
      return {
        build: (plan) => {
          order.push("preview.build");
          return builder.build(plan);
        },
      };
    },
    lander: recordingLander(
      {
        land: (plan, adapter, committer, runtime, importedAt, context) => {
          order.push("lander.land");
          return stages.lander.land(plan, adapter, committer, runtime, importedAt, context);
        },
      },
      landed,
    ),
  };
  return { pipeline: createPipelineFromStages(wrapped), order, plans, landed };
}

/** The reference session, as a source fixture of one agent. */
export function referenceSpec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    id: REFERENCE_SESSION.provenance.ref.id,
    title: REFERENCE_SESSION.provenance.title,
    startedAt: REFERENCE_SESSION.provenance.startedAt,
    repoPath: null,
    commit: REFERENCE_SESSION.provenance.repo.commit,
    branch: REFERENCE_SESSION.provenance.repo.branch,
    turns: REFERENCE_SESSION.turns,
    ...overrides,
  };
}
