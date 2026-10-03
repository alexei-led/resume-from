/**
 * Credential redaction — shared implementation kept in three adapter subfolders.
 *
 * Files:
 *   src/adapters/claude-code/redaction.ts
 *   src/adapters/codex/redaction.ts
 *   src/adapters/pi/redaction.ts
 *
 * These three files are byte-identical by design. A fix in one MUST be applied to all three.
 * src/adapters/boundary.test.ts asserts byte equality and will fail if they drift.
 *
 * Why not a single shared module: src/adapters/contract.ts is types-only (no behaviour). A
 * platform service would be imported as behaviour, and T-ROO-7 requires adapter-to-platform
 * cross-module imports to go through contract.js — which can only export types, not functions.
 */

/** Stable replacement used for credentials that must not cross an adapter boundary. */
export const REDACTED_VALUE = "[REDACTED]";

const ENVIRONMENT_KEYS = new Set(["env", "environment", "environmentvariables"]);
const SENSITIVE_KEYS = new Set([
  "authorization",
  "clientsecret",
  "cookie",
  "credentials",
  "password",
  "passwd",
  "privatekey",
  "proxyauthorization",
  "secret",
  "setcookie",
  "signingkey",
  "token",
]);

const PRIVATE_KEY_PATTERN = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;
const AUTHORIZATION_PATTERN =
  /(\b(?:authorization|proxy-authorization)\s*:\s*)(?:Bearer|Basic)\s+[^\s,;]+/gi;
const API_HEADER_PATTERN = /(\b(?:x-api-key|api-key|x-auth-token)\s*:\s*)[^\s,;]+/gi;
const CREDENTIAL_PATTERN =
  /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g;
const ASSIGNMENT_PATTERN =
  /\b([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|]+)/g;
const FLAG_PATTERN =
  /(--(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|password|passwd|secret|client[-_]?secret|private[-_]?key))(=|\s+)("[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|]+)/gi;
const USER_CREDENTIAL_PATTERN = /(^|[\s;&|])(-u|--user)(=|\s+)("[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|]+)/g;
const URI_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi;
// Unquoted value requires a structural delimiter or line/string end following it, OR a digit
// somewhere in the token (C-RED-1: "token: expired" is plain English and stays, while
// "password: hunter2 # prod" carries a credential that must not cross even mid-line). The value is
// taken whole, however long it is, so a credential can never be left half-redacted (FR-28).
// A quoted key is matched whole and an unquoted one up to 64 characters: an unbounded identifier run
// makes the engine backtrack over the whole run at every start position, which is quadratic on a
// long unbroken line (measured: 50 KB of one word took 11.8 s and 100 KB never finished). A longer
// unquoted run still matches through its last 64 characters, and `isSensitiveKey` decides by the
// name's tail as well as by its whole text, so nothing the unbounded name found is hidden.
const JSON_LIKE_PATTERN =
  /(?:(?<quote>["'])(?<quoted>[A-Za-z_][A-Za-z0-9_-]*)\k<quote>|(?<bare>[A-Za-z_][A-Za-z0-9_-]{0,63}))(\s*:\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+(?=[,;}]|[\r\n]|$)|[^\s,;}]*\d[^\s,;}]*)/g;

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    SENSITIVE_KEYS.has(normalized) ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesskey") ||
    normalized.endsWith("password") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("token")
  );
}

function redactEnvironmentValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactEnvironmentValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value).map((key) => [
        key,
        redactEnvironmentValue((value as Record<string, unknown>)[key]),
      ]),
    );
  }
  return value === undefined ? undefined : REDACTED_VALUE;
}

function redactSensitiveArray(values: unknown[]): unknown[] {
  const redacted = values.map(redactSensitiveStructure);
  for (let index = 0; index < values.length - 1; index += 1) {
    const flag = values[index];
    if (
      typeof flag === "string" &&
      (flag.trim() === "-u" || flag.trim() === "--user") &&
      typeof values[index + 1] === "string"
    ) {
      redacted[index + 1] = REDACTED_VALUE;
    }
  }
  return redacted;
}

/**
 * Redact credentials in JSON-like tool inputs without changing the caller's value.
 * Adapter-specific parsing stays in each adapter; this function only handles secret values.
 */
export function redactSensitiveStructure(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return redactSensitiveArray(value);
  if (typeof value !== "object" || value === null) return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      redacted[key] = REDACTED_VALUE;
    } else if (
      (normalizedKey(key) === "user" || normalizedKey(key) === "username") &&
      typeof child === "string" &&
      child.includes(":")
    ) {
      redacted[key] = REDACTED_VALUE;
    } else if (ENVIRONMENT_KEYS.has(normalizedKey(key))) {
      redacted[key] = redactEnvironmentValue(child);
    } else {
      redacted[key] = redactSensitiveStructure(child);
    }
  }
  return redacted;
}

/** Redact recognizable credentials from shell commands, headers, and unstructured arguments. */
export function redactSensitiveText(text: string): string {
  return text
    .replace(PRIVATE_KEY_PATTERN, REDACTED_VALUE)
    .replace(AUTHORIZATION_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(API_HEADER_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(FLAG_PATTERN, `$1$2${REDACTED_VALUE}`)
    .replace(USER_CREDENTIAL_PATTERN, `$1$2$3${REDACTED_VALUE}`)
    .replace(URI_USERINFO_PATTERN, `$1$2:${REDACTED_VALUE}@`)
    .replace(ASSIGNMENT_PATTERN, (match, key: string, separator: string) =>
      isSensitiveKey(key) ? `${key}${separator}${REDACTED_VALUE}` : match,
    )
    .replace(
      JSON_LIKE_PATTERN,
      (
        match,
        quote: string | undefined,
        quoted: string | undefined,
        bare: string | undefined,
        separator: string,
      ) => {
        const key = quoted ?? bare;
        if (key === undefined || !isSensitiveKey(key)) return match;
        // Only the value is replaced; the quoting and the separator stay as they were recorded.
        const name = quote === undefined ? key : `${quote}${key}${quote}`;
        return `${name}${separator}${REDACTED_VALUE}`;
      },
    )
    .replace(CREDENTIAL_PATTERN, REDACTED_VALUE);
}

/** Redact a source-recorded argument string, preserving valid JSON when it is JSON. */
export function redactSensitiveArgumentsText(text: string): string {
  try {
    return JSON.stringify(redactSensitiveStructure(JSON.parse(text)));
  } catch {
    return redactSensitiveText(text);
  }
}
