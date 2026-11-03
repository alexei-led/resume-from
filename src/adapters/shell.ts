/**
 * The shell form of a native resume command. Every adapter renders through this one function, so
 * quoting cannot differ between agents, and a directory or prompt with a space is handled once.
 */

/** Characters that need no quoting in a POSIX shell. Nothing beyond this is trusted. */
const SAFE_ARGUMENT = /^[A-Za-z0-9_./:=+-]+$/;

/** POSIX single-quote one argument, quoting only when the value needs it. */
export function quoteArgument(value: string): string {
  if (value !== "" && SAFE_ARGUMENT.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** A command line from already separate argv items. */
export function commandLine(argv: readonly string[]): string {
  return argv.map(quoteArgument).join(" ");
}

export interface ResumeCommandParts {
  /** The absolute directory the command must run in. */
  directory: string;
  /** The agent's own argv, each item separate. */
  argv: readonly string[];
  /** Set only when the profile home is not the agent's default home. */
  env?: { name: string; value: string } | null;
}

/** `cd <directory> && [NAME=<value>] <argv...>`. */
export function resumeCommandLine({ directory, argv, env = null }: ResumeCommandParts): string {
  const command = commandLine(argv);
  const withEnv = env === null ? command : `${env.name}=${quoteArgument(env.value)} ${command}`;
  return `cd ${quoteArgument(directory)} && ${withEnv}`;
}
