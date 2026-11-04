# Common workflows and limitations

`resume-from` restores a saved session. In the Claude Code and Codex plugins, the same agent and
profile home use a native resume command; a different agent or profile home gets a new session with
the conversation converted. It transfers conversation context, not the
repository, credentials, or a running process.

## Restore a session from its ID

Examples write `/resume-from`. In Claude Code, type `/resume-from:resume-from`. In Codex, type
`$resume-from`.

```text
/resume-from <id-or-prefix>
```

Lookup is global across every known agent home. The agent, profile home, directory, branch and
commit are taken from the session record, not from the current directory. An exact ID wins; a prefix
of at least six characters selects the session when exactly one matches; several matches are listed
as candidates.

The summary names the session and where it lives:

```text
↻ claude-code dc601a22 · ~/.claude · 2026-11-03 10:04Z · fix the parser crash
  ~/.local/share/chezmoi · master
```

Then the CLI plugin prints `Resume:` (same agent and profile home) or an import preview ending in
`Confirm:` (different agent or profile home, or `--to`). Follow that line; it is the exact command to run.

## Switch to another model, provider, or harness

1. Start the destination agent with the model, provider, and profile you want.
2. Run `/resume-from <id>`.
3. Confirm the import and run the printed `Resume:` command.

The destination controls the active model. `resume-from` does not select or copy model credentials.
Tool calls from the source become plain text, so the destination does not inherit executable tool
state and can inspect the current repository before acting.

## Continue after a usage limit

Leave the source session saved, start another supported agent or profile, restore by ID, and continue
from the new native session. `resume-from` does not bypass a provider limit; it makes the saved task
context available to a destination you can already use.

## Move between profiles

The destination profile is the profile used by the running target agent:

| Agent | Profile variable | Default home |
| --- | --- | --- |
| Pi | `PI_CODING_AGENT_DIR` | `~/.pi/agent` |
| Claude Code | `CLAUDE_CONFIG_DIR` | `~/.claude` |
| Codex | `CODEX_HOME` | `~/.codex` |

Global ID lookup already searches the default roots and the environment home of each agent. To search
an additional source home, add it to `extraHomes` in the shared [configuration](configuration.md).
`--home` narrows one lookup; it is not needed to find a session by ID.

## Recover a missing worktree

The recorded directory may have been removed with its worktree. The tool looks for a parent
repository in the usual layouts (`<repo>.worktrees/<name>`, `<repo>/.worktrees/<name>`,
`<repo>/.claude/worktrees/<name>`) and shows the exact recovery commands:

```text
Recover: git -C /repo worktree add /repo.worktrees/task task
Confirm: /resume-from dc601a22 --confirm v1-sha256-…
```

Recovery runs only with that token, and only after the plan is shown. The commands are chosen in this
order: the recorded local branch, the recorded `origin/<branch>`, the recorded commit, then the
repository's HEAD with a warning. A stale registration is pruned first. Recovery never fetches,
forces, deletes, or writes into an existing path.

After a successful recovery the same invocation continues: native `Resume:` or an import preview.

## Import into another checkout

`--to <dir>` imports into an existing checkout instead of the session's recorded directory. It must
belong to the same repository, proven by the canonical Git common directory. Independent clones,
submodules, and nested independent repositories do not qualify. A bare repository cannot be a
destination.

When the recorded directory is missing and cannot be recovered, `--to` may name any existing Git
checkout, with a warning. The import never moves a session into a different repository behind your
back.

## Continue in place from instructions

In Claude Code and Codex, `/resume <id>` replaces the current conversation, so instructions given to
`/resume-from` cannot cross it. The command shows them again: send them after you resume in place.

`--context` is read-only. It prints the summary and the conversation an import into the current agent
would keep, then `Directory: <dir>`.

## Start a fresh context without losing the task

The importer budgets history against the destination context window. By default it may use 30% of
that window. It pins the first user request, the configured number of recent turns, compaction
summaries, and mutating tool records used to derive changed-file paths.

If the full history does not fit, it drops the oldest unpinned turns and reports them in the preview.
If pinned content alone does not fit, it blocks before writing.

## Current limits

- Supported agents are Pi, Claude Code, and Codex.
- The repository list is filtered by the current repository; an ID, prefix, or file path is not.
- Imports must stay in the session's repository, except when its recorded directory is gone.
- Repository files and uncommitted changes are not copied. Imports neither switch branches nor
  transfer a running process; a missing worktree is recreated only after confirmation.
- Credentials, model selection, hidden reasoning, system prompts, environment data, telemetry, and
  vendor runtime state do not transfer.
- Tool-result bodies do not transfer.
- Pi switches in process. Claude Code and Codex cannot be switched by a plugin: type the printed
  `Resume in place:` command (`/resume <id>`) in the running agent.
- The Codex plugin's first run needs npm access unless its pinned package is already cached.
