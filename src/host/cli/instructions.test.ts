import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

const SHIMS = ["shims/claude-code/commands/resume-from.md", "shims/codex/prompts/resume-from.md"];

test.each(SHIMS)("%s restores the session instead of only previewing it", async (path) => {
  const text = await readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
  for (const required of [
    "Split them into a selector",
    "git worktree add",
    "--to <dir>",
    "shell-quoted argv item after `--`",
    "`Confirm:`",
    "`Resume:`",
    "`Switched.`",
    "agtermctl session new",
    "tmux new-window",
    "`--context`",
    "verbatim",
    "Never delete anything, never force git, never edit a session file",
    "Never pass `--confirm` with a token you did not just read",
  ]) {
    expect(text).toContain(required);
  }
  expect(text).not.toMatch(/(?:node|npx|resume-from).*\$ARGUMENTS/u);
});

test("the Claude command allows the tools the steps need", async () => {
  const text = await readFile(
    new URL("../../../shims/claude-code/commands/resume-from.md", import.meta.url),
    "utf8",
  );
  const allowed = /^allowed-tools: (.+)$/mu.exec(text)?.[1] ?? "";
  for (const tool of ["node", "npx", "git", "agtermctl", "tmux"]) {
    expect(allowed).toContain(`Bash(${tool}`);
  }
});

test("the Codex prompt keeps the pinned package prefix", async () => {
  const text = await readFile(
    new URL("../../../shims/codex/prompts/resume-from.md", import.meta.url),
    "utf8",
  );
  expect(text).toContain("npx --yes resume-from@__RESUME_FROM_VERSION__ --target-agent codex --");
});
