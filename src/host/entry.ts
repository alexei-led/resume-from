/**
 * Which entry point runs, and starting it.
 *
 * C-1 forces two mechanisms: Codex and Claude Code cannot host the command, so they call a
 * binary; Pi can, and its switch needs a live command context (C-10), so it loads an extension
 * in-process. Exactly one of them runs per process, and which one is read from the target
 * adapter's declared `selection` level — never from its name (FR-43, FR-58).
 *
 * The two starts are not symmetrical, and that is the design rather than an omission: the binary
 * is handed an invocation and answers with an outcome, while the extension is handed the live
 * context C-10 proved the switch needs and answers by registering a command.
 */

import { createCliRunner } from "./cli/index.js";
import type {
  AgentCapabilities,
  AgentId,
  CliInvocation,
  CliOutcome,
  HomePath,
  SelectionLevel,
} from "./contract.js";
import {
  createKeyPicker,
  type KeySource,
  type PiCommandRegistrar,
  type PiUi,
  registerResumeFrom,
  type SessionPicker,
} from "./pi-extension/index.js";
import { createHost, type HostDeps } from "./wiring.js";

export type { KeySource, PiCommandRegistrar, PiUi };

/** The two mechanisms C-1 forces. */
export type EntryPointKind = "command-binary" | "interactive-picker";

/**
 * Exhaustive by construction: a new selection level fails to compile here until it is placed,
 * which is the whole reason this is a table and not a branch on the agent.
 */
const ENTRY_POINTS: Record<SelectionLevel, EntryPointKind> = {
  "interactive-picker": "interactive-picker",
  "numbered-list": "command-binary",
};

/** Which entry point hosts an agent (FR-43, FR-58). */
export function entryPointFor(capabilities: AgentCapabilities): EntryPointKind {
  return ENTRY_POINTS[capabilities.selection];
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * One invocation of the command binary, from configuration to printed lines.
 *
 * Every failure is an outcome rather than a rejection: the binary's contract is an exit code and
 * two streams, so a configuration error reaches the user as exit 2 and a sentence (FR-56).
 */
export async function runCommandBinary(
  invocation: CliInvocation,
  deps: HostDeps = {},
): Promise<CliOutcome> {
  try {
    const host = await createHost(deps);
    if (invocation.targetAgent === null) {
      // A bare shell has no target agent: list, look up and print native commands only (FR-61).
      const pipeline = await host.pipelineForListing();
      return await createCliRunner(null).run(invocation, pipeline);
    }
    const declared = host.registry().get(invocation.targetAgent).capabilities();
    if (entryPointFor(declared) !== "command-binary") {
      return {
        stdout: [],
        stderr: [
          `The "${invocation.targetAgent}" adapter declares selection ` +
            `"${declared.selection}", so it hosts /resume-from in-process and not through this ` +
            "binary. Type /resume-from inside the agent itself.",
        ],
        exitCode: 2,
      };
    }
    const target = host
      .profiles()
      .build(invocation.targetAgent, invocation.targetHome, host.config());
    const pipeline = await host.pipelineFor(target);
    return await createCliRunner(target).run(invocation, pipeline);
  } catch (cause) {
    return { stdout: [], stderr: [messageOf(cause)], exitCode: 2 };
  }
}

/** What the agent's own process supplies when it loads the extension. */
export interface PiActivation {
  /** The agent the extension is loaded inside. The host states it; this module never guesses. */
  agent: AgentId;
  /** The command surface of the agent that loaded the extension. */
  registrar: PiCommandRegistrar;
  /** How lines reach the user, and how a confirmation is taken. */
  ui: PiUi;
  /** A host-native picker. When present it replaces the lower-level key source. */
  picker?: SessionPicker;
  /** Where the picker's keys come from (FR-9) when the host has no native picker. */
  keys?: KeySource;
  /** The home the agent is running, or null to use the adapter's declared default (FR-3). */
  home: HomePath | null;
  /** The directory the agent is running in. Used to find the repository (FR-13). */
  cwd?: string;
}

/**
 * Registers /resume-from inside an agent that hosts it itself.
 *
 * Unlike the binary this rejects rather than returning an outcome: there is no exit code to
 * carry the failure, and an extension that registered a command it cannot drive would be worse
 * than one that failed to load.
 */
export async function activatePiExtension(
  activation: PiActivation,
  deps: HostDeps = {},
): Promise<void> {
  const host = await createHost(
    activation.cwd === undefined ? deps : { cwd: activation.cwd, ...deps },
  );
  const declared = host.registry().get(activation.agent).capabilities();
  if (entryPointFor(declared) !== "interactive-picker") {
    throw new Error(
      `The "${activation.agent}" adapter declares selection "${declared.selection}", so it ` +
        "cannot host the picker in-process. It is driven by the command binary instead.",
    );
  }

  const target = host.profiles().build(activation.agent, activation.home, host.config());
  const pipeline = await host.pipelineFor(target);

  registerResumeFrom(activation.registrar, {
    pipeline,
    picker: pickerFor(activation),
    ui: activation.ui,
    // The extension holds no capability knowledge, so the window comes from here (FR-18).
    windowTokens: target.windowTokens,
  });
}

function pickerFor(activation: PiActivation): SessionPicker {
  if (activation.picker !== undefined) return activation.picker;
  if (activation.keys !== undefined) {
    return createKeyPicker({ keys: activation.keys, ui: activation.ui });
  }
  throw new Error("Pi activation requires either a native picker or a key source.");
}
