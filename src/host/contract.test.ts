/**
 * T-HOS-8 to T-HOS-12 — the composition root as a contract: the construction order, one
 * configuration per process, the entry point chosen from a declaration, and the two refusals.
 *
 * Nothing here touches a real agent home. Every adapter is either a fake that declares
 * capabilities and no format, or the fake fourth agent of `test/fixtures/`.
 */

import { describe, expect, it } from "vitest";
import {
  createFixtureAgentAdapter,
  FIXTURE_AGENT_ID,
} from "../../test/fixtures/fixture-agent/index.js";
import { ConfigLoadError } from "../platform/config/index.js";
import type { AgentEntry } from "./agents.js";
import type { AgentId, TargetProfile } from "./contract.js";
import {
  activatePiExtension,
  entryPointFor,
  type PiCommandRegistrar,
  runCommandBinary,
} from "./entry.js";
import { fakeAdapter, fakeEntry, recordingDeps, testConfig } from "./test-support.js";
import { createHost } from "./wiring.js";

const CODEX: AgentId = "codex";
const PI: AgentId = "pi";

describe("T-HOS-8 — the construction order holds", () => {
  it("loads configuration, then the services, then the adapters, then the pipeline", async () => {
    const deps = recordingDeps();
    const host = await createHost(deps);

    // Everything up to and including the adapters happened while the host was built.
    expect(deps.recorder.events).toEqual([
      "config",
      "service:tokens",
      "service:repo",
      "service:store",
      "adapter:pi",
      "adapter:codex",
      "adapter:claude-code",
    ]);

    // Step 4: the profile. It reads the adapter's declaration, so it cannot precede step 3.
    const profile = host.profiles().build(CODEX, null, host.config());
    expect(profile.home).toBe(host.registry().get(CODEX).capabilities().defaultHome);

    // Step 5: the pipeline. `forFamily` is real work only `pipelineFor` does.
    await host.pipelineFor(profile);
    expect(deps.recorder.events.at(-1)).toBe("pipeline");
  });

  it("builds the services before any adapter, whatever the list holds", async () => {
    const deps = recordingDeps();
    await createHost(deps);
    const lastService = deps.recorder.events.findLastIndex((event) => event.startsWith("service:"));
    const firstAdapter = deps.recorder.events.findIndex((event) => event.startsWith("adapter:"));
    expect(lastService).toBeLessThan(firstAdapter);
  });
});

describe("T-HOS-9 — configuration is loaded once", () => {
  it("loads once however many pipelines are built", async () => {
    const deps = recordingDeps();
    const host = await createHost(deps);
    const profile = host.profiles().build(CODEX, null, host.config());

    await host.pipelineFor(profile);
    await host.pipelineFor(profile);
    await host.pipelineFor(profile);

    // Two stages reading different configurations would make the preview and the commit disagree.
    expect(deps.recorder.loads).toBe(1);
  });

  it("hands every pipeline the same configuration object", async () => {
    const host = await createHost(recordingDeps({ config: { budgetShare: 0.5 } }));
    expect(host.config()).toBe(host.config());
    expect(host.config().budgetShare).toBe(0.5);
  });
});

describe("T-HOS-10 — the entry point follows the declared selection level", () => {
  const picker = fakeAdapter({ agent: PI, selection: "interactive-picker", sessions: [] });
  const numbered = fakeAdapter({ agent: CODEX, selection: "numbered-list", sessions: [] });
  const fourth = createFixtureAgentAdapter({ defaultHome: "/nowhere/fixture-home" });

  const cases = [
    ["an adapter declaring interactive-picker", picker, "interactive-picker"],
    ["an adapter declaring numbered-list", numbered, "command-binary"],
    ["a fake fourth agent declaring numbered-list", fourth, "command-binary"],
  ] as const;

  it.each(cases)("%s", (_name, adapter, expected) => {
    expect(entryPointFor(adapter.capabilities())).toBe(expected);
  });

  it("reads the declaration, not the name", () => {
    // The same agent name with the other declaration gets the other entry point.
    const codexAsPicker = fakeAdapter({ agent: CODEX, selection: "interactive-picker" });
    expect(entryPointFor(codexAsPicker.capabilities())).toBe("interactive-picker");
    expect(entryPointFor(numbered.capabilities())).toBe("command-binary");
  });

  const entries: readonly AgentEntry[] = [
    fakeEntry({ agent: PI, selection: "interactive-picker", sessions: [] }),
    fakeEntry({ agent: CODEX, selection: "numbered-list", sessions: [] }),
    { create: () => fourth, family: "generic" },
  ];

  const registrarStub = (): PiCommandRegistrar & { names: string[] } => {
    const names: string[] = [];
    return {
      names,
      registerCommand(definition) {
        names.push(definition.name);
      },
    };
  };

  const activation = (agent: AgentId) => ({
    agent,
    registrar: registrarStub(),
    ui: { show: () => {}, confirm: () => Promise.resolve("cancelled" as const) },
    keys: { next: () => Promise.resolve(null) },
    home: null,
    cwd: "/tmp",
  });

  it("the picker runs the in-process extension", async () => {
    const request = activation(PI);
    await activatePiExtension(request, { agents: entries, configLoader: fixedConfig() });
    expect(request.registrar.names).toEqual(["resume-from"]);
  });

  it("accepts a host-native picker without a raw key source", async () => {
    const request = {
      agent: PI,
      registrar: registrarStub(),
      ui: { show: () => {}, confirm: () => Promise.resolve("cancelled" as const) },
      picker: { pick: async () => ({ choice: "cancelled" as const, selected: null }) },
      home: null,
      cwd: "/tmp",
    };

    await activatePiExtension(request, { agents: entries, configLoader: fixedConfig() });

    expect(request.registrar.names).toEqual(["resume-from"]);
  });

  it.each([
    ["numbered-list", CODEX],
    ["a fake fourth agent", FIXTURE_AGENT_ID],
  ])("%s is refused by the in-process extension", async (_name, agent) => {
    const request = activation(agent);
    await expect(
      activatePiExtension(request, { agents: entries, configLoader: fixedConfig() }),
    ).rejects.toThrow(/numbered-list/);
    expect(request.registrar.names).toEqual([]);
  });

  it.each([
    ["numbered-list", CODEX],
    ["a fake fourth agent", FIXTURE_AGENT_ID],
  ])("%s runs the command binary", async (_name, agent) => {
    const outcome = await runCommandBinary(
      { argv: [], cwd: "/tmp", targetAgent: agent, targetHome: null },
      { agents: entries, configLoader: fixedConfig() },
    );
    expect(outcome.exitCode).toBe(0);
  });

  it("the picker agent is refused by the command binary", async () => {
    const outcome = await runCommandBinary(
      { argv: [], cwd: "/tmp", targetAgent: PI, targetHome: null },
      { agents: entries, configLoader: fixedConfig() },
    );
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr.join(" ")).toMatch(/interactive-picker/);
  });
});

describe("T-HOS-11 — a target without the target role is refused", () => {
  it("rejects, naming the role the adapter does not declare", async () => {
    const host = await createHost({
      agents: [fakeEntry({ agent: CODEX, roles: ["source"] })],
      configLoader: fixedConfig(),
    });
    const profile: TargetProfile = { agent: CODEX, home: "/tmp/home", windowTokens: 100_000 };
    await expect(host.pipelineFor(profile)).rejects.toThrow(/"target"/);
  });

  it("rejects an agent with no adapter at all", async () => {
    const host = await createHost({
      agents: [fakeEntry({ agent: CODEX })],
      configLoader: fixedConfig(),
    });
    const profile: TargetProfile = { agent: PI, home: "/tmp/home", windowTokens: 100_000 };
    await expect(host.pipelineFor(profile)).rejects.toThrow(/pi/);
  });
});

describe("T-HOS-12 — a configuration error stops before anything is listed", () => {
  const failure = new ConfigLoadError(
    "budgetShare",
    "budgetShare must be a share between 0 and 1. Set it to 0.30, or remove it.",
  );

  it("rejects with the field and what to change", async () => {
    const deps = recordingDeps({ configError: failure });
    await expect(createHost(deps)).rejects.toThrow(/budgetShare must be a share between 0 and 1/);
  });

  it("keeps the field on the rejection", async () => {
    const deps = recordingDeps({ configError: failure });
    const caught = await createHost(deps).catch((cause: unknown) => cause);
    expect((caught as ConfigLoadError).field).toBe("budgetShare");
  });

  it("constructs no adapter and reads no home", async () => {
    const deps = recordingDeps({ configError: failure });
    await createHost(deps).catch(() => undefined);
    expect(deps.recorder.events).toEqual(["config"]);
  });
});

function fixedConfig() {
  return { load: () => Promise.resolve(testConfig()) };
}
