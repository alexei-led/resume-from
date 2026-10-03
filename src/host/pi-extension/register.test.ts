import { describe, expect, it } from "vitest";
import { RESUME_FROM_COMMAND_NAME } from "./command.js";
import type { ImportPipeline, PiCommandContext, SessionPicker } from "./contract.js";
import { type PiCommandDefinition, registerResumeFrom } from "./register.js";
import type { PiUi } from "./ui.js";

describe("registration", () => {
  it("registers /resume-from and routes it to the command handler", async () => {
    const registered: PiCommandDefinition[] = [];
    const listed: string[] = [];
    const picker: SessionPicker = {
      async pick() {
        return { choice: "cancelled", selected: null };
      },
    };
    const ui: PiUi = {
      show() {},
      async confirm() {
        return "cancelled";
      },
    };
    const pipeline: ImportPipeline = {
      async list(request) {
        listed.push(request.destinationCwd);
        return { rows: [], failures: [], excluded: 0 };
      },
      async preview() {
        throw new Error("not reached");
      },
      async commit() {
        throw new Error("not reached");
      },
    };
    const ctx: PiCommandContext = {
      cwd: "/repo",
      home: "/Users/me/.pi",
      async switchSession() {
        return { cancelled: false };
      },
    };

    registerResumeFrom(
      { registerCommand: (definition) => registered.push(definition) },
      { picker, ui, windowTokens: 200_000, pipeline },
    );
    await registered[0]?.run(ctx, []);

    expect(registered).toHaveLength(1);
    expect(registered[0]?.name).toBe(RESUME_FROM_COMMAND_NAME);
    expect(listed).toEqual(["/repo"]);
  });
});
