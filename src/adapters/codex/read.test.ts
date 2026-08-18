import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionDescriptor } from "./contract.js";
import { codexAdapterFactory } from "./index.js";
import { readRollout } from "./read.js";
import {
  agentEvent,
  functionCall,
  functionCallOutput,
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

  it("streams large rollouts and keeps discovering after a malformed file", async () => {
    const home = tempHome();
    const goodId = "12121212-1212-4212-8212-121212121212";
    writeRollout(home, goodId, [metaEntry(goodId), userEvent("kept session")]);

    const badId = "13131313-1313-4313-8313-131313131313";
    writeRollout(home, badId, [unknownEntry()], undefined, () => "x".repeat(4 * 1024 * 1024));

    const descriptors = await adapter.listSessions(home);
    expect(descriptors.map((descriptor) => descriptor.ref.id)).toEqual([goodId]);
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
    await expect(adapter.loadSession(await loadOnly(home))).rejects.toThrow(/unreadable/i);
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
