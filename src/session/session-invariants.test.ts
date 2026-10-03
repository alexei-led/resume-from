/**
 * Invariants of the vocabulary — T-SES-3 to T-SES-8 and T-SES-10 to T-SES-15.
 *
 * The reference fixture lives in `test/fixtures/`, outside `src/`, so it belongs to no
 * module. This module owns the invariants that fixture must satisfy and asserts them here.
 *
 * The fixture ships one codex session. T-SES-10, T-SES-14 and T-SES-15 need a second home,
 * a provenance marker and a session per agent, so those are built in this file: they are
 * assertions about the vocabulary, not shared data other modules consume.
 */

import { describe, expect, it } from "vitest";
import { REFERENCE_REF, REFERENCE_SESSION } from "../../test/fixtures/reference-session.js";
import type {
  AgentId,
  CanonicalSession,
  CanonicalTurn,
  ProvenanceMarker,
  RepoSnapshot,
  SessionDescriptor,
  SessionRef,
  SourceProvenance,
  ToolCallRecord,
} from "./contract.js";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const AGENT_IDS = ["pi", "codex", "claude-code", "kimi-code"] as const satisfies readonly AgentId[];

/** ISO-8601 in UTC: never local time, never an epoch number. */
function isIsoUtc(value: string): boolean {
  return ISO_UTC.test(value) && !Number.isNaN(Date.parse(value));
}

function assertTurnInvariants(turn: CanonicalTurn): void {
  if (turn.kind === "tool-call") {
    expect(turn.text).toBe("");
    expect(turn.toolCall).not.toBeNull();
  } else {
    expect(turn.toolCall).toBeNull();
    expect(turn.text.length).toBeGreaterThan(0);
  }
  if (turn.timestamp !== null) {
    expect(isIsoUtc(turn.timestamp)).toBe(true);
  }
}

function assertSessionInvariants(session: CanonicalSession): void {
  expect(isIsoUtc(session.provenance.startedAt)).toBe(true);
  expect(isIsoUtc(session.provenance.updatedAt)).toBe(true);
  session.turns.forEach((turn, position) => {
    expect(turn.index).toBe(position);
    assertTurnInvariants(turn);
  });
}

/** Every key path of a value, with `[]` for array elements. Leaf values are ignored. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return [`${prefix}[]`, ...value.flatMap((item) => keyPaths(item, `${prefix}[]`))];
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, child]) => {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      return [path, ...keyPaths(child, path)];
    });
  }
  return [];
}

function uniqueSorted(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}

/** Every string leaf of a value, paired with the key path that holds it. */
function stringLeaves(value: unknown, prefix = ""): Array<[string, string]> {
  if (typeof value === "string") {
    return [[prefix, value]];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => stringLeaves(item, `${prefix}[]`));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, child]) =>
      stringLeaves(child, prefix === "" ? key : `${prefix}.${key}`),
    );
  }
  return [];
}

const toolCalls = REFERENCE_SESSION.turns.flatMap((turn) =>
  turn.toolCall === null ? [] : [turn.toolCall],
);

interface SessionVariant {
  ref: SessionRef;
  subject: string;
  closing: string;
  repo: RepoSnapshot;
  /** Null for a source format that records no per-turn time. */
  stamp: string | null;
  call: ToolCallRecord;
}

/**
 * One session per agent, built from the same three-turn skeleton but from deliberately
 * different data — different repository knowledge, different timestamp availability,
 * different tool call. T-SES-15 then compares the fields the type has, not copied values.
 */
function sessionFor(variant: SessionVariant): CanonicalSession {
  const provenance: SourceProvenance = {
    ref: variant.ref,
    title: variant.subject,
    startedAt: "2026-07-30T11:00:00Z",
    updatedAt: "2026-07-30T11:04:12Z",
    repo: variant.repo,
  };
  const turns: CanonicalTurn[] = [
    {
      index: 0,
      role: "user",
      kind: "message",
      text: variant.subject,
      toolCall: null,
      timestamp: variant.stamp,
    },
    {
      index: 1,
      role: "agent",
      kind: "tool-call",
      text: "",
      toolCall: variant.call,
      timestamp: variant.stamp,
    },
    {
      index: 2,
      role: "agent",
      kind: "summary",
      text: variant.closing,
      toolCall: null,
      timestamp: variant.stamp,
    },
  ];
  return { provenance, turns };
}

const AGENT_SESSIONS: Record<AgentId, CanonicalSession> = {
  pi: sessionFor({
    ref: { agent: "pi", home: "/home/testuser/.pi", id: "pi-2026-07-30-a41" },
    subject: "add a retry to the fetch helper",
    closing: "Added a bounded retry and left one case open.",
    repo: { commit: null, branch: "main", changedPaths: [] },
    stamp: null,
    call: {
      toolName: "read_file",
      argumentsText: "'src/fetch.ts'",
      outcomeLine: "read_file('src/fetch.ts') → 88 lines (body dropped)",
      effect: "read-only",
      bodyDropped: true,
      resultRecorded: true,
    },
  }),
  codex: sessionFor({
    ref: { agent: "codex", home: "/home/testuser/.codex", id: "01JQ8Z3K7M4N5P6Q7R8S9T0V1X" },
    subject: "rename the config loader",
    closing: "Renamed the loader and updated its two callers.",
    repo: {
      commit: "9b1d4c2ae7f30518293a4b5c6d7e8f90a1b2c3d4",
      branch: "chore/config-rename",
      changedPaths: ["src/config.ts", "src/main.ts"],
    },
    stamp: "2026-07-30T11:02:30Z",
    call: {
      toolName: "shell",
      argumentsText: "'git mv src/loader.ts src/config.ts'",
      outcomeLine: "shell('git mv src/loader.ts src/config.ts') → ok",
      effect: "unknown",
      bodyDropped: false,
      resultRecorded: true,
    },
  }),
  "claude-code": sessionFor({
    ref: {
      agent: "claude-code",
      home: "/home/testuser/.claude",
      id: "6f1c0b7e-2f5a-4d1e-9a3b-77c2d5e8f011",
    },
    subject: "split the router file",
    closing: "Split the router into three files; the tests still pass.",
    repo: {
      commit: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
      branch: null,
      changedPaths: ["src/router/routes.ts", "src/router/index.ts"],
    },
    stamp: "2026-07-30T11:03:44Z",
    call: {
      toolName: "Write",
      argumentsText: "'src/router/routes.ts'",
      outcomeLine: "Write('src/router/routes.ts') → 120 lines written",
      effect: "mutating",
      bodyDropped: false,
      resultRecorded: true,
    },
  }),
  "kimi-code": sessionFor({
    ref: {
      agent: "kimi-code",
      home: "/home/testuser/.kimi-code",
      id: "session_7f3a2b1c-4d5e-4f6a-9b0c-1d2e3f4a5b6c",
    },
    subject: "trace the pose publisher",
    closing: "Traced the publisher; the frame ids were the mismatch.",
    repo: { commit: null, branch: "main", changedPaths: ["src/pose_pub.cpp"] },
    stamp: "2026-07-30T11:04:12Z",
    call: {
      toolName: "Read",
      argumentsText: '{"path":"src/pose_pub.cpp"}',
      outcomeLine: 'Read({"path":"src/pose_pub.cpp"}) → 64 lines, body dropped',
      effect: "read-only",
      bodyDropped: true,
      resultRecorded: true,
    },
  }),
};

const EMPTY_SESSION: CanonicalSession = {
  provenance: {
    ref: { agent: "pi", home: "/home/testuser/.pi", id: "pi-2026-08-01-empty" },
    title: "(no messages)",
    startedAt: "2026-08-01T12:00:00Z",
    updatedAt: "2026-08-01T12:00:00Z",
    repo: { commit: null, branch: null, changedPaths: [] },
  },
  turns: [],
};

// Format produced by src/import/landing/marker.ts buildMarker() and summariseDrops() (FR-47).
const REFERENCE_MARKER: ProvenanceMarker = {
  sourceAgent: REFERENCE_REF.agent,
  sourceHome: REFERENCE_REF.home,
  sourceSessionId: REFERENCE_REF.id,
  importedAt: "2026-08-01T09:20:00Z",
  droppedSummary: "Dropped on import: 3 tool result bodies.",
  lines: [
    `Imported from ${REFERENCE_REF.agent}`,
    `Source home: ${REFERENCE_REF.home}`,
    `Source session: ${REFERENCE_REF.id}`,
    `Imported at: 2026-08-01T09:20:00Z`,
    "Dropped on import: 3 tool result bodies.",
  ],
};

describe("turn invariants", () => {
  it("carries no tool call on a message or summary turn (T-SES-3)", () => {
    const spoken = REFERENCE_SESSION.turns.filter((turn) => turn.kind !== "tool-call");

    expect(spoken.length).toBeGreaterThan(0);
    for (const turn of spoken) {
      expect(turn.toolCall).toBeNull();
      expect(turn.text.length).toBeGreaterThan(0);
    }
  });

  it("carries no text on a tool-call turn (T-SES-4)", () => {
    const calls = REFERENCE_SESSION.turns.filter((turn) => turn.kind === "tool-call");

    expect(calls.length).toBeGreaterThan(0);
    for (const turn of calls) {
      expect(turn.text).toBe("");
      expect(turn.toolCall).not.toBeNull();
    }
  });

  it("states an outcome in exactly one line (T-SES-5)", () => {
    expect(toolCalls.length).toBeGreaterThan(0);
    for (const call of toolCalls) {
      expect(call.outcomeLine).not.toMatch(/[\r\n]/);
      expect(call.outcomeLine.length).toBeGreaterThan(0);
    }
  });

  it("indexes turns in source order, with no gaps and no repeats (T-SES-6)", () => {
    const indexes = REFERENCE_SESSION.turns.map((turn) => turn.index);

    expect(indexes).toEqual(indexes.map((_, position) => position));
    expect(new Set(indexes).size).toBe(indexes.length);
  });

  it("writes every timestamp as ISO-8601 UTC (T-SES-7)", () => {
    const stamps = [
      REFERENCE_SESSION.provenance.startedAt,
      REFERENCE_SESSION.provenance.updatedAt,
      REFERENCE_MARKER.importedAt,
      ...REFERENCE_SESSION.turns.flatMap((turn) =>
        turn.timestamp === null ? [] : [turn.timestamp],
      ),
    ];

    expect(stamps.length).toBeGreaterThan(3);
    for (const stamp of stamps) {
      expect(isIsoUtc(stamp)).toBe(true);
    }
  });

  it.each([
    ["local time", "2026-08-01T09:14:02+02:00"],
    ["no zone", "2026-08-01T09:14:02"],
    ["epoch millis", "1754039642000"],
    ["date only", "2026-08-01"],
  ])("rejects %s as a timestamp (T-SES-7)", (_label, value) => {
    expect(isIsoUtc(value)).toBe(false);
  });
});

describe("reference fixture", () => {
  it("exercises every branch the downstream rules have (T-SES-8)", () => {
    const turns = REFERENCE_SESSION.turns;

    expect(turns.some((turn) => turn.role === "user" && turn.kind === "message")).toBe(true);
    expect(turns.some((turn) => turn.role === "agent" && turn.kind === "message")).toBe(true);
    expect(turns.some((turn) => turn.kind === "summary")).toBe(true);
    expect(toolCalls.some((call) => call.effect === "read-only")).toBe(true);
    expect(toolCalls.some((call) => call.effect === "mutating")).toBe(true);
    expect(toolCalls.some((call) => call.bodyDropped)).toBe(true);
  });

  it("satisfies every invariant of the vocabulary", () => {
    assertSessionInvariants(REFERENCE_SESSION);
  });
});

describe("session identity", () => {
  it("separates two sessions that share an agent and an id but not a home (T-SES-10)", () => {
    const inDefaultHome: SessionRef = { ...REFERENCE_REF, home: "/home/testuser/.codex" };
    const inTeamHome: SessionRef = { ...REFERENCE_REF, home: "/home/testuser/.codex-team" };

    expect(inTeamHome.agent).toBe(inDefaultHome.agent);
    expect(inTeamHome.id).toBe(inDefaultHome.id);
    expect(inTeamHome).not.toEqual(inDefaultHome);
  });
});

describe("boundary shapes", () => {
  it("represents a session with no turns (T-SES-11)", () => {
    expect(EMPTY_SESSION.turns).toEqual([]);
    assertSessionInvariants(EMPTY_SESSION);
  });

  it("represents a repository snapshot with nothing known (T-SES-12)", () => {
    const unknown: RepoSnapshot = { commit: null, branch: null, changedPaths: [] };

    expect(unknown.commit).toBeNull();
    expect(unknown.branch).toBeNull();
    expect(unknown.changedPaths).toEqual([]);
  });

  it("represents a descriptor with no repository (T-SES-13)", () => {
    const descriptor: SessionDescriptor = {
      ref: REFERENCE_REF,
      title: REFERENCE_SESSION.provenance.title,
      startedAt: REFERENCE_SESSION.provenance.startedAt,
      updatedAt: REFERENCE_SESSION.provenance.updatedAt,
      turnCount: REFERENCE_SESSION.turns.length,
      repoPath: null,
      repoPaths: [],
      startDirectory: null,
      filePath: "/home/testuser/.codex/sessions/01JQ8Z3K7M4N5P6Q7R8S9T0V1W.jsonl",
    };

    expect(descriptor.repoPath).toBeNull();
    expect(descriptor.repoPaths).toEqual([]);
    expect(isIsoUtc(descriptor.updatedAt)).toBe(true);
    expect(descriptor.filePath.startsWith("/")).toBe(true);
  });

  it("states every fact the provenance marker owes the user (T-SES-14)", () => {
    expect(AGENT_IDS).toContain(REFERENCE_MARKER.sourceAgent);
    expect(REFERENCE_MARKER.sourceHome.length).toBeGreaterThan(0);
    expect(REFERENCE_MARKER.sourceSessionId.length).toBeGreaterThan(0);
    expect(isIsoUtc(REFERENCE_MARKER.importedAt)).toBe(true);

    // FR-47: droppedSummary must be one of the two forms summariseDrops() produces.
    expect(REFERENCE_MARKER.droppedSummary).toMatch(/^(Nothing was dropped: |Dropped on import: )/);
    if (REFERENCE_MARKER.droppedSummary.startsWith("Dropped on import: ")) {
      // When a numeric part is present it must be a counted noun in the exact grammar.
      const hasCountedNoun = /\d+ (turns?|tool result bod(?:y|ies))/.test(
        REFERENCE_MARKER.droppedSummary,
      );
      const hasTrailingToolCall = REFERENCE_MARKER.droppedSummary.includes(
        "an incomplete trailing tool call",
      );
      expect(hasCountedNoun || hasTrailingToolCall).toBe(true);
    }

    // FR-47: lines carry the four provenance facts in the order buildMarker() declares,
    // with the droppedSummary as the fifth element.
    expect(REFERENCE_MARKER.lines).toHaveLength(5);
    expect(REFERENCE_MARKER.lines[0] ?? "").toMatch(/^Imported from /);
    expect(REFERENCE_MARKER.lines[1] ?? "").toMatch(/^Source home: /);
    expect(REFERENCE_MARKER.lines[2] ?? "").toMatch(/^Source session: /);
    expect(REFERENCE_MARKER.lines[3] ?? "").toMatch(/^Imported at: /);
    expect(REFERENCE_MARKER.lines[4]).toBe(REFERENCE_MARKER.droppedSummary);
  });
});

describe("agent independence", () => {
  it("gives every agent the same fields (T-SES-15)", () => {
    const [first, ...rest] = AGENT_IDS.map((agent) =>
      uniqueSorted(keyPaths(AGENT_SESSIONS[agent])),
    );

    expect(first).toBeDefined();
    for (const other of rest) {
      expect(other).toEqual(first);
    }
  });

  it("names the source agent in one field and nowhere else (T-SES-15)", () => {
    const agentIds = new Set<string>(AGENT_IDS);

    for (const agent of AGENT_IDS) {
      const leaks = stringLeaves(AGENT_SESSIONS[agent])
        .filter(([path]) => path !== "provenance.ref.agent")
        .filter(([, value]) => agentIds.has(value));

      expect(leaks).toEqual([]);
    }
  });

  it("holds every agent's session in the one canonical type (T-SES-15)", () => {
    for (const agent of AGENT_IDS) {
      const session: CanonicalSession = AGENT_SESSIONS[agent];

      expect(session.provenance.ref.agent).toBe(agent);
      assertSessionInvariants(session);
    }
  });
});
