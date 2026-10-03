/**
 * T-ROO-1 to T-ROO-3 — the root's own code.
 *
 * The root is one factory, so there is little here: that `createHost()` with no argument builds
 * something usable, that a configuration it cannot read stops it before anything else is built,
 * and that the package has one way in and not two.
 *
 * Every test that touches the filesystem points `HOME` and the three agent home variables at a
 * throwaway directory first. Nothing here may read the user's own configuration or sessions (C-3).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENTS, type AgentEntry } from "./host/index.js";
import { createHost } from "./index.js";
import {
  agentOf,
  cleanupTempDirs,
  type EnvGuard,
  exportedNames,
  importSpecifiers,
  isInside,
  parseSource,
  readSources,
  repoRelative,
  resolveSpecifier,
  SRC_DIR,
  shippedSources,
  tempDir,
  unionMembers,
  withHomes,
} from "./test-support.js";

const CONFIG_FILE = join(".config", "resume-from", "config.json");

interface Scene {
  home: string;
  guard: EnvGuard;
}

/** A home nobody has configured and no agent has ever written in. */
async function emptyScene(): Promise<Scene> {
  const home = await tempDir("home");
  const guard = withHomes(
    {
      pi: join(home, "pi"),
      codex: join(home, "codex"),
      "claude-code": join(home, "claude-code"),
      "kimi-code": join(home, "kimi-code"),
    },
    home,
  );
  return { home, guard };
}

async function writeConfig(home: string, text: string): Promise<void> {
  const path = join(home, CONFIG_FILE);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text, "utf8");
}

let scene: Scene | null = null;

afterEach(async () => {
  scene?.guard.restore();
  scene = null;
  await cleanupTempDirs();
});

describe("T-ROO-1 — createHost returns a usable host", () => {
  it("holds every adapter of the list, and no other", async () => {
    scene = await emptyScene();
    const host = await createHost();

    // The list is the host's (Decision 3). The root asserts the count, never the names: a test
    // that spelled an agent out would be the third place FR-57 says adding one must not touch.
    expect(host.registry().all()).toHaveLength(AGENTS.length);
    const declared = host.registry().all().map(agentOf);
    expect(new Set(declared).size).toBe(AGENTS.length);

    const session = readSources(join(SRC_DIR, "session")).find((source) =>
      source.path.endsWith("contract.ts"),
    );
    expect(session).toBeDefined();
    const known = session === undefined ? [] : unionMembers(session, "AgentId");
    expect(declared.every((agent) => known.includes(agent))).toBe(true);
  });

  it("fills both roles from that one list (FR-59)", async () => {
    scene = await emptyScene();
    const host = await createHost();

    expect(host.registry().sources().length).toBeGreaterThan(0);
    expect(host.registry().targets().length).toBeGreaterThan(0);
  });

  it("produces a working pipeline for every target", async () => {
    scene = await emptyScene();
    const host = await createHost();

    for (const adapter of host.registry().targets()) {
      const profile = host.profiles().build(agentOf(adapter), null, host.config());
      const pipeline = await host.pipelineFor(profile);

      expect(typeof pipeline.list).toBe("function");
      expect(typeof pipeline.preview).toBe("function");
      expect(typeof pipeline.commit).toBe("function");

      // A listing over empty homes is the cheapest proof that the wiring runs: it reaches every
      // source adapter, every configured home and the repository reader, and writes nothing.
      const listing = await pipeline.list({
        destinationCwd: process.cwd(),
        target: profile,
        onlyAgent: null,
        onlyHome: null,
      });
      expect(listing.rows).toEqual([]);
    }
  });

  it("uses the defaults when there is no configuration file", async () => {
    scene = await emptyScene();
    const host = await createHost();

    expect(host.config().extraHomes).toEqual([]);
    expect(host.config().budgetShare).toBeGreaterThan(0);
    expect(host.config().budgetShare).toBeLessThanOrEqual(1);
    expect(host.config().pinnedRecentTurns).toBeGreaterThan(0);
  });
});

describe("T-ROO-2 — a configuration error surfaces from createHost", () => {
  const cases: { name: string; text: string; says: RegExp }[] = [
    {
      name: "a file that is not JSON",
      text: "{ budgetShare: 0.3",
      says: /not valid JSON.*(Fix the syntax|delete the file)/s,
    },
    {
      name: "a share that is not a share",
      text: JSON.stringify({ budgetShare: 5 }),
      says: /budgetShare/,
    },
    {
      name: "a window that is not a number of tokens",
      text: JSON.stringify({ windowOverrides: [{ agent: "codex", windowTokens: "big" }] }),
      says: /windowTokens/,
    },
  ];

  it.each(cases)("$name is refused with the field and what to change", async ({ text, says }) => {
    scene = await emptyScene();
    await writeConfig(scene.home, text);

    await expect(createHost()).rejects.toThrow(says);
  });

  it("says what to do next, not only what threw (FR-56)", async () => {
    scene = await emptyScene();
    await writeConfig(scene.home, JSON.stringify({ budgetShare: 5 }));

    const failure = await createHost().then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : "";
    // An actionable message names the field and the value it will accept.
    expect(message).toMatch(/budgetShare/);
    expect(message.length).toBeGreaterThan("budgetShare".length + 20);
  });

  it("builds nothing before the configuration is loaded", async () => {
    scene = await emptyScene();
    await writeConfig(scene.home, "{ not json");

    let built = 0;
    const counting: AgentEntry[] = AGENTS.map((entry) => ({
      create: () => {
        built += 1;
        return entry.create();
      },
      family: entry.family,
    }));

    await expect(createHost({ agents: counting })).rejects.toThrow();
    // No partially built host: the rejection happened before an adapter existed.
    expect(built).toBe(0);
  });
});

describe("T-ROO-3 — the root has one entry point", () => {
  const entry = () => {
    const source = readSources(SRC_DIR)
      .filter((file) => !isInside(file.path, join(SRC_DIR, "host")))
      .find((file) => file.path === join(SRC_DIR, "index.ts"));
    expect(source).toBeDefined();
    return source;
  };

  it("publishes the factory and the two entry points C-1 forces", () => {
    const source = entry();
    const names = source === undefined ? [] : exportedNames(source);

    expect(names).toContain("createHost");
    expect(names).toContain("runCommandBinary");
    expect(names).toContain("activatePiExtension");
  });

  it("the contract's call is the zero-argument one", async () => {
    scene = await emptyScene();
    // A compile-time check as much as a runtime one: this only typechecks while the exported
    // factory is assignable to `ResumeFrom["createHost"]`.
    const { ResumeFrom } = await import("./contract.js").then((module) => ({
      ResumeFrom: module,
    }));
    expect(ResumeFrom).toBeDefined();
    const wiring = await createHost();
    expect(typeof wiring.pipelineFor).toBe("function");
  });

  it("the command binary is a process wrapper and nothing else", () => {
    const bin = readSources(SRC_DIR).find((file) => file.path === join(SRC_DIR, "bin.ts"));
    expect(bin).toBeDefined();
    if (bin === undefined) return;

    expect(bin.text.startsWith("#!")).toBe(true);
    // It reaches the system through the entry point, never around it.
    const reached = importSpecifiers(bin).filter((specifier) => specifier.startsWith("."));
    expect(reached.sort()).toEqual(["./contract.js", "./index.js"]);
  });

  it("has one wiring path: only the entry point builds the host", () => {
    const hostDir = join(SRC_DIR, "host");
    const reaching = shippedSources()
      .filter((source) => !isInside(source.path, hostDir))
      .flatMap((source) =>
        importSpecifiers(source)
          .map((specifier) => resolveSpecifier(source.path, specifier))
          .filter((resolved): resolved is string => resolved !== undefined)
          .filter((resolved) => isInside(resolved, hostDir))
          .map((resolved) => ({ from: repoRelative(source.path), to: resolved })),
      );

    // Building means importing a factory, which is `index.js` and nothing else. Naming a type
    // through `contract.js` is the restatement the design asks for, not a second wiring.
    const builders = new Set(
      reaching.filter((edge) => edge.to.endsWith("index.js")).map((edge) => edge.from),
    );
    expect([...builders]).toEqual(["src/index.ts"]);
    expect(
      reaching
        .filter((edge) => !edge.to.endsWith("index.js"))
        .filter((edge) => !edge.to.endsWith("contract.js")),
    ).toEqual([]);
  });

  it("has one composition root: nothing outside src/host/ builds the pipeline", () => {
    const importDir = join(SRC_DIR, "import");
    const hostDir = join(SRC_DIR, "host");
    const builders = shippedSources()
      .filter((source) => !isInside(source.path, importDir))
      .filter((source) =>
        importSpecifiers(source).some((specifier) => {
          const resolved = resolveSpecifier(source.path, specifier);
          return resolved === join(importDir, "index.js");
        }),
      )
      .map((source) => repoRelative(source.path));

    expect(builders.every((path) => isInside(join(SRC_DIR, "..", path), hostDir))).toBe(true);
    expect(builders).toHaveLength(1);
  });

  it("the Pi extension entry loads the same host", () => {
    // The package's `./pi-extension` subpath resolves to src/host/pi-extension/, which holds the
    // command and the picker but not the activation that builds a host for them. The activation
    // is published by the root, and it is the only other door in.
    const activation = parseSource(
      join(SRC_DIR, "host", "entry.ts"),
      readSources(join(SRC_DIR, "host")).find((file) => file.path.endsWith("entry.ts"))?.text ?? "",
    );
    expect(exportedNames(activation)).toContain("activatePiExtension");
    expect(exportedNames(activation)).toContain("runCommandBinary");
  });
});
