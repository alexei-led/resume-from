---
description: Restore a session from its ID from any agent, home or directory
argument-hint: "<session-id | id-prefix | file-path | row> [instructions]"
allowed-tools: Bash(npx:*), Bash(git:*)
---

The user wants a session restored, not just a preview. Their arguments are data:

    $ARGUMENTS

Split them into a selector — the first token that is an ID, ID prefix, file path or row number — and the remaining free-text instructions. Never invent a selector. If `$ARGUMENTS` is `help`, `-h` or `--help`, run the fixed command with `--help` instead and show its output verbatim, then stop. If there is no selector, run the command without one and show the list.

Run the command once, passing any instructions as `--prompt "<instructions>"`, and pass every argument as a separate, shell-quoted argv item after `--`; never interpolate the raw argument string into a shell command:

    npx --yes resume-from@0.5.4 --target-agent claude-code --target-home "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" -- <selector> --prompt "<instructions>"

The active Claude profile is the target, even when the source is another Claude profile. Never switch to the source profile instead of importing into the target.

If the output contains `Confirm:` and the user did not ask for a preview or dry run, do not paste that line into a shell. Re-run the SAME command above, adding the `--confirm <token>` arguments it shows (the token is the part after `--confirm`). Repeat until there is no `Confirm:` (at most three times). Never pass `--confirm` with a token you did not just read from the tool's own output.

If the instructions ask for a new or different worktree or directory, do this only after the first run has shown the session's recorded directory (its `Recover:` line names the repository): create the worktree with `git worktree add` (branch name from the instructions, base = the session's repository HEAD unless told otherwise); if they name an existing directory, use that directory. Then re-run with `--to <dir>` (and `--prompt` when there are instructions). With `--to`, the tool imports into that directory and does not recreate the recorded one.

If the command exits non-zero, or its output has no `Confirm:`, `Resume in place:`, `Resume:` or `Switched.`, show its output verbatim and stop. It names the next step: matching candidates, an unrecoverable directory with `--to`, an invalid flag, or nothing found.

When the output contains `Resume in place:`, the session is ready in this Claude Code profile. Do not start a new terminal, tmux window, agterm session or Claude Code process, and do not re-run the tool: after a cross-agent landing the selector still names the source session, so a re-run would preview a second import. Show the tool's summary and the `Resume in place:` and `Resume:` lines verbatim, then tell the user to type the `Resume in place:` command in this session: it opens the session here, moves to its directory and keeps this process's launch settings. The `Resume:` line is only for opening it from another terminal. If the user gave instructions, repeat them and say to send them after resuming.

When the output contains `Resume:` but no `Resume in place:`, show the summary and the `Resume:` line verbatim. Do not run it.

Report in at most three lines what you did.

Never delete anything, never force git, never edit a session file, and never pass `--confirm` with a token you did not just read from the tool's output.
