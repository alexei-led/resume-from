import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentId,
  CanonicalSession,
  CanonicalTurn,
  CommitError,
  CommitHandle,
  CommitRefusal,
  FileCommitter,
  HomePath,
  LandingError,
  LandingLevel,
  LandingResult,
  LandingStage,
  PendingFile,
  ProvenanceMarker,
  ProvenanceSupport,
  SerializedSession,
  SessionId,
  StoredSessionFacts,
  SwitchOutcome,
  TargetProfile,
  TransferPlan,
  ValidationDefect,
} from "./contract.js";
import { createSessionLander } from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IMPORTED_AT = "2026-02-03T10:11:12.000Z";
const SESSION_ID: SessionId = "landed-0001";
const SOURCE_ID: SessionId = "source-9999";
const SOURCE_HOME: HomePath = "/Users/tester/.codex";
const RUNTIME = { host: "test" };
const FIXTURE_AGENT = "fixture-agent" as AgentId;
const STAGE_CALLS = ["serialize", "validate", "commit", "readBack", "switchTo"];

function turn(index: number): CanonicalTurn {
  return {
    index,
    role: index % 2 === 0 ? "user" : "agent",
    kind: "message",
    text: `turn ${index}`,
    toolCall: null,
    timestamp: null,
  };
}

function makePlan(home: HomePath, over: Partial<TransferPlan> = {}): TransferPlan {
  const target: TargetProfile = {
    agent: "claude-code",
    home,
    windowTokens: 200_000,
  };
  const base: TransferPlan = {
    target,
    provenance: {
      ref: { agent: "codex", home: SOURCE_HOME, id: SOURCE_ID },
      title: "Fix the parser",
      startedAt: "2026-02-01T08:00:00.000Z",
      updatedAt: "2026-02-02T09:00:00.000Z",
      repo: { commit: "abc1234", branch: "master", changedPaths: ["src/a.ts"] },
    },
    turns: [turn(0), turn(1), turn(2)],
    pins: [{ index: 0, reason: "first-request" }],
    drops: [{ index: 7, reason: "budget" }],
    keptTurnCount: 3,
    droppedTurnCount: 12,
    bodiesDropped: 4,
    estimatedTokens: 1200,
    budgetTokens: 100_000,
    brokenTailDropped: false,
    blockedReason: null,
  };
  return { ...base, ...over };
}

// ---------------------------------------------------------------------------
// Stub adapter: records every call it receives, on a shared log
// ---------------------------------------------------------------------------

/** The source-role types are not restated by this module, so they are derived. */
type SessionDescriptor = Parameters<AgentAdapter["loadSession"]>[0];

interface SerializeArgs {
  session: CanonicalSession;
  target: TargetProfile;
  marker: ProvenanceMarker;
}

interface AdapterStub extends AgentAdapter {
  serializeArgs: SerializeArgs | null;
  /** Not part of AgentAdapter. Recorded so FR-46 can be asserted (T-LAN-19). */
  sendMessage(): void;
  runTool(): void;
  prompt: string;
}

interface AdapterOptions {
  agent?: AgentId;
  landing?: LandingLevel;
  provenance?: ProvenanceSupport;
  sessionId?: SessionId;
  fileCount?: number;
  itemCount?: number;
  storedItemCount?: number;
  storedSessionId?: SessionId;
  openable?: boolean;
  defects?: ValidationDefect[];
  switchOutcome?: SwitchOutcome;
  serializeThrows?: Error;
  validateThrows?: Error;
  readBackRejects?: Error;
  switchRejects?: Error;
}

function filesFor(home: HomePath, sessionId: SessionId, count: number): PendingFile[] {
  return Array.from({ length: count }, (_unused, i) => ({
    absolutePath: join(home, "sessions", sessionId, `part-${i}.jsonl`),
    bytes: Buffer.from(`{"part":${i}}\n`, "utf8"),
  }));
}

function createAdapter(log: string[], options: AdapterOptions = {}): AdapterStub {
  const agent = options.agent ?? "claude-code";
  const sessionId = options.sessionId ?? SESSION_ID;
  const itemCount = options.itemCount ?? 24;
  const capabilities: AgentCapabilities = {
    agent,
    roles: ["target"],
    selection: "numbered-list",
    landing: options.landing ?? "create-and-switch",
    provenance: options.provenance ?? "out-of-context-entry",
    defaultHome: "/Users/tester/.target",
    defaultWindowTokens: 200_000,
  };

  const stub: AdapterStub = {
    serializeArgs: null,
    prompt: "",
    capabilities(): AgentCapabilities {
      log.push("capabilities");
      return capabilities;
    },
    listSessions(_home: HomePath): Promise<SessionDescriptor[]> {
      log.push("listSessions");
      return Promise.resolve([]);
    },
    loadSession(_descriptor: SessionDescriptor): Promise<CanonicalSession> {
      log.push("loadSession");
      return Promise.reject(new Error("not a source"));
    },
    serialize(
      session: CanonicalSession,
      target: TargetProfile,
      marker: ProvenanceMarker,
    ): SerializedSession {
      log.push("serialize");
      stub.serializeArgs = { session, target, marker };
      if (options.serializeThrows) throw options.serializeThrows;
      return {
        sessionId,
        files: filesFor(target.home, sessionId, options.fileCount ?? 1),
        itemCount,
      };
    },
    validate(_serialized: SerializedSession): ValidationDefect[] {
      log.push("validate");
      if (options.validateThrows) throw options.validateThrows;
      return options.defects ?? [];
    },
    readBack(_home: HomePath, _sessionId: SessionId): Promise<StoredSessionFacts> {
      log.push("readBack");
      if (options.readBackRejects) return Promise.reject(options.readBackRejects);
      return Promise.resolve({
        sessionId: options.storedSessionId ?? sessionId,
        itemCount: options.storedItemCount ?? itemCount,
        openable: options.openable ?? true,
      });
    },
    switchTo(_home: HomePath, _sessionId: SessionId, _runtime: unknown): Promise<SwitchOutcome> {
      log.push("switchTo");
      if (options.switchRejects) return Promise.reject(options.switchRejects);
      return Promise.resolve(options.switchOutcome ?? { switched: true, cancelled: false });
    },
    sendMessage(): void {
      log.push("sendMessage");
    },
    runTool(): void {
      log.push("runTool");
    },
  };
  return stub;
}

// ---------------------------------------------------------------------------
// A real committer over a temporary directory: add-only, all-or-nothing
// ---------------------------------------------------------------------------

class TestCommitError extends Error implements CommitError {
  readonly refusal: CommitRefusal;
  readonly path: string | null;
  constructor(refusal: CommitRefusal, path: string | null, message: string) {
    super(message);
    this.name = "CommitError";
    this.refusal = refusal;
    this.path = path;
  }
}

async function ensureDir(dir: string, created: string[]): Promise<void> {
  if (existsSync(dir)) return;
  const parent = dirname(dir);
  if (parent !== dir) await ensureDir(parent, created);
  await mkdir(dir);
  created.push(dir);
}

async function undo(files: string[], dirs: string[]): Promise<void> {
  for (const file of files) await unlink(file);
  for (const dir of [...dirs].reverse()) await rmdir(dir);
}

function createFsCommitter(log: string[] = []): FileCommitter {
  return {
    async commit(_root: string, files: PendingFile[]): Promise<CommitHandle> {
      log.push("commit");
      for (const file of files) {
        if (existsSync(file.absolutePath)) {
          throw new TestCommitError(
            "path-exists",
            file.absolutePath,
            `${file.absolutePath} already exists.`,
          );
        }
      }
      const createdFiles: string[] = [];
      const createdDirs: string[] = [];
      try {
        for (const file of files) {
          await ensureDir(dirname(file.absolutePath), createdDirs);
          await writeFile(file.absolutePath, file.bytes, { flag: "wx" });
          createdFiles.push(file.absolutePath);
        }
      } catch (cause) {
        await undo(createdFiles, createdDirs);
        throw new TestCommitError(
          "write-failed",
          null,
          `Writing the session failed: ${(cause as Error).message}`,
        );
      }
      return { createdPaths: createdFiles };
    },
  };
}

function createRefusingCommitter(error: unknown, log: string[] = []): FileCommitter {
  return {
    commit(_root: string, _files: PendingFile[]): Promise<CommitHandle> {
      log.push("commit");
      return Promise.reject(error);
    },
  };
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

async function snapshot(root: string): Promise<string[]> {
  const lines: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      if (entry.isDirectory()) {
        lines.push(`d ${rel}`);
        await walk(full);
      } else {
        const digest = createHash("sha256")
          .update(await readFile(full))
          .digest("hex");
        lines.push(`f ${rel} ${digest}`);
      }
    }
  };
  await walk(root);
  return lines.sort();
}

async function seedHome(home: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const dir = join(home, "existing", `bucket-${i % 5}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `file-${i}.json`), `{"n":${i}}`, "utf8");
  }
}

async function failureOf(promise: Promise<unknown>): Promise<LandingError> {
  try {
    await promise;
  } catch (caught) {
    return caught as LandingError;
  }
  throw new Error("expected the landing to reject, but it resolved");
}

const NEXT_STEP = /run the import again|removed by hand|Open it yourself/;

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "resume-from-landing-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("unit", () => {
  it("T-LAN-1 runs the stages in order, none skipped and none twice", async () => {
    const log: string[] = [];
    const adapter = createAdapter(log);
    const result = await createSessionLander().land(
      makePlan(home),
      adapter,
      createFsCommitter(log),
      RUNTIME,
      IMPORTED_AT,
      { cwd: "/repo" },
    );

    expect(log.filter((call) => STAGE_CALLS.includes(call))).toEqual(STAGE_CALLS);
    for (const stage of STAGE_CALLS) {
      expect(log.filter((call) => call === stage)).toHaveLength(1);
    }
    expect(result.switched).toBe(true);
  });

  it("T-LAN-2 builds a marker carrying every fact FR-47 requires", async () => {
    const adapter = createAdapter([]);
    const { marker } = await createSessionLander().land(
      makePlan(home, { droppedTurnCount: 12 }),
      adapter,
      createFsCommitter(),
      RUNTIME,
      IMPORTED_AT,
      { cwd: "/repo" },
    );

    expect(marker.sourceAgent).toBe("codex");
    expect(marker.sourceHome).toBe(SOURCE_HOME);
    expect(marker.sourceSessionId).toBe(SOURCE_ID);
    expect(marker.importedAt).toBe(IMPORTED_AT);
    expect(marker.droppedSummary).toContain("12");
    expect(marker.droppedSummary).not.toContain("\n");

    const rendered = marker.lines.join("\n");
    expect(marker.lines.length).toBeGreaterThanOrEqual(5);
    for (const fact of [
      marker.sourceAgent,
      marker.sourceHome,
      marker.sourceSessionId,
      marker.importedAt,
      marker.droppedSummary,
    ]) {
      expect(rendered).toContain(fact);
    }
    // The marker reaches the adapter; the adapter decides where it goes (FR-48).
    expect(adapter.serializeArgs?.marker).toEqual(marker);
  });

  it("T-LAN-3 uses the import time passed in", async () => {
    const fixed = "1999-12-31T23:59:59.000Z";
    const { marker } = await createSessionLander().land(
      makePlan(home),
      createAdapter([]),
      createFsCommitter(),
      RUNTIME,
      fixed,
      { cwd: "/repo" },
    );
    expect(marker.importedAt).toBe(fixed);
  });

  it("T-LAN-4 switches when the adapter declares create-and-switch", async () => {
    const log: string[] = [];
    const result = await createSessionLander().land(
      makePlan(home),
      createAdapter(log, {
        landing: "create-and-switch",
        switchOutcome: { switched: true, cancelled: false },
      }),
      createFsCommitter(log),
      RUNTIME,
      IMPORTED_AT,
      { cwd: "/repo" },
    );

    expect(result.switched).toBe(true);
    expect(result.handover).toBeNull();
    expect(log).toContain("switchTo");
  });

  it("T-LAN-5 hands over when the adapter declares create-only", async () => {
    const log: string[] = [];
    const result = await createSessionLander().land(
      makePlan(home),
      createAdapter(log, { landing: "create-only" }),
      createFsCommitter(log),
      RUNTIME,
      IMPORTED_AT,
      { cwd: "/repo" },
    );

    expect(log).not.toContain("switchTo");
    expect(result.switched).toBe(false);
    expect(result.handover?.sessionId).toBe(SESSION_ID);
    expect(result.handover?.command).toContain(SESSION_ID);
  });

  it("T-LAN-6 reports the item counts", async () => {
    const result = await createSessionLander().land(
      makePlan(home),
      createAdapter([], { itemCount: 24, storedItemCount: 24 }),
      createFsCommitter(),
      RUNTIME,
      IMPORTED_AT,
      { cwd: "/repo" },
    );

    expect(result.itemsSent).toBe(24);
    expect(result.itemsStored).toBe(24);
    expect(result.ref).toEqual({ agent: "claude-code", home, id: SESSION_ID });
  });
});

// ---------------------------------------------------------------------------
// Failure table, shared by T-LAN-11 and T-LAN-13
// ---------------------------------------------------------------------------

interface FailureCase {
  name: string;
  stage: LandingStage;
  /** A post-commit failure keeps the published session, so the target gains files. */
  keepsSession: boolean;
  build(targetHome: string): {
    plan: TransferPlan;
    adapter: AdapterStub;
    committer: FileCommitter;
  };
}

const failureCases: FailureCase[] = [
  {
    name: "serialize throws",
    stage: "serialize",
    keepsSession: false,
    build: (targetHome) => ({
      plan: makePlan(targetHome),
      adapter: createAdapter([], {
        serializeThrows: new Error("unknown turn kind"),
      }),
      committer: createFsCommitter(),
    }),
  },
  {
    name: "validate reports defects",
    stage: "validate",
    keepsSession: false,
    build: (targetHome) => ({
      plan: makePlan(targetHome),
      adapter: createAdapter([], {
        defects: [{ path: "items/3/usage", message: "usage is missing" }],
      }),
      committer: createFsCommitter(),
    }),
  },
  {
    name: "the committer refuses",
    stage: "commit",
    keepsSession: false,
    build: (targetHome) => ({
      plan: makePlan(targetHome),
      adapter: createAdapter([]),
      committer: createRefusingCommitter(
        new TestCommitError(
          "not-writable",
          join(targetHome, "sessions"),
          "the directory is read-only",
        ),
      ),
    }),
  },
  {
    name: "the committer fails with something that is not a CommitError",
    stage: "commit",
    keepsSession: false,
    build: (targetHome) => ({
      plan: makePlan(targetHome),
      adapter: createAdapter([]),
      committer: createRefusingCommitter(new Error("the disk went away")),
    }),
  },
  {
    name: "the read-back finds fewer items",
    stage: "read-back",
    keepsSession: true,
    build: (targetHome) => ({
      plan: makePlan(targetHome),
      adapter: createAdapter([], { itemCount: 24, storedItemCount: 23 }),
      committer: createFsCommitter(),
    }),
  },
  {
    name: "the switch fails",
    stage: "switch",
    keepsSession: true,
    build: (targetHome) => ({
      plan: makePlan(targetHome),
      adapter: createAdapter([], {
        switchRejects: new Error("no terminal attached"),
      }),
      committer: createFsCommitter(),
    }),
  },
];

// ---------------------------------------------------------------------------
// Integration contract tests
// ---------------------------------------------------------------------------

describe("integration contract", () => {
  it("T-LAN-7 stops on a validation defect before any write", async () => {
    await seedHome(home, 3);
    const before = await snapshot(home);
    const log: string[] = [];
    const defects: ValidationDefect[] = [
      { path: "items/3/usage", message: "usage is missing" },
      { path: "items/7/role", message: "role is not a known value" },
    ];

    const failure = await failureOf(
      createSessionLander().land(
        makePlan(home),
        createAdapter(log, { defects }),
        createFsCommitter(log),
        RUNTIME,
        IMPORTED_AT,
        { cwd: "/repo" },
      ),
    );

    expect(failure.stage).toBe("validate");
    expect(failure.defects).toMatchObject(defects);
    expect(failure.rolledBack).toBe(false);
    expect(log).not.toContain("commit");
    expect(await snapshot(home)).toEqual(before);
  });

  it("T-LAN-8 preserves and reports the session when the stored item count differs", async () => {
    await seedHome(home, 3);
    const before = await snapshot(home);

    const failure = await failureOf(
      createSessionLander().land(
        makePlan(home),
        createAdapter([], { itemCount: 24, storedItemCount: 23 }),
        createFsCommitter(),
        RUNTIME,
        IMPORTED_AT,
        { cwd: "/repo" },
      ),
    );

    expect(failure.stage).toBe("read-back");
    expect(failure.rolledBack).toBe(false);
    expect(failure.message).toContain("23");
    expect(failure.message).toContain("24");
    expect(failure.message).toContain(join(home, "sessions", SESSION_ID, "part-0.jsonl"));
    expect(await snapshot(home)).toEqual(expect.arrayContaining(before));
    expect(await snapshot(home)).not.toEqual(before);
  });

  it("preserves and reports the session when read-back returns a different session ID", async () => {
    const before = await snapshot(home);

    const failure = await failureOf(
      createSessionLander().land(
        makePlan(home),
        createAdapter([], { storedSessionId: "another-session" }),
        createFsCommitter(),
        RUNTIME,
        IMPORTED_AT,
        { cwd: "/repo" },
      ),
    );

    expect(failure.stage).toBe("read-back");
    expect(failure.rolledBack).toBe(false);
    expect(failure.message).toContain("another-session");
    expect(failure.message).toContain(SESSION_ID);
    expect(failure.message).toContain(join(home, "sessions", SESSION_ID, "part-0.jsonl"));
    expect(await snapshot(home)).toEqual(expect.arrayContaining(before));
    expect(await snapshot(home)).not.toEqual(before);
  });

  it("T-LAN-9 preserves and reports a session the target cannot open", async () => {
    const before = await snapshot(home);

    const failure = await failureOf(
      createSessionLander().land(
        makePlan(home),
        createAdapter([], { openable: false }),
        createFsCommitter(),
        RUNTIME,
        IMPORTED_AT,
        { cwd: "/repo" },
      ),
    );

    expect(failure.stage).toBe("read-back");
    expect(failure.rolledBack).toBe(false);
    expect(failure.message).toMatch(/could not open/i);
    expect(failure.message).toContain(join(home, "sessions", SESSION_ID, "part-0.jsonl"));
    expect(await snapshot(home)).toEqual(expect.arrayContaining(before));
    expect(await snapshot(home)).not.toEqual(before);
  });

  it("T-LAN-10 reports a commit refusal instead of working around it", async () => {
    const clash = join(home, "sessions", SESSION_ID, "part-0.jsonl");
    const log: string[] = [];
    const committer = createRefusingCommitter(
      new TestCommitError("path-exists", clash, `${clash} already exists.`),
      log,
    );

    const failure = await failureOf(
      createSessionLander().land(
        makePlan(home),
        createAdapter(log),
        committer,
        RUNTIME,
        IMPORTED_AT,
        { cwd: "/repo" },
      ),
    );

    expect(failure.stage).toBe("commit");
    expect(failure.message).toContain(clash);
    expect(failure.rolledBack).toBe(false);
    // No retry under another name, and no second attempt.
    expect(log.filter((call) => call === "commit")).toHaveLength(1);
    expect(log).not.toContain("readBack");
    expect(await snapshot(home)).toEqual([]);
  });

  it("reports the exact paths left by incomplete commit cleanup", async () => {
    const remaining = join(home, "sessions", SESSION_ID, "part-0.jsonl");
    const error = Object.assign(
      new TestCommitError("write-failed", remaining, "cleanup was incomplete"),
      { remainingPaths: [remaining] },
    );

    const failure = await failureOf(
      createSessionLander().land(
        makePlan(home),
        createAdapter([]),
        createRefusingCommitter(error),
        RUNTIME,
        IMPORTED_AT,
        { cwd: "/repo" },
      ),
    );

    expect(failure.stage).toBe("commit");
    expect(failure.message).toContain(remaining);
    expect(failure.message).toMatch(/cleanup was incomplete/i);
    expect(failure.message).not.toContain("Nothing was created");
  });

  it.each(failureCases)(
    "T-LAN-11 $name names the stage and the next step",
    async ({ stage, build }) => {
      const { plan, adapter, committer } = build(home);

      const failure = await failureOf(
        createSessionLander().land(plan, adapter, committer, RUNTIME, IMPORTED_AT, {
          cwd: "/repo",
        }),
      );

      expect(failure.stage).toBe(stage);
      expect(failure.rolledBack).toBe(false);
      expect(failure.message.length).toBeGreaterThan(20);
      expect(failure.message).toMatch(NEXT_STEP);
      expect(failure.message).not.toContain("undefined");
      if (stage !== "validate") expect(failure.defects).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Boundary tests
// ---------------------------------------------------------------------------

describe("boundary", () => {
  it("T-LAN-12 refuses a blocked plan before serialization", async () => {
    const log: string[] = [];

    const failure = await failureOf(
      createSessionLander().land(
        makePlan(home, {
          blockedReason: "the pinned turns alone exceed the budget",
        }),
        createAdapter(log),
        createFsCommitter(log),
        RUNTIME,
        IMPORTED_AT,
        { cwd: "/repo" },
      ),
    );

    expect(log).not.toContain("serialize");
    expect(log).not.toContain("commit");
    expect(failure.message).toContain("the pinned turns alone exceed the budget");
    expect(await snapshot(home)).toEqual([]);
  });

  it.each(failureCases)("T-LAN-13 leaves the target home undamaged when $name", async (kase) => {
    await seedHome(home, 50);
    const before = await snapshot(home);
    expect(before.filter((line) => line.startsWith("f "))).toHaveLength(50);

    const { plan, adapter, committer } = kase.build(home);
    await failureOf(
      createSessionLander().land(plan, adapter, committer, RUNTIME, IMPORTED_AT, { cwd: "/repo" }),
    );

    const after = await snapshot(home);
    // Nothing that existed was rewritten or removed (FR-49).
    expect(after).toEqual(expect.arrayContaining(before));
    if (kase.keepsSession) {
      // A failure after publication keeps the session, so the home only grew.
      expect(after.length).toBeGreaterThan(before.length);
    } else {
      expect(after).toEqual(before);
    }
  });

  it("T-LAN-14 keeps the session when the user cancels the switch", async () => {
    const result = await createSessionLander().land(
      makePlan(home),
      createAdapter([], {
        switchOutcome: { switched: false, cancelled: true },
      }),
      createFsCommitter(),
      RUNTIME,
      IMPORTED_AT,
      { cwd: "/repo" },
    );

    expect(result.switched).toBe(false);
    expect(result.handover?.sessionId).toBe(SESSION_ID);
    expect(result.handover?.command).toContain(SESSION_ID);
    const files = (await snapshot(home)).filter((line) => line.startsWith("f "));
    expect(files).toHaveLength(1);
  });

  it("T-LAN-15 keeps the session when the switch fails", async () => {
    const command = `open --session ${SESSION_ID}`;
    const lander = createSessionLander({ handoverCommand: () => command });

    const failure = await failureOf(
      lander.land(
        makePlan(home),
        createAdapter([], { switchRejects: new Error("no terminal attached") }),
        createFsCommitter(),
        RUNTIME,
        IMPORTED_AT,
        { cwd: "/repo" },
      ),
    );

    expect(failure.stage).toBe("switch");
    expect(failure.rolledBack).toBe(false);
    expect(failure.message).toContain(command);
    const files = (await snapshot(home)).filter((line) => line.startsWith("f "));
    expect(files).toHaveLength(1);
  });

  it("T-LAN-16 reports the paths preserved after a post-commit failure", async () => {
    const failure = await failureOf(
      createSessionLander().land(
        makePlan(home),
        createAdapter([], { itemCount: 24, storedItemCount: 23 }),
        createFsCommitter(),
        RUNTIME,
        IMPORTED_AT,
        { cwd: "/repo" },
      ),
    );

    expect(failure.stage).toBe("read-back");
    expect(failure.rolledBack).toBe(false);
    expect(failure.message).toContain("23");
    expect(failure.message).toContain(join(home, "sessions", SESSION_ID, "part-0.jsonl"));
    expect(failure.message).toMatch(/preserved/i);
    expect(failure.message).toMatch(NEXT_STEP);
  });

  it("T-LAN-17 lands with the clock and the network stubbed to throw", async () => {
    const realDate = globalThis.Date;
    const realNow = realDate.now;
    const realFetch = globalThis.fetch;

    // A zero-argument construction is a clock read; a parsed date is not.
    const forbiddenDate = new Proxy(realDate, {
      construct(target, args: unknown[]) {
        if (args.length === 0) throw new Error("this module must not read a clock");
        return Reflect.construct(target, args);
      },
    });

    let result: LandingResult;
    try {
      globalThis.Date = forbiddenDate;
      Date.now = () => {
        throw new Error("this module must not read a clock");
      };
      globalThis.fetch = (() => {
        throw new Error("this module must not use the network");
      }) as typeof fetch;

      result = await createSessionLander().land(
        makePlan(home),
        createAdapter([]),
        createFsCommitter(),
        RUNTIME,
        IMPORTED_AT,
        { cwd: "/repo" },
      );
    } finally {
      globalThis.Date = realDate;
      Date.now = realNow;
      globalThis.fetch = realFetch;
    }

    expect(result.marker.importedAt).toBe(IMPORTED_AT);
    expect(result.switched).toBe(true);
    for (const source of await moduleSources()) {
      expect(source.text).not.toMatch(
        /node:(http|https|net|tls|dgram)|globalThis\.fetch|\bfetch\(/,
      );
    }
  });

  it("T-LAN-18 follows the declared capability for four agents, naming none", async () => {
    const agents: { agent: AgentId; landing: LandingLevel }[] = [
      { agent: "pi", landing: "create-and-switch" },
      { agent: "codex", landing: "create-only" },
      { agent: "claude-code", landing: "create-only" },
      { agent: FIXTURE_AGENT, landing: "create-and-switch" },
    ];

    for (const { agent, landing } of agents) {
      const target = await mkdtemp(join(tmpdir(), "resume-from-landing-agent-"));
      try {
        const log: string[] = [];
        const plan = makePlan(target, {
          target: { agent, home: target, windowTokens: 200_000 },
        });
        const result = await createSessionLander().land(
          plan,
          createAdapter(log, { agent, landing }),
          createFsCommitter(log),
          RUNTIME,
          IMPORTED_AT,
          { cwd: "/repo" },
        );

        const switches = landing === "create-and-switch";
        expect(result.switched).toBe(switches);
        expect(log.includes("switchTo")).toBe(switches);
        expect(result.handover === null).toBe(switches);
        expect(result.ref.agent).toBe(agent);
      } finally {
        await rm(target, { recursive: true, force: true });
      }
    }

    const forbidden = /\b(pi|codex|claude|claude-code)\b/i;
    for (const source of await moduleSources()) {
      expect(stripComments(source.text), `agent name in ${source.name}`).not.toMatch(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// Behavior tests
// ---------------------------------------------------------------------------

describe("behavior", () => {
  it("T-LAN-19 sends nothing and runs nothing after landing", async () => {
    const log: string[] = [];
    const adapter = createAdapter(log);

    await createSessionLander().land(
      makePlan(home),
      adapter,
      createFsCommitter(log),
      RUNTIME,
      IMPORTED_AT,
      { cwd: "/repo" },
    );

    const allowed = new Set(["capabilities", ...STAGE_CALLS]);
    expect(log.filter((call) => !allowed.has(call))).toEqual([]);
    expect(log).not.toContain("sendMessage");
    expect(log).not.toContain("runTool");
    expect(log).not.toContain("listSessions");
    expect(log).not.toContain("loadSession");
    expect(adapter.prompt).toBe("");
  });

  it.each(["out-of-context-entry", "host-output-only"] as ProvenanceSupport[])(
    "T-LAN-20 returns the marker unchanged for %s",
    async (provenance) => {
      const log: string[] = [];
      const adapter = createAdapter(log, { provenance });

      const result = await createSessionLander().land(
        makePlan(home),
        adapter,
        createFsCommitter(log),
        RUNTIME,
        IMPORTED_AT,
        { cwd: "/repo" },
      );

      // The marker is always handed to the adapter and always returned to the
      // host; where it is shown is the adapter's declared capability (FR-48).
      expect(adapter.serializeArgs?.marker).toEqual(result.marker);
      expect(result.marker.importedAt).toBe(IMPORTED_AT);
      expect(log.filter((call) => STAGE_CALLS.includes(call))).toEqual(STAGE_CALLS);
    },
  );

  it("T-LAN-21 leaves either a complete session or nothing", async () => {
    const plan = makePlan(home);
    const adapter = createAdapter([]);

    // Complete: the one committed file holds exactly the bytes that were sent.
    await createSessionLander().land(plan, adapter, createFsCommitter(), RUNTIME, IMPORTED_AT, {
      cwd: "/repo",
    });
    const [sent] = filesFor(home, SESSION_ID, 1);
    expect(sent).toBeDefined();
    if (sent !== undefined) expect(await readFile(sent.absolutePath)).toEqual(sent.bytes);
  });

  it("commits a multi-file session one file at a time, in the adapter's order", async () => {
    // Kimi Code's native session is a wire.jsonl plus a state.json. The landing commits
    // them one at a time through the store — whose one-file atomicity invariant stays
    // untouched — and the adapter orders them so no prefix is a session the agent would
    // list (wire first: without state.json the directory is invisible to Kimi Code).
    const log: string[] = [];

    const result = await createSessionLander().land(
      makePlan(home),
      createAdapter(log, { fileCount: 2 }),
      createFsCommitter(log),
      RUNTIME,
      IMPORTED_AT,
      { cwd: "/repo" },
    );

    expect(result.ref.id).toBe(SESSION_ID);
    expect(log.filter((entry) => entry === "commit")).toHaveLength(2);
    // Two files land in one session directory; the snapshot also lists the directory
    // entries the committer created on the way.
    const lines = await snapshot(home);
    expect(lines.filter((line) => line.startsWith("f "))).toHaveLength(2);
    expect(lines).toContain(`d sessions${sep}${SESSION_ID}`);
  });

  it("refuses an adapter that serializes one session to zero files", async () => {
    // 0 files is also wrong: the committer would succeed vacuously, then readBack would
    // return confusing results. Catch it at the serialize stage before any write (FR-49).
    const log: string[] = [];

    const failure = await failureOf(
      createSessionLander().land(
        makePlan(home),
        createAdapter(log, { fileCount: 0 }),
        createFsCommitter(log),
        RUNTIME,
        IMPORTED_AT,
        { cwd: "/repo" },
      ),
    );

    expect(failure.stage).toBe("serialize");
    expect(failure.message).toContain("produced 0 files");
    expect(log).not.toContain("validate");
    expect(log).not.toContain("commit");
    expect(await snapshot(home)).toEqual([]);
  });

  it("T-LAN-22 tells a create-only user exactly what to type", async () => {
    const lander = createSessionLander({
      handoverCommand: (_agent, sessionId) => `claude --resume ${sessionId}`,
    });

    const result = await lander.land(
      makePlan(home),
      createAdapter([], { landing: "create-only", sessionId: "abc-123" }),
      createFsCommitter(),
      RUNTIME,
      IMPORTED_AT,
      { cwd: "/repo" },
    );

    expect(result.handover).toEqual({
      sessionId: "abc-123",
      command: "claude --resume abc-123",
    });
  });
});

// ---------------------------------------------------------------------------
// Static source checks (T-LAN-17, T-LAN-18)
// ---------------------------------------------------------------------------

/** Every source file of this module except its tests and its generated contract. */
async function moduleSources(): Promise<{ name: string; text: string }[]> {
  const dir = dirname(new URL(import.meta.url).pathname);
  const names = (await readdir(dir)).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "contract.ts",
  );
  expect(names.length).toBeGreaterThan(0);
  return Promise.all(
    names.map(async (name) => ({
      name,
      text: await readFile(join(dir, name), "utf8"),
    })),
  );
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
