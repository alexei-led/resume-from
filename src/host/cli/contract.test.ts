import { describe, expect, it } from "vitest";
import type { CliExit } from "./contract.js";
import { createCliRunner } from "./index.js";
import {
  CONFIRMATION_TOKEN,
  descriptor,
  invocation,
  landing,
  listing,
  marker,
  report,
  stubPipeline,
} from "./test-support.js";

describe("T-CLI-8 the preview is printed verbatim", () => {
  it("prints exactly the report lines, in order, unchanged", async () => {
    const lines = ["header one", "  indented two", "", "Budget: 1k of 200k", "12 turns dropped"];
    const { pipeline } = stubPipeline({ report: report({ lines }) });

    const outcome = await createCliRunner().run(invocation({ argv: ["2"] }), pipeline);

    expect(outcome.stdout.slice(0, lines.length)).toEqual(lines);
    expect(outcome.exitCode).toBe(0);
  });
});

describe("T-CLI-9 the preview is never recomposed", () => {
  it("follows lines even when the structured fields disagree", async () => {
    const lines = ["RENDERED HEADER", "RENDERED BUDGET", "RENDERED WARNING"];
    const { pipeline } = stubPipeline({
      report: report({
        headerLines: ["STRUCTURED HEADER"],
        budgetLine: "STRUCTURED BUDGET",
        warnings: [{ kind: "budget", line: "STRUCTURED WARNING" }],
        dropLines: ["STRUCTURED DROP"],
        lines,
      }),
    });

    const outcome = await createCliRunner().run(invocation({ argv: ["2"] }), pipeline);

    expect(outcome.stdout.slice(0, lines.length)).toEqual(lines);
    const printed = outcome.stdout.join("\n");
    expect(printed).not.toContain("STRUCTURED");
  });
});

describe("T-CLI-10 the landing outcome is printed", () => {
  it("prints the session ID, the exact command and the marker", async () => {
    const result = landing({
      switched: false,
      handover: {
        sessionId: "new-session-7",
        command: "claude --resume new-session-7",
      },
      marker: marker({
        lines: ["=== imported ===", "from codex sess-1", "12 turns dropped"],
      }),
    });
    const { pipeline } = stubPipeline({ landing: result });

    const outcome = await createCliRunner().run(
      invocation({ argv: ["1", "--confirm", CONFIRMATION_TOKEN] }),
      pipeline,
    );

    expect(outcome.stdout).toContain("Resume: claude --resume new-session-7");
    for (const line of result.marker.lines) {
      expect(outcome.stdout).toContain(line);
    }
    expect(outcome.exitCode).toBe(0);
  });
});

describe("T-CLI-11 exit codes", () => {
  const cases: {
    name: string;
    argv: string[];
    exit: CliExit;
    stub: () => ReturnType<typeof stubPipeline>;
  }[] = [
    {
      name: "a successful listing",
      argv: [],
      exit: 0,
      stub: () => stubPipeline({ listing: listing({ rows: [descriptor()] }) }),
    },
    {
      name: "a successful preview",
      argv: ["1"],
      exit: 0,
      stub: () => stubPipeline(),
    },
    {
      name: "a successful commit",
      argv: ["1", "--confirm", CONFIRMATION_TOKEN],
      exit: 0,
      stub: () => stubPipeline(),
    },
    {
      name: "a blocked preview",
      argv: ["1"],
      exit: 1,
      stub: () =>
        stubPipeline({
          report: report({
            blocked: true,
            blockedReason: "The repository has uncommitted changes",
          }),
        }),
    },
    {
      name: "an unknown row",
      argv: ["9"],
      exit: 2,
      stub: () =>
        stubPipeline({
          previewRejects: {
            input: "9",
            message: "There is no row 9. Run /resume-from to list again.",
          },
        }),
    },
    {
      name: "a landing failure",
      argv: ["1", "--confirm", CONFIRMATION_TOKEN],
      exit: 2,
      stub: () =>
        stubPipeline({
          commitRejects: {
            stage: "commit",
            message: "The target home is read only. Check its permissions.",
            defects: [],
            rolledBack: false,
          },
        }),
    },
    {
      name: "a wrong confirmation token",
      argv: ["1", "--confirm", `v1-sha256-${"a".repeat(64)}`],
      exit: 2,
      stub: () =>
        stubPipeline({
          commitRejects: new Error("confirmation token mismatch"),
        }),
    },
  ];

  it.each(cases)("$name exits $exit", async ({ argv, exit, stub }) => {
    const { pipeline } = stub();

    const outcome = await createCliRunner().run(invocation({ argv }), pipeline);

    expect(outcome.exitCode).toBe(exit);
  });
});

describe("T-CLI-12 errors go to standard error with a next step", () => {
  it("keeps standard output empty and explains an unresolved selection", async () => {
    const { pipeline } = stubPipeline({
      previewRejects: {
        input: "9",
        message: "There is no row 9. Run /resume-from to list the sessions again.",
      },
    });

    const outcome = await createCliRunner().run(invocation({ argv: ["9"] }), pipeline);

    expect(outcome.stdout).toEqual([]);
    expect(outcome.stderr.join("\n")).toContain("no row 9");
    expect(outcome.stderr.join("\n")).toContain("/resume-from");
    expect(outcome.exitCode).toBe(2);
  });

  it("keeps standard output empty and explains a landing failure", async () => {
    const { pipeline } = stubPipeline({
      commitRejects: {
        stage: "commit",
        message: "The target home is read only. Check its permissions.",
        defects: [],
        rolledBack: false,
      },
    });

    const outcome = await createCliRunner().run(
      invocation({ argv: ["1", "--confirm", CONFIRMATION_TOKEN] }),
      pipeline,
    );

    expect(outcome.stdout).toEqual([]);
    expect(outcome.stderr.join("\n")).toContain("read only");
    expect(outcome.stderr.join("\n")).toContain("Check its permissions");
    expect(outcome.exitCode).toBe(2);
  });

  it("keeps standard output empty and explains a failed listing", async () => {
    const { pipeline } = stubPipeline({
      listRejects: new Error("No repository here. Run the command inside a repository."),
    });

    const outcome = await createCliRunner().run(invocation({ argv: [] }), pipeline);

    expect(outcome.stdout).toEqual([]);
    expect(outcome.stderr.join("\n")).toContain("No repository here");
    expect(outcome.exitCode).toBe(2);
  });

  it("keeps standard output empty and tells the user to preview again after a wrong confirmation token", async () => {
    const wrongToken = `v1-sha256-${"a".repeat(64)}`;
    const { pipeline, calls } = stubPipeline({
      commitRejects: new Error("confirmation token mismatch"),
    });

    const outcome = await createCliRunner().run(
      invocation({ argv: ["1", "--confirm", wrongToken] }),
      pipeline,
    );

    expect(calls.order).toEqual(["preview", "commit"]);
    expect(calls.commit[0]?.confirmationToken).toBe(wrongToken);
    expect(outcome.stdout).toEqual([]);
    expect(outcome.stderr.join("\n")).toContain("preview again");
    expect(outcome.exitCode).toBe(2);
  });

  // A blocked preview is a refusal (exit 1), not one of the two exit-2 failures of
  // T-CLI-11. The reason states what to change and goes to standard error; the
  // preview itself still goes to standard output, unchanged (FR-21, FR-33).
  it("states what to change when the preview is blocked", async () => {
    const lines = ["From codex sess-1", "Blocked: uncommitted changes"];
    const { pipeline } = stubPipeline({
      report: report({
        blocked: true,
        blockedReason: "Commit or stash the 3 changed files, then run the command again.",
        lines,
      }),
    });

    const outcome = await createCliRunner().run(invocation({ argv: ["1"] }), pipeline);

    expect(outcome.stdout.slice(0, lines.length)).toEqual(lines);
    expect(outcome.stderr.join("\n")).toContain("Commit or stash the 3 changed files");
    expect(outcome.exitCode).toBe(1);
  });
});
