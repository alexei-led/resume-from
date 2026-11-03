# How session restore works

`resume-from` treats a handoff as a lookup plus a format conversion with an explicit safety
boundary.

## Restore pipeline

1. **Locate** — an ID, prefix, path, or row names a session. An ID or path is looked up globally:
   roots are expanded, ordered by ID shape, and only matching file names are parsed. A row stays the
   current repository's numbered list.
2. **Place** — the recorded directory (`startDirectory ?? repoPath`) is `present`, `recoverable`
   (a parent repository was found), or `unrecoverable`. A present checkout on another branch gets a
   warning; nothing is switched.
3. **Recover** — for a missing directory, the tool plans `git worktree add` commands and runs them
   only with the matching confirmation token.
4. **Read** — the source adapter parses its native session format.
5. **Normalize and filter** — supported content becomes one canonical conversation; tool activity
   becomes non-replayable text.
6. **Budget** — pinned content is kept and the oldest unpinned turns are dropped until the plan fits.
7. **Preview** — the import shows source, target, kept and dropped content, token estimate, changed
   files, and warnings. Nothing is written.
8. **Land** — serialize, validate, commit, read back, and open the session or print its native resume
   command. The same agent without `--to` skips all of this and prints its own resume command.

The preview and commit use the same deterministic transfer plan. The transfer itself does not call a
model.

## Identifier lookup

| Input | Scope |
| --- | --- |
| Whole number | Row of the current repository's list. |
| ID or prefix ≥ 6 characters | Every search root; case-insensitive; exact wins; ambiguity lists candidates. |
| File path | That file, with the agent decided by the root that contains it. |

ID shape only orders the search: UUIDv4 looks at Claude Code first, UUIDv7 at Codex then Pi, and
anything else at Pi first. The agent is decided by the root a file was found under. `--agent` and
`--home` narrow the lookup when given.

## Canonical conversation model

Source adapters produce a small shared vocabulary: source agent, profile, session ID, title,
timestamps and repository metadata; user and agent text turns; compaction summaries; tool records
with a name, recorded argument text, one-line outcome and effect; changed-file paths.

Target adapters consume that vocabulary and write their own native format. No target adapter needs to
understand another vendor's file layout.

## Content policy

| Content | Transfer behavior |
| --- | --- |
| User prompts and agent replies | Kept when selected by the budget. |
| Compaction summaries | Pinned. |
| Recent turns | Pinned according to `pinnedRecentTurns`. |
| Tool name and recorded arguments | Converted to plain text. |
| Tool outcome | Reduced to one line. |
| Tool-result body | Removed and marked as dropped. |
| Mutating tool activity | Kept as text and used to derive changed-file paths. |
| Incomplete trailing tool call | Removed. |
| Hidden reasoning, system prompts, environment blocks, secrets, telemetry | Excluded. |

Tool records are deliberately not serialized as executable calls.

## Budget policy

The target budget is `floor(budgetShare × target context window)`; the default `budgetShare` is `0.3`.
The importer pins the first user request, summaries, recent turns, and mutating tool records, then
removes the oldest unpinned turns until the estimate fits. If pinned content exceeds the budget, the
preview is blocked and names `budgetShare`, `pinnedRecentTurns`, and the target window.

## Repository scope

Discovery compares canonical Git common-directory identities, not checkout names or path prefixes.
Main checkouts and linked worktrees match regardless of placement, including subdirectories and
symlink aliases. Independent clones, submodules, and nested independent repositories remain separate.

An import destination must belong to the session's repository. The exception is a session whose
recorded directory is missing and cannot be recovered: then `--to` may name any existing checkout,
with a warning. Confirmation binds the canonical destination and rechecks membership.

## Recovery

A missing directory is matched against the known worktree layouts. The plan is one of: local branch,
`origin/<branch>` tracking branch, recorded commit, or the repository's HEAD with a warning. A
prunable registration is pruned first. The commands are shown before they run, and the token binds
the session file, directory and exact argv. Recovery never fetches, forces, deletes, or writes into
an existing path.

## Commit and landing

After confirmation:

1. The target adapter serializes a new session.
2. The output is validated before commit.
3. The file is added to the target home without replacing an existing session.
4. The committed session is read back and checked as openable.
5. A three-line provenance marker records where the session came from, where it now lives, and what
   was dropped.

The marker never enters model context:

| Agent | Marker channel |
| --- | --- |
| Claude Code | One `system` entry, subtype `informational`, level `info`; rendered gray. |
| Pi | One `custom` entry rendered dim; the collapsed view is its first line. |
| Codex | Printed in the command output. |

Pi can switch to the imported session in the current process. Claude Code and Codex create the
session and return their native resume commands.

## Failure behavior

- Cancelling the picker or confirmation writes nothing.
- A blocked preview writes nothing.
- A recovery token mismatch runs nothing.
- An unreadable source home is reported without suppressing other homes.
- A target validation, commit, or readback failure is reported as an error; it is not presented as a
  successful landing.
- The source session remains unchanged on success and failure paths.
