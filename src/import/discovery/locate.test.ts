// T-DIS-31 — a global lookup finds one session anywhere, without the repository filter (FR-61).

import { rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionDescriptor } from "./contract.js";
import { createSessionLocator } from "./locate.js";
import { makeDir, makeFixtureRoot, makeStubAdapter, writeSession } from "./test-support.js";

let root: string;

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const V4 = "dc601a22-64e3-410b-9321-bb8f86bdc5ad";
const V7 = "019d1e2f-3a4b-7c5d-8e9f-0123456789ab";

async function scene(): Promise<{
  claudeRoot: string;
  codexRoot: string;
  piRoot: string;
}> {
  root = await makeFixtureRoot();
  return {
    claudeRoot: await makeDir(root, "claude", "projects"),
    codexRoot: await makeDir(root, "codex", "sessions"),
    piRoot: await makeDir(root, "pi", "sessions-work"),
  };
}

function errorOf(value: unknown): { input: string; message: string; name: string } {
  return value as { input: string; message: string; name: string };
}

describe("byId", () => {
  it("finds an exact ID case-insensitively", async () => {
    const { claudeRoot } = await scene();
    await writeSession(claudeRoot, { id: V4, updatedAt: "2026-05-01T08:00:00Z", repoPath: null });
    const locator = createSessionLocator({
      adapters: [
        makeStubAdapter({ agent: "claude-code", defaultHome: claudeRoot, roots: [claudeRoot] }),
      ],
    });

    const found = await locator.byId(V4.toUpperCase());
    expect(found.ref.id).toBe(V4);
  });

  it("finds by a prefix of at least six characters", async () => {
    const { codexRoot } = await scene();
    await writeSession(codexRoot, { id: V7, updatedAt: "2026-05-01T08:00:00Z", repoPath: null });
    const locator = createSessionLocator({
      adapters: [makeStubAdapter({ agent: "codex", defaultHome: codexRoot, roots: [codexRoot] })],
    });

    expect((await locator.byId(V7.slice(0, 8))).ref.id).toBe(V7);
    // Five characters cannot select by prefix.
    const error = await locator.byId(V7.slice(0, 5)).then(
      () => null,
      (reason: unknown) => reasonOf(reason),
    );
    expect(error?.name).toBe("SessionSelectionError");
  });

  it("finds a custom ID", async () => {
    const { piRoot } = await scene();
    const custom = "archfit-feedback-app-20261026";
    await writeSession(piRoot, { id: custom, updatedAt: "2026-05-01T08:00:00Z", repoPath: null });
    const locator = createSessionLocator({
      adapters: [makeStubAdapter({ agent: "pi", defaultHome: piRoot, roots: [piRoot] })],
    });
    expect((await locator.byId("ARCHFIT-FEEDBACK")).ref.id).toBe(custom);
  });

  it("lists every candidate when the query is ambiguous", async () => {
    const { claudeRoot, codexRoot } = await scene();
    await writeSession(claudeRoot, {
      id: V4,
      title: "claude copy",
      updatedAt: "2026-05-01T08:00:00Z",
      repoPath: "/work/app",
    });
    await writeSession(codexRoot, {
      id: V4,
      title: "codex copy",
      updatedAt: "2026-05-02T08:00:00Z",
      repoPath: "/work/app",
    });
    const locator = createSessionLocator({
      adapters: [
        makeStubAdapter({ agent: "claude-code", defaultHome: claudeRoot, roots: [claudeRoot] }),
        makeStubAdapter({ agent: "codex", defaultHome: codexRoot, roots: [codexRoot] }),
      ],
    });

    const error = await locator.byId(V4).then(
      () => null,
      (reason: unknown) => errorOf(reason),
    );
    expect(error?.name).toBe("SessionSelectionError");
    expect(error?.input).toBe(V4);
    expect(error?.message).toContain("matches 2 sessions");
    for (const value of ["claude-code", "codex", claudeRoot, codexRoot, "/work/app"]) {
      expect(error?.message).toContain(value);
    }
    expect(error?.message).toContain("claude copy");
    expect(error?.message).toContain("codex copy");
  });

  it("deduplicates one file reached through two root spellings", async () => {
    const { claudeRoot } = await scene();
    await writeSession(claudeRoot, { id: V4, updatedAt: "2026-05-01T08:00:00Z", repoPath: null });
    const alias = join(root, "alias-projects");
    await symlink(claudeRoot, alias, "dir");
    const locator = createSessionLocator({
      adapters: [
        makeStubAdapter({
          agent: "claude-code",
          defaultHome: claudeRoot,
          roots: [claudeRoot, alias],
        }),
      ],
    });

    expect((await locator.byId(V4)).filePath).toBe(join(claudeRoot, `${V4}.json`));
    expect(await locator.roots()).toEqual([claudeRoot]);
  });

  it("names the roots it searched when nothing matches", async () => {
    const { claudeRoot, codexRoot } = await scene();
    const locator = createSessionLocator({
      adapters: [
        makeStubAdapter({ agent: "claude-code", defaultHome: claudeRoot, roots: [claudeRoot] }),
        makeStubAdapter({ agent: "codex", defaultHome: codexRoot, roots: [codexRoot] }),
      ],
    });

    const error = await locator.byId("no-such-session").then(
      () => null,
      (reason: unknown) => errorOf(reason),
    );
    expect(error?.message).toContain("No session matches");
    expect(error?.message).toContain(claudeRoot);
    expect(error?.message).toContain(codexRoot);
  });

  it("orders the search by the query's ID shape", async () => {
    const { claudeRoot, codexRoot, piRoot } = await scene();
    const order: string[] = [];
    const adapters = [
      makeStubAdapter({
        agent: "pi",
        defaultHome: piRoot,
        roots: [piRoot],
        idLookup: { v4: 2, v7: 1, other: 0 },
      }),
      makeStubAdapter({
        agent: "codex",
        defaultHome: codexRoot,
        roots: [codexRoot],
        idLookup: { v4: 1, v7: 0, other: 1 },
      }),
      makeStubAdapter({
        agent: "claude-code",
        defaultHome: claudeRoot,
        roots: [claudeRoot],
        idLookup: { v4: 0, v7: 2, other: 2 },
      }),
    ];
    for (const adapter of adapters) {
      adapter.findSessions = async () => {
        order.push(adapter.capabilities().agent);
        return [];
      };
    }
    const locator = createSessionLocator({ adapters });

    await locator.byId(V4).catch(() => undefined);
    expect(order).toEqual(["claude-code", "codex", "pi"]);
    order.length = 0;
    await locator.byId(V7).catch(() => undefined);
    expect(order).toEqual(["codex", "pi", "claude-code"]);
    order.length = 0;
    await locator.byId("a-custom-name").catch(() => undefined);
    expect(order).toEqual(["pi", "codex", "claude-code"]);
  });

  it("parses no file whose name does not match", async () => {
    const { claudeRoot } = await scene();
    await writeSession(claudeRoot, { id: V4, updatedAt: "2026-05-01T08:00:00Z", repoPath: null });
    // A corrupt neighbour: any attempt to parse it would throw.
    await writeFile(join(claudeRoot, "broken.json"), "{ not JSON", "utf8");
    const locator = createSessionLocator({
      adapters: [
        makeStubAdapter({ agent: "claude-code", defaultHome: claudeRoot, roots: [claudeRoot] }),
      ],
    });
    expect((await locator.byId(V4)).ref.id).toBe(V4);
  });
});

describe("byPath", () => {
  it("uses the adapter whose root contains the file", async () => {
    const { claudeRoot, codexRoot } = await scene();
    const file = await writeSession(claudeRoot, {
      id: V4,
      updatedAt: "2026-05-01T08:00:00Z",
      repoPath: null,
    });
    const locator = createSessionLocator({
      adapters: [
        makeStubAdapter({ agent: "codex", defaultHome: codexRoot, roots: [codexRoot] }),
        makeStubAdapter({ agent: "claude-code", defaultHome: claudeRoot, roots: [claudeRoot] }),
      ],
    });

    const descriptor: SessionDescriptor = await locator.byPath(file);
    expect(descriptor.ref.agent).toBe("claude-code");
    expect(descriptor.filePath).toBe(file);
  });

  it("rejects a path that is not a session file", async () => {
    const { claudeRoot } = await scene();
    const locator = createSessionLocator({
      adapters: [
        makeStubAdapter({ agent: "claude-code", defaultHome: claudeRoot, roots: [claudeRoot] }),
      ],
    });
    const error = await locator.byPath(join(root, "missing.json")).then(
      () => null,
      (reason: unknown) => reasonOf(reason),
    );
    expect(error?.name).toBe("SessionSelectionError");
    expect(error?.message).toContain("not a session file");
  });
});

function reasonOf(reason: unknown): { input: string; message: string; name: string } {
  if (typeof reason !== "object" || reason === null) throw new Error(String(reason));
  const candidate = reason as { input?: unknown; message?: unknown; name?: unknown };
  return {
    input: String(candidate.input ?? ""),
    message: String(candidate.message ?? ""),
    name: String(candidate.name ?? ""),
  };
}
