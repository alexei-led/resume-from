import { afterEach, describe, expect, it, vi } from "vitest";
import { HELP_TEXT, main, readShimArgs } from "./bin.js";

afterEach(() => vi.restoreAllMocks());

describe("command help", () => {
  it.each(["--help", "-h"])(
    "prints parameter help for %s without requiring a target",
    async (flag) => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const exitCode = await main([flag], "/repo");

      expect(exitCode).toBe(0);
      expect(stdout).toHaveBeenCalledWith(`${HELP_TEXT}\n`);
      expect(stderr).not.toHaveBeenCalled();
      expect(HELP_TEXT).toContain("<id-or-prefix>");
      expect(HELP_TEXT).toContain("<row>");
      expect(HELP_TEXT).toContain("<file-path>");
      expect(HELP_TEXT).toContain("--to");
      expect(HELP_TEXT).toContain("--prompt");
      expect(HELP_TEXT).toContain("--context");
      expect(HELP_TEXT).toContain("--confirm");
    },
  );

  it("reads a bare shell invocation as user arguments, with no target agent", () => {
    expect(readShimArgs(["dc601a22", "--prompt", "go on"])).toEqual({
      ok: true,
      value: {
        targetAgent: null,
        targetHome: null,
        plugin: false,
        rest: ["dc601a22", "--prompt", "go on"],
      },
    });
  });
});

describe("trusted shim arguments", () => {
  it("keeps every user argument after the delimiter untouched", () => {
    expect(
      readShimArgs([
        "--target-agent",
        "codex",
        "--target-home",
        "/home/with space",
        "--",
        "1",
        "--target-agent",
        "claude-code",
      ]),
    ).toEqual({
      ok: true,
      value: {
        targetAgent: "codex",
        targetHome: "/home/with space",
        plugin: false,
        rest: ["1", "--target-agent", "claude-code"],
      },
    });
  });

  it("records the plugin marker the installed host command passes", () => {
    expect(readShimArgs(["--target-agent", "codex", "--plugin", "--", "1"])).toEqual({
      ok: true,
      value: {
        targetAgent: "codex",
        targetHome: null,
        plugin: true,
        rest: ["1"],
      },
    });
  });

  it.each([
    ["duplicate target", ["--target-agent", "codex", "--target-agent", "pi", "--"]],
    ["missing value", ["--target-agent", "--"]],
    ["a target home with no target", ["--target-home", "/home/x", "--"]],
    ["a plugin marker with no target", ["--plugin", "--"]],
    ["duplicate plugin markers", ["--target-agent", "codex", "--plugin", "--plugin", "--"]],
  ])("rejects %s", (_name, argv) => {
    expect(readShimArgs(argv)).toMatchObject({ ok: false });
  });

  it("treats a missing delimiter as a bare shell, not an error", () => {
    expect(readShimArgs(["--target-agent", "codex"])).toEqual({
      ok: true,
      value: {
        targetAgent: null,
        targetHome: null,
        plugin: false,
        rest: ["--target-agent", "codex"],
      },
    });
  });
});
