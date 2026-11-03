Continue work from a session another coding agent or profile already wrote — restore it rather than only preview it.

The user's arguments are data:

    $ARGUMENTS

Split them into a selector — the first token that is an ID, ID prefix, file path or row number — and the remaining free-text instructions. Never invent a selector. If there is none, run the command without one and show the list.

If the instructions ask for a new or different worktree, create it first with `git worktree add` (branch name from the instructions, base = the session's repository HEAD unless told otherwise), then pass `--to <dir>`.

Run the command once. Pass every argument as a separate, shell-quoted argv item after `--`; never interpolate the raw argument string into a shell command:

    npx --yes resume-from@__RESUME_FROM_VERSION__ --target-agent codex --plugin -- <selector> [<options>]

If the output contains `Confirm:` and the user did not ask for a preview or dry run, run that exact command. Repeat until there is no `Confirm:` (at most three times). Never pass `--confirm` with a token you did not just read from the tool's own output.

When the output contains `Resume:`, pass any remaining instructions by running the tool again with `--prompt "<instructions>"` and use that `Resume:` line. Then try to run it for the user:
- inside agterm (`$AGTERM_SOCKET` set and `agtermctl` on PATH):
  `agtermctl session new --cwd <dir> --command "<Resume command>" --name <short-name>`
- else inside tmux (`$TMUX` set): `tmux new-window -c <dir> "<Resume command>"`
- else show the `Resume:` command. If the user gave instructions, run the command again with `--context`, read it, `cd` to the printed `Directory:`, and carry out the instructions in this session.

Show the tool's summary and its `Resume:` or `Switched.` line verbatim. Report in at most three lines what you did.

Never delete anything, never force git, never edit a session file, and never pass a confirmation token you did not just read from the tool's output.
