/**
 * T-HOS-1 to T-HOS-7 — the agent list, the registry over it, and the target profile.
 *
 * These are the two pieces of the composition root that hold knowledge rather than wiring: which
 * adapters exist, and how a home and a window become a `TargetProfile`.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENTS } from "./agents.js";
import { createCliRunner } from "./cli/index.js";
import type { AgentId, ImportPipeline, ListRequest } from "./contract.js";
import { createTargetProfileBuilder } from "./profile.js";
import { createAgentRegistry } from "./registry.js";
import {
  fakeAdapter,
  moduleFolders,
  parseSource,
  readSources,
  SRC_DIR,
  testConfig,
  unionMembers,
} from "./test-support.js";

const listed = () => AGENTS.map((entry) => entry.create());
const registryOfList = () => createAgentRegistry(listed());

describe("T-HOS-1 — the registry holds every adapter", () => {
  const declared = registryOfList()
    .all()
    .map((adapter) => adapter.capabilities().agent)
    .sort();

  it("holds one entry per folder under src/adapters/", () => {
    const folders = moduleFolders(join(SRC_DIR, "adapters"))
      .map((path) => path.slice(path.lastIndexOf("/") + 1))
      .sort();
    expect(declared).toEqual(folders);
  });

  it("declares exactly the values of AgentId", () => {
    // A union of string literals is not a runtime value, so the source is the only place the
    // set can be read from.
    const contract = readSources(join(SRC_DIR, "session")).find((source) =>
      source.path.endsWith("contract.ts"),
    );
    expect(contract).toBeDefined();
    const values = unionMembers(contract ?? parseSource("none.ts", ""), "AgentId").sort();
    expect(values).not.toEqual([]);
    expect(declared).toEqual(values);
  });

  it("names each adapter once", () => {
    expect(new Set(declared).size).toBe(declared.length);
  });
});

describe("T-HOS-2 — lookup by agent", () => {
  const registry = registryOfList();
  const agents = registry.all().map((adapter) => [adapter.capabilities().agent] as const);

  it.each(agents)("%s resolves to its own adapter", (agent) => {
    expect(registry.get(agent).capabilities().agent).toBe(agent);
  });
});

describe("T-HOS-3 — an unknown agent rejects", () => {
  const registry = registryOfList();
  const unknown = "aider" as AgentId;

  it("throws, naming the agent", () => {
    expect(() => registry.get(unknown)).toThrow(/aider/);
  });

  it("does not return a default", () => {
    // The failure mode this guards against is silently importing into the wrong agent.
    let returned: unknown;
    try {
      returned = registry.get(unknown);
    } catch {
      returned = undefined;
    }
    expect(returned).toBeUndefined();
  });
});

describe("T-HOS-4 — roles filter the registry", () => {
  const sourceOnly = fakeAdapter({ agent: "codex", roles: ["source"] });
  const targetOnly = fakeAdapter({ agent: "claude-code", roles: ["target"] });
  const registry = createAgentRegistry([sourceOnly, targetOnly]);

  it("sources() holds the source-only adapter and not the target-only one", () => {
    expect(registry.sources()).toEqual([sourceOnly]);
  });

  it("targets() holds the target-only adapter and not the source-only one", () => {
    expect(registry.targets()).toEqual([targetOnly]);
  });

  it("all() still holds both", () => {
    expect(registry.all()).toEqual([sourceOnly, targetOnly]);
  });
});

describe("the target profile", () => {
  const DECLARED_HOME = resolve("/declared/home");
  const DECLARED_WINDOW = 111_000;
  const agent: AgentId = "claude-code";
  const builder = () =>
    createTargetProfileBuilder(
      createAgentRegistry([
        fakeAdapter({
          agent,
          defaultHome: DECLARED_HOME,
          defaultWindowTokens: DECLARED_WINDOW,
        }),
      ]),
    );

  it("T-HOS-5 — uses the adapter's declared default home when none is named", () => {
    expect(builder().build(agent, null, testConfig()).home).toBe(DECLARED_HOME);
  });

  it("T-HOS-6 — a named home wins over the default", () => {
    const profile = builder().build(agent, "~/.claude-team", testConfig());
    expect(profile.home).toBe(join(homedir(), ".claude-team"));
  });

  it("T-HOS-6 — a relative home is resolved to an absolute path (FR-2)", () => {
    const profile = builder().build(agent, "./sessions", testConfig());
    expect(profile.home).toBe(resolve("./sessions"));
  });

  it("T-HOS-6 — an absolute home is kept as it is", () => {
    const profile = builder().build(agent, resolve("/srv/homes/team"), testConfig());
    expect(profile.home).toBe(resolve("/srv/homes/team"));
  });

  it("carries the agent it was built for", () => {
    expect(builder().build(agent, null, testConfig()).agent).toBe(agent);
  });

  describe("T-HOS-7 — a window override wins over the adapter default", () => {
    const cases = [
      ["no override", testConfig(), DECLARED_WINDOW],
      [
        "an override for this agent",
        testConfig({ windowOverrides: [{ agent, windowTokens: 42_000 }] }),
        42_000,
      ],
      [
        "an override for a different agent",
        testConfig({ windowOverrides: [{ agent: "codex", windowTokens: 42_000 }] }),
        DECLARED_WINDOW,
      ],
    ] as const;

    it.each(cases)("%s", (_name, config, expected) => {
      expect(builder().build(agent, null, config).windowTokens).toBe(expected);
    });
  });

  it("rejects an agent with no adapter, rather than defaulting the profile", () => {
    expect(() => builder().build("pi", null, testConfig())).toThrow(/pi/);
  });

  it("T-HOS-6 — the runner delivers the resolved home to the pipeline for a ~/… shim path (FR-3)", async () => {
    // Proves the full chain: profile builder resolves "~/alt-home" and the runner
    // prefers that resolved value over the raw invocation.targetHome (T-CLI-24).
    const profile = builder().build(agent, "~/alt-home", testConfig());
    expect(profile.home).toBe(join(homedir(), "alt-home"));

    const listed: ListRequest[] = [];
    const pipeline: ImportPipeline = {
      list: (req) => {
        listed.push(req);
        return Promise.resolve({ rows: [], failures: [], excluded: 0 });
      },
      preview: () => Promise.reject(new Error("not called")),
      commit: () => Promise.reject(new Error("not called")),
    };

    await createCliRunner(profile).run(
      {
        argv: [],
        cwd: "/cwd",
        targetAgent: agent,
        targetHome: "~/alt-home",
      },
      pipeline,
    );

    expect(listed[0]?.target.home).toBe(join(homedir(), "alt-home"));
  });
});
