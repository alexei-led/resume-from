/**
 * The shell form of a native resume command. Every adapter renders through this one function, so
 * quoting cannot differ between agents, and a directory or prompt with a space is handled once.
 */

/** Characters that need no quoting in a POSIX shell. Nothing beyond this is trusted. */
const SAFE_ARGUMENT = /^[A-Za-z0-9_./:=+-]+$/;

/** POSIX single-quote one argument, quoting only when the value needs it. */
function quoteArgument(value: string): string {
  if (value !== "" && SAFE_ARGUMENT.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** A command line from already separate argv items. */
function commandLine(argv: readonly string[]): string {
  return argv.map(quoteArgument).join(" ");
}

interface ResumeCommandParts {
  /** The absolute directory the command must run in. */
  directory: string;
  /** The agent's own argv, each item separate. */
  argv: readonly string[];
  /** Set only when the profile home is not the agent's default home. */
  env?: { name: string; value: string } | null;
  /** Appended as one argv item when it names an initial prompt (FR-61). */
  prompt?: string | null;
}

/** The end-of-options marker every agent CLI accepts; needed when the prompt starts with `-`. */
const END_OF_OPTIONS = "--";

/** `cd <directory> && [NAME=<value>] <argv...> [<prompt>]`. */
export function resumeCommandLine({
  directory,
  argv,
  env = null,
  prompt = null,
}: ResumeCommandParts): string {
  // A prompt is one argv item, not a shell string: quoting cannot stop `-x` being read as an
  // option. The agents' parsers end option scanning at `--`, so a prompt that looks like a
  // flag is placed behind it.
  const fullArgv =
    prompt === null || prompt === ""
      ? argv
      : [...argv, ...(prompt.startsWith("-") ? [END_OF_OPTIONS] : []), prompt];
  const command = commandLine(fullArgv);
  const withEnv = env === null ? command : `${env.name}=${quoteArgument(env.value)} ${command}`;
  return `cd ${quoteArgument(directory)} && ${withEnv}`;
}
