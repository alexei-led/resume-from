import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SelectionInput, TargetProfile } from "./contract.js";
import { createCliRunner } from "./index.js";
import {
  CONFIRMATION_TOKEN,
  descriptor,
  invocation,
  listing,
  REPO_ROOT,
  rowLines,
  stubPipeline,
} from "./test-support.js";

describe("T-CLI-1 no argument lists", () => {
  it("calls list only, and prints one numbered row per session", async () => {
    const rows = [
      descriptor({ title: "One" }),
      descriptor({ title: "Two" }),
      descriptor({ title: "Three" }),
    ];
    const { pipeline, calls } = stubPipeline({ listing: listing({ rows }) });

    const outcome = await createCliRunner().run(invocation({ argv: [] }), pipeline);

    expect(calls.order).toEqual(["list"]);
    expect(calls.preview).toHaveLength(0);
    expect(calls.commit).toHaveLength(0);
    expect(rowLines(outcome.stdout)).toHaveLength(3);
    expect(outcome.exitCode).toBe(0);
  });
});

describe("T-CLI-2 a row shows every field FR-11 requires", () => {
  it("shows agent, home, time, title and turn count for three sessions across two agents and two homes", async () => {
    const rows = [
      descriptor({
        ref: { agent: "codex", home: "/Users/me/.codex", id: "a" },
        title: "Parser crash",
        updatedAt: "2026-08-05T14:03:00Z",
        turnCount: 12,
      }),
      descriptor({
        ref: { agent: "claude-code", home: "/Users/me/.claude", id: "b" },
        title: "Budget rules",
        updatedAt: "2026-08-04T09:30:00Z",
        turnCount: 7,
      }),
      descriptor({
        ref: { agent: "claude-code", home: "/Users/me/.claude-team", id: "c" },
        title: "Adapter review",
        updatedAt: "2026-08-03T22:15:00Z",
        turnCount: 103,
      }),
    ];
    const { pipeline } = stubPipeline({ listing: listing({ rows }) });

    const outcome = await createCliRunner().run(invocation(), pipeline);

    for (const row of rows) {
      const line = outcome.stdout.find((candidate) => candidate.includes(row.title));
      expect(line, `no row printed for ${row.title}`).toBeDefined();
      expect(line).toContain(row.ref.agent);
      expect(line).toContain(row.ref.home);
      expect(line).toContain(String(row.turnCount));
      expect(line).toContain(row.updatedAt.slice(0, 10));
      expect(line).toContain(row.updatedAt.slice(11, 16));
    }
  });
});

describe("T-CLI-3 rows are numbered from 1, newest first", () => {
  it("numbers ten rows 1 to 10 in the order the pipeline returned them", async () => {
    // The timestamps rise down the list, so any ordering of its own would move a
    // row: the pipeline ordered these, and the printed order is the one returned.
    const rows = Array.from({ length: 10 }, (_, index) =>
      descriptor({
        title: `Session ${index + 1}`,
        updatedAt: new Date(Date.UTC(2026, 7, 1, index)).toISOString(),
      }),
    );
    const { pipeline } = stubPipeline({ listing: listing({ rows }) });

    const outcome = await createCliRunner().run(invocation(), pipeline);

    const printed = rowLines(outcome.stdout);
    expect(printed).toHaveLength(10);
    printed.forEach((line, index) => {
      expect(line.trimStart().startsWith(`${index + 1} `)).toBe(true);
      expect(line).toContain(`Session ${index + 1}`);
    });
  });
});

describe("T-CLI-4 a number previews", () => {
  it("calls preview with row 3 and never commits", async () => {
    const { pipeline, calls } = stubPipeline();

    const outcome = await createCliRunner().run(invocation({ argv: ["3"] }), pipeline);

    expect(calls.order).toEqual(["preview"]);
    expect(calls.preview[0]?.selection).toEqual({ by: "row", row: 3 });
    expect(calls.commit).toHaveLength(0);
    expect(outcome.exitCode).toBe(0);
  });
});

describe("T-CLI-5 a session ID and a file path are told apart", () => {
  const cases: { name: string; token: string; expected: SelectionInput }[] = [
    {
      name: "a session ID",
      token: "9f8e7d6c-4b2a-4c1d-9e8f-0a1b2c3d4e5f",
      expected: {
        by: "session-id",
        id: "9f8e7d6c-4b2a-4c1d-9e8f-0a1b2c3d4e5f",
      },
    },
    {
      name: "an absolute path",
      token: "/Users/me/.codex/sessions/x.jsonl",
      expected: { by: "file-path", path: "/Users/me/.codex/sessions/x.jsonl" },
    },
    {
      name: "a relative path",
      token: "sessions/x.jsonl",
      expected: { by: "file-path", path: `${REPO_ROOT}/sessions/x.jsonl` },
    },
    {
      name: "a Windows drive path",
      token: "C:\\Users\\me\\session.jsonl",
      expected: { by: "file-path", path: "C:\\Users\\me\\session.jsonl" },
    },
    {
      name: "a UNC path",
      token: "\\\\server\\share\\session.jsonl",
      expected: { by: "file-path", path: "\\\\server\\share\\session.jsonl" },
    },
    {
      name: "a backslash relative path",
      token: "sessions\\x.jsonl",
      expected: { by: "file-path", path: `${REPO_ROOT}/sessions/x.jsonl` },
    },
    { name: "a bare number", token: "7", expected: { by: "row", row: 7 } },
  ];

  it.each(cases)("$name produces the right SelectionInput", async ({ token, expected }) => {
    const { pipeline, calls } = stubPipeline();

    await createCliRunner().run(invocation({ argv: [token] }), pipeline);

    expect(calls.preview[0]?.selection).toEqual(expected);
  });
});

describe("T-CLI-6 the agent and home flags are parsed", () => {
  it("maps claude to claude-code and resolves the home path", async () => {
    const { pipeline, calls } = stubPipeline();

    const outcome = await createCliRunner().run(
      invocation({ argv: ["claude", "--home", "~/.claude-team"] }),
      pipeline,
    );

    expect(outcome.exitCode).toBe(0);
    expect(calls.list[0]?.onlyAgent).toBe("claude-code");
    expect(calls.list[0]?.onlyHome).toBe(`${homedir()}/.claude-team`);
  });

  it.each([
    ["agent", ["--agent", "codex", "--agent", "codex"]],
    ["home", ["--home", "/one", "--home", "/two"]],
  ])("rejects a duplicate %s filter", async (_name, argv) => {
    const { pipeline } = stubPipeline();
    const outcome = await createCliRunner().run(invocation({ argv }), pipeline);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr.join(" ")).toMatch(/twice/i);
  });
});

describe("T-CLI-7 the confirmation flag commits", () => {
  it("commits the same request the preview used, with a null runtime handle", async () => {
    const { pipeline, calls } = stubPipeline();

    const outcome = await createCliRunner().run(
      invocation({ argv: ["3", "--confirm", CONFIRMATION_TOKEN] }),
      pipeline,
    );

    expect(calls.order).toEqual(["preview", "commit"]);
    expect(calls.commit[0]?.request).toEqual(calls.preview[0]);
    expect(calls.commit[0]?.runtime).toBeNull();
    expect(calls.commit[0]?.confirmationToken).toBe(CONFIRMATION_TOKEN);
    expect(outcome.exitCode).toBe(0);
  });

  it("accepts the --confirm=<token> inline form and commits", async () => {
    const { pipeline, calls } = stubPipeline();
    const inlineArg = `--confirm=${CONFIRMATION_TOKEN}`;

    const outcome = await createCliRunner().run(invocation({ argv: ["3", inlineArg] }), pipeline);

    expect(calls.order).toEqual(["preview", "commit"]);
    expect(calls.commit[0]?.confirmationToken).toBe(CONFIRMATION_TOKEN);
    expect(outcome.exitCode).toBe(0);
  });
});

describe("T-CLI-24 the shim home is resolved before reaching the pipeline", () => {
  it("the pipeline receives the fallback's resolved home, not the raw tilde path (FR-3)", async () => {
    // The profile builder resolves "~/alt-home" to an absolute path. The runner
    // must prefer fallback.home over invocation.targetHome so the pipeline never
    // sees an unresolved path.
    const resolvedHome = join(homedir(), "alt-home");
    const fallback: TargetProfile = {
      agent: "claude-code",
      home: resolvedHome,
      windowTokens: 100_000,
    };
    const { pipeline, calls } = stubPipeline();

    await createCliRunner(fallback).run(
      invocation({ argv: [], targetHome: "~/alt-home" }),
      pipeline,
    );

    expect(calls.list[0]?.target?.home).toBe(resolvedHome);
  });
});
