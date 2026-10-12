import { describe, expect, it } from "vitest";
import * as claudeCode from "./claude-code/redaction.js";
import * as codex from "./codex/redaction.js";
import * as kimiCode from "./kimi-code/redaction.js";
import * as pi from "./pi/redaction.js";

const IMPLEMENTATIONS = [
  ["pi", pi],
  ["codex", codex],
  ["claude-code", claudeCode],
  ["kimi-code", kimiCode],
] as const;

describe.each(IMPLEMENTATIONS)("%s credential redaction", (_name, redaction) => {
  it("redacts sensitive keys and every value in environment maps", () => {
    expect(
      redaction.redactSensitiveStructure({
        api_key: "sk-12345678901234567890",
        nested: { refreshToken: "refresh-value" },
        env: { NORMAL_NAME: "also-private", PORT: 3000 },
        path: "src/token-refresh.ts",
      }),
    ).toEqual({
      api_key: redaction.REDACTED_VALUE,
      nested: { refreshToken: redaction.REDACTED_VALUE },
      env: {
        NORMAL_NAME: redaction.REDACTED_VALUE,
        PORT: redaction.REDACTED_VALUE,
      },
      path: "src/token-refresh.ts",
    });
  });

  it("redacts command assignments, exact secret flags, headers, tokens, and private keys", () => {
    const source = [
      "OPENAI_API_KEY=sk-12345678901234567890 node app.js --token github_pat_123456789012345678901234",
      "Authorization: Bearer abc.def.ghi",
      "X-Api-Key: plain-secret",
      "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
    ].join("\n");
    const redacted = redaction.redactSensitiveText(source);

    for (const secret of [
      "sk-12345678901234567890",
      "github_pat_123456789012345678901234",
      "abc.def.ghi",
      "plain-secret",
      "private-material",
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain(redaction.REDACTED_VALUE);
  });

  it("preserves normal token-related filenames and non-secret options", () => {
    const source = "rg refreshToken src/token-refresh.ts --token-file fixtures/token.json";
    expect(redaction.redactSensitiveText(source)).toBe(source);
  });

  it.each([
    ["HTTP userinfo", "curl https://alice:supersecret@example.com/api", "supersecret"],
    ["database URI", "psql postgresql://alice:database-secret@db/prod", "database-secret"],
    ["curl short user flag", "curl -u alice:curl-secret https://example.com", "curl-secret"],
    [
      "curl long user flag",
      "curl --user='alice:quoted secret' https://example.com",
      "quoted secret",
    ],
  ])("redacts %s credentials in unstructured text", (_case, source, secret) => {
    const redacted = redaction.redactSensitiveText(source);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain(redaction.REDACTED_VALUE);
  });

  it("keeps JSON valid while redacting nested values", () => {
    const redacted = redaction.redactSensitiveArgumentsText(
      JSON.stringify({
        command: "API_KEY=top-secret npm test",
        path: "src/token.test.ts",
      }),
    );
    expect(JSON.parse(redacted)).toEqual({
      command: `API_KEY=${redaction.REDACTED_VALUE} npm test`,
      path: "src/token.test.ts",
    });
  });

  it("redacts split argv and structured user credentials", () => {
    const redacted = redaction.redactSensitiveStructure({
      command: ["curl", "-u", "alice:array-secret", "https://example.com"],
      nested: { user: "alice:object-secret" },
    });
    const canonical = JSON.stringify(redacted);

    expect(canonical).not.toContain("array-secret");
    expect(canonical).not.toContain("object-secret");
    expect(canonical).toContain(redaction.REDACTED_VALUE);
  });

  it("redacts a credential pasted as plain message text (FR-28, security)", () => {
    // A user who types 'curl -H "Authorization: Bearer sk-abc123" ...' as a message turn must
    // not have that token forwarded to a different model vendor when the session is resumed.
    const bearer = "sk-1234567890abcdef1234";
    const source = `can you run: curl -H "Authorization: Bearer ${bearer}" https://api.example.com`;
    const redacted = redaction.redactSensitiveText(source);

    expect(redacted).not.toContain(bearer);
    expect(redacted).toContain(redaction.REDACTED_VALUE);
  });

  // JSON_LIKE_PATTERN must not fire on bare prose words that follow a sensitive key name.
  // "token: word" in natural language is not a credential; only "token: word" in JSON/YAML
  // structure (where the value is bounded by ,;} or line-end) should be redacted (C-RED-1).
  it.each([
    ["no colon after key word", "please refactor the auth token refresh logic in src/auth.ts"],
    ["colon but value followed by space", "The current token: expired (error 401)"],
    ["colon but value mid-sentence", "The auth token: refresh the cache"],
  ])("leaves normal prose untouched: %s", (_label, prose) => {
    expect(redaction.redactSensitiveText(prose)).toBe(prose);
  });

  // The delimiter rule alone would also skip a real secret sitting mid-line; a digit in the
  // value keeps recall: opaque tokens carry digits, English words do not (C-RED-1).
  it.each([
    ["shell comment after the value", "password: hunter2 # prod box"],
    ["more flags after the value", "token: abc123 verbose true"],
  ])("still redacts a digit-bearing secret mid-line: %s", (_label, text) => {
    const redacted = redaction.redactSensitiveText(text);
    expect(redacted).toContain(redaction.REDACTED_VALUE);
    expect(redacted).not.toMatch(/hunter2|abc123/);
  });

  // A long unbroken line made the *name* pattern backtrack over the whole run at every start
  // position: 50 KB of one word took 11.8 s and 100 KB never finished (FR-28, security). The name is
  // bounded now, and this is the shape that must stay cheap.
  it("redacts a long unbroken line without backtracking over the whole run (FR-28)", () => {
    const line = "y".repeat(200_000);

    expect(redaction.redactSensitiveText(line)).toBe(line);
  });

  // Every `key:` on a separator-dense line is a value match attempt, so the value alternatives must
  // not each scan the rest of the line (FR-28).
  it("redacts a separator-dense line without rescanning it per key (FR-28)", () => {
    const line = `${"x".repeat(64)}:`.repeat(4_000);

    expect(redaction.redactSensitiveText(line)).toBe(line);
  });

  // A quoted key of any length keeps its value redacted (FR-28): the pattern matches it whole.
  it("redacts the value of a quoted key longer than the bound (FR-28)", () => {
    const longName = `${"x".repeat(58)}_password`;

    // The value's own quotes are part of the match.
    expect(redaction.redactSensitiveText(`{"${longName}": "hunter2"}`)).toBe(
      `{"${longName}": ${redaction.REDACTED_VALUE}}`,
    );
    expect(redaction.redactSensitiveText(`{'${longName}': 'hunter2'}`)).toBe(
      `{'${longName}': ${redaction.REDACTED_VALUE}}`,
    );
  });

  // A bounded scan cannot decide a long value, and a partial match would leave most of a credential
  // in place: a long unquoted token is taken whole, which is the kubeconfig case (FR-28).
  it.each([
    ["a service-account JWT", `    token: ${"eyJhbGciOiJSUzI1NiJ9."}${"QQ".repeat(300)}.c2ln`],
    ["a 200-character secret with no digit", `client_secret: ${"Q".repeat(200)}`],
    ["letters and a final digit", `token: ${"a".repeat(130)}7`],
    ["a digit first, then letters", `password: 1${"a".repeat(299)}`],
    ["a URL-encoded tail", `token: ${"A".repeat(150)}%2B${"TAIL".repeat(40)}`],
    ["a tilde in the middle", `client_secret: ${"Q".repeat(140)}~${"TAIL".repeat(40)}`],
    ["a colon-joined pair", `token: ${"a".repeat(200)}:${"b".repeat(200)}`],
    ["an encoded character early", `refresh_token: ${"A".repeat(20)}%2F${"B".repeat(300)}`],
    ["a 4200-character token", `token: ${"A".repeat(4200)}`],
    // A pass that replaces part of a value must not hide the rest from this one.
    ["a vendor token with a tilde inside", `token: sk-${"A1".repeat(150)}~${"TAIL".repeat(25)}`],
    ["a sensitive key inside the value", `token: ${"Q".repeat(60)}secret:${"z".repeat(119)}9`],
    ["a vendor token with a dot inside", `password: ghp_${"A".repeat(150)}.${"B".repeat(100)}`],
  ])("redacts a long unquoted value under a sensitive key: %s (FR-28)", (_label, text) => {
    const redacted = redaction.redactSensitiveText(text);
    expect(redacted).toContain(redaction.REDACTED_VALUE);
    // The value is taken to its end: no part of it may be left behind the marker.
    expect(redacted).toMatch(/\[REDACTED\]$/);
    expect(redacted).not.toMatch(/a{20}|A{20}|b{20}|B{20}|Q{20}|eyJ|TAIL/);
  });
});
