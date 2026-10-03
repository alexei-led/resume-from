/**
 * T-HOS-18 to T-HOS-20 — what the wiring produces, end to end.
 *
 * Every home here is a throwaway directory created for the test and removed afterwards. The
 * three real adapters are pointed at those homes through the environment variable each one
 * already reads, so no test ever opens the user's own sessions (C-3).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFixtureAgentAdapter,
  FIXTURE_AGENT_ID,
} from "../../test/fixtures/fixture-agent/index.js";
import { REFERENCE_SESSION } from "../../test/fixtures/reference-session.js";
import type { AgentEntry } from "./agents.js";
import { AGENTS } from "./agents.js";
import type { AgentAdapter, AgentId, HomePath, ImportConfig, SessionId } from "./contract.js";
import {
  cleanupTempDirs,
  descriptorOf,
  type EnvGuard,
  seedSession,
  tempDir,
  testConfig,
  withHomes,
} from "./test-support.js";
import { createHost, type Host } from "./wiring.js";

const REAL_AGENTS: AgentId[] = ["pi", "codex", "claude-code", "kimi-code"];

const configLoader = (config: ImportConfig = testConfig()) => ({
  load: () => Promise.resolve(config),
});

/**
 * The repository every seeded session belongs to. A session is listed only in the repository it
 * ran in (FR-13), and the three shipped adapters key a session to the directory the process runs
 * in, so this is that directory. Only homes are throwaway: nothing is ever written here.
 */
const REPO_ROOT = process.cwd();

interface Bench {
  root: string;
  host: Host;
  homes: Map<AgentId, HomePath>;
  seeded: Map<AgentId, SessionId>;
  guard: EnvGuard;
}

/**
 * Every agent of the list, each with its own throwaway home, each home holding one session
 * written by that agent's own serializer. The fourth agent arrives the way FR-57 says a new
 * agent arrives: one entry in the list, and nothing else in the tree changed.
 */
async function bench(config: ImportConfig = testConfig()): Promise<Bench> {
  const root = await tempDir("bench");
  const homes = new Map<AgentId, HomePath>(
    REAL_AGENTS.map((agent) => [agent, `${root}/${agent}`] as const),
  );
  const guard = withHomes(Object.fromEntries(homes));

  const fixtureHome = `${root}/fixture-agent`;
  homes.set(FIXTURE_AGENT_ID, fixtureHome);
  const fixtureEntry: AgentEntry = {
    create: () => createFixtureAgentAdapter({ defaultHome: fixtureHome }),
    family: "generic",
  };

  const host = await createHost({
    agents: [...AGENTS, fixtureEntry],
    configLoader: configLoader(config),
    cwd: REPO_ROOT,
  });

  const seeded = new Map<AgentId, SessionId>();
  for (const adapter of host.registry().sources()) {
    const agent = adapter.capabilities().agent;
    const home = adapter.capabilities().defaultHome;
    homes.set(agent, home);
    seeded.set(agent, await seedSession(adapter, home, REFERENCE_SESSION, { cwd: REPO_ROOT }));
  }

  return { root, host, homes, seeded, guard };
}

/**
 * A stand-in for Pi's command context. It lives in this file rather than in `test-support.ts`
 * because T-PI-20 allows the name `switchSession` in `src/adapters/pi/` and
 * `src/host/pi-extension/` alone, and reads every file that is not a `*.test.ts`.
 */
const fakePiRuntime = (cwd: string, home: HomePath): unknown => ({
  cwd,
  home,
  switchSession(_path: string, options: { withSession: () => void }) {
    options.withSession();
    return Promise.resolve({ cancelled: false });
  },
});

/** The runtime handle the target's declared landing needs — never one this module invented. */
const runtimeFor = (adapter: AgentAdapter, cwd: string, home: HomePath): unknown =>
  adapter.capabilities().landing === "create-and-switch" ? fakePiRuntime(cwd, home) : null;

describe("T-HOS-18 — adding an agent costs one folder and one line", () => {
  let scene: Bench;

  beforeAll(async () => {
    scene = await bench();
  }, 60_000);

  afterAll(async () => {
    scene?.guard.restore();
    await cleanupTempDirs();
  });

  it("the fourth agent is in the list", () => {
    const listed = scene.host
      .registry()
      .all()
      .map((adapter) => adapter.capabilities().agent);
    expect(listed).toContain(FIXTURE_AGENT_ID);
    expect(listed).toHaveLength(REAL_AGENTS.length + 1);
  });

  it("it reaches both roles (FR-59)", () => {
    const named = (adapters: AgentAdapter[]) =>
      adapters.map((adapter) => adapter.capabilities().agent);
    expect(named(scene.host.registry().sources())).toContain(FIXTURE_AGENT_ID);
    expect(named(scene.host.registry().targets())).toContain(FIXTURE_AGENT_ID);
  });

  const directions = (): (readonly [string, AgentId, AgentId])[] => {
    const agents: AgentId[] = [...REAL_AGENTS, FIXTURE_AGENT_ID];
    return agents.flatMap((source) =>
      agents.map((target) => [`${source} → ${target}`, source, target] as const),
    );
  };

  it("runs every direction of the grown table", () => {
    expect(directions()).toHaveLength((REAL_AGENTS.length + 1) * (REAL_AGENTS.length + 1));
  });

  it.each(directions())(
    "%s lands what it planned",
    async (_name, sourceAgent, targetAgent) => {
      const sourceHome = scene.homes.get(sourceAgent);
      const sourceId = scene.seeded.get(sourceAgent);
      expect(sourceHome).toBeDefined();
      expect(sourceId).toBeDefined();

      const profile = scene.host.profiles().build(targetAgent, null, scene.host.config());
      const pipeline = await scene.host.pipelineFor(profile);
      const request = {
        destinationCwd: REPO_ROOT,
        target: profile,
        selection: { by: "session-id" as const, id: sourceId ?? "" },
        onlyAgent: sourceAgent,
        onlyHome: sourceHome ?? null,
      };

      const report = await pipeline.preview(request);
      expect([report.blocked, report.blockedReason]).toEqual([false, null]);
      expect(report.lines.length).toBeGreaterThan(0);

      const target = scene.host.registry().get(targetAgent);
      const result = await pipeline.commit(
        request,
        runtimeFor(target, scene.root, profile.home),
        report.confirmationToken,
      );

      expect(result.ref.agent).toBe(targetAgent);
      expect(result.ref.home).toBe(profile.home);
      // FR-52: what the target stored is what the adapter said it sent.
      expect(result.itemsStored).toBe(result.itemsSent);

      const facts = await target.readBack(profile.home, result.ref.id);
      expect(facts.openable).toBe(true);
    },
    60_000,
  );
});

describe("T-HOS-19 — the profile is right for every agent", () => {
  let scene: Bench;

  beforeAll(async () => {
    scene = await bench();
  }, 60_000);

  afterAll(async () => {
    scene?.guard.restore();
    await cleanupTempDirs();
  });

  it.each(REAL_AGENTS.map((agent) => [agent] as const))(
    "%s carries its declared home and a positive window",
    (agent) => {
      const profile = scene.host.profiles().build(agent, null, scene.host.config());
      expect(profile.home).toBe(scene.host.registry().get(agent).capabilities().defaultHome);
      expect(profile.windowTokens).toBeGreaterThan(0);
    },
  );

  it.each(REAL_AGENTS.map((agent) => [agent] as const))(
    "%s takes the configured window when the user set one (FR-18)",
    (agent) => {
      const config = testConfig({
        windowOverrides: [{ agent, windowTokens: 64_000 }],
      });
      expect(scene.host.profiles().build(agent, null, config).windowTokens).toBe(64_000);
    },
  );

  it("every agent gets a pipeline, so the budget line of FR-18 has a window to quote", async () => {
    for (const agent of REAL_AGENTS) {
      const profile = scene.host.profiles().build(agent, null, scene.host.config());
      await expect(scene.host.pipelineFor(profile)).resolves.toBeDefined();
    }
  });
});

describe("T-HOS-20 — two homes of one agent are two targets", () => {
  let scene: Bench;
  let teamHome: string;

  beforeAll(async () => {
    scene = await bench();
    teamHome = `${scene.root}/claude-team`;
  }, 60_000);

  afterAll(async () => {
    scene?.guard.restore();
    await cleanupTempDirs();
  });

  const profiles = () => {
    const config = scene.host.config();
    return {
      first: scene.host.profiles().build("claude-code", null, config),
      second: scene.host.profiles().build("claude-code", teamHome, config),
    };
  };

  it("builds two distinct profiles for one agent (FR-4)", () => {
    const { first, second } = profiles();
    expect(first.agent).toBe(second.agent);
    expect(first.home).not.toBe(second.home);
    expect(second.home).toBe(teamHome);
  });

  it("an import into one home does not touch the other (AC-6)", async () => {
    const { first, second } = profiles();
    const sourceAgent = FIXTURE_AGENT_ID;
    const sourceHome = scene.homes.get(sourceAgent) ?? "";
    const sourceId = scene.seeded.get(sourceAgent) ?? "";
    const adapter = scene.host.registry().get("claude-code");

    const landed: Record<string, string> = {};
    for (const [name, profile] of [
      ["first", first],
      ["second", second],
    ] as const) {
      const pipeline = await scene.host.pipelineFor(profile);
      const request = {
        destinationCwd: REPO_ROOT,
        target: profile,
        selection: { by: "session-id" as const, id: sourceId },
        onlyAgent: sourceAgent,
        onlyHome: sourceHome,
      };
      const report = await pipeline.preview(request);
      const result = await pipeline.commit(request, null, report.confirmationToken);
      expect(result.ref.home).toBe(profile.home);
      landed[name] = result.ref.id;
    }

    // Each session is openable in its own home and absent from the other.
    const first_id = landed.first ?? "";
    const second_id = landed.second ?? "";
    expect((await adapter.readBack(first.home, first_id)).openable).toBe(true);
    expect((await adapter.readBack(second.home, second_id)).openable).toBe(true);
    expect((await adapter.readBack(first.home, second_id)).openable).toBe(false);
    expect((await adapter.readBack(second.home, first_id)).openable).toBe(false);

    // And the source home still holds exactly what it held (FR-8, NG-1).
    const source = scene.host.registry().get(sourceAgent);
    const rows = await source.listSessions(sourceHome);
    expect(rows.map((row) => row.ref.id)).toEqual([sourceId]);
    await expect(descriptorOf(source, sourceHome, sourceId)).resolves.toBeDefined();
  }, 60_000);
});
