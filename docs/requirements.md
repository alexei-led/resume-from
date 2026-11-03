# resume-from — functional requirements

**Status:** approved by interview, 2026-08-03. No design. No code.
**Scope of this document:** what the user sees and does. Nothing about modules or file formats.

---

## In one minute

|               |                                                                            |
| ------------- | -------------------------------------------------------------------------- |
| **What**      | Continue a coding session in a different agent, or in a different profile. |
| **Agents**    | Pi, Claude Code, Codex. All of them are sources. All of them are targets.  |
| **Command**   | `/resume-from`, typed in the agent you want to land in.                    |
| **Rule 1**    | The source session never changes.                                          |
| **Rule 2**    | No old file contents cross over. Ever.                                     |
| **Rule 3**    | Nothing is written until the user confirms a preview.                      |
| **Rule 4**    | One new agent costs one new file.                                          |
| **Done when** | You continue the work in the new agent and repeat nothing.                 |

---

## Terms

| Term                 | Meaning                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| **Agent**            | Pi, Claude Code, or Codex.                                                                               |
| **Home**             | The directory that holds the sessions of one agent profile, for example `~/.claude` or `~/.claude-team`. |
| **Source**           | The agent, home, and session you come from.                                                              |
| **Target**           | The agent and home you land in.                                                                          |
| **Turn**             | One message from the user, or one answer from the agent.                                                 |
| **Tool call record** | The name and arguments of a tool call, and one line about the outcome. No result body.                   |
| **Pinned**           | Content that the tool never drops.                                                                       |

---

## Scope

**All nine directions work.** There are no phases.

| From \ To       | Pi              | Claude Code     | Codex           |
| --------------- | --------------- | --------------- | --------------- |
| **Pi**          | ✅ across homes | ✅              | ✅              |
| **Claude Code** | ✅              | ✅ across homes | ✅              |
| **Codex**       | ✅              | ✅              | ✅ across homes |

The three diagonal cells move a session between two homes of the same agent. An example is
`~/.claude` to `~/.claude-team`.

**The extension point must fit these agents later:** Antigravity CLI, opencode, Copilot CLI,
Grok, Cursor CLI. They are not in this release. Section J states what "later" must cost.

---

## Constraints (facts, not choices)

These facts come from tests of the installed software. They limit the design.

**C-1 to C-6 come from the deleted design documents. They were not tested again in this session.
C-7 to C-11 were tested on 2026-08-03. C-12 was measured on 2026-09-03 and again on 2026-09-30.**

- **C-1** — Our command cannot open its own picker inside Codex or Claude Code. Their command set
  is fixed. The native picker of each agent still works, and it shows an imported session.
  Section B gives each agent the best experience that it can support.
- **C-2** — Our command cannot move the user into another session inside Codex or Claude Code.
  The user opens the imported session with the native command of the agent.
- **C-3** — The session store of Claude Code is an internal application database with ten entry
  types. A bad write can damage the real sessions of the user. Section H holds the guards.
- **C-4** — Reasoning traces of Codex are encrypted and locked to the provider. They cannot move.
- **C-5** — In one measured Codex session, visible conversation was about 10% of the file.
  Reasoning was about 41%. Tool calls and outputs were about 49%.
- **C-6** — Codex stores an injected item without any validation. It also drops an unknown item
  type in silence. The tool must do its own validation.
- **C-7** — In Codex, `thread/inject_items` fills the model history only. It makes no turn that
  the user can see. A test of codex-cli 0.146.0 on 2026-08-03 gave these results:

  | What was tested                                     | Result                                                                                                 |
  | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
  | `thread/start` with no login                        | Works. It writes a rollout file at once.                                                               |
  | `thread/inject_items`                               | Accepted. The items are in the rollout file as `response_item` entries.                                |
  | Entries that the user interface reads (`event_msg`) | **None.** A real session has `user_message` and `agent_message` entries. An injected session has none. |
  | `thread/read` and `thread/resume`                   | 0 turns. The injected text is not in the answer.                                                       |
  | `thread/list` with the default filter               | **The thread does not appear.** Its preview is empty.                                                  |
  | The same filter on 861 real threads                 | 25 threads appear, from the `cli` and `vscode` sources.                                                |

  The Codex source gives the cause. The user interface builds the history from `event_msg`
  entries. The picker lists a thread only when it has session metadata and a preview, and the
  preview also comes from an `event_msg` entry.

- **C-8** — A new session file with `event_msg` entries works. This was tested end to end on
  2026-08-03, with codex-cli 0.146.0 and a real login:

  | What was tested                                          | Result                                                                          |
  | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
  | The forged file in `thread/list` with the default filter | **Listed.** The preview holds the first imported message.                       |
  | `thread/resume`                                          | 1 turn. The imported text is in the answer.                                     |
  | The Codex user interface, `codex resume <id>`            | **The turns are on the screen**, as a native user turn and a native agent turn. |

  The screen showed these two lines:

  ```text
  › IMPORTED FROM PI: make the auth token refresh work
  • IMPORTED: Read('src/auth.ts') -> 400 lines (content dropped: imported session, may be stale)
  ```

  The file was new. No file that existed was opened or changed. This keeps FR-49.

- **C-9** — The same method works for Claude Code. A test on 2026-08-03, with Claude Code
  2.1.220 and a throwaway `CLAUDE_CONFIG_DIR`, wrote one new session file with two entries: one
  `user` entry and one `assistant` entry. The results were:

  | What was tested          | Result                                                                          |
  | ------------------------ | ------------------------------------------------------------------------------- |
  | `claude --resume <id>`   | **The turns are on the screen**, as a native user turn and a native agent turn. |
  | `claude --resume` picker | **Listed**, with the time, the branch, and the size.                            |

  The screen showed these two lines:

  ```text
  ❯ IMPORTED FROM CODEX: make the auth token refresh work
  ⏺ IMPORTED: Read('src/auth.ts') -> 400 lines (content dropped: imported session, may be stale)
  ```

  Eight of the ten entry types of C-3 were not necessary. Two entry types were enough.

  CAUTION: This test used a throwaway configuration directory with one session. It does not show
  that a write into the real store of the user is safe. C-3 still holds.

- **C-10** — Pi can create a session and move the user into it. A test on 2026-08-03, with Pi
  0.83.0, a throwaway session directory, and a small extension, gave these results:

  | What was tested                                                      | Result                                                                        |
  | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
  | A new session file with a `session` header and two `message` entries | **The turns are on the screen**, as native Pi turns.                          |
  | `ctx.switchSession(path, { withSession })` from a command            | **Works.** It returned `{"cancelled":false}`. The `withSession` callback ran. |
  | The screen after the switch                                          | The imported turns, and the marker `Resumed session`.                         |

  Pi is the only agent of the three that moves the user without a second command.

  CAUTION: The test called `switchSession` from a command handler. The deleted design documents
  said that a call from an event handler causes a deadlock. That claim was not tested.

- **C-11** — A session file with a missing field can crash the agent. The first Pi test left out
  the `usage` object on the assistant message. Pi stopped with an uncaught exception in the
  footer: `TypeError: Cannot read properties of undefined (reading 'input')`. This is the reason
  for FR-50.

- **C-12** — Codex moved its visible history to a second schema, and every measured client now writes
  it. Observed on 2026-09-03 with codex-cli 0.151.0-alpha (`originator: "codex_vscode"`), on
  0.153.x and 0.154.0-alpha, and again on 2026-09-30 with 0.157.1, 0.158.0 and 0.159.2 writing
  `codex_vscode`, `codex_exec` and `codex-tui` rollouts. Such a rollout holds **no**
  `user_message` or `agent_message` `event_msg` entries at all. Every turn is one `event_msg` of
  type `item_completed`, wrapping an `item` whose own `type` says which kind of turn it is:

  | `item.type`                                | What it holds                                                       |
  | ------------------------------------------ | ------------------------------------------------------------------- |
  | `UserMessage` / `AgentMessage`             | the dialogue; text in `content[].text`                              |
  | `CommandExecution`                         | a shell command, its exit code and its output                       |
  | `FileChange`                               | the paths changed and, for an added file, its whole content         |
  | `McpToolCall`                              | a server tool call: `server`, `tool`, `arguments`, `result`         |
  | `Extension`                                | a tool action such as `web.search`, with its queries and results    |
  | `ImageView`                                | an image path                                                       |
  | `CollabAgentToolCall`                      | an action on another agent: `tool`, receivers, `agents_states`      |
  | `SubAgentActivity`                         | a progress marker of another agent; it carries no turn              |
  | `Reasoning`                                | encrypted reasoning (C-4)                                           |
  | `ContextCompaction`                        | that a compaction happened; it carries no summary text              |

  Two measurements fix what this means for the tool. In one session recorded by `codex_vscode`
  (3,761 entries, 68 MB), 1257 `item_completed` entries carried 44 user messages, 109 agent
  messages and 509 tool-like actions, and not one `user_message`/`agent_message` entry existed. In
  one developer home on 2026-09-30, 1953 of 2023 rollout files carried `item_completed`, 4 still
  carried the older shape, and **no** file carried both; over the 60 most recent files the kinds
  counted were `Reasoning` 600, `CommandExecution` 487, `McpToolCall` 480, `AgentMessage` 184,
  `SubAgentActivity` 63, `UserMessage` 49, `CollabAgentToolCall` 24, `Extension` 23 and
  `FileChange` 2. A reader that still looks only for `user_message`/`agent_message` therefore reads
  **every current Codex session as zero dialogue**.

  The parallel `response_item` stream repeats the same actions, but not one for one: in one measured
  session, 10 `custom_tool_call` entries covered 17 structured actions, because one outer call can
  run several commands. Its `message` entries also hold vendor and system text. A reader that takes
  turns from both streams would cross the same action twice, so when `item_completed` dialogue is
  present that stream is the sole source of turns.

  This session's `compacted` entries also carried an empty `message`, and their `replacement_history`
  holds the context Codex rebuilt after the compaction — which this tool deliberately does not read,
  because it restates vendor system text.

  The schema moved on the reading side only: a thread written with C-8's `event_msg` messages is
  still listed, still resumable and still shows native turns on codex-cli 0.159.2 (re-tested
  2026-09-30).

---

- **C-13** — A Codex rollout can be larger than one JavaScript string, and a home can hold thousands
  of them. Measured on 2026-09-30 in a developer home holding 2023 rollout files (2.37 GB, largest
  33 MB): listing every thread cost about 41 s while every file was read whole, and one rollout of
  635 MB made the **whole home** unreadable with `RangeError: Invalid string length`, because the
  text of that one file exceeds the maximum string length. A reader that streams a file line by line
  never holds it: the same 635 MB rollout lists in 0.7 s (254 MB peak memory against 621 MB), and
  the 2023-file home lists in about 9 s — the remaining cost is parsing 2.37 GB of JSON, which no
  reader can avoid. A line longer than any Codex entry (the cap is 16 MB) is treated as damage: it is
  dropped, the file counts as truncated, and reading continues at the next line. One rollout that
  cannot be read at all no longer hides the rest of its home, and a home where nothing at all could
  be read still reports a failure rather than an empty listing.

  The listing and the loader compute their fields from one classifier, so a row always agrees with
  the session it opens: over those 2023 files the two agreed on every field of all 2007 rows.

---

## A. Agents and homes

**FR-1** — A session is identified by three values: the agent, the home, and the session ID.

**FR-2** — The user can name a home that is not the default one.

> Test: `/resume-from claude --home ~/.claude-team` lists the sessions of the work profile.

**FR-3** — When the user names no home, the tool uses the default home of that agent.

**FR-4** — The source home and the target home can be the same agent with different directories.

> Test: Import a `~/.claude` session into `~/.claude-team`. Both sessions exist after the import.

**FR-5** — The user can keep a list of extra homes. The tool reads sessions from the default home
of each agent, and from every home in that list.

> Test: Add `~/.claude-team` to the list. Sessions of both Claude Code profiles appear together.

**FR-6** — Every rule in this document applies to all nine directions. The agent names change
nothing.

> Test: The preview of a Pi → Pi import has the same lines as the preview of a Codex → Claude
> import.

---

## B. Start and select

**FR-7** — The user starts the import in the target agent, with the command `/resume-from`.

**FR-8** — The tool reads the source session from disk. It never calls the model of the source
agent.

> Test: Stop the source agent. Reach its usage limit. The list and the import still work.

**FR-9** — In Pi, the command opens an interactive picker.

> Test: Type `/resume-from`. Move with the arrow keys. Press Enter to select.

**FR-10** — In Codex and Claude Code, the command prints a numbered list. The user runs the command
again with a number.

> Test: `/resume-from` prints 10 rows. `/resume-from 3` opens the preview of row 3.

**FR-11** — Each row shows the agent, the home, the time, the title, and the turn count.

**FR-12** — The user can give a session ID or a file path instead of a number.

**FR-13** — The list holds only sessions that ran in the current repository.

> Test: Start the command in repository A. No session of repository B appears.
> Test: A session that started in A stays listed in A after it was resumed in a subdirectory of A,
> and a conflicting recorded repository identity still excludes it (issue #5).

**FR-14** — The most recent session is the first row.

**FR-15** — The list holds the sessions of every agent and every home of FR-5, unless the user
names one.

> Test: `/resume-from` in Pi shows Codex and Claude Code sessions in the same list.

---

## C. Preview and confirm

**FR-16** — The tool shows a preview before it writes anything.

> Test: Cancel at the preview. No new session exists.

**FR-17** — The preview states the number of turns that cross over, and the number dropped.

**FR-18** — The preview states the size of the import, and the size of the target window.

> Test: The preview shows a line of this form: `Budget: 34k tokens of a 200k window`.

**FR-19** — The preview lists each warning. The warning about the repository state is first.

**FR-20** — The import starts only after the user confirms.

**FR-21** — The preview has the same shape for every source agent and every target agent.

---

## D. What crosses over

**FR-22** — These items always cross over:

- the visible messages of the user
- the visible answers of the agent
- summaries that the source agent made when it compacted
- the title, the timestamps, the source agent, the source home, and the source session ID

**FR-23** — A tool call crosses over as a record: the tool name, the arguments, and one line about
the outcome.

> Test: `Read('src/auth.ts')` appears as `Read('src/auth.ts') → 400 lines`.

**FR-24** — The tool drops every tool result body. This rule holds for all nine directions,
including a move between two homes of one agent.

> Test: Import a session that read a file. Search the new session for a line of that file. There
> is no hit.

**FR-25** — Each dropped body is marked in text that the model can read.

> Test: The record ends with `(content dropped: imported session, may be stale)`.

**FR-26** — A call that changed the repository crosses over as a record only. The target can never
run it again.

> Test: Import a session with an `Edit`. The target starts no edit and asks for no approval.

**FR-27** — The tool keeps the original tool names. It translates no name.

> Test: A Claude Code `Read` call stays `Read` in Codex.

**FR-28** — These items never cross over:

- hidden reasoning and chain of thought
- system prompts and developer prompts
- tokens, passwords, and environment values
- internal telemetry and vendor model state

---

## E. Size

**FR-29** — The import fits in a token budget. The budget is a share of the target window.

**FR-30** — The default budget is 30% of the target window. The user can change this value.
(The number 30% is a placeholder. See Open questions.)

> Test: A 200k window gives a default budget of 60k tokens.

**FR-31** — When the content is larger than the budget, the tool drops the oldest turns first.

**FR-32** — The tool never drops pinned content. Pinned content is:

- the first request of the user
- the last 5 turns, word for word (the number 5 is a placeholder)
- the decisions, and any summary that the source agent made
- the list of files that the source changed

**FR-33** — When the pinned content alone is larger than the budget, the tool stops and states
this. It writes nothing.

**FR-34** — The tool never drops one half of a call and its result. It drops both, or it keeps
both.

**FR-35** — The preview states what the budget dropped.

> Test: The preview shows a line of this form: `12 older turns dropped`.

---

## F. Repository state

**FR-36** — The tool records the commit of the source session, and the files that were dirty at
that time.

**FR-37** — The tool compares the source commit to the current HEAD.

**FR-38** — If the two commits are different, the preview shows a warning with the distance.

> Test: The preview shows a warning of this form:
> `⚠ Source ran at 3f2a1bc. The tree is now at 9d81e04 (14 commits ahead).`

**FR-39** — This warning does not block the import. The user can continue.

---

## G. Landing

**FR-40** — The tool creates a new session in the target agent and the target home.

**FR-41** — The imported turns are native turns of the target agent.

> Test: Scrollback and the native resume list work on the imported turns. Compaction is not
> tested yet. It needs a real turn.

**FR-42** — An adapter declares how it can land a session. There are two levels:

| Level                 | Meaning                                                                     |
| --------------------- | --------------------------------------------------------------------------- |
| **Create and switch** | Make a new session and move the user into it.                               |
| **Create only**       | Make a new session. The user opens it with the native command of the agent. |

**FR-43** — The tool uses the highest level that the adapter declares.

**FR-44** — In Pi, the tool creates the session and moves the user into it.

**FR-45** — When the adapter cannot switch, the tool states the session ID and the command that
opens it.

**FR-46** — After the landing, the agent waits. It sends no message and runs no tool.

> Test: The prompt is empty. The user types the next instruction.

**FR-47** — The new session shows a provenance marker to the user.

> Test: The marker states the source agent, the source home, the source session ID, the time of
> the import, and what was dropped.

**FR-48** — The provenance marker is not in the model context and costs no tokens.

The marker is a durable transcript/session metadata entry when the target host has a verified
out-of-context entry (Pi and Claude Code). It is host output only when the target does not have one
(Codex). It must not be a sticky footer, status line, or fake tool result. A host may show a compact
landing notice in addition to the durable marker.

---

## H. Target safety

**FR-49** — In the target home, the tool only adds. It never rewrites or deletes a file that
exists. It never changes a turn that exists.

> Test: Take a checksum of every file in the target home before the import. Only new content
> appears after it.

**FR-50** — The tool checks the structure of the new session before it places it in the target
home. A missing field must not reach the agent.

> Test: Remove the `usage` object from an assistant message. The check stops the import. Pi stops
> with an uncaught exception when this field is absent. See C-11.

**FR-51** — The target agent must be able to open the new session with its own commands.

> Test: After a Claude Code import, the native resume list of Claude Code shows the session and
> opens it.

**FR-52** — The tool compares the number of items it sent to the number of items the target
stored. A difference is an error.

> Test: Import into Codex. Codex drops an unknown item in silence. The tool reports the loss.

---

## I. Failure

**FR-53** — If the write fails at any point, nothing remains. There is no partial session.

> Test: Stop the write in the middle. The target shows no new session.

**FR-54** — If the last tool call of the source has no result, the tool drops that call.

> Test: Import a session from an agent that crashed. The import stops at the last complete turn.

**FR-55** — The preview states that the tool dropped a broken tail.

**FR-56** — An error message states what failed, and what the user can do next.

---

## J. Extension

**FR-57** — One new agent costs one new adapter file, and one line in the agent list.

> Test: Add Cursor CLI. No rule, no preview, and no other adapter changes.

**FR-58** — An adapter declares what its agent can do: the selection level of section B, and the
landing level of FR-42.

> Test: An adapter that declares no picker gets the numbered list of FR-10.

**FR-59** — An adapter declares one role or both roles: source, target.

> Test: An adapter with the source role only never appears as an import target.

**FR-60** — The rules of sections C to I are the same for every adapter. An adapter cannot change
them.

> Test: A new adapter cannot keep a tool result body, because the rules run before it.

---

## K. Restore from an ID

**FR-61** — A session can be named by its ID or a prefix, anywhere on disk, without the repository
filter. Matching is case-insensitive; an exact ID wins, a prefix of at least six characters selects
when exactly one session matches, and several matches are listed as candidates. A prefix is
matched against file names before any file is parsed. No match names the roots that were searched.

**FR-62** — The recorded directory of a session is `startDirectory ?? repoPath`. It is `present`
when it exists (with a warning when the checkout is on a different branch), `recoverable` when a
parent repository matches a known worktree layout, and `unrecoverable` otherwise.

**FR-63** — A recoverable directory is recreated only after confirmation, in this order: the
recorded local branch, the recorded `origin/<branch>`, the recorded commit, then the repository's
HEAD with a warning. A stale registration is pruned first. Recovery never fetches, forces, deletes,
or writes into an existing path; a failed command reports git's own message and stops.

**FR-64** — A native resume command is absolute, POSIX-quoted only where needed, and names the
agent's home variable when needed to select the profile. Claude Code keeps a non-default home
explicit even when it is already set in the current environment, because another terminal may not
inherit that environment.

**FR-65** — A bare shell (no `--target-agent`) and a CLI plugin whose source agent and home equal
the target without `--to` print the source agent's native resume command and write nothing. A
different agent or profile home, or `--to <dir>`, imports with the destination at the session's recorded directory or the override.
`--to` must name an existing checkout of the same repository while the recorded directory exists,
and, when that directory is missing but recoverable, of the repository that would recreate it; the
check happens before any recovery writes. When the recorded directory is missing and unrecoverable,
any existing checkout is allowed with a warning.
`--prompt <text>` appends the text, shell-quoted, as the initial prompt of the native resume command.
`--context` is read-only: it prints the summary and the budgeted conversation an import into the
current agent would keep, then a final `Directory: <dir>` line. Pi switches in process to the
original session when a native restore targets Pi's current directory; otherwise it shows the
command.

**FR-66** — Restore output uses stable labels: `Resume:`, `Recover:`, `Confirm:` and `Directory:`.
Native output starts with two summary lines naming the agent, id prefix, home, time, title,
directory, branch, and any state note. An import landing prints a three-line provenance summary:
where it came from, where it now lives, and the kept and dropped counts. Claude Code stores that
summary in one `system` entry (subtype `informational`, level `info`, `isMeta` false), rendered gray;
Pi stores one `custom` entry rendered dim, with the collapsed view showing its first line; Codex
prints it. Imported Claude Code assistant turns declare the model `<synthetic>` so a resume shows no
restore notice. A `Confirm:` re-run uses the host's `/resume-from` whenever a target agent is stated, and a
runnable `resume-from …` shell command in a bare shell. Displayed text is sanitised.

---

## Non-goals

The tool must never do these things.

| #         | Never                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| **NG-1**  | Change the source session. The source file is read-only.                                                   |
| **NG-2**  | Synchronize two sessions. The import is a copy.                                                            |
| **NG-3**  | Keep two homes of one agent in step. This tool is not a sync tool.                                         |
| **NG-4**  | Merge two sessions into one.                                                                               |
| **NG-5**  | Make a full copy that keeps tool result bodies. A different profile does not make old file contents fresh. |
| **NG-6**  | Run an imported tool call again.                                                                           |
| **NG-7**  | Move tokens, passwords, or environment values.                                                             |
| **NG-8**  | Move hidden reasoning.                                                                                     |
| **NG-9**  | Import a session into a repository other than the one it ran in.                                           |
| **NG-10** | Replace the history with a summary. The target must show real turns.                                       |

The user can open the source session later to read it. The source session stays valid.
A copy of a copy is a new independent session.

---

## Open questions

Two values are not yet decided. Q-3 is answered.

| #       | Question                                                                          | Default in this document                                                 |
| ------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Q-1** | What share of the target window can one import use?                               | 30% (FR-30)                                                              |
| **Q-2** | How many recent turns are pinned, word for word?                                  | 5 (FR-32)                                                                |
| **Q-3** | ~~Can a Codex thread be created that the resume list shows, with visible turns?~~ | **Answered 2026-08-03. Not through the injection API. See C-7 and C-8.** |

---

## Acceptance

**The one test that proves the product.**

1. Work in a real Codex session until it holds file reads, edits, and 20 or more turns.
2. Start Pi in the same repository.
3. Run `/resume-from` and select that Codex session.
4. Confirm the preview.
5. Type the next instruction.

**Pass:** The agent continues the task. The user explains nothing again.

**Supporting checks:**

| #        | Check                                                                                       |
| -------- | ------------------------------------------------------------------------------------------- |
| **AC-1** | All nine directions of the scope table pass the same test.                                  |
| **AC-2** | The imported turns are native turns. Scrollback, resume, and compaction work on them.       |
| **AC-3** | A file that changed after the source session is read again by the target, not edited blind. |
| **AC-4** | Every source session file is byte-identical after the import.                               |
| **AC-5** | The import of a very large session leaves room to work.                                     |
| **AC-6** | A `~/.claude` session opens in `~/.claude-team` with the profile of the work account.       |
| **AC-7** | A new agent adapter reaches both roles with one new file.                                   |
