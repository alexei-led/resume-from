# Host shims

The host shims expose one core implementation as `/resume-from` (`/resume-from:resume-from` in Claude Code, `$resume-from` in Codex).

- Pi uses `resume-from` and `shims/pi/extensions/resume-from.js`.
- Claude Code installs `shims/claude-code` from git at the release tag and uses
  `commands/resume-from.md`. The `@alexeiled/resume-from-claude` package holds the same files.
- Codex uses `@alexeiled/resume-from-codex` and `skills/resume-from/SKILL.md`.

## Boundaries

The core package owns discovery, transfer, preview, and confirmation. A shim
contains no transfer rules.

Claude Code and Codex supply `--target-agent`. They do not detect the target
from the environment. Only the user supplies `--confirm`.

The Pi shim uses `registerCommand`, `ui.select`, `ui.confirm`, and
`switchSession`. It keeps the live command context only until the session switch
is complete.

## Package staging

Run this command to stage the three npm packages:

```sh
npm run packages:stage
```

The command writes generated packages to `build/npm/`.

Run this command to inspect the npm files and manifests:

```sh
npm run packages:check
```

The Claude Code command and the Codex skill both pin the matching core package version and run it
through `npx`. Neither package contains a binary.

Read the user guides in [`docs/agents/`](../docs/agents/).
