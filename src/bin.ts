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

const USAGE =
  `Usage: resume-from ${TARGET_AGENT} <agent> [${TARGET_HOME} <path>] ${USER_ARGUMENTS} ` +
  "[<source-agent>] [<row> | <session-id> | <file-path>] [options]";

export const HELP_TEXT = `${USAGE}

Selectors:
  no selector       List sessions available for the current repository.
  <row>             Select a numbered row from that list (1 or greater).
  <session-id>      Select an exact session ID.
  <file-path>       Select a session file by absolute, relative or ~/ path.

Options:
  --agent <name>    Filter source sessions: pi, codex, claude, claude-code, or kimi.
  --home <path>     Search one source home, even one outside the configuration.
  --confirm <token> Import the exact selection and preview identified by the token.
  --target-agent    Target host ID; normally supplied by the installed plugin.
  --target-home     Target agent home; omit to use that agent's default.
  -h, --help        Show this help.

Examples:
  resume-from --target-agent codex --
  resume-from --target-agent codex -- claude 2
  resume-from --target-agent claude-code -- session-id
  resume-from --target-agent codex -- ~/sessions/session.jsonl`;

/** The invocation split in two: what the shim states, and what the user typed. */
export interface ShimArgs {
  /** The agent the shim is running inside. Null when it did not say (FR-56). */
  targetAgent: string | null;
  /** The home that agent is running, or null to use the adapter's declared default (FR-3). */
  targetHome: string | null;
  /** Everything else, in the order it was given. The host's own parser reads it. */
  rest: string[];
}

export type ShimArgsResult = { ok: true; value: ShimArgs } | { ok: false; problem: string };

/**
 * Both forms of both flags are accepted (`--flag value` and `--flag=value`) because a shim is a
 * text file a user edits. A flag with no value is left for the caller to report rather than
 * silently swallowing the argument that follows it.
 */
export function readShimArgs(argv: string[]): ShimArgsResult {
  let targetAgent: string | null = null;
  let targetHome: string | null = null;
  const separator = argv.indexOf(USER_ARGUMENTS);
  if (separator < 0) {
    return {
      ok: false,
      problem: `${USER_ARGUMENTS} is missing after the shim-owned target flags.`,
    };
  }

  const trusted = argv.slice(0, separator);
  const rest = argv.slice(separator + 1);

  for (let index = 0; index < trusted.length; index += 1) {
    const arg = trusted[index];
    if (arg === undefined) continue;

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

  return { ok: true, value: { targetAgent, targetHome, rest } };
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
  const { targetAgent, targetHome, rest } = parsed.value;
  if (targetAgent === null) {
    process.stderr.write(
      `${TARGET_AGENT} is missing: the shim that calls this binary states which agent it is ` +
        `running inside, because guessing it would import into the wrong agent.\n${USAGE}\n` +
        "Run resume-from --help for selectors, options, and examples.\n",
    );
    return 2;
  }

  const outcome = await runCommandBinary({
    argv: rest,
    cwd,
    // Unchecked on purpose: the registry knows which agents exist and says so (FR-56).
    targetAgent: targetAgent as AgentId,
    targetHome: targetHome as HomePath | null,
  });

  for (const line of outcome.stdout) process.stdout.write(`${line}\n`);
  for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
  return outcome.exitCode;
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
