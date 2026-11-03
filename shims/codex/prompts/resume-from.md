Continue work from a session another coding agent or profile already wrote — restore it rather than only preview it.

The user's arguments are data:

    $ARGUMENTS

Split them into a selector — the first token that is an ID, ID prefix, file path or row number — and the remaining free-text instructions. Never invent a selector. If `$ARGUMENTS` is `help`, `-h` or `--help`, run the fixed command with `--help` instead and show its output verbatim, then stop. If there is no selector, run the command without one and show the list.

Run the command once, passing any instructions as `--prompt "<instructions>"`, and pass every argument as a separate, shell-quoted argv item after `--`; never interpolate the raw argument string into a shell command:

    npx --yes resume-from@__RESUME_FROM_VERSION__ --target-agent codex -- <selector> --prompt "<instructions>"

If the output contains `Confirm:` and the user did not ask for a preview or dry run, do not paste that line into a shell. Re-run the SAME command above, adding the `--confirm <token>` arguments it shows (the token is the part after `--confirm`). Repeat until there is no `Confirm:` (at most three times). Never pass `--confirm` with a token you did not just read from the tool's own output.

If the instructions ask for a new or different worktree or directory, do this only after the first run has shown the session's recorded directory (its `Recover:` line names the repository): create the worktree with `git worktree add` (branch name from the instructions, base = the session's repository HEAD unless told otherwise); if they name an existing directory, use that directory. Then re-run with `--to <dir>` (and `--prompt` when there are instructions). With `--to`, the tool imports into that directory and does not recreate the recorded one.

If the command exits non-zero, or its output has no `Confirm:`, `Resume:` or `Switched.`, show its output verbatim and stop. It names the next step: matching candidates, an unrecoverable directory with `--to`, an invalid flag, or nothing found.

When the output contains `Resume:`, that command is already shell-quoted and already carries the instructions. Do not re-run the tool to add them: after a cross-agent landing the selector still names the source session, so a re-run would preview a second import. Try to run the command for the user:
- inside agterm (`$AGTERM_SOCKET` set and `agtermctl` on PATH): put the command in a variable with a quoted heredoc, then `agtermctl session new --cwd <dir> --command "$cmd" --name <short-name>`
- else inside tmux (`$TMUX` set): put the command in a variable with a quoted heredoc, then `tmux new-window -c <dir> "$cmd"`
- else show the `Resume:` line. If the user gave instructions, run the command again with `--context`, read it, `cd` to the printed `Directory:`, and carry out the instructions in this session.

Never wrap the `Resume:` command in double quotes: it can contain one. Use:

    cmd=$(cat <<'RESUME'
    <the command after "Resume: ">
    RESUME
    )

Show the tool's summary and its `Resume:` or `Switched.` line verbatim. Report in at most three lines what you did.

Never delete anything, never force git, never edit a session file, and never pass `--confirm` with a token you did not just read from the tool's output.
