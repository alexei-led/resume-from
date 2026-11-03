# Pi guide

Pi supplies the native session picker and can open a restored session without a restart.

## Install

Requires Pi 1.x starting at 1.0.2. The extension is tested with Pi 1.0.2. Claude Code and Codex
transfers do not depend on Pi.

```sh
pi install npm:resume-from
```

Restart Pi after the install. The package registers `/resume-from`.

## Restore a session

```text
/resume-from <id>
```

The lookup is global. An exact ID wins; a prefix of at least six characters selects the session when
exactly one matches; several matches are listed as candidates. A session file path is also accepted.

A Pi session whose directory is Pi's current directory is switched to in process, using the original
file: no copy, no confirmation. A session from another directory, or another agent, prints `Resume:`
or shows an import preview ending in `Confirm:`.

## Import with the picker

1. Run `/resume-from`.
2. Select a session.
3. Read the preview.
4. Confirm the import.

Pi writes the new session and opens it when the destination is its cwd. Otherwise it prints the
native resume command. The next prompt is empty, so you decide when work starts.

## Marker

An imported session starts with a three-line summary in one `custom` entry. Pi renders it dim, and
the collapsed view shows the first line:

```text
↻ Restored from claude-code dc601a22 (~/.claude) · 2026-11-03 10:04Z
  ~/work/app · master
  4 turns kept · Dropped on import: 2 tool result bodies.
```

## Options

```text
/resume-from <id> --to <existing-checkout>
/resume-from <id> --prompt "continue the refactor"
/resume-from <id> --context
```

`--context` is read-only and prints the conversation an import into Pi would keep.

## Show command help

```text
/resume-from --help
```

## Use another Pi home

Pi reads `PI_CODING_AGENT_DIR`. The default home is `~/.pi/agent`. Global lookup already searches
`~/.pi/agent/*sessions*`, `$PI_CODING_AGENT_DIR/sessions`, and `$PI_CODING_AGENT_SESSION_DIR`.

If another home is the import target, start Pi with that home:

```sh
PI_CODING_AGENT_DIR="$HOME/.pi/work-agent" pi
```

Add other source homes in the shared [configuration file](../configuration.md).

## Try without an install

Run the package for one Pi process:

```sh
pi -e npm:resume-from
```

Pi packages run with full system access. Review the source before you install a third-party Pi
package.
