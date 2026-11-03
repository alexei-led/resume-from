# Configuration

`resume-from` works without a configuration file. If you need another agent home
or token budget, create the file.

## Search roots

An ID lookup searches these roots without configuration:

| Agent | Roots |
| --- | --- |
| Claude Code | `~/.claude*/projects` and `$CLAUDE_CONFIG_DIR/projects` |
| Codex | `~/.codex*/sessions`, `~/.codex*/archived_sessions` (last 14 days), and `$CODEX_HOME/...` |
| Pi | `~/.pi/agent/*sessions*`, `$PI_CODING_AGENT_DIR/sessions`, and `$PI_CODING_AGENT_SESSION_DIR` |

The repository list adds configured `extraHomes` to the same roots. An ID, prefix, or file path
lookup searches the roots globally; `--agent` and `--home` narrow it when given.

## File location

The default file is:

```text
~/.config/resume-from/config.json
```

The file must contain valid JSON. Comments are not valid in this file.

## Complete example

```json
{
  "extraHomes": [
    { "agent": "claude-code", "home": "~/.claude-team" },
    { "agent": "pi", "home": "~/.pi/work-agent" }
  ],
  "budgetShare": 0.3,
  "pinnedRecentTurns": 5,
  "windowOverrides": [{ "agent": "codex", "windowTokens": 258400 }]
}
```

## Fields

- `extraHomes` defaults to `[]`. It adds agent and home pairs to the search, on top of the
  default roots above.
- `budgetShare` defaults to `0.3`. It must be greater than `0` and at most `1`.
- `pinnedRecentTurns` defaults to `5`. It must be a whole number of `0` or more.
- `windowOverrides` defaults to `[]`. It replaces a default context-window size.

Valid agent names are `pi`, `codex`, and `claude-code`.

## Add another profile

For a one-off lookup in Claude Code or Codex, narrow it with the source home:

```text
/resume-from --home ~/.claude-team <id>
```

`--home` selects a source profile; it does not change the destination profile or checkout. It is not
needed to find a session by ID, because the default roots are searched anyway. For a profile you use
often, add it to `extraHomes`.

```json
{
  "extraHomes": [{ "agent": "claude-code", "home": "~/.claude-team" }]
}
```

The session list now includes the default Claude Code home and `~/.claude-team`.

An extra home can use an absolute path, `~/`, or a relative path. A relative
path starts from the directory that contains `config.json`.

## Change the import budget

`budgetShare` controls the maximum share of the target context window. The
default value is `0.3`, which means 30 percent.

```json
{
  "budgetShare": 0.5
}
```

The tool keeps these items before it keeps older turns:

- The first user request.
- The most recent pinned turns.
- Session summaries.
- The list of changed files.

If these items exceed the budget, the import stops before it writes a file.

## Change the pinned turns

Set `pinnedRecentTurns` to the number of recent turns that must remain word for
word.

```json
{
  "pinnedRecentTurns": 8
}
```

If only the other required content must remain, use `0`.

## Replace a context-window size

If an agent model has a different context-window size, use `windowOverrides`.

```json
{
  "windowOverrides": [{ "agent": "claude-code", "windowTokens": 200000 }]
}
```

Each `windowTokens` value must be a whole number greater than zero.

## Agent home variables

Each agent also has its own home variable:

| Agent       | Variable              | Default home  |
| ----------- | --------------------- | ------------- |
| Pi          | `PI_CODING_AGENT_DIR` | `~/.pi/agent` |
| Claude Code | `CLAUDE_CONFIG_DIR`   | `~/.claude`   |
| Codex       | `CODEX_HOME`          | `~/.codex`    |

The target plugin uses the home of the running agent. Use `extraHomes` to search
additional source homes.
