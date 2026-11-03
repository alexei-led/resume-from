#!/usr/bin/env node
/**
 * The command binary. The Codex prompt file and the Claude Code slash-command file call it
 * (C-1, FR-10), and it is a process wrapper and nothing more: read the two facts only the
 * caller knows, hand the rest to the host, print what came back.
 *
 * The shim states which agent the binary is running inside. This file never guesses it from the
 * environment, and never checks the name against a list of its own — an unknown agent is the
 * registry's error to raise, with the agents it does know in the message (FR-56). That is what
 * keeps FR-57's "one new folder and one line" true of this file too.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentId, HomePath } from "./contract.js";
import { runCommandBinary } from "./index.js";

const TARGET_AGENT = "--target-agent";
const TARGET_HOME = "--target-home";
const USER_ARGUMENTS = "--";
/** Hidden: an installed agent command passes it, so `Confirm:` re-runs use `/resume-from`. */
const PLUGIN_FLAG = "--plugin";

const USAGE =
  `Usage: resume-from <id-or-prefix> [options]\n` +
  `       resume-from ${TARGET_AGENT} <agent> [${TARGET_HOME} <path>] ${USER_ARGUMENTS} ` +
  "[<row> | <id-or-prefix> | <file-path>] [options]";

export const HELP_TEXT = `${USAGE}

Selectors:
  <id-or-prefix>    Find one session anywhere by ID, or by a prefix of 6+ characters.
  <file-path>       Describe a session file by absolute, relative or ~/ path.
  <row>             Inside an agent, select a numbered row from this repository's list.
  no selector       Inside an agent, list sessions available for the current directory.

Options:
  --to <dir>        Import into this directory instead of the session's own directory.
  --prompt <text>   Append the text as the initial prompt of the Resume command.
  --context         Print the conversation an import would keep; write nothing.
  --agent <name>    Filter source sessions: pi, codex, claude, or claude-code.
  --home <path>     Search one source home, even one outside the configuration.
  --confirm <token> Run the exact recovery or import identified by the token.
  --target-agent    Target host ID; normally supplied by the installed plugin.
  --target-home     Target agent home; omit to use that agent's default.
  -h, --help        Show this help.

Examples:
  resume-from dc601a22
  resume-from dc601a22 --prompt "continue the refactor"
  resume-from --target-agent codex --
  resume-from --target-agent claude-code -- claude 2
  resume-from --target-agent codex -- ~/sessions/session.jsonl`;

/** The invocation split in two: what the shim states, and what the user typed. */
export interface ShimArgs {
  /** The agent the shim is running inside. Null when it did not say (FR-56). */
  targetAgent: string | null;
  /** The home that agent is running, or null to use the adapter's declared default (FR-3). */
  targetHome: string | null;
  /**
   * True when an installed agent command supplied the target, rather than a person importing
   * from a shell. It decides whether a `Confirm:` line is a slash command or a shell command.
   */
  plugin: boolean;
  /** Everything else, in the order it was given. The host's own parser reads it. */
  rest: string[];
}

export type ShimArgsResult = { ok: true; value: ShimArgs } | { ok: false; problem: string };

/**
 * Both forms of both flags are accepted (`--flag value` and `--flag=value`) because a shim is a
 * text file a user edits. A flag with no value is left for the caller to report rather than
 * silently swallowing the argument that follows it.
 *
 * A bare shell passes no shim flags and no delimiter: every argument is the user's. A shim
 * passes its target flags, then `--`, then the user's arguments unchanged.
 */
export function readShimArgs(argv: string[]): ShimArgsResult {
  let targetAgent: string | null = null;
  let targetHome: string | null = null;
  let plugin = false;
  const separator = argv.indexOf(USER_ARGUMENTS);
  if (separator < 0) {
    return {
      ok: true,
      value: { targetAgent: null, targetHome: null, plugin: false, rest: [...argv] },
    };
  }

  const trusted = argv.slice(0, separator);
  const rest = argv.slice(separator + 1);

  for (let index = 0; index < trusted.length; index += 1) {
    const arg = trusted[index];
    if (arg === undefined) continue;

    if (arg === PLUGIN_FLAG) {
      if (plugin) return { ok: false, problem: `${PLUGIN_FLAG} was given twice by the shim.` };
      plugin = true;
      continue;
    }

    const named = [TARGET_AGENT, TARGET_HOME].find(
      (flag) => arg === flag || arg.startsWith(`${flag}=`),
    );
    if (named === undefined) {
      return {
        ok: false,
        problem: `Unexpected shim argument before ${USER_ARGUMENTS}: ${arg}.`,
      };
    }

    const inline = arg.startsWith(`${named}=`);
    const value = inline ? arg.slice(named.length + 1) : trusted[index + 1];
    if (value === undefined || value === "" || value.startsWith("-")) {
      return { ok: false, problem: `${named} needs one non-empty value.` };
    }
    if (!inline) index += 1;
    if (named === TARGET_AGENT) {
      if (targetAgent !== null) {
        return {
          ok: false,
          problem: `${TARGET_AGENT} was given twice by the shim.`,
        };
      }
      targetAgent = value;
    } else {
      if (targetHome !== null) {
        return {
          ok: false,
          problem: `${TARGET_HOME} was given twice by the shim.`,
        };
      }
      targetHome = value;
    }
  }

  if (targetHome !== null && targetAgent === null) {
    return { ok: false, problem: `${TARGET_HOME} needs ${TARGET_AGENT} before ${USER_ARGUMENTS}.` };
  }
  if (plugin && targetAgent === null) {
    return { ok: false, problem: `${PLUGIN_FLAG} needs ${TARGET_AGENT} before ${USER_ARGUMENTS}.` };
  }

  return { ok: true, value: { targetAgent, targetHome, plugin, rest } };
}

export async function main(argv: string[], cwd: string): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }

  const parsed = readShimArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.problem}\n${USAGE}\nRun resume-from --help for details.\n`);
    return 2;
  }
  const { targetAgent, targetHome, plugin, rest } = parsed.value;
  const bareShell = targetAgent === null;

  const outcome = await runCommandBinary({
    argv: rest,
    cwd,
    // Unchecked on purpose: the registry knows which agents exist and says so (FR-56).
    targetAgent: targetAgent === null ? null : (targetAgent as AgentId),
    targetHome: targetHome as HomePath | null,
    plugin,
  });

  // Dim only the summary lines, only in a bare shell on a terminal the user can colour (FR-61).
  const dim = bareShell && process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
  for (const line of dim ? dimSummary(outcome.stdout) : outcome.stdout) {
    process.stdout.write(`${line}\n`);
  }
  for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
  return outcome.exitCode;
}

/** Wrap the first summary line and its indented continuation in ANSI dim. */
function dimSummary(lines: readonly string[]): string[] {
  return lines.map((line, index) => {
    const isSummary =
      line.startsWith("↻ ") ||
      (index > 0 && lines[index - 1]?.startsWith("↻ ") === true && line.startsWith("  "));
    return isSummary ? `\x1b[2m${line}\x1b[22m` : line;
  });
}

/**
 * Run only when this file is the program. `realpathSync` because the installed binary is reached
 * through a symlink in `node_modules/.bin`, and the unresolved path would never match.
 * `process.exitCode` rather than `process.exit`, so the streams above are flushed.
 */
const invokedPath = process.argv[1];
if (invokedPath !== undefined && realpathSync(invokedPath) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.cwd());
}
