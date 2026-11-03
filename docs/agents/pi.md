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
file: no copy, no confirmation. A session from another directory, or another agent, prints `Resume:`.
A Pi import shows the preview and then asks `Import this session? (y/N)` before writing anything.

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

Pi accepts the selector only: `/resume-from <id-or-prefix>` or `/resume-from <file-path>`. Row
numbers, `--to`, `--prompt`, and `--context` belong to the CLI, Claude Code, and Codex entry points;
run `resume-from --help` for those. `--to` and `--context` need a target agent, so from a shell use
`resume-from --target-agent <agent> -- <selector> --to <dir>` rather than a bare `--to`.

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
