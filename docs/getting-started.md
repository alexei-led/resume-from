# Install and run the first restore

Install `resume-from` in the agent that will restore or receive the session.

## 1. Install

### Pi

```sh
pi install npm:resume-from
```

Restart Pi after installation.

### Claude Code

```sh
claude plugin marketplace add alexei-led/resume-from
claude plugin install resume-from@alexei-led-resume-from
```

Restart Claude Code if the command does not appear. The command runs a pinned package through
`npx`. Its first use needs access to the npm registry.

### Codex

```sh
codex plugin marketplace add alexei-led/resume-from
codex plugin add resume-from@alexei-led-resume-from
```

Run the Codex skill as `$resume-from <id>`. It uses a pinned package through `npx`. Its first use
needs access to the npm registry.

## 2. Restore by ID

Claude Code prefixes every plugin command with the plugin name, so plain `/resume-from` is "Unknown
command" there. Each agent has its own form:

| Agent       | Command                          |
| ----------- | -------------------------------- |
| Pi          | `/resume-from <id>`              |
| Claude Code | `/resume-from:resume-from <id>`  |
| Codex       | `$resume-from <id>`              |

Examples in this guide write `/resume-from`. Use the form for your agent.

```text
/resume-from <session-id>
```

The lookup is global: it is not filtered by the current repository, so a session recorded in a
removed worktree is still found. Matching is case-insensitive. An exact ID wins; a prefix of at least
six characters selects the session when exactly one matches, and several matches are listed as
candidates. You can also pass a session file path. Row numbers come from the list in Claude Code,
Codex, and the CLI; Pi uses its session picker.

The tool prints a two-line summary, any warnings, and then:

- `Resume:` — run this when the agent is the same. Nothing was written.
- `Confirm:` — re-run this exact command to import, or to run a shown worktree recovery.

Same agent and profile home in a CLI plugin: run `Resume:`. Another agent or profile home: confirm the import; the new native session starts with the
three-line recovery summary.

## 3. Options

These apply to the CLI, Claude Code, and Codex; Pi accepts a selector only and confirms imports with
its own `Import this session? (y/N)` dialog.

```text
/resume-from <id> --to <existing-checkout>     # import into another checkout of the same repository
/resume-from <id> --prompt "continue the refactor"
/resume-from <id> --context                    # read-only: print the conversation an import would keep
```

A missing recorded directory is recovered only after the printed `Confirm:` token. The tool will
recreate the worktree at the recorded branch, `origin/<branch>`, the recorded commit, or the
repository HEAD, in that order.

## 4. Check the preview

Before confirming an import, verify:

- Source agent, profile, session, directory, branch, and any state warning.
- Kept and dropped turn counts.
- Tool-result bodies removed.
- Estimated tokens and target budget.

Nothing has been written at this point. A blocked preview cannot be confirmed, and a recovery token
from another directory cannot be reused.

## Confirm success

A successful transfer has these properties:

- The source session is unchanged.
- A new target-native session exists, or the native resume command printed the original one.
- The target can open and read the new session.
- The imported session shows its source and what was dropped.
- Tool activity is plain text, not replayable calls.

Use `/resume-from --help` for the exact selectors and options available in the current host.
