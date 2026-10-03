/**
 * T-KIMI-2 to T-KIMI-4 — the reader against the NATIVE loop-event wire shape.
 *
 * The conformance suite seeds source homes through this adapter's own serializer, so its
 * round trips exercise the message-based shape the writer produces. Real Kimi Code sessions
 * speak the loop-event shape — `step.begin`/`content.part`/`tool.call`/`tool.result` — and
 * only the fixtures here speak it back. A reader that understood only its own writer would
 * list every real session as zero turns; these tests pin that down.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listKimiCodeSessions, loadKimiCodeSession, readWire, scanWire } from "./read.js";

/** The single row of a one-session listing, asserted without a non-null assertion. */
function only<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row === undefined) throw new Error("a one-row listing held no row");
  return row;
}

const dir = join(tmpdir(), `kimi-native-fixture-${process.pid}-${Date.now().toString(36)}`);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const MS = 1_789_112_135_000;

/** One native-shaped wire file: loop events, injections, think parts, undo and compaction. */
function nativeWire(): string {
  const records: Record<string, unknown>[] = [
    { type: "metadata", protocol_version: "1.5", created_at: MS },
    {
      type: "runtime.set_binding",
      workspaceId: "wd_x",
      runtimeId: "local",
      agentId: "main",
      time: MS,
    },
    { type: "profile.bind", agentId: "main", profileName: "agent", time: MS },
    {
      type: "prompt.accepted",
      agentId: "main",
      promptId: "msg_open",
      content: [{ type: "text", text: "fix the retry bug" }],
      time: MS + 1,
    },
    {
      type: "turn.prompt",
      agentId: "main",
      input: [{ type: "text", text: "fix the retry bug" }],
      origin: { kind: "user" },
      promptId: "msg_open",
      time: MS + 2,
    },
    {
      type: "context.append_message",
      agentId: "main",
      message: {
        role: "user",
        content: [{ type: "text", text: "fix the retry bug" }],
        toolCalls: [],
        origin: { kind: "user" },
        id: "msg_open",
      },
      time: MS + 3,
    },
    {
      // A date injection: native files carry them, the reader must produce no turn.
      type: "context.append_message",
      agentId: "main",
      message: {
        role: "user",
        content: [{ type: "text", text: "<system-reminder>today is 2026-09-11</system-reminder>" }],
        toolCalls: [],
        origin: { kind: "injection", variant: "date_change" },
        id: "msg_inject",
      },
      time: MS + 4,
    },
    {
      type: "context.append_loop_event",
      agentId: "main",
      event: { type: "step.begin", uuid: "s1", turnId: "0", step: 1 },
      time: MS + 5,
    },
    {
      type: "context.append_loop_event",
      agentId: "main",
      event: {
        type: "content.part",
        uuid: "p1",
        turnId: "0",
        step: 1,
        stepUuid: "s1",
        part: { type: "think", think: "REASONING-TRACE-must-never-cross" },
      },
      time: MS + 6,
    },
    {
      type: "context.append_loop_event",
      agentId: "main",
      event: {
        type: "tool.call",
        uuid: "c1",
        turnId: "0",
        step: 1,
        stepUuid: "s1",
        toolCallId: "call_1",
        name: "Read",
        args: { path: "src/auth.ts" },
      },
      time: MS + 7,
    },
    {
      type: "context.append_loop_event",
      agentId: "main",
      event: {
        type: "tool.result",
        parentUuid: "c1",
        toolCallId: "call_1",
        result: { output: "line1\nline2\nline3" },
      },
      time: MS + 8,
    },
    {
      type: "context.append_loop_event",
      agentId: "main",
      event: {
        type: "tool.call",
        uuid: "c2",
        turnId: "0",
        step: 1,
        stepUuid: "s1",
        toolCallId: "call_2",
        name: "Edit",
        args: { path: "src/auth.ts" },
      },
      time: MS + 9,
    },
    // call_2's result never arrives: the broken tail stays visible (T-KIMI-4).
    {
      type: "context.append_loop_event",
      agentId: "main",
      event: {
        type: "step.end",
        uuid: "s1",
        turnId: "0",
        step: 1,
        finishReason: "tool_use",
      },
      time: MS + 10,
    },
    {
      type: "turn.ended",
      agentId: "main",
      turnId: 0,
      reason: "completed",
      time: MS + 11,
    },
    // A second prompt the user undoes afterwards.
    {
      type: "context.append_message",
      agentId: "main",
      message: {
        role: "user",
        content: [{ type: "text", text: "also rename the helper" }],
        toolCalls: [],
        origin: { kind: "user" },
        id: "msg_second",
      },
      time: MS + 12,
    },
    {
      type: "context.append_loop_event",
      agentId: "main",
      event: {
        type: "content.part",
        uuid: "p2",
        turnId: "1",
        step: 1,
        stepUuid: "s2",
        part: { type: "text", text: "Renaming it now." },
      },
      time: MS + 13,
    },
    { type: "context.undo", agentId: "main", count: 1, time: MS + 14 },
    // After the undo, a compaction summarizes the surviving history.
    {
      type: "context.apply_compaction",
      agentId: "main",
      summary: "## Task state\n\nThe retry bug is fixed and tested.",
      compactedCount: 3,
      time: MS + 15,
    },
    {
      type: "prompt.completed",
      agentId: "main",
      promptId: "msg_open",
      finishedAt: "2026-09-11T07:36:00.695Z",
      reason: "completed",
      time: MS + 16,
    },
  ];
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

async function seedSession(home: string, sessionId: string, workDir: string): Promise<string> {
  const sessionDir = join(home, "sessions", `wd_${workDir.replaceAll("/", "_")}`, sessionId);
  await mkdir(join(sessionDir, "agents", "main"), { recursive: true });
  await writeFile(
    join(sessionDir, "state.json"),
    `${JSON.stringify({
      id: sessionId,
      version: 2,
      cwd: workDir,
      createdAt: MS,
      updatedAt: MS + 16,
      archived: false,
      title: "fix the retry bug",
      titleKind: "replaceable",
      isCustomTitle: false,
      lastPrompt: "fix the retry bug",
      lastTurnReason: "completed",
      agents: {
        main: {
          homedir: join(sessionDir, "agents", "main"),
          type: "main",
          parentAgentId: null,
        },
      },
      custom: {},
    })}\n`,
  );
  await writeFile(join(sessionDir, "agents", "main", "wire.jsonl"), nativeWire());
  return sessionDir;
}

describe("T-KIMI-2 — a native wire file becomes canonical turns", () => {
  const home = join(dir, "home-native");
  const sessionId = "session_11111111-2222-4333-8444-555555555555";

  beforeAll(async () => {
    await seedSession(home, sessionId, "/repo/project");
  });

  it("lists the session with the turns the native shape holds", async () => {
    const rows = await listKimiCodeSessions(home);
    expect(rows).toHaveLength(1);
    const row = only(rows);
    expect(row.ref).toEqual({ agent: "kimi-code", home, id: sessionId });
    expect(row.title).toBe("fix the retry bug");
    expect(row.turnCount).toBe(4); // user message, agent text, Read call, summary
    expect(row.repoPath).toBe("/repo/project");
    expect(row.startDirectory).toBe("/repo/project");
    expect(row.filePath.endsWith("wire.jsonl")).toBe(true);
  });

  it("builds turns the way the replay fold would, undo and compaction included", async () => {
    const rows = await listKimiCodeSessions(home);
    const session = await loadKimiCodeSession(only(rows));
    const turns = session.turns;

    const texts = turns.map((turn) => `${turn.role}:${turn.kind}:${turn.text}`);
    expect(texts).toContain("user:message:fix the retry bug");
    // The undo removed the second user turn AND the agent text that followed it, so the
    // renamed-helper exchange is gone; the compaction summary survives as the last turn.
    expect(texts).not.toContain("agent:message:Renaming it now.");
    expect(texts.filter((text) => text.startsWith("user:message:"))).toHaveLength(1);
    expect(texts.filter((text) => text.startsWith("agent:tool-call:"))).toHaveLength(2);
    expect(turns.at(-1)).toMatchObject({ role: "agent", kind: "summary" });
    expect(turns.at(-1)?.text).toContain("retry bug is fixed");

    // No injection, no think part crossed.
    const joined = JSON.stringify(turns);
    expect(joined).not.toContain("system-reminder");
    expect(joined).not.toContain("REASONING-TRACE");
  });

  it("indexes turns densely and stably", async () => {
    const rows = await listKimiCodeSessions(home);
    const session = await loadKimiCodeSession(only(rows));
    expect(session.turns.map((turn) => turn.index)).toEqual(
      session.turns.map((_turn, index) => index),
    );
    expect(session.provenance.repo.commit).toBeNull();
    expect(session.provenance.repo.branch).toBeNull();
  });
});

describe("T-KIMI-3 — tool results become one outcome line", () => {
  const home = join(dir, "home-tool");

  beforeAll(async () => {
    await seedSession(home, "session_22222222-2222-4333-8444-555555555555", "/repo/tool");
  });

  it("measures the body, drops it, and keeps the effect", async () => {
    const rows = await listKimiCodeSessions(home);
    const session = await loadKimiCodeSession(only(rows));
    const read = session.turns.find((turn) => turn.toolCall?.toolName === "Read");
    expect(read?.toolCall).toMatchObject({
      toolName: "Read",
      argumentsText: '{"path":"src/auth.ts"}',
      effect: "read-only",
      bodyDropped: true,
      resultRecorded: true,
    });
    expect(read?.toolCall?.outcomeLine).toContain("Read(");
    expect(read?.toolCall?.outcomeLine).toContain("3 lines, body dropped");
    expect(read?.toolCall?.outcomeLine.split("\n")).toHaveLength(1);
    expect(JSON.stringify(session.turns)).not.toContain("line2");
    // The unanswered Edit is still a mutating call: its file reaches the snapshot (FR-36).
    expect(session.provenance.repo.changedPaths).toEqual(["src/auth.ts"]);
  });

  it("T-KIMI-4 — a broken tail stays visible as unanswered", async () => {
    const rows = await listKimiCodeSessions(home);
    const session = await loadKimiCodeSession(only(rows));
    const edit = session.turns.find((turn) => turn.toolCall?.toolName === "Edit");
    expect(edit?.toolCall).toMatchObject({
      effect: "mutating",
      bodyDropped: false,
      resultRecorded: false,
    });
    expect(edit?.toolCall?.outcomeLine).toContain("no output recorded");
    expect(session.provenance.repo.changedPaths).toContain("src/auth.ts");
  });
});

describe("T-KIMI-13 — a truncated or unknown-typed wire file", () => {
  it("reports a file cut mid-record as unreadable", async () => {
    const home = join(dir, "home-truncated");
    const sessionDir = await seedSession(
      home,
      "session_33333333-2222-4333-8444-555555555555",
      "/repo/truncated",
    );
    const wirePath = join(sessionDir, "agents", "main", "wire.jsonl");
    await writeFile(wirePath, '{"type":"metadata","protocol_version":"1.5","created_at":1}\n{"typ');

    const scan = await scanWire(wirePath);
    expect(scan.truncated).toBe(true);
    await expect(loadKimiCodeSession(only(await listKimiCodeSessions(home)))).rejects.toThrow(
      /unreadable/i,
    );
  });

  it("skips and counts a record type it does not know", async () => {
    const home = join(dir, "home-unknown");
    const sessionDir = await seedSession(
      home,
      "session_44444444-2222-4333-8444-555555555555",
      "/repo/unknown",
    );
    const wirePath = join(sessionDir, "agents", "main", "wire.jsonl");
    await writeFile(
      wirePath,
      '{"type":"metadata","protocol_version":"1.5","created_at":1}\n' +
        '{"type":"future_record_kind","payload":{"note":"UNKNOWN-ENTRY-CONTENT"}}\n' +
        '{"type":"prompt.completed","agentId":"main","promptId":"x","reason":"completed","time":2}\n',
    );

    const scan = await readWire(wirePath);
    expect(scan.truncated).toBe(false);
    expect(scan.skippedRecords).toBe(1);
    expect(JSON.stringify(scan.turns)).not.toContain("UNKNOWN-ENTRY-CONTENT");
  });
});
