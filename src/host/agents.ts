/**
 * The agent list — the one place in the tree that knows which adapters exist (FR-57).
 *
 * It lives in the composition root rather than in `src/adapters/` because nothing depends on the
 * composition root. A list inside `src/adapters/` would close the cycle
 * list → `adapters/pi` → `import` → adapter port, and the Pi entry point could not exist.
 *
 * Adding an agent is a new folder under `src/adapters/`, a new value in `AgentId`, and one line
 * below. There is no `switch` anywhere in this module for the same reason: a branch on the agent
 * name would be a second place to edit.
 */

import { claudeCodeAdapter } from "../adapters/claude-code/index.js";
import { codexAdapterFactory } from "../adapters/codex/index.js";
import { kimiCodeAdapterFactory } from "../adapters/kimi-code/index.js";
import { piAdapterFactory } from "../adapters/pi/index.js";
import type { AgentAdapter, EstimatorFamily } from "./contract.js";

/** One agent, as the composition root needs it. */
export interface AgentEntry {
  /**
   * Builds the adapter. Called once per process, after the configuration is loaded, so a
   * rejected configuration constructs nothing (FR-56).
   */
  create(): AgentAdapter;
  /**
   * How tokens are counted for an import *into* this agent. The budget is a share of the target
   * window (FR-30), so the counting rule is a property of the target. `AgentCapabilities` does
   * not declare it, so it is stated here, where the implementation is already named — which
   * keeps adding an agent a one-line change.
   */
  family: EstimatorFamily;
}

/** The agent list. Adding an agent adds one line here (FR-57). */
export const AGENTS: readonly AgentEntry[] = [
  { create: () => piAdapterFactory.create(), family: "claude" },
  { create: () => codexAdapterFactory.create(), family: "gpt" },
  { create: () => claudeCodeAdapter.create(), family: "claude" },
  { create: () => kimiCodeAdapterFactory.create(), family: "gpt" },
];
