import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

const SHIMS = ["shims/claude-code/commands/resume-from.md", "shims/codex/skills/resume-from/SKILL.md"];

test.each(SHIMS)("%s restores the session instead of only previewing it", async (path) => {
  const text = await readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
  for (const required of [
    "Split them into a selector",
    "git worktree add",
    "--to <dir>",
    "shell-quoted argv item after `--`",
    "`Confirm:`",
    "`Resume in place:`",
    "`Resume:`",
    "`Switched.`",
    "Do not start a new terminal",
    "keeps this process's launch settings",
    '--prompt "<instructions>"',
    "verbatim",
    "Never delete anything, never force git, never edit a session file",
    "Never pass `--confirm` with a token you did not just read",
  ]) {
    expect(text).toContain(required);
  }
  expect(text).not.toMatch(/(?:node|npx|resume-from).*\$ARGUMENTS/u);
  expect(text).not.toContain("agtermctl");
  expect(text).not.toContain("tmux new-window");
});

test("the Claude command allows the tools the steps need", async () => {
  const text = await readFile(
    new URL("../../../shims/claude-code/commands/resume-from.md", import.meta.url),
    "utf8",
  );
  const allowed = /^allowed-tools: (.+)$/mu.exec(text)?.[1] ?? "";
  for (const tool of ["node", "npx", "git"]) {
    expect(allowed).toContain(`Bash(${tool}`);
  }
  for (const tool of ["agtermctl", "tmux"]) {
    expect(allowed).not.toContain(`Bash(${tool}`);
  }
});

test("the Claude command preserves the target profile", async () => {
  const text = await readFile(
    new URL("../../../shims/claude-code/commands/resume-from.md", import.meta.url),
    "utf8",
  );
  expect(text).toContain("--target-home");
  expect(text).toContain("CLAUDE_CONFIG_DIR:-$HOME/.claude");
});

test("the Codex skill keeps the pinned package prefix", async () => {
  const text = await readFile(
    new URL("../../../shims/codex/skills/resume-from/SKILL.md", import.meta.url),
    "utf8",
  );
  expect(text).toContain("npx --yes resume-from@__RESUME_FROM_VERSION__ --target-agent codex --");
});

test.each(SHIMS)("%s offers an existing directory as well as a new worktree", async (path) => {
  const text = await readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
  expect(text).toContain("git worktree add");
  expect(text).toContain("if they name an existing directory, use that directory");
});

test.each(SHIMS)("%s makes Confirm a re-run of the same invocation", async (path) => {
  const text = await readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
  expect(text).toContain("Re-run the SAME");
  expect(text).toContain("do not paste that line into a shell");
  expect(text).toContain("--confirm <token>");
});
