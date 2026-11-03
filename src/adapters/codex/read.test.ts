import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionDescriptor } from "./contract.js";
import { codexAdapterFactory } from "./index.js";
import { readRollout, summarizeRollout } from "./read.js";
import {
  agentEvent,
  functionCall,
  functionCallOutput,
  itemCompletedAgentMessage,
  itemCompletedCollabAgentToolCall,
  itemCompletedCommandExecution,
  itemCompletedContextCompaction,
  itemCompletedExtension,
  itemCompletedFileChange,
  itemCompletedImageView,
  itemCompletedMcpToolCall,
  itemCompletedReasoning,
  itemCompletedSubAgentActivity,
  itemCompletedUserMessage,
  makeTempHome,
  metaEntry,
  reasoningEvent,
  reasoningItem,
  tokenCountEvent,
  unknownEntry,
  userEvent,
  writeRollout,
} from "./test-support.js";

const adapter = codexAdapterFactory.create();
const homes: string[] = [];
const rootUser = typeof process.getuid === "function" && process.getuid() === 0;

function tempHome(): string {
  const home = makeTempHome();
  homes.push(home);
  return home;
}

afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
});

const ENCRYPTED = "gAAAAABqS_O35PXVyKaI9PRJdGp8zV5sRqL6r0jalp2YGJLzguNThcgNuKZ1abcEFVpz";
const BIG_OUTPUT = Array.from({ length: 400 }, (_, i) => `line ${i}: secret-result-body`).join(
  "\n",
);

function fullThread(sessionId: string) {
  return [
    metaEntry(sessionId),
    userEvent("make the auth token refresh work"),
    reasoningEvent("**Thinking about where the token lives**"),
    reasoningItem(ENCRYPTED),
    agentEvent("I'll look at how the token is stored first."),
    functionCall("shell", '{"command":["rg","refreshToken","src/"]}', "call_1"),
    functionCallOutput("call_1", BIG_OUTPUT),
    tokenCountEvent(),
    functionCall(
      "apply_patch",
      '{"input":"*** Begin Patch\\n*** Update File: src/auth.ts\\n"}',
      "call_2",
    ),
    functionCallOutput("call_2", "Success. Updated the following files:\nM src/auth.ts"),
    agentEvent("Fixed the write path."),
  ];
}

async function loadOnly(home: string): Promise<SessionDescriptor> {
  const descriptors = await adapter.listSessions(home);
  const descriptor = descriptors[0];
  if (descriptor === undefined) throw new Error("no session listed");
  return descriptor;
}

/** FR-11: the fields the selection list needs. */
describe("listSessions", () => {
  it("lists one row per rollout, with the fields the selection list needs", async () => {
    const home = tempHome();
    const path = writeRollout(
      home,
      "11111111-1111-4111-8111-111111111111",
      fullThread("11111111-1111-4111-8111-111111111111"),
    );
    const [descriptor, ...rest] = await adapter.listSessions(home);
    expect(rest).toEqual([]);
    if (descriptor === undefined) throw new Error("no session listed");
    expect(descriptor.ref).toEqual({
      agent: "codex",
      home,
      id: "11111111-1111-4111-8111-111111111111",
    });
    expect(descriptor.title).toBe("make the auth token refresh work");
    expect(descriptor.filePath).toBe(path);
    expect(descriptor.repoPath).toBe("/repo/demo");
    expect(descriptor.turnCount).toBe(5);
    expect(descriptor.startedAt).toBe("2026-08-01T09:14:02.000Z");
    expect(descriptor.updatedAt).toBe("2026-08-01T09:14:02.000Z");
  });

  it("returns an empty list for a home with no sessions directory", async () => {
    const home = tempHome();
    rmSync(`${home}/sessions`, { recursive: true, force: true });
    expect(await adapter.listSessions(home)).toEqual([]);
  });

  it("sorts newest first (FR-14)", async () => {
    const home = tempHome();
    writeRollout(
      home,
      "aaaaaaaa-1111-4111-8111-111111111111",
      [
        metaEntry("aaaaaaaa-1111-4111-8111-111111111111", {
          timestamp: "2026-01-01T00:00:00.000Z",
        }),
        userEvent("older", "2026-01-01T00:00:00.000Z"),
      ],
      new Date("2026-01-01T00:00:00.000Z"),
    );
    writeRollout(
      home,
      "bbbbbbbb-2222-4222-8222-222222222222",
      [
        metaEntry("bbbbbbbb-2222-4222-8222-222222222222", {
          timestamp: "2026-05-05T00:00:00.000Z",
        }),
        userEvent("newer", "2026-05-05T00:00:00.000Z"),
      ],
      new Date("2026-05-05T00:00:00.000Z"),
    );
    const titles = (await adapter.listSessions(home)).map((descriptor) => descriptor.title);
    expect(titles).toEqual(["newer", "older"]);
  });

  // C-13's split between counting and loading: a row that disagrees with the session it opens is
  // the defect a summary that re-derived turns for itself would introduce.
  it("counts and titles each row exactly as the session it opens (C-13)", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const cases = [
      {
        name: "the older schema",
        entries: fullThread(id),
        title: "make the auth token refresh work",
        turnCount: 5,
      },
      {
        name: "the item_completed schema",
        entries: [
          metaEntry(id),
          itemCompletedUserMessage("verify the contract"),
          itemCompletedAgentMessage("Here is the report."),
          itemCompletedCommandExecution(["/bin/bash", "-lc", "pwd"], "/repo/demo\n"),
          itemCompletedContextCompaction(),
        ],
        title: "verify the contract",
        turnCount: 3,
      },
      {
        name: "item_completed items beside their response_item repeats",
        entries: [
          metaEntry(id),
          itemCompletedUserMessage("item request"),
          itemCompletedCommandExecution(["ls"], "item output\n"),
          functionCall("exec", '{"command":["ls"]}', "call_repeat"),
          functionCallOutput("call_repeat", "REPEAT-OUTPUT"),
          itemCompletedAgentMessage("item answer"),
        ],
        title: "item request",
        turnCount: 3,
      },
      {
        name: "item_completed items beside older dialogue",
        entries: [
          metaEntry(id),
          userEvent("legacy request"),
          agentEvent("legacy answer"),
          itemCompletedUserMessage("new request"),
          itemCompletedCommandExecution(["ls"], "tool-only\n"),
        ],
        title: "legacy request",
        turnCount: 4,
      },
    ];

    for (const fixture of cases) {
      const home = tempHome();
      writeRollout(home, id, fixture.entries);
      const row = await loadOnly(home);
      const session = await adapter.loadSession(row);
      expect([fixture.name, row.title, row.turnCount]).toEqual([
        fixture.name,
        fixture.title,
        fixture.turnCount,
      ]);
      expect(session.turns.length).toBe(row.turnCount);
    }
  });

  it("treats an over-long line as damage and keeps reading the file (C-13)", async () => {
    const home = tempHome();
    const id = "cccccccc-3333-4333-8333-333333333333";
    writeRollout(home, id, [
      metaEntry(id),
      userEvent("x".repeat(17 * 1024 * 1024)),
      userEvent("the real request", "2026-08-01T09:20:00.000Z"),
    ]);

    const row = await loadOnly(home);
    expect([row.title, row.turnCount]).toEqual(["the real request", 1]);
    expect((await summarizeRollout(row.filePath)).truncated).toBe(true);
    // The loader calls the same line damage, so the row never opens a different session.
    await expect(adapter.loadSession(row)).rejects.toThrow(/unreadable/i);
  });

  // A stream hands over a line in pieces; an entry bigger than one chunk must still arrive whole.
  it("reads an entry whose line is longer than one stream chunk (C-13)", async () => {
    const home = tempHome();
    const id = "99999999-7777-4777-8777-777777777777";
    const long = `first line of ${"y".repeat(1200 * 1024)}`;
    writeRollout(home, id, [
      metaEntry(id),
      userEvent(long),
      userEvent("second request", "2026-08-01T09:20:00.000Z"),
    ]);

    const row = await loadOnly(home);
    const session = await adapter.loadSession(row);
    expect((await summarizeRollout(row.filePath)).truncated).toBe(false);
    expect([row.turnCount, session.turns.length]).toEqual([2, 2]);
    expect(session.turns[0]?.text).toBe(long);
  });

  // One unreadable rollout must not hide the rest of its home (C-13). Root can read a 0o000 file.
  it.skipIf(rootUser)("lists the rest of a home beside an unreadable rollout (C-13)", async () => {
    const home = tempHome();
    const good = writeRollout(
      home,
      "dddddddd-4444-4444-8444-444444444444",
      fullThread("dddddddd-4444-4444-8444-444444444444"),
    );
    const unreadable = writeRollout(
      home,
      "eeeeeeee-5555-4555-8555-555555555555",
      fullThread("eeeeeeee-5555-4555-8555-555555555555"),
    );
    await chmod(unreadable, 0o000);

    expect((await adapter.listSessions(home)).map((row) => row.filePath)).toEqual([good]);
  });

  it.skipIf(rootUser)(
    "reports a home it cannot read at all, rather than an empty one (C-13)",
    async () => {
      const home = tempHome();
      const unreadable = writeRollout(
        home,
        "ffffffff-6666-4666-8666-666666666666",
        fullThread("ffffffff-6666-4666-8666-666666666666"),
      );
      await chmod(unreadable, 0o000);

      await expect(adapter.listSessions(home)).rejects.toThrow();
    },
  );
});

/** T-COD-2 — a rollout file becomes canonical turns. */
describe("T-COD-2 rollout to canonical turns", () => {
  it("keeps messages and calls in source order and drops reasoning", async () => {
    const home = tempHome();
    const id = "22222222-2222-4222-8222-222222222222";
    writeRollout(home, id, fullThread(id));
    const session = await adapter.loadSession(await loadOnly(home));

    expect(
      session.turns.map((turn) => [
        turn.index,
        turn.role,
        turn.kind,
        turn.toolCall?.toolName ?? turn.text,
      ]),
    ).toEqual([
      [0, "user", "message", "make the auth token refresh work"],
      [1, "agent", "message", "I'll look at how the token is stored first."],
      [2, "agent", "tool-call", "shell"],
      [3, "agent", "tool-call", "apply_patch"],
      [4, "agent", "message", "Fixed the write path."],
    ]);
  });

  it("carries the provenance of the source thread (FR-36)", async () => {
    const home = tempHome();
    const id = "33333333-3333-4333-8333-333333333333";
    writeRollout(home, id, fullThread(id));
    const session = await adapter.loadSession(await loadOnly(home));

    expect(session.provenance.ref.id).toBe(id);
    expect(session.provenance.ref.agent).toBe("codex");
    expect(session.provenance.repo.commit).toBe("d68d5097e6a304724cf75f5faf92a8945a1e0785");
    expect(session.provenance.repo.branch).toBe("main");
    expect(session.provenance.repo.changedPaths).toEqual(["src/auth.ts"]);
  });

  it("names tools exactly as the source did (FR-27)", async () => {
    const home = tempHome();
    const id = "44444444-4444-4444-8444-444444444444";
    writeRollout(home, id, fullThread(id));
    const session = await adapter.loadSession(await loadOnly(home));
    expect(
      session.turns.filter((t) => t.kind === "tool-call").map((t) => t.toolCall?.toolName),
    ).toEqual(["shell", "apply_patch"]);
  });

  it("imports compacted.payload.message as one summary and ignores replacement_history", async () => {
    const home = tempHome();
    const id = "45454545-4545-4545-8545-454545454545";
    writeRollout(home, id, [
      metaEntry(id),
      userEvent("original request"),
      {
        timestamp: "2026-08-01T09:15:00.000Z",
        type: "compacted",
        payload: {
          message: "Work completed before compaction.",
          replacement_history: [{ role: "user", content: "REPLACEMENT-HISTORY-MUST-NOT-CROSS" }],
        },
      },
      agentEvent("continued after compaction"),
    ]);

    const session = await adapter.loadSession(await loadOnly(home));
    expect(session.turns.map((turn) => [turn.kind, turn.text])).toEqual([
      ["message", "original request"],
      ["summary", "Work completed before compaction."],
      ["message", "continued after compaction"],
    ]);
    expect(JSON.stringify(session)).not.toContain("REPLACEMENT-HISTORY-MUST-NOT-CROSS");
  });

  it("uses an absolute metadata cwd as repoPath even when git metadata is absent", async () => {
    const home = tempHome();
    const id = "46464646-4646-4646-8646-464646464646";
    writeRollout(home, id, [
      metaEntry(id, { cwd: "/repo/no-git", git: undefined }),
      userEvent("go"),
    ]);

    const descriptor = await loadOnly(home);
    expect(descriptor.repoPath).toBe("/repo/no-git");
  });
});

describe("contained rollout discovery", () => {
  it("does not follow a symlinked directory outside the sessions root", async () => {
    const home = tempHome();
    const outside = tempHome();
    const id = "47474747-4747-4747-8747-474747474747";
    writeRollout(outside, id, [metaEntry(id), userEvent("outside")]);
    symlinkSync(join(outside, "sessions"), join(home, "sessions", "linked"));

    expect(await adapter.listSessions(home)).toEqual([]);
  });

  it("propagates a malformed sessions-root error", async () => {
    const home = tempHome();
    const root = join(home, "sessions");
    rmSync(root, { recursive: true, force: true });
    writeFileSync(root, "not a directory");

    await expect(adapter.listSessions(home)).rejects.toThrow(/not a directory/);
  });
});

/** T-COD-3 — tool outputs become one outcome line. */
describe("T-COD-3 tool outputs become one outcome line", () => {
  it("keeps one line, marks the body dropped, and lets no fragment survive", async () => {
    const home = tempHome();
    const id = "55555555-5555-4555-8555-555555555555";
    writeRollout(home, id, fullThread(id));
    const session = await adapter.loadSession(await loadOnly(home));
    const call = session.turns.find((turn) => turn.toolCall?.toolName === "shell")?.toolCall;
    if (call === undefined || call === null) throw new Error("no shell call");

    expect(call.outcomeLine.includes("\n")).toBe(false);
    expect(call.outcomeLine).toContain("shell");
    expect(call.bodyDropped).toBe(true);

    const whole = JSON.stringify(session);
    expect(whole).not.toContain("secret-result-body");
    expect(whole).not.toContain("line 399");
  });

  it("classifies the effect of a mutating and a read-only call (FR-26)", async () => {
    const home = tempHome();
    const id = "66666666-6666-4666-8666-666666666666";
    writeRollout(home, id, [
      metaEntry(id),
      userEvent("go"),
      functionCall(
        "apply_patch",
        '{"input":"*** Begin Patch\\n*** Update File: src/auth.ts\\n"}',
        "c1",
      ),
      functionCallOutput("c1", "done"),
      functionCall("read_file", '{"path":"src/auth.ts"}', "c2"),
      functionCallOutput("c2", "contents"),
      functionCall("shell", '{"command":["npm","test"]}', "c3"),
    ]);
    const session = await adapter.loadSession(await loadOnly(home));
    expect(
      session.turns.filter((t) => t.kind === "tool-call").map((t) => t.toolCall?.effect),
    ).toEqual(["mutating", "read-only", "unknown"]);
  });

  it("marks a call with no recorded output as body-not-dropped (FR-25)", async () => {
    const home = tempHome();
    const id = "77777777-7777-4777-8777-777777777777";
    writeRollout(home, id, [
      metaEntry(id),
      userEvent("go"),
      functionCall("shell", '{"command":["true"]}', "c9"),
    ]);
    const session = await adapter.loadSession(await loadOnly(home));
    const call = session.turns.find((turn) => turn.kind === "tool-call")?.toolCall;
    expect(call?.bodyDropped).toBe(false);
  });

  it("redacts credentials before canonical and serialized data can carry them", async () => {
    const home = tempHome();
    const id = "78787878-7878-4878-8878-787878787878";
    const apiKey = "sk-12345678901234567890";
    const bearer = "header.payload.signature";
    const uriPassword = "uri-supersecret";
    const userPassword = "curl-supersecret";
    writeRollout(home, id, [
      metaEntry(id),
      userEvent("update the token fixture"),
      functionCall(
        "apply_patch",
        JSON.stringify({
          path: "src/token-refresh.ts",
          api_key: apiKey,
          command:
            `curl -H 'Authorization: Bearer ${bearer}' ` +
            `-u alice:${userPassword} https://alice:${uriPassword}@example.com/api`,
          env: { DATABASE_URL: "postgres://user:password@localhost/db" },
        }),
        "secret-call",
      ),
      functionCallOutput("secret-call", "done"),
    ]);
    const session = await adapter.loadSession(await loadOnly(home));
    const canonical = JSON.stringify(session);

    expect(session.provenance.repo.changedPaths).toEqual(["src/token-refresh.ts"]);
    expect(canonical).not.toContain(apiKey);
    expect(canonical).not.toContain(bearer);
    expect(canonical).not.toContain(uriPassword);
    expect(canonical).not.toContain(userPassword);
    expect(canonical).not.toContain("postgres://user:password@localhost/db");
    expect(canonical).toContain("[REDACTED]");

    const serialized = adapter.serialize(
      session,
      { agent: "codex", home, windowTokens: 200_000 },
      {
        sourceAgent: "codex",
        sourceHome: home,
        sourceSessionId: id,
        importedAt: "2026-08-01T10:00:00.000Z",
        droppedSummary: "tool result bodies",
        lines: ["Imported session"],
      },
      { cwd: "/repo/demo" },
    );
    const bytes = serialized.files
      .map((file) => Buffer.from(file.bytes).toString("utf8"))
      .join("\n");
    expect(bytes).not.toContain(apiKey);
    expect(bytes).not.toContain(bearer);
    expect(bytes).not.toContain(uriPassword);
    expect(bytes).not.toContain(userPassword);
    expect(bytes).not.toContain("postgres://user:password@localhost/db");
  });

  it("redacts a credential typed as a user message turn (FR-28, security)", async () => {
    // A credential pasted into chat must not cross to a different model vendor.
    const home = tempHome();
    const id = "77777777-7777-4777-8777-777777777777";
    const cred = "sk-1234567890abcdef1234";
    writeRollout(home, id, [
      metaEntry(id),
      userEvent(`run: curl -H "Authorization: Bearer ${cred}" https://api.example.com`),
      agentEvent("On it."),
    ]);
    const session = await adapter.loadSession(await loadOnly(home));
    const canonical = JSON.stringify(session);

    expect(canonical).not.toContain(cred);
    expect(canonical).toContain("[REDACTED]");
    // Normal assistant reply is not disturbed.
    expect(session.turns[1]?.text).toBe("On it.");
  });
});

/** T-COD-13 — encrypted reasoning is never read. */
describe("T-COD-13 encrypted reasoning is never read", () => {
  it("produces no turn and appears nowhere in the canonical session", async () => {
    const home = tempHome();
    const id = "88888888-8888-4888-8888-888888888888";
    writeRollout(home, id, [
      metaEntry(id),
      userEvent("go"),
      reasoningItem(ENCRYPTED),
      reasoningEvent("**Thinking about the token refresh**"),
      agentEvent("done"),
    ]);
    const session = await adapter.loadSession(await loadOnly(home));

    expect(session.turns.map((turn) => turn.text)).toEqual(["go", "done"]);
    const whole = JSON.stringify(session);
    expect(whole).not.toContain(ENCRYPTED);
    expect(whole).not.toContain("Thinking about the token refresh");
  });
});

/** T-COD-21 — the item_completed dialogue schema (C-12). */
describe("T-COD-21 the item_completed dialogue schema", () => {
  const id = "abababab-abab-4bab-8bab-abababababab";

  function newSchemaThread(sessionId: string) {
    return [
      metaEntry(sessionId, { originator: "codex_vscode", cli_version: "0.151.0-alpha.7.2" }),
      itemCompletedUserMessage("verify the contract"),
      itemCompletedReasoning(ENCRYPTED),
      itemCompletedAgentMessage("I'll read the context first.", "commentary"),
      itemCompletedCommandExecution(["/bin/bash", "-lc", "pwd && ls"], "/repo/demo\nfile.md\n"),
      itemCompletedFileChange({
        "/repo/demo/report.md": { type: "add", content: "# Report\n\nbody text" },
      }),
      itemCompletedMcpToolCall(
        "example_mcp",
        "execute",
        { language: "javascript", code: "console.log(1)" },
        [{ type: "text", text: "SECRET-MCP-RESULT" }],
      ),
      itemCompletedCollabAgentToolCall("wait", ["/root/migration_read"]),
      itemCompletedSubAgentActivity(),
      itemCompletedExtension(
        "web.search",
        ["site:example.com law"],
        [{ type: "text_result", snippet: "SECRET-EXTENSION-RESULT" }],
      ),
      itemCompletedImageView("file:///repo/demo/page.jpg"),
      itemCompletedContextCompaction(),
      itemCompletedAgentMessage("Here is the report.", "final_answer"),
    ];
  }

  it("extracts every turn the schema carries, in source order", async () => {
    const home = tempHome();
    writeRollout(home, id, newSchemaThread(id));
    const session = await adapter.loadSession(await loadOnly(home));

    expect(
      session.turns.map((turn) => [turn.role, turn.kind, turn.toolCall?.toolName ?? turn.text]),
    ).toEqual([
      ["user", "message", "verify the contract"],
      ["agent", "message", "I'll read the context first."],
      ["agent", "tool-call", "exec"],
      ["agent", "tool-call", "apply_patch"],
      ["agent", "tool-call", "example_mcp.execute"],
      ["agent", "tool-call", "wait"],
      ["agent", "tool-call", "web.search"],
      ["agent", "tool-call", "view_image"],
      ["agent", "message", "Here is the report."],
    ]);
    // The title and the picker preview come from the first user turn, as for the older schema.
    expect((await loadOnly(home)).title).toBe("verify the contract");
  });

  it("settles the effect from the item kind, not from a tool name (FR-26)", async () => {
    const home = tempHome();
    writeRollout(home, id, newSchemaThread(id));
    const session = await adapter.loadSession(await loadOnly(home));
    expect(
      session.turns.filter((t) => t.kind === "tool-call").map((t) => t.toolCall?.effect),
    ).toEqual(["unknown", "mutating", "unknown", "unknown", "read-only", "read-only"]);
  });

  it("names a server tool by its server and tool, and drops its results (FR-24, FR-27)", async () => {
    const home = tempHome();
    writeRollout(home, id, newSchemaThread(id));
    const session = await adapter.loadSession(await loadOnly(home));
    const call = session.turns.find(
      (turn) => turn.toolCall?.toolName === "example_mcp.execute",
    )?.toolCall;

    expect(call?.argumentsText).toContain('"language":"javascript"');
    expect(call?.outcomeLine).toContain("completed");
    expect(call?.outcomeLine).toContain("1 result(s) dropped");
    expect(call?.bodyDropped).toBe(true);
    expect(JSON.stringify(session)).not.toContain("SECRET-MCP-RESULT");
  });

  it("carries the agents another-agent call addressed (FR-23, FR-24)", async () => {
    const home = tempHome();
    writeRollout(home, id, newSchemaThread(id));
    const session = await adapter.loadSession(await loadOnly(home));
    const call = session.turns.find((turn) => turn.toolCall?.toolName === "wait")?.toolCall;

    expect(call?.argumentsText).toBe("/root/migration_read");
    expect(call?.outcomeLine).toContain("completed");
  });

  it("keeps an extension kind that is not a measured read at unknown effect (FR-26)", async () => {
    const home = tempHome();
    writeRollout(home, id, [
      metaEntry(id),
      itemCompletedUserMessage("open it"),
      itemCompletedExtension("browser.open", ["https://example.com"], [{ type: "text_result" }]),
    ]);
    const session = await adapter.loadSession(await loadOnly(home));

    expect(session.turns[1]?.toolCall?.toolName).toBe("browser.open");
    expect(session.turns[1]?.toolCall?.effect).toBe("unknown");
  });

  it("drops the command and extension result bodies without carrying a fragment", async () => {
    const home = tempHome();
    writeRollout(home, id, newSchemaThread(id));
    const session = await adapter.loadSession(await loadOnly(home));
    const whole = JSON.stringify(session);

    const exec = session.turns.find((turn) => turn.toolCall?.toolName === "exec")?.toolCall;
    expect(exec?.bodyDropped).toBe(true);
    expect(exec?.outcomeLine).toContain("body dropped");
    expect(whole).not.toContain("file.md");

    const extension = session.turns.find(
      (turn) => turn.toolCall?.toolName === "web.search",
    )?.toolCall;
    expect(extension?.bodyDropped).toBe(true);
    expect(extension?.argumentsText).toContain("site:example.com law");
    expect(whole).not.toContain("SECRET-EXTENSION-RESULT");
  });

  it("keeps a FileChange patch as a tool argument and records its paths (FR-24, FR-36)", async () => {
    const home = tempHome();
    writeRollout(home, id, newSchemaThread(id));
    const session = await adapter.loadSession(await loadOnly(home));
    const change = session.turns.find(
      (turn) => turn.toolCall?.toolName === "apply_patch",
    )?.toolCall;

    // FR-24 protects a result body, not a tool argument: the legacy apply_patch call keeps the
    // patch it was given, and this is the same kind of argument in the new shape.
    expect(change?.argumentsText).toContain("# Report");
    expect(change?.effect).toBe("mutating");
    expect(session.provenance.repo.changedPaths).toEqual(["/repo/demo/report.md"]);
  });

  it("reads reasoning, compaction and activity markers as no turn, without counting them as skipped", async () => {
    const home = tempHome();
    const path = writeRollout(home, id, newSchemaThread(id));
    const rollout = await readRollout(path);

    expect(rollout.skippedEntries).toBe(0);
    expect(JSON.stringify(rollout.turns)).not.toContain(ENCRYPTED);
  });

  it("does not turn a compaction into a second summary turn", async () => {
    const home = tempHome();
    writeRollout(home, id, [
      metaEntry(id),
      itemCompletedUserMessage("go"),
      {
        timestamp: "2026-08-01T09:15:00.000Z",
        type: "compacted",
        payload: {
          message: "Work completed before compaction.",
          replacement_history: [{ role: "user", content: "REPLACEMENT-HISTORY-MUST-NOT-CROSS" }],
        },
      },
      itemCompletedContextCompaction(),
      itemCompletedAgentMessage("continued"),
    ]);
    const session = await adapter.loadSession(await loadOnly(home));

    // The empty ContextCompaction item adds nothing: the summary text is the `compacted` entry's.
    expect(session.turns.map((turn) => [turn.kind, turn.text])).toEqual([
      ["message", "go"],
      ["summary", "Work completed before compaction."],
      ["message", "continued"],
    ]);
    expect(JSON.stringify(session)).not.toContain("REPLACEMENT-HISTORY-MUST-NOT-CROSS");
  });

  it("carries no turn for a message the model sent no text in (C-12)", async () => {
    const home = tempHome();
    writeRollout(home, id, [
      metaEntry(id),
      itemCompletedUserMessage("   "),
      itemCompletedAgentMessage("real answer"),
    ]);

    const row = await loadOnly(home);
    const session = await adapter.loadSession(row);
    // Both eras drop an empty message, so the row and the session it opens agree.
    expect(session.turns.map((turn) => turn.text)).toEqual(["real answer"]);
    expect([row.title, row.turnCount]).toEqual(["", 1]);
  });

  it("keeps both eras' dialogue and drops the repeated actions (C-12)", async () => {
    const home = tempHome();
    writeRollout(home, id, [
      metaEntry(id),
      userEvent("old-schema request"),
      agentEvent("old-schema answer"),
      functionCall("shell", '{"command":["ls"]}', "call_old"),
      functionCallOutput("call_old", "OLD-SCHEMA-OUTPUT"),
      itemCompletedUserMessage("new-schema request"),
      itemCompletedCommandExecution(["ls"], "new output\n"),
      itemCompletedAgentMessage("new-schema answer"),
    ]);
    const session = await adapter.loadSession(await loadOnly(home));

    // A resumed thread carries the dialogue of both eras and each stays readable. Its actions do
    // not double: the call it made before the first item turn is the only record of that work and
    // is read, while the coarser `response_item` repeats of the items are not.
    expect(session.turns.map((turn) => turn.toolCall?.toolName ?? turn.text)).toEqual([
      "old-schema request",
      "old-schema answer",
      "shell",
      "new-schema request",
      "exec",
      "new-schema answer",
    ]);
    expect(JSON.stringify(session)).not.toContain("OLD-SCHEMA-OUTPUT");
  });

  it("reads a rollout with no item_completed entry as the older schema (C-12)", async () => {
    const home = tempHome();
    writeRollout(home, id, [
      metaEntry(id),
      userEvent("legacy request"),
      functionCall("shell", '{"command":["ls"]}', "call_1"),
      functionCallOutput("call_1", "out"),
      agentEvent("legacy answer"),
    ]);
    const session = await adapter.loadSession(await loadOnly(home));

    expect(session.turns.map((turn) => turn.toolCall?.toolName ?? turn.text)).toEqual([
      "legacy request",
      "shell",
      "legacy answer",
    ]);
    expect(session.turns[1]?.toolCall?.resultRecorded).toBe(true);
  });

  it("keeps the older calls when an item carries no turn (C-12)", async () => {
    const home = tempHome();
    writeRollout(home, id, [
      metaEntry(id),
      userEvent("legacy request"),
      functionCall("shell", '{"command":["ls"]}', "call_1"),
      functionCallOutput("call_1", "out"),
      agentEvent("legacy answer"),
      itemCompletedReasoning("encrypted-reasoning"),
      itemCompletedContextCompaction(),
    ]);
    const session = await adapter.loadSession(await loadOnly(home));

    // Reasoning and compaction carry no turn, so they do not make the item stream the source of
    // this file's actions.
    expect(session.turns.map((turn) => turn.toolCall?.toolName ?? turn.text)).toEqual([
      "legacy request",
      "shell",
      "legacy answer",
    ]);
  });
});

/** T-COD-14 — a truncated or unknown-typed thread. */
describe("T-COD-14 truncated or unknown-typed threads", () => {
  const id = "99999999-9999-4999-8999-999999999999";

  const whole = [metaEntry(id), userEvent("go"), agentEvent("a long enough answer to cut")];

  it.each([
    {
      name: "cut in the last entry",
      cut: (text: string) => text.slice(0, text.length - 30),
    },
    {
      name: "cut in the first entry",
      cut: (text: string) => text.slice(0, 40),
    },
  ])("reports a thread $name as unreadable", async ({ cut }) => {
    const home = tempHome();
    const path = writeRollout(home, id, whole, undefined, cut);
    await expect(readRollout(path)).rejects.toThrow(/unreadable/i);
  });

  it("rejects loadSession for a thread cut mid-entry", async () => {
    const home = tempHome();
    writeRollout(home, id, whole, undefined, (text) => text.slice(0, text.length - 30));
    const descriptor = await loadOnly(home);
    // The session_meta header is the first line, so the cut does not lose the directory:
    // a native restore can still place the thread, while the loader refuses an import.
    expect(descriptor.repoPaths).toEqual(["/repo/demo"]);
    expect(descriptor.startDirectory).toBe("/repo/demo");
    await expect(adapter.loadSession(descriptor)).rejects.toThrow(/unreadable/i);
  });

  it("leaves a thread it cannot read at all out of the listing", async () => {
    const home = tempHome();
    writeRollout(home, id, whole, undefined, (text) => text.slice(0, 40));
    expect(await adapter.listSessions(home)).toEqual([]);
  });

  it("loads the entries it understands and reports the skipped ones", async () => {
    const home = tempHome();
    const path = writeRollout(home, id, [
      metaEntry(id),
      userEvent("go"),
      unknownEntry(),
      unknownEntry(),
      agentEvent("done"),
    ]);
    const rollout = await readRollout(path);
    expect(rollout.skippedEntries).toBe(2);
    expect(rollout.turns.map((turn) => turn.text)).toEqual(["go", "done"]);

    const session = await adapter.loadSession(await loadOnly(home));
    expect(session.turns).toHaveLength(2);
  });

  it("does not count a known entry it simply does not carry as skipped", async () => {
    const home = tempHome();
    const path = writeRollout(home, id, [
      metaEntry(id),
      userEvent("go"),
      tokenCountEvent(),
      reasoningItem(ENCRYPTED),
    ]);
    expect((await readRollout(path)).skippedEntries).toBe(0);
  });
});

describe("recorded repository directory candidates", () => {
  it.each(["/removed/worktree", "/repo/demo", "relative/worktree", "", null, undefined, 42])(
    "uses only absolute header cwd %s, never body or tool directories",
    async (cwd) => {
      const home = tempHome();
      const id = "46464646-4646-4646-8646-464646464646";
      writeRollout(home, id, [
        metaEntry(id, { cwd }),
        userEvent("continue in /other/repository"),
        {
          timestamp: "2026-08-01T09:14:02.000Z",
          type: "turn_context",
          payload: { cwd: "/body/repository" },
        },
        functionCall("shell", '{"cwd":"/tool/repository","command":"pwd"}', "call-cwd"),
      ]);
      const descriptor = await loadOnly(home);
      const expected = typeof cwd === "string" && cwd.startsWith("/") ? [cwd] : [];
      expect(descriptor.repoPaths).toEqual(expected);
      expect(descriptor.repoPath).toBe(expected[0] ?? null);
    },
  );
});
