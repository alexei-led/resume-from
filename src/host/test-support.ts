/**
 * Test support for `src/host/`.
 *
 * Four kinds of help, because this module's tests are of four kinds: recording stubs that make
 * the construction order observable, fake adapters that declare capabilities without owning a
 * format, static-analysis helpers for the boundary checks, and throwaway homes for the
 * end-to-end directions.
 *
 * Source is read with `node:fs` and parsed with the stable TypeScript 6 compiler-API alias. The
 * TypeScript 7 AST API is unstable, and syntax is the only way to distinguish calls from strings. `src/platform/`
 * has helpers of the same shape; they live in that module's folder, so these are this module's
 * own. Test support only: nothing here is imported by shipped code.
 */

import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript-compiler-api";
import { createFileCommitter } from "../platform/store/index.js";
import type { AgentEntry } from "./agents.js";
import type {
  AdapterRole,
  AgentAdapter,
  AgentCapabilities,
  AgentId,
  CanonicalSession,
  ConfigLoader,
  EstimatorFactory,
  FileCommitter,
  HomePath,
  ImportConfig,
  ProvenanceMarker,
  RepoReader,
  SelectionLevel,
  SessionDescriptor,
  SessionId,
  StoredSessionFacts,
  TargetProfile,
} from "./contract.js";

// `resolve` drops the trailing separator, so path containment compares whole segments.
export const HOST_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
export const SRC_DIR = resolve(HOST_DIR, "..");
export const REPO_DIR = resolve(SRC_DIR, "..");

/** This module's own submodules. Its code is everything in `src/host/` except these. */
export const SUBMODULES = ["cli", "pi-extension"] as const;

// ---------------------------------------------------------------------------
// Source reading and the TypeScript syntax API
// ---------------------------------------------------------------------------

export interface Source {
  /** Absolute path. */
  path: string;
  text: string;
  ast: ts.SourceFile;
}

export function parseSource(path: string, text: string): Source {
  return {
    path,
    text,
    ast: ts.createSourceFile(path, text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS),
  };
}

/**
 * Test files and test-only helpers. `*.test.ts` is the runner's convention (vitest.config.ts);
 * `test-support.ts` and `fixtures.ts` are the repository's name for a helper a test imports.
 */
export function isTestFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf(sep) + 1);
  return name.endsWith(".test.ts") || name === "test-support.ts" || name === "fixtures.ts";
}

export interface ReadOptions {
  /** Include `*.test.ts` and test-only helpers. Default true. */
  tests?: boolean;
  /** Directories to skip, absolute. */
  skip?: readonly string[];
}

/** Every `.ts` file under `dir`, recursively, parsed. */
export function readSources(dir: string, options: ReadOptions = {}): Source[] {
  const includeTests = options.tests ?? true;
  const skip = options.skip ?? [];
  const found: Source[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skip.includes(full)) continue;
      found.push(...readSources(full, options));
    } else if (entry.name.endsWith(".ts") && (includeTests || !isTestFile(full))) {
      found.push(parseSource(full, readFileSync(full, "utf8")));
    }
  }
  return found;
}

/** Path relative to the repository root, with forward slashes, for readable failures. */
export const repoRelative = (path: string): string =>
  path
    .slice(REPO_DIR.length + 1)
    .split(sep)
    .join("/");

export const isInside = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(dir + sep);

const literalText = (node: ts.Expression | undefined): string | undefined =>
  node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;

/** Every module specifier a file names: static, re-exported, dynamic, `require` and `import()`. */
export function importSpecifiers(source: Source): string[] {
  const found: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier !== undefined) found.push(specifier);
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)) {
        found.push(argument.literal.text);
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamic =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require");
      const specifier = literalText(node.arguments[0]);
      if (isDynamic && specifier !== undefined) found.push(specifier);
    }
    ts.forEachChild(node, walk);
  };
  walk(source.ast);
  return found;
}

/** A relative specifier as an absolute path, with the `.js` extension left as written. */
export function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  return resolve(dirname(fromFile), specifier);
}

/**
 * The name of every function a file calls: `writeFile(x)` and `fs.promises.writeFile(x)` both
 * yield `writeFile`. A name inside a string or a comment is not a call and is not returned.
 */
export function callNames(source: Source): { name: string; line: number }[] {
  const calls: { name: string; line: number }[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (name !== undefined) {
        const { line } = source.ast.getLineAndCharacterOfPosition(node.getStart(source.ast));
        calls.push({ name, line: line + 1 });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source.ast);
  return calls;
}

/** Every string literal a file holds, with the line it sits on. */
export function stringLiterals(source: Source): { text: string; line: number }[] {
  const found: { text: string; line: number }[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      const { line } = source.ast.getLineAndCharacterOfPosition(node.getStart(source.ast));
      found.push({ text: node.text, line: line + 1 });
    }
    ts.forEachChild(node, walk);
  };
  walk(source.ast);
  return found;
}

/**
 * The members of a string-literal union: `type AgentId = "pi" | "codex"` yields both. A union of
 * types is not a runtime value, so the only way to compare it with a list is to read the source.
 */
export function unionMembers(source: Source, alias: string): string[] {
  for (const statement of source.ast.statements) {
    if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== alias) continue;
    const node = statement.type;
    const parts = ts.isUnionTypeNode(node) ? node.types : [node];
    return parts.flatMap((part) =>
      ts.isLiteralTypeNode(part) && ts.isStringLiteralLike(part.literal) ? [part.literal.text] : [],
    );
  }
  return [];
}

/** Folders under `dir` that hold a `module.md` — the modules of the design tree. */
export function moduleFolders(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name))
    .filter((path) => readdirSync(path).includes("module.md"))
    .sort();
}

// ---------------------------------------------------------------------------
// Fake adapters — capabilities without a format
// ---------------------------------------------------------------------------

export interface FakeAdapterOptions {
  agent: AgentId;
  roles?: AdapterRole[];
  selection?: SelectionLevel;
  defaultHome?: HomePath;
  defaultWindowTokens?: number;
  /** Rows `listSessions` resolves with. Left out, listing this agent is an error. */
  sessions?: SessionDescriptor[];
}

const notCalled = (agent: AgentId, method: string): never => {
  throw new Error(`the fake ${agent} adapter has no ${method}: this test never reads a session`);
};

/**
 * An adapter that declares capabilities and nothing else. The registry, the profile builder and
 * the entry-point choice read only what is declared, so this is everything they need.
 */
export function fakeAdapter(options: FakeAdapterOptions): AgentAdapter {
  const capabilities: AgentCapabilities = Object.freeze({
    agent: options.agent,
    roles: (options.roles ?? ["source", "target"]) as AdapterRole[],
    selection: options.selection ?? "numbered-list",
    landing: "create-only",
    provenance: "out-of-context-entry",
    defaultHome: options.defaultHome ?? resolve(sep, "fake-home", options.agent),
    defaultWindowTokens: options.defaultWindowTokens ?? 100_000,
  });
  const rows = options.sessions;
  return {
    capabilities: () => capabilities,
    listSessions: () =>
      rows === undefined ? notCalled(options.agent, "listSessions") : Promise.resolve(rows),
    loadSession: () => notCalled(options.agent, "loadSession"),
    serialize: () => notCalled(options.agent, "serialize"),
    validate: () => notCalled(options.agent, "validate"),
    readBack: () => notCalled(options.agent, "readBack"),
    switchTo: () => notCalled(options.agent, "switchTo"),
  };
}

/** A list entry that builds a fake adapter, recording when it was built. */
export function fakeEntry(options: FakeAdapterOptions, onCreate?: () => void): AgentEntry {
  return {
    create: () => {
      onCreate?.();
      return fakeAdapter(options);
    },
    family: "generic",
  };
}

// ---------------------------------------------------------------------------
// Recording stubs — the construction order made observable
// ---------------------------------------------------------------------------

export interface Recorder {
  /** What happened, in the order it happened. */
  events: string[];
  loads: number;
}

export interface RecordingDeps {
  recorder: Recorder;
  configLoader: ConfigLoader;
  createEstimators: () => EstimatorFactory;
  createRepo: () => RepoReader;
  createCommitter: () => FileCommitter;
  agents: readonly AgentEntry[];
}

export interface RecordingOptions {
  agents?: readonly FakeAdapterOptions[];
  config?: Partial<ImportConfig>;
  /** Set to make `load` reject, so nothing downstream may be built (FR-56). */
  configError?: Error;
}

export function testConfig(overrides: Partial<ImportConfig> = {}): ImportConfig {
  return {
    extraHomes: [],
    budgetShare: 0.3,
    pinnedRecentTurns: 5,
    windowOverrides: [],
    ...overrides,
  };
}

const unusedRepo: RepoReader = {
  checkCancellation() {},
  identify: () =>
    Promise.resolve({ root: null, commonDir: null, isBare: false, head: null, branch: null }),
  distanceFrom: () => Promise.resolve({ known: false, ahead: 0, behind: 0 }),
};

const unusedCommitter: FileCommitter = {
  commit: () => Promise.reject(new Error("this test never writes a file")),
};

/** Deps whose every step announces itself, so a test can assert the documented order. */
export function recordingDeps(options: RecordingOptions = {}): RecordingDeps {
  const recorder: Recorder = { events: [], loads: 0 };
  const declared = options.agents ?? [
    { agent: "pi" as AgentId, selection: "interactive-picker" as SelectionLevel },
    { agent: "codex" as AgentId },
    { agent: "claude-code" as AgentId },
  ];
  return {
    recorder,
    configLoader: {
      load: () => {
        recorder.events.push("config");
        recorder.loads += 1;
        return options.configError === undefined
          ? Promise.resolve(testConfig(options.config))
          : Promise.reject(options.configError);
      },
    },
    createEstimators: () => {
      recorder.events.push("service:tokens");
      // Choosing an estimator is work only `pipelineFor` does, so it dates the last step.
      return {
        forFamily: () => {
          recorder.events.push("pipeline");
          return { estimate: () => 0 };
        },
      };
    },
    createRepo: () => {
      recorder.events.push("service:repo");
      return unusedRepo;
    },
    createCommitter: () => {
      recorder.events.push("service:store");
      return unusedCommitter;
    },
    agents: declared.map((agent) =>
      fakeEntry(agent, () => recorder.events.push(`adapter:${agent.agent}`)),
    ),
  };
}

// ---------------------------------------------------------------------------
// Throwaway homes and end-to-end seeding
// ---------------------------------------------------------------------------

const roots: string[] = [];

/** A throwaway directory. Every one of them is removed by `cleanupTempDirs`. */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `resume-from-host-${prefix}-`));
  roots.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

/** The environment variable each agent reads for its default home. */
export const HOME_ENV: Record<string, string> = {
  pi: "PI_CODING_AGENT_DIR",
  codex: "CODEX_HOME",
  "claude-code": "CLAUDE_CONFIG_DIR",
  "kimi-code": "KIMI_CODE_HOME",
};

export interface EnvGuard {
  restore(): void;
}

/** Points every real adapter at a throwaway home. No test may read the user's own (C-3). */
export function withHomes(homes: Record<string, string>): EnvGuard {
  const previous = new Map<string, string | undefined>();
  for (const [agent, home] of Object.entries(homes)) {
    const name = HOME_ENV[agent];
    if (name === undefined) continue;
    previous.set(name, process.env[name]);
    process.env[name] = home;
  }
  return {
    restore(): void {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

/** A marker good enough to serialize with. The landing builds the real one (FR-47). */
export function markerFor(session: CanonicalSession): ProvenanceMarker {
  const { ref, title } = session.provenance;
  return {
    sourceAgent: ref.agent,
    sourceHome: ref.home,
    sourceSessionId: ref.id,
    importedAt: "2026-08-01T10:00:00.000Z",
    droppedSummary: "nothing dropped",
    lines: [`Imported from ${ref.agent} ${ref.id}`, title],
  };
}

/**
 * Writes a session into a home in that agent's own format, using the agent's own serializer and
 * the one module allowed to create files. It is how a source home comes to exist without any
 * test knowing a file layout.
 */
export async function seedSession(
  adapter: AgentAdapter,
  home: HomePath,
  session: CanonicalSession,
  context: { cwd: string },
): Promise<SessionId> {
  const target: TargetProfile = {
    agent: adapter.capabilities().agent,
    home,
    windowTokens: adapter.capabilities().defaultWindowTokens,
  };
  const serialized = adapter.serialize(session, target, markerFor(session), context);
  // One commit per file, in the adapter's order: the store's one-file atomicity stays
  // untouched, and an adapter that orders its files safely leaves no visible partial session.
  for (const file of serialized.files) {
    await createFileCommitter().commit(home, [file]);
  }
  return serialized.sessionId;
}

/** The descriptor of one seeded session, found the way the pipeline finds it. */
export async function descriptorOf(
  adapter: AgentAdapter,
  home: HomePath,
  id: SessionId,
): Promise<SessionDescriptor> {
  const rows = await adapter.listSessions(home);
  const found = rows.find((row) => row.ref.id === id);
  if (found === undefined) {
    throw new Error(`the seeded session ${id} is not in ${home}: ${rows.length} rows listed`);
  }
  return found;
}

export function factsOf(
  adapter: AgentAdapter,
  home: HomePath,
  id: SessionId,
): Promise<StoredSessionFacts> {
  return adapter.readBack(home, id);
}

// A stand-in for Pi's command context belongs in the test file that lands into Pi, not here:
// T-PI-20 reads every non-`*.test.ts` file of `src/` and allows the name `switchSession` in
// `src/adapters/pi/` and `src/host/pi-extension/` alone.
