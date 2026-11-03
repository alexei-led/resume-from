/**
 * T-HOS-13 to T-HOS-17 — static checks over the source tree.
 *
 * These are the properties the composition root exists to guarantee, and none of them can be
 * checked by running the code: that there is one agent list, that no other module knows an agent
 * by name, that this module neither reads nor writes a session, that a runtime handle comes only
 * from the entry point of its own agent, and that the module graph has no cycle.
 *
 * They read source from disk and parse it, so a name inside a string is never mistaken for a
 * call, and a renamed import cannot hide a violation.
 */

import { join, sep } from "node:path";
import ts from "typescript-compiler-api";
import { describe, expect, it } from "vitest";
import {
  callNames,
  HOST_DIR,
  importSpecifiers,
  isInside,
  isTestFile,
  moduleFolders,
  parseSource,
  readSources,
  repoRelative,
  resolveSpecifier,
  SRC_DIR,
  SUBMODULES,
  stringLiterals,
  unionMembers,
} from "./test-support.js";

const ADAPTERS_DIR = join(SRC_DIR, "adapters");
const SESSION_DIR = join(SRC_DIR, "session");
const IMPORT_DIR = join(SRC_DIR, "import");
const PLATFORM_DIR = join(SRC_DIR, "platform");
const CLI_DIR = join(HOST_DIR, "cli");
const PI_EXTENSION_DIR = join(HOST_DIR, "pi-extension");

/** Every shipped file of the tree: tests and test-only helpers are not the design. */
const shipped = readSources(SRC_DIR, { tests: false });

/** This module's own code — `src/host/`, without its two submodules. */
const ownFiles = shipped.filter(
  (source) =>
    isInside(source.path, HOST_DIR) &&
    !SUBMODULES.some((name) => isInside(source.path, join(HOST_DIR, name))),
);

describe("T-HOS-13 — there is exactly one agent list", () => {
  /** A file that constructs more than one adapter implementation is an agent list. */
  const importsAdapterImplementation = (path: string, specifier: string): boolean => {
    const resolved = resolveSpecifier(path, specifier);
    return (
      resolved !== undefined &&
      isInside(resolved, ADAPTERS_DIR) &&
      resolved.endsWith(`${sep}index.js`)
    );
  };

  const lists = shipped
    .map((source) => ({
      path: source.path,
      implementations: importSpecifiers(source).filter((specifier) =>
        importsAdapterImplementation(source.path, specifier),
      ),
    }))
    .filter((file) => file.implementations.length > 0);

  it("only one file in the tree constructs adapter implementations", () => {
    expect(lists.map((file) => repoRelative(file.path))).toEqual(["src/host/agents.ts"]);
  });

  it("that file holds every adapter", () => {
    const folders = moduleFolders(ADAPTERS_DIR).map((path) =>
      path.slice(path.lastIndexOf(sep) + 1),
    );
    const listed = lists[0]?.implementations ?? [];
    for (const folder of folders) {
      expect(listed.some((specifier) => specifier.includes(`/${folder}/`))).toBe(true);
    }
    expect(listed).toHaveLength(folders.length);
  });
});

describe("T-HOS-14 — no agent name appears outside the list", () => {
  const contract = parseSource(
    join(SESSION_DIR, "contract.ts"),
    readSources(SESSION_DIR).find((source) => source.path.endsWith("contract.ts"))?.text ?? "",
  );
  const names = unionMembers(contract, "AgentId");

  /**
   * Three shipped files outside the permitted folders hold an agent name today. Each is pinned
   * with the reason, so a new one fails the test and a stale one fails it too. They are also a
   * design finding: FR-57's "one folder, one `AgentId` value, one line here" is not literally
   * true while these exist.
   */
  const KNOWN = new Map<string, string>([
    ["src/host/cli/args.ts", "the names the user may type for --agent (FR-15)"],
    ["src/host/pi-extension/command.ts", "Pi is always its own import target (FR-1, C-10)"],
    ["src/platform/config/validate.ts", "a closed-world check of the agent of a config entry"],
  ]);

  const permitted = (path: string): boolean =>
    isInside(path, SESSION_DIR) ||
    isInside(path, ADAPTERS_DIR) ||
    ownFiles.some((f) => f.path === path);

  const offenders = shipped
    .filter((source) => !permitted(source.path))
    .map((source) => ({
      path: repoRelative(source.path),
      hits: stringLiterals(source).filter((literal) => names.includes(literal.text)),
    }))
    .filter((file) => file.hits.length > 0);

  it("names an agent nowhere but src/session/, an adapter's own folder, and the list here", () => {
    expect(offenders.map((file) => file.path).sort()).toEqual([...KNOWN.keys()].sort());
  });

  it("names no agent inside src/import/ — that would be an FR-60 violation", () => {
    const inside = shipped
      .filter((source) => isInside(source.path, IMPORT_DIR))
      .flatMap((source) =>
        stringLiterals(source)
          .filter((literal) => names.includes(literal.text))
          .map((literal) => `${repoRelative(source.path)}:${literal.line}`),
      );
    expect(inside).toEqual([]);
  });

  it("names no agent in this module at all", () => {
    // Stronger than the tree needs: the list is built from factories, and the registry keys it
    // by what each adapter declares, so even the composition root never writes an agent down.
    expect(ownFiles).not.toHaveLength(0);
    const here = ownFiles.flatMap((source) =>
      stringLiterals(source)
        .filter((literal) => names.includes(literal.text))
        .map((literal) => `${repoRelative(source.path)}:${literal.line}`),
    );
    expect(here).toEqual([]);
  });

  it("chooses no behaviour by agent name in this module", () => {
    for (const source of ownFiles) {
      const switches: string[] = [];
      const walk = (node: ts.Node): void => {
        if (ts.isSwitchStatement(node)) switches.push(node.expression.getText(source.ast));
        ts.forEachChild(node, walk);
      };
      walk(source.ast);
      // A switch on AgentId here would make FR-57's "one line" false (FR-43, FR-58).
      expect(switches.filter((subject) => /agent/i.test(subject))).toEqual([]);
    }
  });
});

describe("T-HOS-15 — this module never writes and never reads a session", () => {
  it("imports no filesystem module", () => {
    expect(ownFiles).not.toHaveLength(0);
    for (const source of ownFiles) {
      const fsImports = importSpecifiers(source).filter((specifier) =>
        specifier.startsWith("node:fs"),
      );
      expect([repoRelative(source.path), fsImports]).toEqual([repoRelative(source.path), []]);
    }
  });

  it("calls no method that reads or writes a session", () => {
    // The port's own verbs. This module builds the things that call them.
    const SESSION_WORK = ["listSessions", "loadSession", "serialize", "validate", "readBack"];
    for (const source of ownFiles) {
      const found = callNames(source)
        .filter((call) => SESSION_WORK.includes(call.name))
        .map((call) => `${repoRelative(source.path)}:${call.line} ${call.name}`);
      expect(found).toEqual([]);
    }
  });

  it("calls no committer", () => {
    for (const source of ownFiles) {
      const found = callNames(source)
        .filter((call) => call.name === "commit")
        .map((call) => `${repoRelative(source.path)}:${call.line}`);
      expect(found).toEqual([]);
    }
  });
});

describe("T-HOS-16 — the runtime handle is never constructed here", () => {
  /** The runtime argument of every `commit(request, runtime, confirmationToken)` call in a file. */
  const runtimeArguments = (source: { ast: ts.SourceFile }): string[] => {
    const found: string[] = [];
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "commit" &&
        node.arguments.length === 3
      ) {
        const runtime = node.arguments[1];
        if (runtime !== undefined) found.push(runtime.getText(source.ast));
      }
      ts.forEachChild(node, walk);
    };
    walk(source.ast);
    return found;
  };

  const fileIn = (dir: string, name: string) =>
    readSources(dir, { tests: false }).find((source) => source.path.endsWith(sep + name));

  it("the command binary passes null", () => {
    const runner = fileIn(CLI_DIR, "runner.ts");
    expect(runner).toBeDefined();
    expect(runner === undefined ? [] : runtimeArguments(runner)).toEqual(["null"]);
  });

  it("the Pi extension passes Pi's own command context", () => {
    const command = fileIn(PI_EXTENSION_DIR, "command.ts");
    expect(command).toBeDefined();
    const argumentsSeen = command === undefined ? [] : runtimeArguments(command);
    expect(argumentsSeen.length).toBeGreaterThan(0);
    expect(argumentsSeen.every((argument) => argument === "ctx" || argument === "runtime")).toBe(
      true,
    );
  });

  it("this module passes none, because it drives no commit", () => {
    expect(ownFiles.flatMap(runtimeArguments)).toEqual([]);
  });

  it("no other module commits at all", () => {
    const elsewhere = shipped
      .filter(
        (source) => !isInside(source.path, CLI_DIR) && !isInside(source.path, PI_EXTENSION_DIR),
      )
      .filter((source) => !isInside(source.path, IMPORT_DIR))
      .flatMap((source) =>
        runtimeArguments(source).map((argument) => `${repoRelative(source.path)} ${argument}`),
      );
    expect(elsewhere).toEqual([]);
  });
});

describe("T-HOS-17 — the module graph has no cycle", () => {
  /** Every module of the design tree: a folder holding a module.md, plus the root. */
  const modules = ((): string[] => {
    const found: string[] = [SRC_DIR];
    const walk = (dir: string): void => {
      for (const folder of moduleFolders(dir)) {
        found.push(folder);
        walk(folder);
      }
    };
    walk(SRC_DIR);
    return found.sort((left, right) => right.length - left.length);
  })();

  /** The deepest module that contains a file — the module the file belongs to. */
  const moduleOf = (path: string): string => modules.find((dir) => isInside(path, dir)) ?? SRC_DIR;

  const edges = new Map<string, Set<string>>();
  for (const source of shipped) {
    const from = moduleOf(source.path);
    for (const specifier of importSpecifiers(source)) {
      const resolved = resolveSpecifier(source.path, specifier);
      if (resolved === undefined) continue;
      const to = moduleOf(resolved);
      if (to === from) continue;
      const seen = edges.get(from) ?? new Set<string>();
      seen.add(to);
      edges.set(from, seen);
    }
  }

  it("has an edge for the design's documented exception (M-1)", () => {
    // src/host/pi-extension/ → src/adapters/pi/ for PiSwitchContext. The graph must hold it,
    // or the acyclicity below would be proving something weaker than the design claims.
    expect([...(edges.get(PI_EXTENSION_DIR) ?? [])]).toContain(join(ADAPTERS_DIR, "pi"));
  });

  it("is acyclic", () => {
    const state = new Map<string, "open" | "done">();
    const cycles: string[] = [];
    const visit = (node: string, trail: string[]): void => {
      if (state.get(node) === "done") return;
      if (state.get(node) === "open") {
        cycles.push([...trail.slice(trail.indexOf(node)), node].map(repoRelative).join(" → "));
        return;
      }
      state.set(node, "open");
      for (const next of edges.get(node) ?? []) visit(next, [...trail, node]);
      state.set(node, "done");
    };
    for (const node of edges.keys()) visit(node, []);
    expect(cycles).toEqual([]);
  });

  it("nothing imports src/host/", () => {
    // The root module builds the host (src/module.md: `src → src/host`, contract coupling), and
    // nothing imports the root, so the cycle-avoidance property is that no *submodule* reaches
    // the composition root. Root files are the direct children of src/.
    const isRootFile = (path: string): boolean => !path.slice(SRC_DIR.length + 1).includes(sep);
    const scanned = shipped.filter(
      (source) => !isInside(source.path, HOST_DIR) && !isRootFile(source.path),
    );
    expect(scanned.length).toBeGreaterThan(20);
    const importers = scanned.flatMap((source) =>
      importSpecifiers(source)
        .map((specifier) => resolveSpecifier(source.path, specifier))
        .filter((resolved): resolved is string => resolved !== undefined)
        .filter((resolved) => isInside(resolved, HOST_DIR))
        .map((resolved) => `${repoRelative(source.path)} → ${repoRelative(resolved)}`),
    );
    expect(importers).toEqual([]);
  });

  it("reaches src/platform/ and src/import/ from here, and never the other way", () => {
    const fromHost = edges.get(HOST_DIR) ?? new Set<string>();
    expect([...fromHost]).toContain(IMPORT_DIR);
    expect([...fromHost].some((dir) => isInside(dir, PLATFORM_DIR))).toBe(true);
    for (const [from, to] of edges) {
      if (isInside(from, PLATFORM_DIR) || isInside(from, IMPORT_DIR)) {
        expect([...to].filter((dir) => isInside(dir, HOST_DIR))).toEqual([]);
      }
    }
  });
});

describe("the fake fourth agent costs no edit in the tree", () => {
  it("no shipped file names it", () => {
    // T-HOS-18 adds it through the injected list alone. If a module had to learn its name, the
    // "one folder, one line" claim of FR-57 would already be false.
    const named = shipped
      .filter((source) => !isTestFile(source.path))
      .filter((source) =>
        stringLiterals(source).some((literal) => literal.text.includes("fixture-agent")),
      )
      .map((source) => repoRelative(source.path));
    expect(named).toEqual([]);
  });
});
