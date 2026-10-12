/**
 * Test support for the root module.
 *
 * The root's own code is one factory, so most of its tests are system-wide invariants: the design
 * tree against the source tree, the coupling assessment against the folder tree, the one write
 * path, the absence of a field. Those cannot be checked by running anything, so the helpers here
 * are of two kinds — static analysis of the source and of the design documents, and a throwaway
 * scene the composed system can actually run in.
 *
 * Source is read with `node:fs` and parsed with the stable TypeScript 6 compiler-API alias. The
 * TypeScript 7 AST API is unstable, and syntax is the only way to distinguish calls from strings. `src/platform/`
 * and `src/host/` have helpers of the same shape; they live in those modules' folders, so these
 * are this module's own. Test support only: nothing here is imported by shipped code.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript-compiler-api";
import { createFixtureAgentAdapter } from "../test/fixtures/fixture-agent/index.js";
import { REFERENCE_SESSION } from "../test/fixtures/reference-session.js";
import type {
  AgentAdapter,
  AgentId,
  CanonicalSession,
  HomePath,
  ProvenanceMarker,
  SessionDescriptor,
  SessionId,
  TargetProfile,
} from "./host/contract.js";
import { AGENTS, type AgentEntry } from "./host/index.js";
import { createHost, type Host, type HostDeps } from "./index.js";

// `resolve` drops the trailing separator, so path containment compares whole segments.
export const SRC_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
export const REPO_DIR = resolve(SRC_DIR, "..");

/** This module's own submodules. Its code is everything in `src/` except these. */
export const SUBMODULES = ["adapters", "host", "import", "platform", "session"] as const;

/** Path relative to the repository root, with forward slashes, for readable failures. */
export const repoRelative = (path: string): string => relative(REPO_DIR, path).split(sep).join("/");

export const isInside = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(dir + sep);

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
}

/** Every `.ts` file under `dir`, recursively, parsed. */
export function readSources(dir: string, options: ReadOptions = {}): Source[] {
  const includeTests = options.tests ?? true;
  const found: Source[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...readSources(full, options));
    } else if (entry.name.endsWith(".ts") && (includeTests || !isTestFile(full))) {
      found.push(parseSource(full, readFileSync(full, "utf8")));
    }
  }
  return found;
}

/** Every shipped file of the tree: tests and test-only helpers are not the design. */
export const shippedSources = (): Source[] => readSources(SRC_DIR, { tests: false });

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

export interface FsBindings {
  /** Local name to the `node:fs` export it was imported under, so a rename hides nothing. */
  named: Map<string, string>;
  /** Local names bound to the whole module: `import * as fs`, `import fs from`. */
  namespaces: Set<string>;
}

/** What a file pulled in from `node:fs` or `node:fs/promises`, however it spelled it. */
export function fsBindings(source: Source): FsBindings {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of source.ast.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = literalText(statement.moduleSpecifier);
    if (specifier !== "node:fs" && specifier !== "node:fs/promises") continue;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined) namespaces.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else
      for (const element of bindings.elements) {
        named.set(element.name.text, (element.propertyName ?? element.name).text);
      }
  }
  return { named, namespaces };
}

/** Local names bound to a `node:fs` export, so a rename cannot hide a write. */
export const fsAliases = (source: Source): Map<string, string> => fsBindings(source).named;

/**
 * Calls of a `node:fs` function, and only those. A local helper named `truncate` is not a
 * filesystem call, so the callee is resolved to what the file actually imported: an identifier
 * bound by a named import, or a property of a namespace binding — `fs.writeFile` and
 * `fs.promises.writeFile` alike.
 */
export function fsCalls(
  source: Source,
  wanted: ReadonlySet<string>,
): { name: string; line: number }[] {
  const { named, namespaces } = fsBindings(source);
  const rootOf = (node: ts.Node): string | undefined => {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) return rootOf(node.expression);
    return undefined;
  };

  const found: { name: string; line: number }[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let name: string | undefined;
      if (ts.isIdentifier(callee)) {
        name = named.get(callee.text);
      } else if (ts.isPropertyAccessExpression(callee)) {
        const root = rootOf(callee.expression);
        if (root !== undefined && namespaces.has(root)) name = callee.name.text;
      }
      if (name !== undefined && wanted.has(name)) {
        const { line } = source.ast.getLineAndCharacterOfPosition(node.getStart(source.ast));
        found.push({ name, line: line + 1 });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source.ast);
  return found;
}

/** The members of a string-literal union: `type AgentId = "pi" | "codex"` yields both. */
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

export interface TypeMember {
  /** The interface the member belongs to. */
  owner: string;
  name: string;
  /** The declared type, as written. Empty for a method. */
  type: string;
  /** True for a method signature rather than a data field. */
  isMethod: boolean;
}

/**
 * Every property and method of every interface a file declares. A field is where a value can be
 * kept; a method parameter is not, which is why the two are told apart here.
 */
export function interfaceMembers(source: Source): TypeMember[] {
  const members: TypeMember[] = [];
  for (const statement of source.ast.statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue;
    for (const member of statement.members) {
      const name = member.name === undefined ? "" : member.name.getText(source.ast);
      if (ts.isMethodSignature(member)) {
        members.push({
          owner: statement.name.text,
          name,
          type: "",
          isMethod: true,
        });
      } else if (ts.isPropertySignature(member)) {
        members.push({
          owner: statement.name.text,
          name,
          type: member.type?.getText(source.ast) ?? "",
          isMethod: false,
        });
      } else if (ts.isIndexSignatureDeclaration(member)) {
        // An index signature is a field with any name at all: named so a test can refuse it.
        members.push({
          owner: statement.name.text,
          name: "[index signature]",
          type: member.type?.getText(source.ast) ?? "",
          isMethod: false,
        });
      }
    }
  }
  return members;
}

/** Everything a file exports by name, whether declared here or re-exported from elsewhere. */
export function exportedNames(source: Source): string[] {
  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

  const names: string[] = [];
  for (const statement of source.ast.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause)) {
        names.push(...clause.elements.map((element) => element.name.text));
      }
    } else if (isExported(statement)) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
        }
      } else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement)) &&
        statement.name !== undefined
      ) {
        names.push(statement.name.text);
      }
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// The design tree
// ---------------------------------------------------------------------------

/** Every folder under `dir` that holds a `module.md`, recursively, plus `dir` itself. */
export function moduleFolders(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    if (readdirSync(current).includes("module.md")) found.push(current);
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(current, entry.name));
    }
  };
  walk(dir);
  return found.sort();
}

/** Every folder under `dir`, recursively, whether it is a module or not. */
export function allFolders(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(current, entry.name);
      found.push(full);
      walk(full);
    }
  };
  walk(dir);
  return found.sort();
}

/** A module's design document, addressed the way its own metadata addresses it: `src/host/cli`. */
export const modulePath = (dir: string): string => repoRelative(dir);

export const documentOf = (dir: string): string => readFileSync(join(dir, "module.md"), "utf8");

/** The headings of a design document, without the leading `## `. */
export const headings = (text: string): string[] =>
  [...text.matchAll(/^## (.+)$/gm)].map((match) => (match[1] ?? "").trim());

/** The body of one `## ` section, up to the next one. */
export function section(text: string, name: string): string | null {
  const start = new RegExp(`^## ${name}\\s*$`, "m").exec(text);
  if (start === null) return null;
  const from = start.index + start[0].length;
  const next = text.slice(from).search(/^## /m);
  return next === -1 ? text.slice(from) : text.slice(from, from + next);
}

// ---------------------------------------------------------------------------
// Contract restatement validation
// ---------------------------------------------------------------------------

/** One module document supplied to the project-owned restatement validator. */
export interface ModuleDocument {
  /** Repository-relative path, for example `src/host/module.md`. */
  path: string;
  text: string;
}

/** One actionable defect in a contract restatement. */
export interface RestatementDefect {
  document: string;
  line: number;
  type: string;
  message: string;
}

interface ContractMarker {
  document: string;
  line: number;
  types: string[];
  owner: string;
  subset: boolean;
  fence: ContractFence;
}

interface ContractFence {
  document: string;
  openLine: number;
  code: string;
}

interface ContractDeclaration {
  document: string;
  line: number;
  name: string;
  lines: string[];
}

const CONTRACT_MARKER =
  /^<!--\s*contract:\s*(.+?)\s+(?:—|–|-{1,2})\s+restated from\s+(\S+?)(?:\s+\(\s*subset:\s*([^)]*?)\s*\))?\s*-->$/u;
const CONTRACT_MARKER_START = "<!-- contract:";
const CODE_FENCE = /^```[^`\s]*\s*$/u;

/**
 * Checks every contract marker without a personal plugin, Python, or a subprocess.
 * Exact restatements match declaration-for-declaration. A marker that explicitly
 * declares a subset may omit owner lines, but may not add or rewrite them.
 */
export function validateContractRestatements(
  documents: readonly ModuleDocument[],
): RestatementDefect[] {
  const defects: RestatementDefect[] = [];
  const byPath = new Map(
    documents.map((document) => [normalizeDocumentPath(document.path), document]),
  );
  const ownerDeclarations = new Map<string, Map<string, ContractDeclaration[]>>();
  const markers = documents.flatMap((document) => markersOf(document, defects));

  for (const marker of markers) {
    const actual = declarationsOf(marker.fence);
    const actualNames = [...actual.keys()].sort();
    const markerNames = [...marker.types].sort();
    if (!sameStrings(actualNames, markerNames)) {
      defects.push({
        document: marker.document,
        line: marker.line,
        type: "marker",
        message:
          `marker names [${markerNames.join(", ")}] but its fence declares ` +
          `[${actualNames.join(", ")}]`,
      });
    }

    const ownerPath = normalizeDocumentPath(marker.owner);
    const owner = byPath.get(ownerPath);
    if (owner === undefined) {
      defects.push({
        document: marker.document,
        line: marker.line,
        type: "owner",
        message: `owner ${marker.owner} does not exist in the design tree`,
      });
      continue;
    }

    let available = ownerDeclarations.get(ownerPath);
    if (available === undefined) {
      available = publicDeclarationsOf(owner, defects);
      ownerDeclarations.set(ownerPath, available);
    }

    for (const type of marker.types) {
      const candidate = actual.get(type);
      if (candidate === undefined) continue;
      const owners = available.get(type) ?? [];
      if (owners.length !== 1) {
        defects.push({
          document: marker.document,
          line: marker.line,
          type,
          message:
            owners.length === 0
              ? `${marker.owner} does not declare ${type} in its Public Contract`
              : `${marker.owner} declares ${type} ${owners.length} times in its Public Contract`,
        });
        continue;
      }

      const expected = owners[0];
      if (expected === undefined) continue;
      const matches = marker.subset
        ? isLineSubsequence(candidate.lines, expected.lines)
        : sameStrings(candidate.lines, expected.lines);
      if (matches) continue;

      defects.push({
        document: marker.document,
        line: candidate.line,
        type,
        message:
          `${marker.subset ? "declared subset" : "restatement"} differs from ` +
          `${marker.owner}:${expected.line}; ${differenceOf(candidate.lines, expected.lines, marker.subset)}`,
      });
    }
  }

  return defects;
}

/** Stable, readable output for one Vitest assertion. */
export function formatRestatementDefects(defects: readonly RestatementDefect[]): string {
  return defects
    .map((defect) => `${defect.document}:${defect.line} [${defect.type}] ${defect.message}`)
    .join("\n");
}

function markersOf(document: ModuleDocument, defects: RestatementDefect[]): ContractMarker[] {
  const lines = document.text.split(/\r?\n/u);
  const markers: ContractMarker[] = [];
  let insideFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("```")) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence || !line.includes(CONTRACT_MARKER_START)) continue;

    const parsed = CONTRACT_MARKER.exec(line);
    if (parsed === null) {
      defects.push({
        document: document.path,
        line: index + 1,
        type: "marker",
        message: "malformed contract restatement marker",
      });
      continue;
    }

    const next = lines[index + 1] ?? "";
    if (!CODE_FENCE.test(next)) {
      defects.push({
        document: document.path,
        line: index + 1,
        type: "marker",
        message: "marker must be immediately followed by a code fence",
      });
      continue;
    }

    const close = closingFence(lines, index + 1);
    if (close === null) {
      defects.push({
        document: document.path,
        line: index + 2,
        type: "marker",
        message: "contract code fence is not closed",
      });
      continue;
    }

    const types = (parsed[1] ?? "")
      .split(",")
      .map((type) => type.trim())
      .filter((type) => type.length > 0);
    markers.push({
      document: document.path,
      line: index + 1,
      types,
      owner: parsed[2] ?? "",
      subset: parsed[3] !== undefined,
      fence: {
        document: document.path,
        openLine: index + 2,
        code: lines.slice(index + 2, close).join("\n"),
      },
    });
  }

  return markers;
}

function publicDeclarationsOf(
  document: ModuleDocument,
  defects: RestatementDefect[],
): Map<string, ContractDeclaration[]> {
  const lines = document.text.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === "## Public Contract");
  if (start === -1) return new Map();
  const nextSection = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const end = nextSection === -1 ? lines.length : nextSection;
  const declarations = new Map<string, ContractDeclaration[]>();

  for (let index = start + 1; index < end; index += 1) {
    if (!CODE_FENCE.test(lines[index] ?? "")) continue;
    const close = closingFence(lines, index);
    if (close === null || close > end) {
      defects.push({
        document: document.path,
        line: index + 1,
        type: "owner",
        message: "Public Contract code fence is not closed",
      });
      break;
    }
    const fence: ContractFence = {
      document: document.path,
      openLine: index + 1,
      code: lines.slice(index + 1, close).join("\n"),
    };
    for (const [name, declaration] of declarationsOf(fence)) {
      const existing = declarations.get(name) ?? [];
      existing.push(declaration);
      declarations.set(name, existing);
    }
    index = close;
  }

  return declarations;
}

function declarationsOf(fence: ContractFence): Map<string, ContractDeclaration> {
  const source = ts.createSourceFile(
    fence.document,
    fence.code,
    ts.ScriptTarget.ES2023,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = new Map<string, ContractDeclaration>();
  for (const statement of source.statements) {
    const name = declarationName(statement);
    if (name === null) continue;
    const { line } = source.getLineAndCharacterOfPosition(statement.getStart(source));
    declarations.set(name, {
      document: fence.document,
      line: fence.openLine + line + 1,
      name,
      lines: normalizedDeclaration(statement.getFullText(source)),
    });
  }
  return declarations;
}

function declarationName(statement: ts.Statement): string | null {
  if (
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isFunctionDeclaration(statement)
  ) {
    return statement.name?.text ?? null;
  }
  return null;
}

function normalizedDeclaration(text: string): string[] {
  return text
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

function closingFence(lines: readonly string[], open: number): number | null {
  for (let index = open + 1; index < lines.length; index += 1) {
    if ((lines[index] ?? "").startsWith("```")) return index;
  }
  return null;
}

function normalizeDocumentPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isLineSubsequence(actual: readonly string[], expected: readonly string[]): boolean {
  let cursor = 0;
  for (const line of actual) {
    while (cursor < expected.length && expected[cursor] !== line) cursor += 1;
    if (cursor === expected.length) return false;
    cursor += 1;
  }
  return true;
}

function differenceOf(
  actual: readonly string[],
  expected: readonly string[],
  subset: boolean,
): string {
  if (subset) {
    let cursor = 0;
    for (const line of actual) {
      while (cursor < expected.length && expected[cursor] !== line) cursor += 1;
      if (cursor === expected.length) return `unexpected line ${JSON.stringify(line)}`;
      cursor += 1;
    }
  }
  const count = Math.max(actual.length, expected.length);
  for (let index = 0; index < count; index += 1) {
    if (actual[index] === expected[index]) continue;
    return (
      `first difference at declaration line ${index + 1}: expected ` +
      `${JSON.stringify(expected[index] ?? "<end>")}, got ${JSON.stringify(actual[index] ?? "<end>")}`
    );
  }
  return "declarations differ";
}

/** A module path as the documents write it: backticks off, trailing slash off. */
export const normalizePath = (raw: string): string =>
  raw.replace(/`/g, "").trim().replace(/\/+$/, "");

/** The `**Path**`, `**Parent**` and `**Submodules**` lines of a design document. */
export interface ModuleMetadata {
  path: string | null;
  parent: string | null;
  /** Empty for a leaf. Null when the line is missing. */
  submodules: string[] | null;
}

export function metadataOf(text: string): ModuleMetadata {
  const line = (name: string): string | null => {
    const match = new RegExp(`^\\*\\*${name}\\*\\*:\\s*(.+)$`, "m").exec(text);
    return match === null ? null : (match[1] ?? "").trim();
  };

  /** The backticked names of a metadata line: "`src/` (root)" is one, "none (leaf)" is none. */
  const quoted = (raw: string): string[] =>
    [...raw.matchAll(/`([^`]+)`/g)].map((match) => normalizePath(match[1] ?? ""));

  const pathLine = line("Path");
  const parentLine = line("Parent");
  const submoduleLine = line("Submodules");

  return {
    // The path line carries prose after the path: "src/host/ — the module's code is …".
    path: pathLine === null ? null : normalizePath((pathLine.split("—")[0] ?? "").trim()),
    parent: parentLine === null ? null : (quoted(parentLine)[0] ?? normalizePath(parentLine)),
    submodules: submoduleLine === null ? null : quoted(submoduleLine),
  };
}

// ---------------------------------------------------------------------------
// The coupling assessment
// ---------------------------------------------------------------------------

/** Depth below `src/`: `src` is 0, `src/host` is 1, `src/host/cli` is 2. */
export const depthOf = (path: string): number => path.split("/").length - 1;

/** The deepest folder that contains both. */
export function lcaOf(left: string, right: string): string {
  const from = left.split("/");
  const to = right.split("/");
  const shared: string[] = [];
  for (let index = 0; index < Math.min(from.length, to.length); index += 1) {
    if (from[index] !== to[index]) break;
    shared.push(from[index] ?? "");
  }
  return shared.join("/");
}

/** Steps from the lowest common ancestor down to the deeper of the two. */
export const rankOf = (left: string, right: string): number =>
  Math.max(depthOf(left), depthOf(right)) - depthOf(lcaOf(left, right));

/** The Fibonacci distance scale of the fractal-design model. */
const DISTANCE_BY_RANK: Record<number, number> = {
  0: 0,
  1: 1,
  2: 2,
  3: 3,
  4: 5,
};

export const distanceOf = (rank: number): number => DISTANCE_BY_RANK[rank] ?? 8;

/** Maximum balanced distance per integration strength. Contract coupling tolerates any. */
export const MAX_BALANCED_DISTANCE: Record<string, number> = {
  intrusive: 0,
  functional: 1,
  model: 2,
  contract: Number.POSITIVE_INFINITY,
};

export interface Integration {
  /** The module whose document states it. */
  module: string;
  counterpart: string;
  /** The `**Strength**` bullet's first clause, lowercased, as written. */
  strength: string;
  /** Every strength named in the bullet. One bullet may name two (`src/import/`'s stages). */
  strengths: string[];
  /** The `**LCA / Rank / Distance**` line, as written. */
  claim: string;
  lca: string | null;
  rank: number | null;
  distance: number | null;
}

const STRENGTHS = ["intrusive", "functional", "model", "contract"] as const;

/** Every strength a bullet names, in order of decreasing strictness. */
export const strengthsIn = (text: string): string[] =>
  STRENGTHS.filter((name) => new RegExp(`\\b${name}\\b`, "i").test(text));

/**
 * The strictest strength a bullet names. An integration that is contract coupling for its
 * interfaces and model coupling for the values crossing them is bounded by the model half.
 */
export const strictestStrength = (strengths: string[]): string | undefined =>
  STRENGTHS.find((name) => strengths.includes(name));

/** One `- **Name**: …` bullet, including its wrapped continuation lines. */
function bulletOf(block: string, name: string): string | null {
  const match = new RegExp(
    `- \\*\\*${name}\\*\\*:\\s*([^\\n]*(?:\\n(?!\\s*- \\*\\*)[^\\n]*)*)`,
  ).exec(block);
  return match === null ? null : (match[1] ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Every integration a module's Integrations section documents. One bullet may name several
 * counterparts — "`src/adapters/pi/`, `src/adapters/codex/` and `src/adapters/claude-code/`" is
 * three integrations with one set of computed values, so both separators are read.
 */
export function integrationsOf(dir: string): Integration[] {
  const text = documentOf(dir);
  const body = section(text, "Integrations");
  if (body === null) return [];
  const found: Integration[] = [];
  for (const block of body.split(/\n---\n/)) {
    const counterparts = bulletOf(block, "Counterpart");
    if (counterparts === null) continue;
    const claim = bulletOf(block, "LCA / Rank / Distance") ?? "";
    const computed = /LCA\s+`?([^`,]+)`?\s*,\s*rank\s+(\d+)\s*,\s*distance\s+(\d+)/.exec(claim);
    const stated = bulletOf(block, "Strength") ?? "";
    const strength = stated.split("—")[0]?.trim().toLowerCase() ?? "";
    for (const raw of counterparts.split(/,|\band\b/)) {
      const counterpart = normalizePath(raw);
      if (!/^src(\/|$)/.test(counterpart)) continue;
      found.push({
        module: modulePath(dir),
        counterpart,
        strength,
        strengths: strengthsIn(strength),
        claim,
        lca: computed === null ? null : normalizePath(computed[1] ?? ""),
        rank: computed === null ? null : Number(computed[2]),
        distance: computed === null ? null : Number(computed[3]),
      });
    }
  }
  return found;
}

export interface CouplingRow {
  from: string;
  to: string;
  strength: string;
  lca: string;
  rank: number;
  distance: number;
  volatility: string;
  balanced: string;
}

/** The rows of the complete coupling assessment in `src/module.md`. */
export function couplingRows(text: string): CouplingRow[] {
  const pattern =
    /^\| (src[^|]*?) → ([^|]*?) \| ([^|]*?) \| ([^|]*?) \| ([^|]*?) \| ([^|]*?) \| ([^|]*?) \| ([^|]*?) \|/gm;
  return [...text.matchAll(pattern)].map((match) => ({
    from: normalizePath(match[1] ?? ""),
    to: normalizePath(match[2] ?? ""),
    strength: (match[3] ?? "").trim().toLowerCase(),
    lca: normalizePath(match[4] ?? ""),
    rank: Number(match[5]),
    distance: Number(match[6]),
    volatility: (match[7] ?? "").trim(),
    balanced: (match[8] ?? "").trim(),
  }));
}

/** An integration as an unordered pair, so a table row and a bullet can be compared. */
export const edgeKey = (left: string, right: string): string => [left, right].sort().join(" ~ ");

// ---------------------------------------------------------------------------
// Throwaway homes
// ---------------------------------------------------------------------------

const roots: string[] = [];

/** A throwaway directory. Every one of them is removed by `cleanupTempDirs`. */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `resume-from-root-${prefix}-`));
  roots.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

/** The environment variable each shipped agent reads for its default home. */
export const HOME_ENV: Record<string, string> = {
  pi: "PI_CODING_AGENT_DIR",
  codex: "CODEX_HOME",
  "claude-code": "CLAUDE_CONFIG_DIR",
  "kimi-code": "KIMI_CODE_HOME",
};

export interface EnvGuard {
  restore(): void;
}

/** Sets environment variables for the duration of a test, and puts back what was there. */
export function withEnv(values: Record<string, string | undefined>): EnvGuard {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
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

/**
 * Points every shipped adapter at a throwaway home, and moves `HOME` with them so the
 * configuration loader reads a directory this test owns. No test may touch the user's own
 * agent homes or configuration (C-3).
 */
export function withHomes(homes: Record<string, string>, home?: string): EnvGuard {
  const values: Record<string, string | undefined> = {};
  for (const [agent, path] of Object.entries(homes)) {
    const name = HOME_ENV[agent];
    if (name !== undefined) values[name] = path;
  }
  if (home !== undefined) values.HOME = home;
  return withEnv(values);
}

// ---------------------------------------------------------------------------
// Seeding, and looking at what landed
// ---------------------------------------------------------------------------

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
 * Writes a session into a home in that agent's own format, using the agent's own serializer.
 *
 * The files are written here with `node:fs` rather than through `src/platform/store/`: the root
 * reaches the tree through `src/host/` alone, and seeding a *source* home is not an import. It is
 * the fixture a real import will later read.
 */
export async function seedSession(
  adapter: AgentAdapter,
  home: HomePath,
  session: CanonicalSession,
  context: { cwd: string },
): Promise<SessionId> {
  const capabilities = adapter.capabilities();
  const target: TargetProfile = {
    agent: capabilities.agent,
    home,
    windowTokens: capabilities.defaultWindowTokens,
  };
  const serialized = adapter.serialize(session, target, markerFor(session), context);
  for (const file of serialized.files) {
    await mkdir(dirname(file.absolutePath), { recursive: true });
    await writeFile(file.absolutePath, file.bytes, { flag: "wx" });
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

/** Every file under `dir`, relative path to SHA-256, so two moments can be compared (AC-4). */
export async function checksumTree(dir: string): Promise<Map<string, string>> {
  const sums = new Map<string, string>();
  const walk = async (current: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(current, name);
      const info = await stat(full);
      if (info.isDirectory()) await walk(full);
      else {
        sums.set(
          relative(dir, full),
          createHash("sha256")
            .update(await readFile(full))
            .digest("hex"),
        );
      }
    }
  };
  await walk(dir);
  return sums;
}

/** Every file under `dir`, relative path only. Cheaper than a checksum when only "did anything
 *  appear?" is asked (FR-16, FR-20). */
export async function fileList(dir: string): Promise<string[]> {
  return [...(await checksumTree(dir)).keys()].sort();
}

/** The agent of a running adapter, for building a map keyed the way the registry keys it. */
export const agentOf = (adapter: AgentAdapter): AgentId => adapter.capabilities().agent;

// ---------------------------------------------------------------------------
// A scene the composed system can run in
// ---------------------------------------------------------------------------

/**
 * The repository every seeded session belongs to. A session is listed only in the repository it
 * ran in (FR-13), and the shipped adapters key a session to the directory the process runs in, so
 * this is that directory. Only homes are throwaway: nothing is ever written here.
 */
export const REPO_ROOT = REPO_DIR;

export interface Bench {
  /** The throwaway directory every home of this scene sits under. */
  root: string;
  host: Host;
  homes: Map<AgentId, HomePath>;
  /** The session seeded into each source agent's home. */
  seeded: Map<AgentId, SessionId>;
  guard: EnvGuard;
}

export interface BenchOptions {
  /** The session written into every source home. Defaults to the reference session. */
  session?: CanonicalSession;
  /** Adds the fake fourth agent of `test/fixtures/fixture-agent/` to the list (FR-57). */
  fourthAgent?: boolean;
  /** Passed to `createHost`, so one generic service can be replaced (T-ROO-22). */
  deps?: HostDeps;
  /** Seed the source homes. Off for a scene that must start with nothing in it. */
  seed?: boolean;
}

/**
 * Every agent of the list, each with its own throwaway home, each home holding one session
 * written by that agent's own serializer — and the composed system, built by the root's own
 * entry point, pointed at all of it.
 *
 * `HOME` moves with the agent homes so the configuration loader reads a directory this scene
 * owns. Nothing here may touch the user's own sessions or settings (C-3).
 */
export async function bench(options: BenchOptions = {}): Promise<Bench> {
  const root = await tempDir("bench");
  const guard = withHomes(
    Object.fromEntries(Object.keys(HOME_ENV).map((agent) => [agent, join(root, agent)])),
    root,
  );

  const fourth = options.fourthAgent === true;
  const fixtureHome = join(root, "fourth-agent");
  const agents: AgentEntry[] = fourth
    ? [
        ...AGENTS,
        {
          create: () =>
            createFixtureAgentAdapter({
              defaultHome: fixtureHome,
            }),
          family: "generic",
        },
      ]
    : [...AGENTS];

  const host = await createHost({ agents, cwd: REPO_ROOT, ...options.deps });

  const homes = new Map<AgentId, HomePath>();
  const seeded = new Map<AgentId, SessionId>();
  for (const adapter of host.registry().all()) {
    homes.set(agentOf(adapter), adapter.capabilities().defaultHome);
  }
  if (options.seed !== false) {
    for (const adapter of host.registry().sources()) {
      const home = adapter.capabilities().defaultHome;
      seeded.set(
        agentOf(adapter),
        await seedSession(adapter, home, options.session ?? REFERENCE_SESSION, { cwd: REPO_ROOT }),
      );
    }
  }

  return { root, host, homes, seeded, guard };
}

/** The request the pipeline takes for one direction of the scope table. */
export function importRequest(
  scene: Bench,
  source: AgentId,
  target: TargetProfile,
): {
  destinationCwd: string;
  target: TargetProfile;
  selection: { by: "session-id"; id: SessionId };
  onlyAgent: AgentId;
  onlyHome: HomePath | null;
} {
  return {
    destinationCwd: REPO_ROOT,
    target,
    selection: { by: "session-id", id: scene.seeded.get(source) ?? "" },
    onlyAgent: source,
    onlyHome: scene.homes.get(source) ?? null,
  };
}
