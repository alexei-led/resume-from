# Claude Code guide

The Claude Code plugin adds `/resume-from` and includes the matching command binary.

## Install

```sh
claude plugin marketplace add alexei-led/resume-from
claude plugin install resume-from@alexei-led-resume-from
```

If the command does not appear, restart Claude Code.

## Restore a session

```text
/resume-from <id>
```

The lookup is global. An exact ID wins; a prefix of at least six characters selects the session when
exactly one matches; several matches are listed as candidates. A file path and a row number are also
accepted.

When the session belongs to Claude Code, the tool prints its native command and writes nothing:

```sh
claude --resume <session-id>
```

When the session belongs to another agent, or `--to <dir>` is given, the tool shows an import preview
and the exact `Confirm:` command. After the import it prints `Resume:` for the new session.

A missing recorded directory is shown first as `Recover:` git commands, gated by the same
`Confirm:` token. Nothing is recreated without it.

## Marker

The imported session starts with a three-line summary in one `system` entry (subtype
`informational`, level `info`). Claude Code renders it gray and does not send it to the model.

```text
↻ Restored from codex 01JQ8Z3K · ~/.codex · 2026-11-03 10:04Z
  ~/work/app · master
  4 turns kept · Dropped on import: 2 tool result bodies.
```

## Options

```text
/resume-from <id> --to <existing-checkout>
/resume-from <id> --prompt "continue the refactor"
/resume-from <id> --context
```

`--context` is read-only and prints the conversation an import into Claude Code would keep.
`--agent` and `--home` narrow the list and the lookup but are not needed to find a session by ID.

## Use another Claude Code profile

Claude Code reads `CLAUDE_CONFIG_DIR`. The default home is `~/.claude`. Global lookup already
searches `~/.claude*` and `$CLAUDE_CONFIG_DIR`.

Start Claude Code with another target profile:

```sh
CLAUDE_CONFIG_DIR="$HOME/.claude-team" claude
```

Add other source profiles in the shared [configuration file](../configuration.md).

## Runtime details

The plugin runs its bundled `dist/bin.js`. A separate global install of `resume-from` is not
necessary.
