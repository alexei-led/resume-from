# Documentation

Choose the shortest guide for the task in front of you.

## Start and use `resume-from`

- [Install and run the first restore](getting-started.md)
- [Common workflows and limitations](workflows.md)
- [How session restore works](how-it-works.md)

## Install in a specific target agent

- [Pi](agents/pi.md)
- [Claude Code](agents/claude-code.md)
- [Codex](agents/codex.md)

The target-agent guide owns installation and landing instructions. The shared getting-started guide owns the cross-agent restore workflow.

## Configure and troubleshoot

- [Configuration](configuration.md) — extra agent homes, context budget, pinned turns, and context-window overrides.
- [Troubleshooting](troubleshooting.md) — missing commands, missing sessions, blocked previews, and landing problems.

## Releases

- [v0.5.3](releases/v0.5.3.md) — resume in place in Claude Code, Codex and Pi.
- [v0.5.2](releases/v0.5.2.md) — Claude Code imports ignore your own files beside sessions.
- [v0.5.1](releases/v0.5.1.md) — personal-to-work profile imports and safe agterm launches.
- [v0.5.0](releases/v0.5.0.md) — restore a session from its ID alone, native resume, worktree recovery, restore summary.
- [v0.4.1](releases/v0.4.1.md) — Pi 1.x compatibility, verified on Pi 1.0.2.
- [v0.4.0](releases/v0.4.0.md) — current Codex sessions import, large homes list in seconds, sessions keep their start directory.
- [v0.3.1](releases/v0.3.1.md) — dependency and release-tooling updates.
- [v0.3.0](releases/v0.3.0.md) — transfers across linked Git worktrees and API migration steps.

## Maintain the project

- [Requirements](requirements.md) — normative product behavior and acceptance criteria.
- [Technical stack](tech-stack.md) — implementation choices and development constraints.
- [Implementation plan](plans/2026-08-04-implement-resume-from.md) — original delivery sequence.
- [Visual assets](visual-assets.md) — source artwork, palette, typography, rendering, and accessibility text.
- [`shims/README.md`](../shims/README.md) — host integration and package staging boundaries.

The files under `src/**/module.md` define internal module contracts. They are contributor references, not user guides.
