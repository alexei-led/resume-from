import { describe, expect, it } from "vitest";
import type { AgentId, LandingResult } from "./contract.js";
import { createCliRunner } from "./index.js";
import {
  CONFIRMATION_TOKEN,
  descriptor,
  invocation,
  landing,
  listing,
  marker,
  presentPlace,
  report,
  rowLines,
  stubPipeline,
} from "./test-support.js";

describe("T-CLI-21 the FR-10 sequence", () => {
  it("lists, previews row 3, then lands row 3 — three runs with no shared state", async () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      descriptor({
        ref: {
          agent: "codex",
          home: "/Users/me/.codex",
          id: `sess-${index + 1}`,
        },
        title: `Session ${index + 1}`,
      }),
    );
    const chosen = rows[2];
    if (chosen === undefined) throw new Error("fixture is missing row 3");

    // 1. /resume-from
    const first = stubPipeline({ listing: listing({ rows }) });
    const listed = await createCliRunner().run(invocation({ argv: [] }), first.pipeline);
    expect(rowLines(listed.stdout)).toHaveLength(10);
    expect(rowLines(listed.stdout)[2]).toContain(chosen.title);

    // 2. /resume-from 3 — a separate run, nothing carried over
    const second = stubPipeline({
      report: report({
        lines: [`From codex ${chosen.ref.id}`, "12 turns cross, 4 dropped"],
      }),
    });
    const previewed = await createCliRunner().run(invocation({ argv: ["3"] }), second.pipeline);
    expect(second.calls.preview[0]?.selection).toEqual({ by: "row", row: 3 });
    expect(previewed.stdout[0]).toBe(`From codex ${chosen.ref.id}`);
    expect(second.calls.commit).toHaveLength(0);
    expect(previewed.exitCode).toBe(0);

    // 3. /resume-from 3 --confirm — a separate run; the pipeline recomputes
    const third = stubPipeline({
      landing: landing({
        ref: {
          agent: "claude-code",
          home: "/Users/me/.claude",
          id: "landed-from-3",
        },
        marker: marker({ sourceSessionId: chosen.ref.id }),
      }),
    });
    const landed = await createCliRunner().run(
      invocation({ argv: ["3", "--confirm", CONFIRMATION_TOKEN] }),
      third.pipeline,
    );
    expect(third.calls.order).toEqual(["preview", "commit"]);
    expect(third.calls.commit[0]?.request.selection).toEqual({
      by: "row",
      row: 3,
    });
    expect(third.calls.commit[0]?.request).toEqual(second.calls.preview[0]);
    expect(landed.stdout.join("\n")).toContain("Resume: claude --resume new-session-7");
    expect(landed.exitCode).toBe(0);
  });
});

describe("T-CLI-25 the identifier flow", () => {
  it("resumes natively when the session belongs to the current agent", async () => {
    const located = descriptor({
      ref: {
        agent: "claude-code",
        home: "/Users/me/.claude",
        id: "dc601a22-64e3-410b-9321-bb8f86bdc5ad",
      },
      startDirectory: "/work/app",
      repoPath: "/work/app",
    });
    const { pipeline, calls } = stubPipeline({
      located,
      place: presentPlace({ directory: "/work/app", branch: "main" }),
    });

    const outcome = await createCliRunner().run(invocation({ argv: [located.ref.id] }), pipeline);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout.join("\n")).toContain("Resume: cd /work/app && claude-code resume");
    expect(calls.preview).toHaveLength(0);
    expect(calls.commit).toHaveLength(0);
  });

  it("never imports in a bare shell, even when the agent differs", async () => {
    const located = descriptor({
      ref: { agent: "codex", home: "/Users/me/.codex", id: "019d1e2f-3a4b-7c5d-8e9f-0123456789ab" },
      startDirectory: "/work/app",
      repoPath: "/work/app",
    });
    const { pipeline, calls } = stubPipeline({ located });

    const outcome = await createCliRunner(null).run(
      invocation({ argv: [located.ref.id], targetAgent: null }),
      pipeline,
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout.join("\n")).toContain("Resume:");
    expect(calls.preview).toHaveLength(0);
    expect(calls.commit).toHaveLength(0);
  });

  it("--context prints the conversation an import would keep and a Directory line", async () => {
    const located = descriptor({ startDirectory: "/work/app", repoPath: "/work/app" });
    const { pipeline, calls } = stubPipeline({
      located,
      place: presentPlace({ directory: "/work/app", branch: "main" }),
      contextLines: ["User: inspect it", "Agent: done", "Tool: Read(file) → ok"],
    });

    const outcome = await createCliRunner().run(
      invocation({ argv: [located.ref.id, "--context"] }),
      pipeline,
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout.join("\n")).toContain("User: inspect it");
    expect(outcome.stdout.join("\n")).toContain("Tool: Read(file) → ok");
    expect(outcome.stdout.join("\n")).toContain("Directory: /work/app");
    expect(calls.preview).toHaveLength(0);
    expect(calls.commit).toHaveLength(0);
  });

  it("prints the ambiguity message and selects nothing", async () => {
    const { pipeline, calls } = stubPipeline({
      locateRejects: {
        input: "dc601a22",
        message:
          'Session "dc601a22" matches 2 sessions. Select one by exact file path, or narrow the search with --agent or --home.',
      },
    });

    const outcome = await createCliRunner().run(invocation({ argv: ["dc601a22"] }), pipeline);

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr.join("\n")).toContain("matches 2 sessions");
    expect(calls.preview).toHaveLength(0);
  });

  it("keeps each ambiguity candidate on its own line", async () => {
    const message =
      'Session "dc601a22" matches 2 sessions. Select one by exact file path, or narrow the search with --agent or --home:\n' +
      "- claude-code dc601a22-… · /home/a · /work/app · 2026-05-01T08:00:00Z · claude copy\n" +
      "- codex dc601a22-… · /home/b · /work/app · 2026-05-02T08:00:00Z · codex copy";
    const { pipeline } = stubPipeline({ locateRejects: { input: "dc601a22", message } });

    const outcome = await createCliRunner().run(invocation({ argv: ["dc601a22"] }), pipeline);

    expect(outcome.stderr.join("\n")).toContain(
      "- claude-code dc601a22-… · /home/a · /work/app · 2026-05-01T08:00:00Z · claude copy\n" +
        "- codex dc601a22-… · /home/b · /work/app · 2026-05-02T08:00:00Z · codex copy",
    );
  });

  it("appends --prompt to the native command, shell-quoted by the adapter", async () => {
    const located = descriptor({
      ref: { agent: "claude-code", home: "/Users/me/.claude", id: "sess-9" },
      startDirectory: "/work/app",
      repoPath: "/work/app",
    });
    const { pipeline } = stubPipeline({
      located,
      place: presentPlace({ directory: "/work/app" }),
    });

    const outcome = await createCliRunner().run(
      invocation({ argv: [located.ref.id, "--prompt", "continue the refactor"] }),
      pipeline,
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout.join("\n")).toContain("continue the refactor");
  });

  it("--context never recovers a missing directory", async () => {
    const located = descriptor({ startDirectory: "/gone/app", repoPath: "/gone/app" });
    const { pipeline, calls } = stubPipeline({
      located,
      place: {
        state: "recoverable",
        directory: "/gone/app",
        branch: null,
        warnings: [],
        recovery: {
          directory: "/gone/app",
          commands: [
            {
              cwd: "/work/app",
              argv: ["worktree", "add", "/gone/app", "main"],
              display: "git -C /work/app worktree add /gone/app main",
            },
          ],
          warnings: [],
        },
        reason: null,
      },
      contextLines: ["User: inspect it"],
    });

    const outcome = await createCliRunner().run(
      invocation({ argv: [located.ref.id, "--context"] }),
      pipeline,
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout.join("\n")).toContain("Directory: /gone/app");
    expect(calls.order).not.toContain("recover");
    expect(calls.commit).toHaveLength(0);
  });

  it("lets --to import an unrecoverable session into another checkout, with a warning", async () => {
    const located = descriptor({
      ref: { agent: "codex", home: "/Users/me/.codex", id: "sess-2" },
      startDirectory: "/gone/app",
      repoPath: "/gone/app",
    });
    const warning =
      "the session's recorded directory /gone/app is missing; importing into /work/other anyway";
    const { pipeline, calls } = stubPipeline({
      located,
      place: {
        state: "unrecoverable",
        directory: "/gone/app",
        branch: null,
        warnings: [],
        recovery: null,
        reason: "no repository was found for /gone/app",
      },
      destination: { directory: "/work/other", warning },
    });

    const outcome = await createCliRunner().run(
      invocation({ argv: [located.ref.id, "--to", "/work/other"] }),
      pipeline,
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout.join("\n")).toContain("Confirm:");
    expect(outcome.stdout.join("\n")).toContain(warning);
    expect(calls.preview[0]?.destinationCwd).toBe("/work/other");
    expect(calls.preview[0]?.located).toEqual(located);
  });

  it("validates --to before offering a recovery, so no worktree is written first", async () => {
    const located = descriptor({ startDirectory: "/gone/app", repoPath: "/gone/app" });
    const { pipeline, calls } = stubPipeline({
      located,
      place: {
        state: "recoverable",
        directory: "/gone/app",
        branch: "main",
        warnings: [],
        recovery: { directory: "/gone/app", commands: [], warnings: [] },
        reason: null,
      },
      recoveryToken: `v1-sha256-${"2".repeat(64)}`,
      destinationRejects: new Error("belongs to a different repository"),
    });

    const outcome = await createCliRunner().run(
      invocation({ argv: [located.ref.id, "--to", "/work/other"] }),
      pipeline,
    );

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr.join("\n")).toContain("different repository");
    expect(calls.order).not.toContain("recover");
  });

  it("shows the destination warning in the recovery preview", async () => {
    const located = descriptor({ startDirectory: "/gone/app", repoPath: "/gone/app" });
    const warning =
      "the session's recorded directory /gone/app is missing; importing into /work/other anyway";
    const { pipeline } = stubPipeline({
      located,
      place: {
        state: "recoverable",
        directory: "/gone/app",
        branch: "main",
        warnings: [],
        recovery: {
          directory: "/gone/app",
          commands: [
            {
              cwd: "/work/app",
              argv: ["worktree", "add", "/gone/app", "main"],
              display: "git -C /work/app worktree add /gone/app main",
            },
          ],
          warnings: [],
        },
        reason: null,
      },
      recoveryToken: `v1-sha256-${"3".repeat(64)}`,
      destination: { directory: "/work/other", warning },
    });

    const outcome = await createCliRunner().run(
      invocation({ argv: [located.ref.id, "--to", "/work/other"] }),
      pipeline,
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout.join("\n")).toContain(warning);
    expect(outcome.stdout.join("\n")).toContain("Recover:");
  });

  it("sanitizes an unrecoverable summary before printing it", async () => {
    const located = descriptor({
      ref: { agent: "codex", home: "/Users/me/.codex", id: "sess-3" },
      title: "owned\u001b[31m title",
      startDirectory: "/gone/app",
      repoPath: "/gone/app",
    });
    const { pipeline } = stubPipeline({
      located,
      place: {
        state: "unrecoverable",
        directory: "/gone/app",
        branch: null,
        warnings: [],
        recovery: null,
        reason: "no repository was found",
      },
    });

    const outcome = await createCliRunner().run(invocation({ argv: [located.ref.id] }), pipeline);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout.join("\n")).not.toContain("\u001b");
    expect(outcome.stdout.join("\n")).toContain("owned");
  });

  it("refuses --to in a bare shell, which never imports", async () => {
    const { pipeline, calls } = stubPipeline();

    const outcome = await createCliRunner(null).run(
      invocation({ argv: ["sess-1", "--to", "/work/other"], targetAgent: null }),
      pipeline,
    );

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr.join("\n")).toContain("bare shell");
    expect(calls.preview).toHaveLength(0);
    expect(calls.commit).toHaveLength(0);
  });
});

describe("the Confirm line is runnable where it is printed", () => {
  it("uses the host's slash command when a target agent runs the tool", async () => {
    const { pipeline } = stubPipeline();
    const outcome = await createCliRunner().run(
      invocation({ argv: ["sess-1", "--to", "/work/other"], targetAgent: "codex" }),
      pipeline,
    );
    expect(outcome.stdout).toContain(
      `Confirm: /resume-from sess-1 --to /work/other --confirm ${CONFIRMATION_TOKEN}`,
    );
  });

  it("uses a runnable resume-from command in a bare shell", async () => {
    const token = `v1-sha256-${"1".repeat(64)}`;
    const { pipeline } = stubPipeline({
      place: {
        state: "recoverable",
        directory: "/gone/app",
        branch: "main",
        warnings: [],
        recovery: { directory: "/gone/app", commands: [], warnings: [] },
        reason: null,
      },
      recoveryToken: token,
    });
    const outcome = await createCliRunner(null).run(
      invocation({ argv: ["sess-1"], targetAgent: null }),
      pipeline,
    );
    expect(outcome.stdout).toContain(`Confirm: resume-from sess-1 --confirm ${token}`);
  });
});

describe("T-CLI-22 the same shape from Codex and from Claude Code", () => {
  async function commitWith(agent: AgentId, result: LandingResult) {
    const { pipeline } = stubPipeline({ landing: result });
    return createCliRunner().run(
      invocation({
        argv: ["1", "--confirm", CONFIRMATION_TOKEN],
        targetAgent: agent,
      }),
      pipeline,
    );
  }

  it("lists the same way from both agents", async () => {
    const rows = [descriptor({ title: "Shared" })];
    const fromCodex = await createCliRunner().run(
      invocation({ targetAgent: "codex" }),
      stubPipeline({ listing: listing({ rows }) }).pipeline,
    );
    const fromClaude = await createCliRunner().run(
      invocation({ targetAgent: "claude-code" }),
      stubPipeline({ listing: listing({ rows }) }).pipeline,
    );

    expect(fromCodex.stdout).toEqual(fromClaude.stdout);
  });

  it("previews the same way from both agents", async () => {
    const lines = ["From codex sess-1", "Budget: 34k of 200k"];
    const fromCodex = await createCliRunner().run(
      invocation({ argv: ["1"], targetAgent: "codex" }),
      stubPipeline({ report: report({ lines }) }).pipeline,
    );
    const fromClaude = await createCliRunner().run(
      invocation({ argv: ["1"], targetAgent: "claude-code" }),
      stubPipeline({ report: report({ lines }) }).pipeline,
    );

    expect(fromCodex.stdout).toEqual(fromClaude.stdout);
  });

  it("differs only in the values the adapter supplied", async () => {
    const codexResult = landing({
      ref: { agent: "codex", home: "/Users/me/.codex", id: "landed-1" },
      handover: { sessionId: "landed-1", command: "codex resume landed-1" },
    });
    const claudeResult = landing({
      ref: { agent: "claude-code", home: "/Users/me/.claude", id: "landed-1" },
      handover: { sessionId: "landed-1", command: "claude --resume landed-1" },
    });

    const fromCodex = await commitWith("codex", codexResult);
    const fromClaude = await commitWith("claude-code", claudeResult);

    expect(fromCodex.exitCode).toBe(fromClaude.exitCode);

    // The layout is the same; only the adapter-supplied Resume command differs (FR-45).
    expect(fromCodex.stdout).toContain("Resume: codex resume landed-1");
    expect(fromClaude.stdout).toContain("Resume: claude --resume landed-1");
    for (const line of fromCodex.stdout.filter((candidate) => !candidate.startsWith("Resume: "))) {
      expect(fromClaude.stdout).toContain(line);
    }
  });
});

describe("T-CLI-23 a new numbered-list agent needs no change here", () => {
  const fourth = "fixture-agent" as AgentId;

  it("gets the numbered list", async () => {
    const rows = [descriptor({ title: "Fixture session" })];
    const { pipeline, calls } = stubPipeline({ listing: listing({ rows }) });

    const outcome = await createCliRunner().run(invocation({ targetAgent: fourth }), pipeline);

    expect(calls.list[0]?.target?.agent).toBe(fourth);
    expect(rowLines(outcome.stdout)).toHaveLength(1);
    expect(outcome.exitCode).toBe(0);
  });

  it("gets the handover with no edit to this module", async () => {
    const { pipeline } = stubPipeline({
      landing: landing({
        ref: { agent: fourth, home: "/Users/me/.fixture", id: "fixture-9" },
        switched: false,
        handover: {
          sessionId: "fixture-9",
          command: "fixture-agent open fixture-9",
        },
      }),
    });

    const outcome = await createCliRunner().run(
      invocation({
        argv: ["1", "--confirm", CONFIRMATION_TOKEN],
        targetAgent: fourth,
      }),
      pipeline,
    );

    expect(outcome.stdout.join("\n")).toContain("fixture-agent open fixture-9");
    expect(outcome.exitCode).toBe(0);
  });
});
