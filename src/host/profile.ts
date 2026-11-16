/**
 * Where an import is going, and how much room it has (FR-3, FR-18).
 *
 * Three values, each from one source: the agent the entry point reported, the home the user named
 * or the adapter declared, and the window the user configured or the adapter declared.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  AgentId,
  AgentRegistry,
  HomePath,
  ImportConfig,
  TargetProfile,
  TargetProfileBuilder,
} from "./contract.js";

/** A home is always absolute (FR-2). `~` is the user's, and everything else is resolved. */
function resolveHome(home: HomePath): HomePath {
  if (home === "~") return resolve(homedir());
  if (home.startsWith("~/") || home.startsWith("~\\")) {
    return join(resolve(homedir()), home.slice(2));
  }
  return resolve(home);
}

export function createTargetProfileBuilder(registry: AgentRegistry): TargetProfileBuilder {
  return {
    build(
      agent: AgentId,
      home: HomePath | null,
      config: ImportConfig,
      sessionDir?: HomePath,
    ): TargetProfile {
      // Rejects an agent with no adapter, rather than guessing one (FR-56).
      const declared = registry.get(agent).capabilities();
      const override = config.windowOverrides.find((entry) => entry.agent === agent);
      return {
        agent,
        home: home === null ? declared.defaultHome : resolveHome(home),
        ...(sessionDir === undefined ? {} : { sessionDir: resolve(sessionDir) }),
        windowTokens: override?.windowTokens ?? declared.defaultWindowTokens,
      };
    },
  };
}
