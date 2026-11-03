/**
 * The source-role lookup additions: `searchRoots`, `findSessions`, `describeSession` and
 * `resumeCommand`. These are the facts a global lookup and the native `Resume:` line depend on.
 */

import { mkdir, readFile, rename, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { createClaudeCodeAdapter } from "./claude-code/adapter.js";
import { codexAdapterFactory } from "./codex/index.js";
import { searchRoots as codexSearchRoots } from "./codex/rollout.js";
import type { AgentAdapter } from "./contract.js";
import { piUserDraft, writeFixtureSession } from "./pi/fixtures.js";
import { searchRoots as piSearchRoots } from "./pi/format.js";
import { piAdapterFactory } from "./pi/index.js";
import {
  type AdapterCase,
  CLAUDE_CODE_CASE,
  CODEX_CASE,
  cleanupHomes,
  PI_CASE,
  REFERENCE_SESSION,
  seedSource,
  throwawayHome,
} from "./test-support.js";

afterAll(async () => {
  await cleanupHomes();
});

const HOME_HINT = "/home/tester";

function claudeAdapter(homeDir = HOME_HINT) {
  return createClaudeCodeAdapter({ env: {}, homeDir });
}

describe("searchRoots names every profile, including the environment's", () => {
  it("names the configured home and the ~/.claude* profiles", () => {
    const adapter = createClaudeCodeAdapter({
      env: { CLAUDE_CONFIG_DIR: "/profiles/claude-work" },
      homeDir: "/home/tester",
    });
    expect(adapter.searchRoots()).toEqual([
      "/profiles/claude-work/projects",
      "/home/tester/.claude*/projects",
    ]);
  });

  it("names CODEX_HOME and the ~/.codex* profiles", () => {
    expect(codexSearchRoots({ CODEX_HOME: "/profiles/codex" }, "/home/tester")).toEqual([
      "/profiles/codex/sessions",
      "/profiles/codex/archived_sessions",
      "/home/tester/.codex*/sessions",
      "/home/tester/.codex*/archived_sessions",
    ]);
  });

  it("names both Pi overrides and every ~/.pi/agent *sessions* directory", () => {
    expect(
      piSearchRoots(
        {
          PI_CODING_AGENT_DIR: "/profiles/pi-agent",
          PI_CODING_AGENT_SESSION_DIR: "/profiles/pi-sessions",
        },
        "/home/tester",
      ),
    ).toEqual([
      "/profiles/pi-agent/sessions",
      "/profiles/pi-sessions",
      "/home/tester/.pi/agent/*sessions*",
    ]);
  });
});

describe("searchRoots names the roots inside one named home", () => {
  it("maps each named home to its own layout", () => {
    expect(claudeAdapter().searchRoots("/profiles/claude-work")).toEqual([
      "/profiles/claude-work/projects",
    ]);
    expect(codexAdapterFactory.create().searchRoots("/profiles/codex")).toEqual([
      "/profiles/codex/sessions",
      "/profiles/codex/archived_sessions",
    ]);
    expect(piAdapterFactory.create().searchRoots("/profiles/pi")).toEqual([
      "/profiles/pi/*sessions*",
    ]);
  });
});

describe("findSessions matches by ID without parsing a whole home", () => {
  it("finds an exact ID and an uppercase spelling (Claude Code)", async () => {
    const adapter = claudeAdapter();
    const seeded = await seedSource(CLAUDE_CODE_CASE, REFERENCE_SESSION);
    const root = join(seeded.home, "projects");

    const [exact] = await adapter.findSessions(root, seeded.sessionId);
    expect(exact?.ref.id).toBe(seeded.sessionId);
    expect(exact?.filePath).toBe(seeded.filePath);

    const [upper] = await adapter.findSessions(root, seeded.sessionId.toUpperCase());
    expect(upper?.ref.id).toBe(seeded.sessionId);
  });

  it("finds by a prefix of at least six characters (Codex)", async () => {
    const adapter = codexAdapterFactory.create();
    const seeded = await seedSource(CODEX_CASE, REFERENCE_SESSION);
    const root = join(seeded.home, "sessions");

    const [match] = await adapter.findSessions(root, seeded.sessionId.slice(0, 8));
    expect(match?.ref.id).toBe(seeded.sessionId);
    // Fewer than six characters cannot select by prefix.
    expect(await adapter.findSessions(root, seeded.sessionId.slice(0, 5))).toEqual([]);
  });

  it("finds a custom Pi ID under a sessions-work root, and derives its home", async () => {
    const adapter = piAdapterFactory.create();
    const home = await throwawayHome("pi-work");
    writeFixtureSession(home, "/work/app", [piUserDraft("hello")], {
      id: "archfit-feedback-app-20261026",
    });
    await rename(join(home, "sessions"), join(home, "sessions-work"));

    const [match] = await adapter.findSessions(join(home, "sessions-work"), "ARCHFIT-FEEDBACK");
    expect(match?.ref.id).toBe("archfit-feedback-app-20261026");
    expect(match?.ref.home).toBe(home);
  });

  it("never parses a file whose name does not match", async () => {
    const adapter = claudeAdapter();
    const seeded = await seedSource(CLAUDE_CODE_CASE, REFERENCE_SESSION);
    const root = join(seeded.home, "projects");
    // A corrupt file beside the session: parsing it would throw or invent a row.
    await writeFile(join(dirname(seeded.filePath), "not-the-session.jsonl"), "{ not JSONL", "utf8");

    const rows = await adapter.findSessions(root, seeded.sessionId);
    expect(rows.map((row) => row.filePath)).toEqual([seeded.filePath]);
    expect(await adapter.findSessions(root, "zzzzzz")).toEqual([]);
  });
});

describe("Codex archived sessions", () => {
  async function archivedFixture(): Promise<{
    adapter: ReturnType<typeof codexAdapterFactory.create>;
    root: string;
    archived: string;
    sessionId: string;
  }> {
    const adapter = codexAdapterFactory.create();
    const seeded = await seedSource(CODEX_CASE, REFERENCE_SESSION);
    const root = join(seeded.home, "archived_sessions");
    await mkdir(root, { recursive: true });
    const archived = join(root, `${basename(seeded.filePath)}.zst`);
    await writeFile(archived, zstdCompressSync(await readFile(seeded.filePath)));
    return { adapter, root, archived, sessionId: seeded.sessionId };
  }

  it("finds and loads a .jsonl.zst thread modified within 14 days", async () => {
    const { adapter, root, archived, sessionId } = await archivedFixture();
    const [match] = await adapter.findSessions(root, sessionId);
    expect(match?.filePath).toBe(archived);

    if (match === undefined) throw new Error("no archived match");
    const loaded = await adapter.loadSession(match);
    expect(loaded.turns).toHaveLength(REFERENCE_SESSION.turns.length);
  });

  it("does not search an archived thread older than 14 days", async () => {
    const { adapter, root, archived, sessionId } = await archivedFixture();
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    await utimes(archived, old, old);
    expect(await adapter.findSessions(root, sessionId)).toEqual([]);
  });

  it("keeps a readable match when a corrupt rollout shares its ID prefix", async () => {
    const { adapter, root, archived, sessionId } = await archivedFixture();
    const prefix = sessionId.slice(0, 8);
    const corrupt = join(root, `rollout-2026-01-01T00-00-00-${prefix}.jsonl.zst`);
    await writeFile(corrupt, "not a zstd frame");

    const rows = await adapter.findSessions(root, prefix);
    expect(rows.map((row) => row.filePath)).toEqual([archived]);
  });

  it("reports a failure when nothing matching could be read", async () => {
    const adapter = codexAdapterFactory.create();
    const home = await throwawayHome("codexbroken");
    const root = join(home, "archived_sessions");
    await mkdir(root, { recursive: true });
    const id = "019d1e2f-3a4b-7c5d-8e9f-0123456789ab";
    await writeFile(join(root, `rollout-2026-01-01T00-00-00-${id}.jsonl.zst`), "not a zstd frame");

    await expect(adapter.findSessions(root, id.slice(0, 8))).rejects.toThrow();
  });
});

describe("describeSession describes one file directly", () => {
  it("describes a Claude Code file and derives its home", async () => {
    const adapter = claudeAdapter();
    const seeded = await seedSource(CLAUDE_CODE_CASE, REFERENCE_SESSION);
    const descriptor = await adapter.describeSession(seeded.filePath);
    expect(descriptor.ref.id).toBe(seeded.sessionId);
    expect(descriptor.filePath).toBe(seeded.filePath);
    expect(descriptor.ref.home).toBe(seeded.home);
  });

  it("describes a Codex file and derives its home", async () => {
    const adapter = codexAdapterFactory.create();
    const seeded = await seedSource(CODEX_CASE, REFERENCE_SESSION);
    const descriptor = await adapter.describeSession(seeded.filePath);
    expect(descriptor.ref.id).toBe(seeded.sessionId);
    expect(descriptor.ref.home).toBe(seeded.home);
  });

  it("describes a Pi file and derives its home", async () => {
    const adapter = piAdapterFactory.create();
    const seeded = await seedSource(PI_CASE, REFERENCE_SESSION);
    const descriptor = await adapter.describeSession(seeded.filePath);
    expect(descriptor.ref.id).toBe(seeded.sessionId);
    expect(descriptor.ref.home).toBe(seeded.home);
  });

  // A permissive reader would describe any readable JSONL as its own session. The path lookup
  // offers a file outside every root to each adapter in turn, so only a positive identification
  // may accept it (FR-61).
  const foreign: { reader: () => AgentAdapter; source: AdapterCase }[] = [
    {
      reader: () => codexAdapterFactory.create(),
      source: CLAUDE_CODE_CASE,
    },
    {
      reader: () => piAdapterFactory.create(),
      source: CLAUDE_CODE_CASE,
    },
    {
      reader: () => piAdapterFactory.create(),
      source: CODEX_CASE,
    },
    {
      reader: () => createClaudeCodeAdapter({ env: {}, homeDir: HOME_HINT }),
      source: CODEX_CASE,
    },
    {
      reader: () => createClaudeCodeAdapter({ env: {}, homeDir: HOME_HINT }),
      source: PI_CASE,
    },
    {
      reader: () => codexAdapterFactory.create(),
      source: PI_CASE,
    },
  ];

  it.each(foreign)(
    "rejects another agent's file instead of claiming it",
    async ({ reader, source }) => {
      const seeded = await seedSource(source, REFERENCE_SESSION);
      await expect(reader().describeSession(seeded.filePath)).rejects.toThrow();
    },
  );
});

describe("resumeCommand renders a native, safely quoted command", () => {
  it("quotes a directory and prompt that need it (Claude Code)", () => {
    const adapter = claudeAdapter();
    const command = adapter.resumeCommand({
      home: adapter.capabilities().defaultHome,
      directory: "/work/a b",
      sessionId: "dc601a22-64e3-410b-9321-bb8f86bdc5ad",
      filePath: "/work/a b/session.jsonl",
      prompt: "don't stop",
    });
    expect(command).toBe(
      `cd '/work/a b' && claude --resume dc601a22-64e3-410b-9321-bb8f86bdc5ad 'don'"'"'t stop'`,
    );
  });

  it("adds the home variable only when the home is not the default (Claude Code)", () => {
    const adapter = claudeAdapter();
    const command = adapter.resumeCommand({
      home: "/profiles/.claude-team",
      directory: "/work/app",
      sessionId: "id-1",
      filePath: "/x/id-1.jsonl",
      prompt: null,
    });
    expect(command).toBe(
      "cd /work/app && CLAUDE_CONFIG_DIR=/profiles/.claude-team claude --resume id-1",
    );
  });

  it("keeps the active Claude profile explicit when the command opens another terminal", () => {
    const home = "/profiles/.claude-team";
    const adapter = createClaudeCodeAdapter({
      env: { CLAUDE_CONFIG_DIR: home },
      homeDir: HOME_HINT,
    });
    expect(
      adapter.resumeCommand({
        home,
        directory: "/work/app",
        sessionId: "id-1",
        filePath: "/x/id-1.jsonl",
        prompt: null,
      }),
    ).toBe("cd /work/app && CLAUDE_CONFIG_DIR=/profiles/.claude-team claude --resume id-1");
  });

  it("adds CODEX_HOME only for a non-default Codex home", () => {
    const adapter = codexAdapterFactory.create();
    expect(
      adapter.resumeCommand({
        home: adapter.capabilities().defaultHome,
        directory: "/work/app",
        sessionId: "id-1",
        filePath: "/x/id-1.jsonl",
        prompt: null,
      }),
    ).toBe("cd /work/app && codex resume id-1");
    expect(
      adapter.resumeCommand({
        home: "/profiles/codex-work",
        directory: "/work/app",
        sessionId: "id-1",
        filePath: "/x/id-1.jsonl",
        prompt: "go on",
      }),
    ).toBe("cd /work/app && CODEX_HOME=/profiles/codex-work codex resume id-1 'go on'");
  });

  it("resumes Pi by session file", () => {
    const adapter = piAdapterFactory.create();
    expect(
      adapter.resumeCommand({
        home: "/homes/pi",
        directory: "/work/app",
        sessionId: "id-1",
        filePath: "/homes/pi/sessions/--work-app--/x_id-1.jsonl",
        prompt: "continue",
      }),
    ).toBe("cd /work/app && pi --session /homes/pi/sessions/--work-app--/x_id-1.jsonl continue");
  });

  it("ends option scanning before a prompt that starts with a dash", () => {
    const adapter = claudeAdapter();
    // Quoting cannot change argv parsing: without `--`, `--help` resumes as a flag.
    expect(
      adapter.resumeCommand({
        home: adapter.capabilities().defaultHome,
        directory: "/work/app",
        sessionId: "id-1",
        filePath: "/x/id-1.jsonl",
        prompt: "--help",
      }),
    ).toBe("cd /work/app && claude --resume id-1 -- --help");
  });
});

describe("inPlaceCommand names what the user types in the running agent", () => {
  const id = "dc601a22-64e3-410b-9321-bb8f86bdc5ad";

  it.each([
    ["Claude Code", () => claudeAdapter(), `/resume ${id}`],
    ["Codex", () => codexAdapterFactory.create(), `/resume ${id}`],
    ["Pi, which switches itself", () => piAdapterFactory.create(), null],
  ] as const)("%s", (_name, adapter, expected) => {
    expect(adapter().inPlaceCommand(id)).toBe(expected);
  });
});
