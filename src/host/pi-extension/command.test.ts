import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createResumeFromCommand, type ResumeFromDeps } from "./command.js";
import type {
  AgentId,
  AgentRuntime,
  HomeFailure,
  ImportPipeline,
  ImportRequest,
  LandingResult,
  Listing,
  ListRequest,
  PiCommandContext,
  PickResult,
  PiSwitchContext,
  PiSwitchOptions,
  PreviewReport,
  SessionDescriptor,
  SessionPicker,
  UserChoice,
} from "./contract.js";
import { createKeyPicker, type PickerKey } from "./picker.js";
import type { PiUi } from "./ui.js";

const PI_WINDOW = 200_000;

// ---------------------------------------------------------------- fixtures

function descriptor(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    ref: over.ref ?? { agent: "pi", home: "/Users/me/.pi", id: "s-1" },
    title: over.title ?? "Some session",
    startedAt: over.startedAt ?? "2026-08-01T09:00:00Z",
    updatedAt: over.updatedAt ?? "2026-08-01T10:00:00Z",
    turnCount: over.turnCount ?? 7,
    repoPath: over.repoPath ?? "/repo",
    repoPaths: over.repoPaths ?? [over.repoPath ?? "/repo"],
    startDirectory: over.startDirectory ?? over.repoPath ?? "/repo",
    filePath: over.filePath ?? "/Users/me/.pi/sessions/s-1.json",
  };
}

function row(agent: AgentId, id: string, home: string): SessionDescriptor {
  return descriptor({
    ref: { agent, home, id },
    title: `${agent} ${id}`,
    filePath: `${home}/sessions/${id}.json`,
  });
}

function listing(rows: SessionDescriptor[], failures: HomeFailure[] = []): Listing {
  return { rows, failures, excluded: 0 };
}

function report(over: Partial<PreviewReport> = {}): PreviewReport {
  return {
    confirmationToken:
      over.confirmationToken ??
      "v1-sha256-0000000000000000000000000000000000000000000000000000000000000000",
    headerLines: over.headerLines ?? ["From codex, into pi"],
    budgetLine: over.budgetLine ?? "Budget: 34k tokens of a 200k window",
    warnings: over.warnings ?? [],
    dropLines: over.dropLines ?? [],
    blocked: over.blocked ?? false,
    blockedReason: over.blockedReason ?? null,
    lines: over.lines ?? ["From codex, into pi", "Budget: 34k tokens of a 200k window", "12 turns"],
  };
}

function landing(over: Partial<LandingResult> = {}): LandingResult {
  return {
    ref: over.ref ?? { agent: "pi", home: "/Users/me/.pi", id: "new-1" },
    switched: over.switched ?? true,
    handover: over.handover ?? null,
    itemsSent: over.itemsSent ?? 0,
    itemsStored: over.itemsStored ?? 12,
    marker: over.marker ?? {
      sourceAgent: "codex",
      sourceHome: "/Users/me/.codex",
      sourceSessionId: "cx-1",
      importedAt: "2026-08-03T12:00:00Z",
      droppedSummary: "12 older turns dropped",
      lines: ["Imported from codex /Users/me/.codex", "12 older turns dropped"],
    },
  };
}

// ---------------------------------------------------------------- stubs

interface PipelineStub {
  pipeline: ImportPipeline;
  listCalls: ListRequest[];
  previewCalls: ImportRequest[];
  commitCalls: {
    request: ImportRequest;
    runtime: AgentRuntime;
    confirmationToken: string;
  }[];
  order: string[];
}

function stubPipeline(
  opts: {
    listing?: Listing;
    preview?: PreviewReport;
    landing?: LandingResult;
    onCommit?: (request: ImportRequest, runtime: AgentRuntime, confirmationToken: string) => void;
  } = {},
): PipelineStub {
  const stub: PipelineStub = {
    listCalls: [],
    previewCalls: [],
    commitCalls: [],
    order: [],
    pipeline: {
      async list(request) {
        stub.listCalls.push(request);
        stub.order.push("list");
        return opts.listing ?? listing([descriptor({})]);
      },
      async preview(request) {
        stub.previewCalls.push(request);
        stub.order.push("preview");
        return opts.preview ?? report();
      },
      async commit(request, runtime, confirmationToken) {
        stub.commitCalls.push({ request, runtime, confirmationToken });
        stub.order.push("commit");
        opts.onCommit?.(request, runtime, confirmationToken);
        return opts.landing ?? landing();
      },
    },
  };
  return stub;
}

function stubUi(answers: UserChoice[] = []): {
  ui: PiUi;
  blocks: string[][];
  asked: string[];
} {
  const blocks: string[][] = [];
  const asked: string[] = [];
  const queue = [...answers];
  return {
    blocks,
    asked,
    ui: {
      show(lines) {
        blocks.push([...lines]);
      },
      async confirm(question) {
        asked.push(question);
        return queue.shift() ?? "cancelled";
      },
    },
  };
}

function stubPicker(result: PickResult): {
  picker: SessionPicker;
  calls: Listing[];
} {
  const calls: Listing[] = [];
  return {
    calls,
    picker: {
      async pick(given) {
        calls.push(given);
        return result;
      },
    },
  };
}

function keyPicker(sequence: PickerKey[], ui: PiUi): SessionPicker {
  let index = 0;
  return createKeyPicker({
    ui,
    keys: {
      async next() {
        const key = sequence[index];
        index += 1;
        return key ?? null;
      },
    },
  });
}

interface ContextStub {
  ctx: PiCommandContext;
  sendMessage: ReturnType<typeof vi.fn>;
  runTool: ReturnType<typeof vi.fn>;
  switches: { path: string; options: PiSwitchOptions }[];
}

function stubContext(over: { cwd?: string; home?: string } = {}): ContextStub {
  const sendMessage = vi.fn();
  const runTool = vi.fn();
  const switches: { path: string; options: PiSwitchOptions }[] = [];
  const ctx = {
    cwd: over.cwd ?? "/repo",
    home: over.home ?? "/Users/me/.pi",
    async switchSession(path: string, options: PiSwitchOptions) {
      switches.push({ path, options });
      options.withSession();
      return { cancelled: false };
    },
    // Not part of PiCommandContext. Present only so the tests can prove the
    // module never reaches for a way to send something (FR-46, FR-48).
    sendMessage,
    runTool,
  };
  return { ctx, sendMessage, runTool, switches };
}

function deps(over: Partial<ResumeFromDeps> & { picker: SessionPicker; ui: PiUi }): ResumeFromDeps {
  return {
    picker: over.picker,
    ui: over.ui,
    windowTokens: over.windowTokens ?? PI_WINDOW,
  };
}

// ---------------------------------------------------------------- unit tests

describe("T-PIX-1 — no argument opens the picker", () => {
  it("lists and opens the picker over the result", async () => {
    const rows = [row("codex", "cx-1", "/Users/me/.codex")];
    const pipeline = stubPipeline({ listing: listing(rows) });
    const picked = stubPicker({ choice: "cancelled", selected: null });
    const ui = stubUi();
    const { ctx } = stubContext();

    await createResumeFromCommand(deps({ picker: picked.picker, ui: ui.ui })).run(
      ctx,
      [],
      pipeline.pipeline,
    );

    expect(pipeline.listCalls).toHaveLength(1);
    expect(picked.calls).toEqual([listing(rows)]);
  });
});

describe("command help", () => {
  it.each(["help", "-h", "--help"])("shows expected parameters for %s", async (argument) => {
    const pipeline = stubPipeline();
    const picked = stubPicker({ choice: "cancelled", selected: null });
    const ui = stubUi();
    const { ctx } = stubContext();

    await createResumeFromCommand(deps({ picker: picked.picker, ui: ui.ui })).run(
      ctx,
      [argument],
      pipeline.pipeline,
    );

    expect(ui.blocks.flat().join("\n")).toContain(
      "Usage: /resume-from [<session-id> | <file-path>]",
    );
    expect(ui.blocks.flat().join("\n")).toContain("No argument opens the session selector.");
    expect(pipeline.order).toEqual([]);
    expect(picked.calls).toEqual([]);
  });
});

describe("T-PIX-4 — Escape cancels", () => {
  it("never previews and never commits when the picker is cancelled", async () => {
    const pipeline = stubPipeline();
    const ui = stubUi();
    const { ctx } = stubContext();
    const picker = keyPicker(["escape"], ui.ui);

    await createResumeFromCommand(deps({ picker, ui: ui.ui })).run(ctx, [], pipeline.pipeline);

    expect(pipeline.previewCalls).toEqual([]);
    expect(pipeline.commitCalls).toEqual([]);
  });
});

describe("T-PIX-5 — an argument skips the picker", () => {
  const cases: {
    name: string;
    argument: string;
    selection: ImportRequest["selection"];
  }[] = [
    {
      name: "a session ID",
      argument: "cx-1",
      selection: { by: "session-id", id: "cx-1" },
    },
    {
      name: "an absolute file path",
      argument: "/Users/me/.codex/sessions/cx-1.jsonl",
      selection: {
        by: "file-path",
        path: "/Users/me/.codex/sessions/cx-1.jsonl",
      },
    },
  ];

  it.each(cases)("$name previews without a picker", async ({ argument, selection }) => {
    const pipeline = stubPipeline();
    const picked = stubPicker({ choice: "cancelled", selected: null });
    const ui = stubUi(["cancelled"]);
    const { ctx } = stubContext();

    await createResumeFromCommand(deps({ picker: picked.picker, ui: ui.ui })).run(
      ctx,
      [argument],
      pipeline.pipeline,
    );

    expect(picked.calls).toEqual([]);
    expect(pipeline.listCalls).toEqual([]);
    expect(pipeline.previewCalls).toHaveLength(1);
    expect(pipeline.previewCalls[0]?.selection).toEqual(selection);
  });
});

describe("T-PIX-6 — the target is the Pi home the user is in", () => {
  it("uses the context home and the context directory in every request", async () => {
    const pipeline = stubPipeline();
    const picked = stubPicker({ choice: "cancelled", selected: null });
    const ui = stubUi(["selected"]);
    const { ctx } = stubContext({
      home: "/Users/me/.pi-work",
      cwd: "/work/repo",
    });

    await createResumeFromCommand(deps({ picker: picked.picker, ui: ui.ui })).run(
      ctx,
      ["cx-1"],
      pipeline.pipeline,
    );

    const request = pipeline.previewCalls[0];
    expect(request?.target).toEqual({
      agent: "pi",
      home: "/Users/me/.pi-work",
      windowTokens: PI_WINDOW,
    });
    expect(request?.destinationCwd).toBe("/work/repo");
    expect(pipeline.commitCalls[0]?.request.target.home).toBe("/Users/me/.pi-work");
  });
});

// ------------------------------------------------- integration contract tests

describe("T-PIX-7 — the preview is shown verbatim", () => {
  it("shows exactly PreviewReport.lines, in order, as one unmodified block", async () => {
    const lines = ["From codex /Users/me/.codex", "Budget: 34k tokens of a 200k window", "! repo"];
    const pipeline = stubPipeline({ preview: report({ lines }) });
    const picked = stubPicker({ choice: "cancelled", selected: null });
    const ui = stubUi(["cancelled"]);
    const { ctx } = stubContext();

    await createResumeFromCommand(deps({ picker: picked.picker, ui: ui.ui })).run(
      ctx,
      ["cx-1"],
      pipeline.pipeline,
    );

    expect(ui.blocks).toContainEqual(lines);
  });
});

describe("T-PIX-8 — confirmation commits, cancellation does not", () => {
  const cases: { name: string; answer: UserChoice; commits: number }[] = [
    { name: "the user confirms", answer: "selected", commits: 1 },
    { name: "the user cancels", answer: "cancelled", commits: 0 },
  ];

  it.each(cases)("$name", async ({ answer, commits }) => {
    const pipeline = stubPipeline();
    const picked = stubPicker({ choice: "cancelled", selected: null });
    const ui = stubUi([answer]);
    const { ctx } = stubContext();

    await createResumeFromCommand(deps({ picker: picked.picker, ui: ui.ui })).run(
      ctx,
      ["cx-1"],
      pipeline.pipeline,
    );

    expect(ui.asked).toHaveLength(1);
    expect(pipeline.commitCalls).toHaveLength(commits);
    if (commits === 1) {
      expect(pipeline.commitCalls[0]?.confirmationToken).toBe(report().confirmationToken);
    }
  });
});

describe("T-PIX-9 — the runtime handle is Pi's own context", () => {
  it("passes the very PiCommandContext instance Pi supplied", async () => {
    const pipeline = stubPipeline();
    const picked = stubPicker({ choice: "cancelled", selected: null });
    const ui = stubUi(["selected"]);
    const { ctx } = stubContext();

    await createResumeFromCommand(deps({ picker: picked.picker, ui: ui.ui })).run(
      ctx,
      ["cx-1"],
      pipeline.pipeline,
    );

    expect(pipeline.commitCalls[0]?.runtime).toBe(ctx);
  });
});

describe("T-PIX-10 — landing presentation respects Pi's session lifecycle", () => {
  it("leaves marker presentation to the new extension instance after switching", async () => {
    const result = landing({ switched: true, handover: null });
    const pipeline = stubPipeline({ landing: result });
    const picked = stubPicker({ choice: "cancelled", selected: null });
    const ui = stubUi(["selected"]);
    const { ctx } = stubContext();

    await createResumeFromCommand(deps({ picker: picked.picker, ui: ui.ui })).run(
      ctx,
      ["cx-1"],
      pipeline.pipeline,
    );

    expect(ui.blocks).not.toContainEqual(result.marker.lines);
  });

  it("does not reuse the old UI after switching sessions", async () => {
    let stale = false;
    const ui: PiUi = {
      show() {
        if (stale) throw new Error("stale command context");
      },
      async confirm() {
        return "selected";
      },
    };
    const pipeline = stubPipeline({
      landing: landing({ switched: true, handover: null }),
      onCommit: () => {
        stale = true;
      },
    });
    const { ctx } = stubContext();

    await expect(
      createResumeFromCommand(
        deps({
          picker: stubPicker({ choice: "cancelled", selected: null }).picker,
          ui,
        }),
      ).run(ctx, ["cx-1"], pipeline.pipeline),
    ).resolves.toBeUndefined();
  });

  it("shows the session ID and the command that opens it when the switch did not happen", async () => {
    const result = landing({
      switched: false,
      handover: { sessionId: "new-1", command: "pi --resume new-1" },
    });
    const pipeline = stubPipeline({ landing: result });
    const picked = stubPicker({ choice: "cancelled", selected: null });
    const ui = stubUi(["selected"]);
    const { ctx } = stubContext();

    await createResumeFromCommand(deps({ picker: picked.picker, ui: ui.ui })).run(
      ctx,
      ["cx-1"],
      pipeline.pipeline,
    );

    const shown = ui.blocks.flat().join("\n");
    expect(ui.blocks).toContainEqual(result.marker.lines);
    expect(shown).toContain("new-1");
    expect(shown).toContain("pi --resume new-1");
  });
});

// ---------------------------------------------------------------- boundary tests

describe("T-PIX-11 — nothing is written on any cancel path", () => {
  async function checksum(dir: string): Promise<string> {
    const entries = await readdir(dir, {
      withFileTypes: true,
      recursive: true,
    });
    const paths = entries
      .map((entry) => ({
        full: join(entry.parentPath, entry.name),
        directory: entry.isDirectory(),
      }))
      .sort((a, b) => (a.full < b.full ? -1 : 1));
    const parts: string[] = [];
    for (const entry of paths) {
      parts.push(
        entry.directory
          ? `d:${entry.full}`
          : `f:${entry.full}:${await readFile(entry.full, "utf8")}`,
      );
    }
    return createHash("sha256").update(parts.join("\n")).digest("hex");
  }

  it("leaves the Pi home identical after a picker cancel and after a preview cancel", async () => {
    const home = await mkdtemp(join(tmpdir(), "resume-from-pix-"));
    try {
      await writeFile(join(home, "config.json"), '{"home":"pi"}');
      const before = await checksum(home);

      const atPicker = stubPipeline();
      const uiPicker = stubUi();
      await createResumeFromCommand(
        deps({
          picker: stubPicker({ choice: "cancelled", selected: null }).picker,
          ui: uiPicker.ui,
        }),
      ).run(stubContext({ home }).ctx, [], atPicker.pipeline);
      const afterPickerCancel = await checksum(home);

      const atPreview = stubPipeline();
      const uiPreview = stubUi(["cancelled"]);
      await createResumeFromCommand(
        deps({
          picker: stubPicker({ choice: "selected", selected: descriptor({}) }).picker,
          ui: uiPreview.ui,
        }),
      ).run(stubContext({ home }).ctx, [], atPreview.pipeline);
      const afterPreviewCancel = await checksum(home);

      expect(afterPickerCancel).toBe(before);
      expect(afterPreviewCancel).toBe(before);
      expect(atPicker.commitCalls).toEqual([]);
      expect(atPreview.commitCalls).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("T-PIX-12 — a blocked preview offers no confirmation", () => {
  it("shows the reason, asks nothing and never commits", async () => {
    const blocked = report({
      blocked: true,
      blockedReason: "The repository has uncommitted changes",
      lines: ["From codex, into pi", "Blocked"],
    });
    const pipeline = stubPipeline({ preview: blocked });
    const picked = stubPicker({ choice: "cancelled", selected: null });
    const ui = stubUi(["selected"]);
    const { ctx } = stubContext();

    await createResumeFromCommand(deps({ picker: picked.picker, ui: ui.ui })).run(
      ctx,
      ["cx-1"],
      pipeline.pipeline,
    );

    expect(ui.blocks).toContainEqual(blocked.lines);
    expect(ui.blocks.flat().join("\n")).toContain("The repository has uncommitted changes");
    expect(ui.asked).toEqual([]);
    expect(pipeline.commitCalls).toEqual([]);
  });
});

describe("T-PIX-13 — an empty listing does not open a picker", () => {
  it("names the repository and opens no picker", async () => {
    const pipeline = stubPipeline({ listing: listing([]) });
    const picked = stubPicker({ choice: "cancelled", selected: null });
    const ui = stubUi();
    const { ctx } = stubContext({ cwd: "/work/repo" });

    await createResumeFromCommand(deps({ picker: picked.picker, ui: ui.ui })).run(
      ctx,
      [],
      pipeline.pipeline,
    );

    expect(picked.calls).toEqual([]);
    expect(ui.blocks.flat().join("\n")).toContain("/work/repo");
    expect(pipeline.previewCalls).toEqual([]);
    expect(pipeline.commitCalls).toEqual([]);
  });
});

describe("T-PIX-14 — discovery failures are shown", () => {
  it("reports a session exclusion without claiming its home was skipped", async () => {
    const home = "/Users/me/.claude-team";
    const rows = [row("claude-code", "accepted", home)];
    const failure: HomeFailure = {
      home,
      agent: "claude-code",
      message: "session excluded has conflicting repository identity evidence",
    };
    const sessions = listing(rows, [failure]);
    const pipeline = stubPipeline({ listing: sessions });
    const picked = stubPicker({ choice: "cancelled", selected: null });
    const ui = stubUi();
    const { ctx } = stubContext();

    await createResumeFromCommand(deps({ picker: picked.picker, ui: ui.ui })).run(
      ctx,
      [],
      pipeline.pipeline,
    );

    expect(ui.blocks.flat()).toContain(`claude-code ${home}: ${failure.message}`);
    expect(ui.blocks.flat().join("\n")).not.toContain("Skipped claude-code home");
    expect(picked.calls).toEqual([sessions]);
  });

  it("shows every failure alongside the picker", async () => {
    const failures: HomeFailure[] = [
      {
        home: "/Users/me/.codex",
        agent: "codex",
        message: "permission denied",
      },
      {
        home: "/Users/me/.claude-team",
        agent: "claude-code",
        message: "not a directory",
      },
    ];
    const rows = [row("pi", "pi-1", "/Users/me/.pi")];
    const pipeline = stubPipeline({ listing: listing(rows, failures) });
    const picked = stubPicker({ choice: "cancelled", selected: null });
    const ui = stubUi();
    const { ctx } = stubContext();

    await createResumeFromCommand(deps({ picker: picked.picker, ui: ui.ui })).run(
      ctx,
      [],
      pipeline.pipeline,
    );

    const shown = ui.blocks.flat().join("\n");
    for (const failure of failures) {
      expect(shown).toContain(failure.home);
      expect(shown).toContain(failure.message);
    }
    expect(picked.calls).toHaveLength(1);
  });

  it("summarizes non-member sessions as one count, not one line each", async () => {
    const sessions: Listing = {
      rows: [row("pi", "pi-1", "/Users/me/.pi")],
      failures: [],
      excluded: 112,
    };
    const pipeline = stubPipeline({ listing: sessions });
    const picked = stubPicker({ choice: "cancelled", selected: null });
    const ui = stubUi();
    const { ctx } = stubContext();

    await createResumeFromCommand(deps({ picker: picked.picker, ui: ui.ui })).run(
      ctx,
      [],
      pipeline.pipeline,
    );

    const shown = ui.blocks.flat().join("\n");
    expect(shown).toContain("112 sessions do not belong to this repository and were not listed.");
    expect(picked.calls).toHaveLength(1);
  });
});

describe("T-PIX-16 — nothing is sent after landing", () => {
  it("sends no message and runs no tool, including from the withSession callback", async () => {
    const context = stubContext();
    const pipeline = stubPipeline({
      onCommit: (_request, runtime) => {
        // The adapter — not this module — is what calls switchSession.
        void (runtime as PiSwitchContext).switchSession("/Users/me/.pi/sessions/new-1.json", {
          withSession: () => {},
        });
      },
    });
    const picked = stubPicker({ choice: "cancelled", selected: null });
    const ui = stubUi(["selected"]);

    await createResumeFromCommand(deps({ picker: picked.picker, ui: ui.ui })).run(
      context.ctx,
      ["cx-1"],
      pipeline.pipeline,
    );

    expect(context.switches).toHaveLength(1);
    expect(context.sendMessage).not.toHaveBeenCalled();
    expect(context.runTool).not.toHaveBeenCalled();
    expect(pipeline.order).toEqual(["preview", "commit"]);
  });
});

// ---------------------------------------------------------------- behavior tests

describe("T-PIX-19 — pick, confirm, hand the context over", () => {
  it("commits once with Pi's own context and stays silent after the switch", async () => {
    const rows = [
      row("pi", "pi-1", "/Users/me/.pi"),
      row("claude-code", "cc-1", "/Users/me/.claude-team"),
      row("codex", "cx-1", "/Users/me/.codex"),
      row("pi", "pi-2", "/Users/me/.pi"),
    ];
    const result = landing({ switched: true });
    const pipeline = stubPipeline({ listing: listing(rows), landing: result });
    const ui = stubUi(["selected"]);
    const context = stubContext();
    const picker = keyPicker(["down", "down", "enter"], ui.ui);

    await createResumeFromCommand(deps({ picker, ui: ui.ui })).run(
      context.ctx,
      [],
      pipeline.pipeline,
    );

    expect(pipeline.order).toEqual(["list", "preview", "commit"]);
    expect(pipeline.previewCalls[0]?.selection).toEqual({
      by: "file-path",
      path: "/Users/me/.codex/sessions/cx-1.json",
    });
    expect(pipeline.commitCalls).toHaveLength(1);
    expect(pipeline.commitCalls[0]?.runtime).toBe(context.ctx);
    expect(ui.blocks).not.toContainEqual(result.marker.lines);
    expect(context.sendMessage).not.toHaveBeenCalled();
    expect(context.runTool).not.toHaveBeenCalled();
  });
});

describe("T-PIX-20 — a cancelled switch is not a loss", () => {
  it("tells the user the session exists and how to open it, and retries nothing", async () => {
    const result = landing({
      switched: false,
      handover: { sessionId: "new-7", command: "pi --resume new-7" },
    });
    const pipeline = stubPipeline({
      listing: listing([row("codex", "cx-1", "/Users/me/.codex")]),
      landing: result,
    });
    const ui = stubUi(["selected"]);
    const context = stubContext();
    const picker = keyPicker(["enter"], ui.ui);

    await createResumeFromCommand(deps({ picker, ui: ui.ui })).run(
      context.ctx,
      [],
      pipeline.pipeline,
    );

    const shown = ui.blocks.flat().join("\n");
    expect(shown).toContain("new-7");
    expect(shown).toContain("pi --resume new-7");
    expect(ui.blocks).toContainEqual(result.marker.lines);
    expect(pipeline.order).toEqual(["list", "preview", "commit"]);
    expect(context.sendMessage).not.toHaveBeenCalled();
  });
});

describe("pipeline failure diagnostics", () => {
  it.each(["list", "preview", "commit"] as const)(
    "shows one sanitized %s failure and stops without a false write-status claim",
    async (stage) => {
      const pipeline = stubPipeline();
      const failure = new Error(
        "ambiguous repository\n\u001b[31mCheck recorded directories; recover with pi --session /saved",
      );
      pipeline.pipeline[stage] = vi.fn().mockRejectedValue(failure);
      const ui = stubUi(["selected"]);
      const picked = stubPicker({ choice: "selected", selected: descriptor() });
      const { ctx, switches } = stubContext();
      await createResumeFromCommand(deps({ picker: picked.picker, ui: ui.ui })).run(
        ctx,
        stage === "list" ? [] : ["s-1"],
        pipeline.pipeline,
      );
      const diagnostics = ui.blocks.flat().filter((line) => line.includes("ambiguous repository"));
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain(
        "Check recorded directories; recover with pi --session /saved",
      );
      expect(diagnostics[0]).not.toContain("\n");
      expect(diagnostics[0]).not.toContain("\u001b");
      expect(ui.blocks.flat().join("\n")).not.toContain("Nothing was written");
      expect(pipeline.commitCalls).toEqual([]);
      expect(switches).toEqual([]);
      expect(ui.asked).toHaveLength(stage === "commit" ? 1 : 0);
      expect(picked.calls).toEqual([]);
    },
  );

  it.each([false, true])(
    "propagates cancellation (wrapped: %s) rather than presenting it as a failure",
    async (wrapped) => {
      const pipeline = stubPipeline();
      const cancellation = new Error("cancelled", { cause: "user" });
      cancellation.name = "AbortError";
      const failure = wrapped ? new Error("preview failed", { cause: cancellation }) : cancellation;
      pipeline.pipeline.preview = vi.fn().mockRejectedValue(failure);
      const ui = stubUi();
      const picked = stubPicker({ choice: "cancelled", selected: null });
      await expect(
        createResumeFromCommand(deps({ picker: picked.picker, ui: ui.ui })).run(
          stubContext().ctx,
          ["s-1"],
          pipeline.pipeline,
        ),
      ).rejects.toBe(failure);
      expect(ui.blocks).toEqual([]);
      expect(ui.asked).toEqual([]);
    },
  );
});
