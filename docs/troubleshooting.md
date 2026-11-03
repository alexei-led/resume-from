# Troubleshooting

## The command does not appear

Install the package in the target agent, then restart it. For Pi, `pi list` shows installed packages.
For Claude Code or Codex, open the plugin manager and make sure `resume-from` is enabled.

## A new release is not available on npm

A successful GitHub release does not mean that npm has made the packages available. npm scans new
versions before publication; scanning can delay availability or require manual review. A pinned
installation can return `404` during that time.

Check the core package version before retrying the install:

```sh
npm view resume-from@0.5.0 version
```

Claude Code and Codex also need their matching plugin packages:
`@alexeiled/resume-from-claude@0.5.0` and `@alexeiled/resume-from-codex@0.5.0`.

## No session matches the ID

An ID lookup is global, not repository-scoped. Check the value: an exact ID wins, and a prefix needs
at least six characters and exactly one match. Several matches are listed as candidates with agent,
home, directory, and last activity; select one by exact file path.

No match names the search roots that were tried. Start the agent that wrote the session once, or add
its home to `extraHomes`, so the file is under a known root. Unreadable homes are reported separately;
correct permissions rather than guessing a selector.

To list only the current repository's sessions, run `/resume-from` with no argument. `--agent` and
`--home` narrow both the list and the lookup.

## The recorded worktree was removed

`resume-from` finds the session by ID, then shows `Recover:` commands for the missing directory. Run
the exact `Confirm:` command the tool printed; recovery runs only with that token. If no parent
repository is found, the directory is unrecoverable and no restore runs. `--to <existing-checkout>`
can import the session elsewhere, with a warning, when the recorded directory is gone.

## The preview names another destination or rejects confirmation

`--to` must name an existing checkout of the session's repository. A token is bound to the session
file, directory, and exact commands; a token from another worktree or a changed preview is rejected.
Preview again in the directory you intend to use.

## The preview is blocked

The required content is larger than the import budget. No target file was written. Increase
`budgetShare`, reduce `pinnedRecentTurns`, or correct the target context-window size. See
[Configuration](configuration.md#change-the-import-budget).

## `nothing to import`

The source session has no turns that can cross over. A session that holds only slash commands — for
example one created by `/clear` — reads as empty. Choose a session that holds conversation.

## `--target-agent` is missing

The direct binary needs the target agent only for an import. Installed host commands supply it. A
bare shell without it prints the source agent's native resume command and writes nothing.

To import from a shell:

```sh
resume-from --target-agent codex --
```

Everything after `--` is the selection: a row number, session ID, or file path.

## Codex cannot reach npm

The Codex prompt uses a pinned package through `npx`. Make sure that the process can reach
`https://registry.npmjs.org`. If the network is restricted, install the core command once:

```sh
npm install --global resume-from
```

The npm cache can then satisfy the pinned `npx` command.

## The import is complete, but the agent did not switch

Claude Code and Codex create a new native session but cannot switch the current process. Run the
printed `Resume:` command from its directory with the same target profile. Pi switches in the current
process when the destination is its cwd.

## The configuration file fails to load

The file must contain valid JSON. Remove comments and trailing commas. Make sure that:

- `budgetShare` is greater than `0` and at most `1`.
- `pinnedRecentTurns` is a whole number of `0` or more.
- `windowTokens` is a whole number greater than `0`.
- Each agent is `pi`, `codex`, or `claude-code`.
