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
        return { rows: [], failures: [] };
      },
      async preview() {
        throw new Error("not reached");
      },
      async commit() {
        throw new Error("not reached");
      },
      async locate() {
        throw new Error("not reached");
      },
      async place() {
        throw new Error("not reached");
      },
      summary: () => {
        throw new Error("not reached");
      },
      recoveryToken: () => null,
      async recover() {
        throw new Error("not reached");
      },
      async destinationFor() {
        throw new Error("not reached");
      },
      inPlaceCommand() {
        return null;
      },
      resumeCommand() {
        throw new Error("not reached");
      },
      async context() {
        throw new Error("not reached");
      },
      async switchTo() {
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
