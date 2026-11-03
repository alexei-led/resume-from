import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const moduleDir = fileURLToPath(new URL(".", import.meta.url));

async function moduleFiles(): Promise<string[]> {
  const entries = await readdir(moduleDir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

async function read(files: string[]): Promise<{ path: string; text: string }[]> {
  return Promise.all(files.map(async (path) => ({ path, text: await readFile(path, "utf8") })));
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

interface ImportStatement {
  path: string;
  specifier: string;
  names: string[];
}

const IMPORT_PATTERN =
  /(?:import|export)\s+(?:type\s+)?(?:\{([^}]*)\}|[^"';]*?)\s*from\s*"([^"]+)"/g;

function importsOf(files: { path: string; text: string }[]): ImportStatement[] {
  const statements: ImportStatement[] = [];
  for (const file of files) {
    const source = stripComments(file.text);
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const [, named, specifier] = match;
      if (specifier === undefined) continue;
      const names = (named ?? "")
        .split(",")
        .map((name) => name.replace(/\btype\b/, "").trim())
        .filter((name) => name.length > 0);
      statements.push({ path: file.path, specifier, names });
    }
  }
  return statements;
}

describe("T-PIX-15 — the switch has exactly one call site", () => {
  // Scoped to this module, which is what the invariant it protects is scoped to:
  // "PiResumeFromCommand.run is that handler, and no other code path in this module
  // reaches the switch" (module.md, Constraints and Invariants). A tree-wide sweep
  // would flag src/adapters/*/ implementing AgentAdapter.switchTo, which is legal.
  it("invokes switchSession or switchTo only from the command handler", async () => {
    const files = await read((await moduleFiles()).filter((path) => !path.endsWith(".test.ts")));

    const callers = files
      .filter((file) => /\bswitch(?:Session|To)\s*\(/.test(stripComments(file.text)))
      .map((file) => file.path);

    expect(callers).toEqual([join(moduleDir, "command.ts")]);
  });

  it("hands the runtime to the pipeline only from the command handler", async () => {
    const files = await read((await moduleFiles()).filter((path) => !path.endsWith(".test.ts")));

    const commits = files.flatMap((file) => {
      const hits = stripComments(file.text).match(/\.commit\s*\(/g) ?? [];
      return hits.map(() => file.path);
    });

    expect(commits.length).toBeGreaterThan(0);
    expect(new Set(commits)).toEqual(new Set([join(moduleDir, "command.ts")]));
  });

  it("subscribes to no event, so no event handler can reach the switch", async () => {
    const files = await read((await moduleFiles()).filter((path) => !path.endsWith(".test.ts")));

    const subscribers = files
      .filter((file) => /\.on\s*\(|addListener|addEventListener/.test(stripComments(file.text)))
      .map((file) => file.path);

    expect(subscribers).toEqual([]);
  });
});

describe("T-PIX-17 — no format knowledge lives here", () => {
  const allowed = ["PiSwitchContext", "PiSwitchOptions", "PiSwitchResult"];

  it("imports only the switch types from src/adapters/pi/, and only from its contract", async () => {
    const statements = importsOf(await read(await moduleFiles()));
    const fromPi = statements.filter((statement) => statement.specifier.includes("adapters/pi"));

    expect(fromPi.length).toBeGreaterThan(0);
    for (const statement of fromPi) {
      expect(statement.specifier.endsWith("/contract.js")).toBe(true);
      for (const name of statement.names) {
        expect(allowed).toContain(name);
      }
    }
  });

  it("imports from no other adapter", async () => {
    const statements = importsOf(await read(await moduleFiles()));
    const otherAdapters = statements
      .map((statement) => statement.specifier)
      .filter((specifier) => /adapters\/(?!pi\/)/.test(specifier));

    expect(otherAdapters).toEqual([]);
  });

  it("crosses a module boundary only through a contract", async () => {
    const statements = importsOf(await read(await moduleFiles()));
    const violations = statements
      .map((statement) => statement.specifier)
      .filter((specifier) => specifier.startsWith("../") && !specifier.endsWith("/contract.js"));

    expect(violations).toEqual([]);
  });
});

describe("T-PIX-18 — no rule lives here", () => {
  it("imports nothing from src/import/transfer/", async () => {
    const statements = importsOf(await read(await moduleFiles()));
    const fromTransfer = statements
      .map((statement) => statement.specifier)
      .filter((specifier) => specifier.includes("import/transfer"));

    expect(fromTransfer).toEqual([]);
  });
});
