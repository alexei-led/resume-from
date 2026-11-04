# Codex guide

The Codex plugin adds a `resume-from` skill. The skill runs the matching published command
package.

## Install

```sh
codex plugin marketplace add alexei-led/resume-from
codex plugin add resume-from@alexei-led-resume-from
```

Use Codex CLI or the Codex desktop application. The Codex IDE extension does not install plugins.

## Network requirement

The skill runs a pinned `resume-from` version through `npx --yes`. The first use needs access to the
npm registry. Later use can use the local npm cache.

## Restore a session

```text
$resume-from <id>
```

The lookup is global. An exact ID wins; a prefix of at least six characters selects the session when
exactly one matches; several matches are listed as candidates. A file path and a row number are also
accepted.

When the session belongs to the active Codex profile, the tool writes nothing and prints:

```text
Resume in place: /resume <thread-id>
Resume: cd <dir> && codex resume <thread-id>
```

When the session belongs to another agent or Codex profile, or `--to <dir>` is given, the tool shows an import preview
and the exact `Confirm:` command. After the import it prints the same two lines for the new thread.

Type the `Resume in place:` command in the Codex session where you ran `$resume-from`. Codex opens
the thread there and moves to its directory. The plugin does not start another Codex process. The
`Resume:` line is for another terminal.

A missing recorded directory is shown first as `Recover:` git commands, gated by the same
`Confirm:` token. Nothing is recreated without it.

## Marker

Codex has no verified entry that renders arbitrary gray text on resume, so the three-line summary is
printed in the command output only:

```text
↻ Restored from claude-code dc601a22 (~/.claude) · 2026-11-03 10:04Z
  ~/work/app · master
  4 turns kept · Dropped on import: 2 tool result bodies.
```

## Options

```text
$resume-from <id> --to <existing-checkout>
$resume-from <id> --prompt "continue the refactor"
$resume-from <id> --context
```

`--context` is read-only and prints the conversation an import into Codex would keep. `--agent` and
`--home` narrow the list and the lookup but are not needed to find a session by ID.

## Use another Codex home

Codex reads `CODEX_HOME`. The default home is `~/.codex`. Global lookup already searches `~/.codex*`
and `$CODEX_HOME`, including archived sessions from the last 14 days.

Start Codex with another target home:

```sh
CODEX_HOME="$HOME/.codex-work" codex
```

Add other source homes in the shared [configuration file](../configuration.md).
