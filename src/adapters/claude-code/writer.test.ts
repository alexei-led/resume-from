import path from "node:path";
import { describe, expect, it } from "vitest";
import { REFERENCE_SESSION } from "../../../test/fixtures/reference-session.js";
import { createClaudeCodeAdapter } from "./adapter.js";
import type { ProvenanceMarker, SerializedSession, TargetProfile } from "./contract.js";
import { encodeProjectPath } from "./layout.js";

const HOME = "/tmp/does-not-need-to-exist/.claude";
const REPO = "/work/app";

const TARGET: TargetProfile = { agent: "claude-code", home: HOME, windowTokens: 200_000 };

const MARKER: ProvenanceMarker = {
  sourceAgent: "codex",
  sourceHome: "/home/testuser/.codex",
  sourceSessionId: REFERENCE_SESSION.provenance.ref.id,
  importedAt: "2026-08-02T10:00:00.000Z",
  droppedSummary: "3 tool result bodies dropped",
  lines: [
    "Imported from codex",
    "Source session 01JQ8Z3K7M4N5P6Q7R8S9T0V1W",
    "3 tool result bodies dropped",
  ],
};

/** The entry types of C-3 this adapter must never write besides its marker and turns. */
const FORBIDDEN_ENTRY_TYPES = [
  "summary",
  "attachment",
  "file-history-snapshot",
  "file-history-delta",
  "mode",
  "last-prompt",
  "queue-operation",
];

function serializeReference(repo = REPO): SerializedSession {
  const adapter = createClaudeCodeAdapter();
  return adapter.serialize(REFERENCE_SESSION, TARGET, MARKER, { cwd: repo });
}

function entriesOf(serialized: SerializedSession): Record<string, unknown>[] {
  const file = serialized.files[0];
  if (file === undefined) throw new Error("serialize produced no file");
  return file.bytes
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("T-CC-4 — serialization writes two entry types and no more", () => {
  const serialized = serializeReference();
  const entries = entriesOf(serialized);

  it("writes one file, and one item per entry (FR-52)", () => {
    expect(serialized.files).toHaveLength(1);
    expect(serialized.itemCount).toBe(entries.length);
    expect(entries.length).toBeGreaterThan(REFERENCE_SESSION.turns.length);
  });

  it("writes the system marker and user and assistant turns (C-9, FR-47)", () => {
    const types = new Set(entries.map((entry) => entry.type));
    expect([...types].sort()).toEqual(["assistant", "system", "user"]);
    for (const forbidden of FORBIDDEN_ENTRY_TYPES) {
      expect(types.has(forbidden)).toBe(false);
    }
  });

  it("writes no tool_use and no thinking block — text only, so a resume never replays a call", () => {
    const blob = JSON.stringify(entries);
    expect(blob).not.toContain('"tool_use"');
    expect(blob).not.toContain('"thinking"');
    expect(blob).not.toContain('"tool_result"');
  });

  it("keeps every tool name unchanged in the target file (FR-27)", () => {
    const blob = JSON.stringify(entries);
    for (const turn of REFERENCE_SESSION.turns) {
      if (turn.toolCall !== null) expect(blob).toContain(turn.toolCall.toolName);
    }
  });

  it("gives every assistant entry the fields Claude Code reads on it", () => {
    for (const entry of entries.filter((item) => item.type === "assistant")) {
      const message = entry.message as Record<string, unknown>;
      expect(typeof message.model).toBe("string");
      expect(String(message.model).length).toBeGreaterThan(0);
      expect(message.usage).toBeTypeOf("object");
      expect(Array.isArray(message.content)).toBe(true);
    }
  });

  it("shows the provenance marker as one gray system entry outside model context (FR-47, FR-48)", () => {
    const first = entries[0];
    expect(first?.type).toBe("system");
    expect(first?.subtype).toBe("informational");
    expect(first?.level).toBe("info");
    expect(first?.isMeta).toBe(false);
    expect(first?.message).toBeUndefined();
    expect(String(first?.content)).toBe(MARKER.lines.join("\n"));
  });

  it("names an imported assistant model that resumes without a restore notice", () => {
    for (const entry of entries.filter((item) => item.type === "assistant")) {
      const message = entry.message as Record<string, unknown>;
      expect(message.model).toBe("<synthetic>");
    }
  });

  it("chains every entry to the one before it", () => {
    expect(entries[0]?.parentUuid).toBeNull();
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]?.parentUuid).toBe(entries[i - 1]?.uuid);
    }
  });

  it("is deterministic apart from the session id it mints", () => {
    const a = serializeReference();
    const b = serializeReference();
    expect(a.sessionId).not.toBe(b.sessionId);

    // Every identifier of the file is derived from the minted session id, so those are the
    // only fields that may differ between two runs of the same session, target and marker.
    const stable = (serialized: SerializedSession) =>
      entriesOf(serialized).map((entry) => {
        const { uuid: _uuid, parentUuid: _parent, sessionId: _session, ...rest } = entry;
        const message = { ...(rest.message as Record<string, unknown>) };
        delete message.id;
        return { ...rest, message };
      });

    expect(stable(a)).toEqual(stable(b));
    expect(a.itemCount).toBe(b.itemCount);
  });
});

describe("T-CC-5 — the session is keyed to the right repository", () => {
  it("places the file under the record of the repository the import runs in", () => {
    const serialized = serializeReference(REPO);
    const expected = path.join(
      HOME,
      "projects",
      encodeProjectPath(REPO),
      `${serialized.sessionId}.jsonl`,
    );
    expect(serialized.files[0]?.absolutePath).toBe(expected);
  });

  it("puts a session for another repository somewhere else, so FR-13's filter separates them", () => {
    const mine = serializeReference(REPO);
    const other = serializeReference("/work/other");
    expect(path.dirname(mine.files[0]?.absolutePath as string)).not.toBe(
      path.dirname(other.files[0]?.absolutePath as string),
    );
    expect(path.dirname(other.files[0]?.absolutePath as string)).toBe(
      path.join(HOME, "projects", encodeProjectPath("/work/other")),
    );
  });

  it("records the repository and branch on every entry", () => {
    const entries = entriesOf(serializeReference());
    for (const entry of entries) {
      expect(entry.cwd).toBe(REPO);
      expect(entry.gitBranch).toBe(REFERENCE_SESSION.provenance.repo.branch);
    }
  });
});

describe("T-CC-9 — validation catches a damaged entry", () => {
  function damaged(
    mutate: (entry: Record<string, unknown>, index: number) => void,
  ): SerializedSession {
    const serialized = serializeReference();
    const entries = entriesOf(serialized);
    entries.forEach(mutate);
    const bytes = Buffer.from(`${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
    const file = serialized.files[0];
    if (file === undefined) throw new Error("serialize produced no file");
    return { ...serialized, files: [{ absolutePath: file.absolutePath, bytes }] };
  }

  it("passes a clean session (FR-50)", () => {
    expect(createClaudeCodeAdapter().validate(serializeReference())).toEqual([]);
  });

  const cases: [string, (entry: Record<string, unknown>, index: number) => void, RegExp][] = [
    [
      "an assistant entry missing a required field",
      (entry) => {
        if (entry.type === "assistant") delete (entry.message as Record<string, unknown>).usage;
      },
      /usage/,
    ],
    [
      "an entry with a malformed timestamp",
      (entry, index) => {
        if (index === 1) entry.timestamp = "yesterday";
      },
      /timestamp/,
    ],
    [
      "an entry with a null message body",
      (entry, index) => {
        if (index === 1) entry.message = null;
      },
      /message/,
    ],
  ];

  it.each(cases)("reports %s", (_name, mutate, pathPattern) => {
    const adapter = createClaudeCodeAdapter();
    const defects = adapter.validate(damaged(mutate));
    expect(defects.length).toBeGreaterThan(0);
    expect(defects.some((defect) => pathPattern.test(defect.path))).toBe(true);
    for (const defect of defects) {
      expect(defect.path).toMatch(/^(files|items|itemCount)/);
      expect(defect.message.length).toBeGreaterThan(0);
    }
  });

  it("reports every defect, not the first (FR-50)", () => {
    const adapter = createClaudeCodeAdapter();
    const defects = adapter.validate(
      damaged((entry, index) => {
        if (index === 1) entry.timestamp = "yesterday";
        if (index === 2) entry.uuid = "";
        if (index === 3) entry.message = null;
      }),
    );
    expect(defects.length).toBeGreaterThanOrEqual(3);
  });

  it("catches a line that is not an entry at all", () => {
    const serialized = serializeReference();
    const file = serialized.files[0];
    if (file === undefined) throw new Error("serialize produced no file");
    const broken = `${file.bytes.toString("utf8")}{"type":"user"`;
    const defects = createClaudeCodeAdapter().validate({
      ...serialized,
      files: [{ absolutePath: file.absolutePath, bytes: Buffer.from(broken, "utf8") }],
    });
    expect(defects.length).toBeGreaterThan(0);
  });

  it("catches an item count that does not match the file (FR-52)", () => {
    const serialized = serializeReference();
    const defects = createClaudeCodeAdapter().validate({
      ...serialized,
      itemCount: 99,
    });
    expect(defects.some((defect) => defect.path === "itemCount")).toBe(true);
  });
});
