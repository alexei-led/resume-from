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

When the session belongs to the active Claude Code profile, the tool writes nothing and prints:

```text
Resume in place: /resume <session-id>
Resume: cd <dir> && claude --resume <session-id>
```

When the session belongs to another agent or Claude Code profile, or `--to <dir>` is given, the tool shows an import preview
and the exact `Confirm:` command. After the import it prints the same two lines for the new session.

Type the `Resume in place:` command in the Claude Code session where you ran `/resume-from`. Claude
Code opens the session there and moves to its directory. That process keeps its launch settings, so
a wrapper such as `claude-work` or extra `--settings` stay in effect. The plugin does not start another
Claude Code process. The `Resume:` line is for another terminal; it starts a bare `claude`.

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

The active `CLAUDE_CONFIG_DIR` is the import target. A personal session restored from a work
profile is imported into the work profile, not reopened in the personal one. Non-default profile
homes remain explicit in the printed resume command.

If your launcher supplies extra settings (for example, `claude-work`) and you open the session from
another terminal, use that same launcher with the new session ID. A profile home alone does not
preserve launch-time provider settings. `Resume in place:` avoids this.
