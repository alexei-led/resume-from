import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REFERENCE_SESSION } from "../../../test/fixtures/reference-session.js";
import { createClaudeCodeAdapter } from "./adapter.js";
import type { AgentId, ProvenanceMarker, TargetProfile } from "./contract.js";
import { projectDir } from "./layout.js";
import {
  assistantTextEntry,
  bodyOfLines,
  checksumTree,
  cleanupThrowaways,
  commitPendingFiles,
  type EntryContext,
  makeThrowawayHome,
  referenceEntries,
  userEntry,
  uuidFor,
  writeFileIn,
  writeSessionFile,
} from "./test-support.js";

const REPO = "/work/app";
const SECOND_REPO = "/work/second";

const MARKER: ProvenanceMarker = {
  sourceAgent: "claude-code",
  sourceHome: "/home/testuser/.claude",
  sourceSessionId: "source-1",
  importedAt: "2026-08-02T10:00:00.000Z",
  droppedSummary: "1 tool result body dropped",
  lines: ["Imported from claude-code", "1 tool result body dropped"],
};

function ctx(repo: string, sessionId: string): EntryContext {
  return { cwd: repo, gitBranch: "main", sessionId };
}

afterEach(async () => {
  await cleanupThrowaways();
});

/** A home holding 50 sessions, a project record and a settings file. */
async function populatedHome(): Promise<string> {
  const home = await makeThrowawayHome();
  for (let i = 0; i < 50; i++) {
    const repo = i % 2 === 0 ? REPO : SECOND_REPO;
    const id = uuidFor(i);
    await writeSessionFile(
      home,
      repo,
      id,
      referenceEntries(ctx(repo, id), bodyOfLines(20, "BODY")),
    );
  }
  // Claude Code keeps a per-session sidecar directory beside the session file. The adapter
  // recognises it, so an import into this repository is not refused.
  await writeFileIn(path.join(projectDir(home, REPO), uuidFor(0), "snapshot.json"), "{}");
  await writeFileIn(
    path.join(projectDir(home, REPO), "sessions-index.json"),
    JSON.stringify({ version: 1, entries: [] }),
  );
  await writeFileIn(path.join(projectDir(home, REPO), ".session-aliases"), SECOND_REPO);
  await writeFileIn(path.join(projectDir(home, REPO), "memory", "MEMORY.md"), "project memory");
  await writeFileIn(path.join(home, "settings.json"), JSON.stringify({ theme: "dark" }));
  await writeFileIn(path.join(home, "__store.db"), "SQLite format 3\0pretend-index");
  await writeFileIn(
    path.join(home, "history.jsonl"),
    `${JSON.stringify({ display: "old prompt" })}\n`,
  );
  await writeFileIn(path.join(home, "todos", "abc.json"), "[]");
  return home;
}

describe("T-CC-10 — the module never writes", () => {
  it("leaves the home identical around serialize and validate (FR-49, FR-53)", async () => {
    const home = await populatedHome();
    const before = await checksumTree(home);

    const adapter = createClaudeCodeAdapter();
    const target: TargetProfile = {
      agent: "claude-code",
      home,
      windowTokens: 200_000,
    };
    const serialized = adapter.serialize(REFERENCE_SESSION, target, MARKER, { cwd: REPO });
    expect(adapter.validate(serialized)).toEqual([]);

    expect(await checksumTree(home)).toEqual(before);
  });
});

describe("T-CC-11 — nothing that exists is opened for writing", () => {
  it("adds only new paths and leaves every pre-existing file byte-identical (C-3)", async () => {
    const home = await populatedHome();
    const before = await checksumTree(home);

    const adapter = createClaudeCodeAdapter();
    const target: TargetProfile = {
      agent: "claude-code",
      home,
      windowTokens: 200_000,
    };

    const listed = await adapter.listSessions(home);
    expect(listed).toHaveLength(50);
    const source = await adapter.loadSession(listed[0] as never);
    const serialized = adapter.serialize(source, target, MARKER, { cwd: REPO });
    expect(adapter.validate(serialized)).toEqual([]);
    await commitPendingFiles(serialized.files);
    const facts = await adapter.readBack(home, serialized.sessionId);
    expect(facts.itemCount).toBe(serialized.itemCount);

    const after = await checksumTree(home);
    for (const [file, sum] of before) {
      expect(after.get(file), `${file} changed`).toBe(sum);
    }
    const added = [...after.keys()].filter((file) => !before.has(file));
    expect(added).toEqual([path.relative(home, serialized.files[0]?.absolutePath as string)]);
  });
});

describe("T-CC-12 — an import that would need to modify an existing file is refused", () => {
  it("declares the limitation instead of editing an index (FR-49)", async () => {
    const home = await populatedHome();
    const indexFile = path.join(projectDir(home, REPO), "index.json");
    await writeFileIn(indexFile, JSON.stringify({ sessions: ["existing-000"] }));
    const before = await checksumTree(home);

    const adapter = createClaudeCodeAdapter();
    const target: TargetProfile = {
      agent: "claude-code",
      home,
      windowTokens: 200_000,
    };

    expect(() => adapter.serialize(REFERENCE_SESSION, target, MARKER, { cwd: REPO })).toThrow(
      /index\.json/,
    );
    expect(() => adapter.serialize(REFERENCE_SESSION, target, MARKER, { cwd: REPO })).toThrow(
      /only ever creates new paths/,
    );
    expect(await checksumTree(home)).toEqual(before);
  });

  it("still serves a repository whose record holds only session files", async () => {
    const home = await populatedHome();
    await writeFileIn(path.join(projectDir(home, REPO), "index.json"), "{}");
    const adapter = createClaudeCodeAdapter();
    const target: TargetProfile = {
      agent: "claude-code",
      home,
      windowTokens: 200_000,
    };
    expect(() =>
      adapter.serialize(REFERENCE_SESSION, target, MARKER, { cwd: SECOND_REPO }),
    ).not.toThrow();
  });

  it("accepts the per-session sidecar directory Claude Code creates beside a session", async () => {
    const home = await populatedHome();
    const adapter = createClaudeCodeAdapter();
    const target: TargetProfile = {
      agent: "claude-code",
      home,
      windowTokens: 200_000,
    };
    // The sidecar directory of populatedHome() sits in this repository's record.
    expect(() => adapter.serialize(REFERENCE_SESSION, target, MARKER, { cwd: REPO })).not.toThrow();
  });

  it("ignores the user's own notes, scripts and folders in the project record", async () => {
    const home = await populatedHome();
    const dir = projectDir(home, REPO);
    await writeFileIn(path.join(dir, "briefs", "brief.md"), "a brief");
    await writeFileIn(path.join(dir, "state", "lane.md"), "state");
    await writeFileIn(path.join(dir, "team-rules.md"), "rules");
    await writeFileIn(path.join(dir, "lead.goal"), "goal");
    await writeFileIn(path.join(dir, "launch.sh"), "#!/bin/sh");
    await writeFileIn(path.join(dir, "owners.tsv"), "a\tb");
    const before = await checksumTree(home);
    const adapter = createClaudeCodeAdapter();
    const target: TargetProfile = {
      agent: "claude-code",
      home,
      windowTokens: 200_000,
    };

    expect(() => adapter.serialize(REFERENCE_SESSION, target, MARKER, { cwd: REPO })).not.toThrow();
    expect(await checksumTree(home)).toEqual(before);
  });

  it("accepts current inert project records without modifying them", async () => {
    const home = await populatedHome();
    const before = await checksumTree(home);
    const adapter = createClaudeCodeAdapter();
    const target: TargetProfile = {
      agent: "claude-code",
      home,
      windowTokens: 200_000,
    };

    expect(() => adapter.serialize(REFERENCE_SESSION, target, MARKER, { cwd: REPO })).not.toThrow();
    expect(await checksumTree(home)).toEqual(before);
  });
});

describe("T-CC-13 — source sessions are byte-identical", () => {
  const targets: AgentId[] = ["pi", "codex", "claude-code"];

  it.each(targets)("leaves the source home untouched when importing into %s", async (agent) => {
    const sourceHome = await makeThrowawayHome();
    await writeSessionFile(
      sourceHome,
      REPO,
      "source-1",
      referenceEntries(ctx(REPO, "source-1"), bodyOfLines(400, "BODY")),
    );
    const before = await checksumTree(sourceHome);

    const adapter = createClaudeCodeAdapter();
    const listed = await adapter.listSessions(sourceHome);
    const session = await adapter.loadSession(listed[0] as never);

    // The pi and codex adapters are separate modules; the port they implement is the same,
    // so the source half of the import is exercised for all three and only the claude-code
    // target writes here. T-ADA-14 covers the nine directions across the real adapters.
    if (agent === "claude-code") {
      const targetHome = await makeThrowawayHome(".claude-target");
      const serialized = adapter.serialize(
        session,
        { agent, home: targetHome, windowTokens: 200_000 },
        MARKER,
        { cwd: REPO },
      );
      await commitPendingFiles(serialized.files);
    }

    expect(await checksumTree(sourceHome)).toEqual(before);
  });

  it("never mints a session id that collides with the home (FR-49)", async () => {
    const home = await populatedHome();
    const adapter = createClaudeCodeAdapter();
    const target: TargetProfile = {
      agent: "claude-code",
      home,
      windowTokens: 200_000,
    };
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const serialized = adapter.serialize(REFERENCE_SESSION, target, MARKER, { cwd: REPO });
      ids.add(serialized.sessionId);
      paths.add(serialized.files[0]?.absolutePath as string);
    }
    expect(ids.size).toBe(200);
    expect(paths.size).toBe(200);
    const existing = await checksumTree(home);
    for (const file of paths) {
      expect(existing.has(path.relative(home, file))).toBe(false);
    }
  });

  it("refuses a session id whose file already exists", async () => {
    const home = await makeThrowawayHome();
    const adapter = createClaudeCodeAdapter();
    const target: TargetProfile = {
      agent: "claude-code",
      home,
      windowTokens: 200_000,
    };
    const serialized = adapter.serialize(REFERENCE_SESSION, target, MARKER, { cwd: REPO });
    await commitPendingFiles(serialized.files);
    await expect(commitPendingFiles(serialized.files)).rejects.toThrow(/refusing to overwrite/);
  });

  it("keeps a session written for one repository out of another (FR-13)", async () => {
    const home = await makeThrowawayHome();
    const adapter = createClaudeCodeAdapter();
    const target: TargetProfile = {
      agent: "claude-code",
      home,
      windowTokens: 200_000,
    };
    const serialized = adapter.serialize(REFERENCE_SESSION, target, MARKER, { cwd: REPO });
    await commitPendingFiles(serialized.files);

    await writeSessionFile(home, SECOND_REPO, "other-1", [
      userEntry(
        ctx(SECOND_REPO, "other-1"),
        uuidFor(1),
        "2026-08-01T09:00:00.000Z",
        "other repo work",
      ),
      assistantTextEntry(ctx(SECOND_REPO, "other-1"), uuidFor(2), "2026-08-01T09:00:05.000Z", "ok"),
    ]);

    const listed = await adapter.listSessions(home);
    const mine = listed.filter((descriptor) => descriptor.repoPath === REPO);
    expect(mine.map((descriptor) => descriptor.ref.id)).toEqual([serialized.sessionId]);
  });
});
