/**
 * How a global lookup matches a session ID (FR-61). One rule for every adapter: matching by file
 * name is a string comparison, and a second copy would let the agents disagree about what the user
 * typed.
 */

/** The shortest non-exact match. A shorter query must be a whole ID. */
export const MIN_SESSION_ID_PREFIX = 6;

/**
 * True when `id` is the query itself, or starts with a query of at least six characters.
 * Case-insensitive: Claude Code writes some IDs in upper case and the user may type either.
 */
export function sessionIdMatches(id: string, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return false;
  const candidate = id.toLowerCase();
  return (
    candidate === wanted || (wanted.length >= MIN_SESSION_ID_PREFIX && candidate.startsWith(wanted))
  );
}
