// Shared fixtures for this module's tests. Not part of the public surface.
// Stub adapters read real fixture directories, so a missing home, an unreadable
// home and a corrupt session file behave exactly as they would in production.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type {
  AdapterRole,
  AgentCapabilities,
  AgentId,
  CanonicalSession,
  CanonicalTurn,
  HomePath,
  SessionDescriptor,
} from "./contract.js";
import type { SourceAdapter } from "./finder.js";

/** What a fixture session file holds on disk. */
export interface FixtureSession {
  id: string;
  updatedAt: string;
  repoPath: string | null;
  repoPaths?: string[];
  startDirectory?: string | null;
  title?: string;
  startedAt?: string;
  turns?: CanonicalTurn[];
}

/** A temporary directory, with symlinks resolved so comparisons are stable on macOS. */
export async function makeFixtureRoot(): Promise<string> {
  return await realpath(await mkdtemp(path.join(tmpdir(), "resume-from-discovery-")));
}

export async function makeDir(...parts: string[]): Promise<string> {
  const dir = path.join(...parts);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Writes one session file into a home. Returns its absolute path. */
export async function writeSession(home: HomePath, session: FixtureSession): Promise<string> {
  await mkdir(home, { recursive: true });
  const file = path.join(home, `${session.id}.json`);
  await writeFile(file, JSON.stringify(session, null, 2), "utf8");
  return file;
}

export interface StubAdapterOptions {
  agent: AgentId;
  defaultHome: HomePath;
  /** Defaults to the source role only. */
  roles?: AdapterRole[];
  /** When set, loadSession resolves this exact object. */
  loadResult?: CanonicalSession;
  /** Reorders what listSessions returns, to prove the ordering is a total order. */
  permute?: (rows: SessionDescriptor[]) => SessionDescriptor[];
  /** Roots a global lookup expands. Defaults to the home itself. */
  roots?: string[];
  /** Search preference by query shape (FR-61). */
  idLookup?: { v4: number; v7: number; other: number };
}

export interface StubAdapter extends SourceAdapter {
  /** Every home this adapter was asked to search, in call order. */
  readonly calls: HomePath[];
}

export function makeStubAdapter(options: StubAdapterOptions): StubAdapter {
  const calls: HomePath[] = [];
  const capabilities = (): AgentCapabilities => ({
    agent: options.agent,
    roles: options.roles ?? ["source"],
    selection: "numbered-list",
    landing: "create-only",
    provenance: "host-output-only",
    defaultHome: options.defaultHome,
    defaultWindowTokens: 200_000,
    idLookup: options.idLookup ?? { v4: 0, v7: 0, other: 0 },
  });

  async function describeFile(home: HomePath, filePath: string): Promise<SessionDescriptor> {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as FixtureSession;
    return {
      ref: { agent: options.agent, home, id: raw.id },
      title: raw.title ?? raw.id,
      startedAt: raw.startedAt ?? raw.updatedAt,
      updatedAt: raw.updatedAt,
      turnCount: raw.turns?.length ?? 0,
      repoPath: raw.repoPath !== null && path.isAbsolute(raw.repoPath) ? raw.repoPath : null,
      repoPaths:
        raw.repoPaths ??
        (raw.repoPath !== null && path.isAbsolute(raw.repoPath) ? [raw.repoPath] : []),
      startDirectory:
        raw.startDirectory ??
        (raw.repoPath !== null && path.isAbsolute(raw.repoPath) ? raw.repoPath : null),
      filePath,
    };
  }

  return {
    calls,
    capabilities,
    searchRoots: (home?: string) =>
      home === undefined ? (options.roots ?? [options.defaultHome]) : [home],
    async findSessions(root: string, query: string): Promise<SessionDescriptor[]> {
      calls.push(root);
      const names = (await readdir(root).catch(() => [])).filter((n) => n.endsWith(".json"));
      const wanted = query.toLowerCase();
      const rows: SessionDescriptor[] = [];
      for (const name of names) {
        const id = name.slice(0, -".json".length);
        const matches =
          id.toLowerCase() === wanted ||
          (wanted.length >= 6 && id.toLowerCase().startsWith(wanted));
        if (!matches) continue;
        rows.push(await describeFile(options.defaultHome, path.join(root, name)));
      }
      return rows;
    },
    describeSession(filePath: string): Promise<SessionDescriptor> {
      return describeFile(options.defaultHome, filePath);
    },
    async listSessions(home: HomePath): Promise<SessionDescriptor[]> {
      calls.push(home);
      const names = (await readdir(home)).filter((n) => n.endsWith(".json")).sort();
      const rows: SessionDescriptor[] = [];
      for (const name of names) {
        const filePath = path.join(home, name);
        // A corrupt file rejects the whole listing of this home, as a real reader would.
        rows.push(await describeFile(home, filePath));
      }
      return options.permute ? options.permute(rows) : rows;
    },
    async loadSession(descriptor: SessionDescriptor): Promise<CanonicalSession> {
      if (options.loadResult) return options.loadResult;
      const raw = JSON.parse(await readFile(descriptor.filePath, "utf8")) as FixtureSession;
      return {
        provenance: {
          ref: descriptor.ref,
          title: descriptor.title,
          startedAt: descriptor.startedAt,
          updatedAt: descriptor.updatedAt,
          repo: { commit: null, branch: null, changedPaths: [] },
        },
        turns: raw.turns ?? [],
      };
    },
  };
}

/** Content hash of a directory tree: sorted relative paths plus file bytes. */
export async function checksumTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const next = path.posix.join(rel, entry.name);
      if (entry.isSymbolicLink()) {
        hash.update(`L ${next} -> ${await readlink(abs)}\n`);
      } else if (entry.isDirectory()) {
        hash.update(`D ${next}\n`);
        await walk(abs, next);
      } else {
        hash.update(`F ${next}\n`);
        hash.update(await readFile(abs));
      }
    }
  };
  await walk(root, ".");
  return hash.digest("hex");
}

/** Makes every network call fail, so FR-8 is enforced rather than assumed. */
export function stubNetwork(): ReturnType<typeof vi.fn> {
  const blocked = vi.fn(() => {
    throw new Error("network is disabled: discovery reads from disk only (FR-8)");
  });
  vi.stubGlobal("fetch", blocked);
  return blocked;
}

/** Non-Git identity for exact-directory/ordering unit fixtures; worktree tests use real Git. */
export const unresolvedRepo = {
  checkCancellation() {},
  async identify() {
    return { root: null, commonDir: null, isBare: false, head: null, branch: null };
  },
};
