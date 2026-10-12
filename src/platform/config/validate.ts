import type { AgentId, HomeEntry, ImportConfig, WindowOverride } from "./contract.js";
import { defaultConfig } from "./defaults.js";
import { ConfigLoadError } from "./errors.js";
import { resolveHomePath } from "./paths.js";

// Exhaustive by construction: adding an agent (FR-57) fails to compile here until it is listed,
// instead of silently rejecting the new value at run time.
const AGENTS: Record<AgentId, true> = {
  pi: true,
  codex: true,
  "claude-code": true,
  "kimi-code": true,
};
const SETTINGS: Record<keyof ImportConfig, true> = {
  extraHomes: true,
  budgetShare: true,
  pinnedRecentTurns: true,
  windowOverrides: true,
};

/**
 * Completes and checks one parsed configuration file. Absent settings keep their default;
 * a present but unusable one rejects with the field named (FR-56).
 *
 * @param baseDir directory a relative home is resolved against — the file's own directory.
 * @param source the file's path, used as the field of a whole-file complaint.
 */
export async function buildConfig(
  raw: unknown,
  baseDir: string,
  source: string,
): Promise<ImportConfig> {
  const settings = asRecord(
    raw,
    source,
    `${source} must hold a JSON object of settings, such as { "budgetShare": 0.5 }.`,
  );

  for (const key of Object.keys(settings)) {
    if (!Object.hasOwn(SETTINGS, key)) {
      throw new ConfigLoadError(
        key,
        `${key} is not a setting. The settings are ${Object.keys(SETTINGS).join(", ")}. ` +
          "Correct the spelling or remove the line.",
      );
    }
  }

  const config = defaultConfig();
  if (settings.budgetShare !== undefined) {
    config.budgetShare = asShare("budgetShare", settings.budgetShare);
  }
  if (settings.pinnedRecentTurns !== undefined) {
    config.pinnedRecentTurns = asTurnCount("pinnedRecentTurns", settings.pinnedRecentTurns);
  }
  if (settings.extraHomes !== undefined) {
    config.extraHomes = await asHomeEntries(settings.extraHomes, baseDir);
  }
  if (settings.windowOverrides !== undefined) {
    config.windowOverrides = asWindowOverrides(settings.windowOverrides);
  }
  return config;
}

function asShare(field: string, value: unknown): number {
  // 0 is refused: it would make FR-33 block every import, which is a mistake, not a choice.
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new ConfigLoadError(
      field,
      `${field} must be a number greater than 0 and at most 1, for example 0.5. Found ${show(value)}.`,
    );
  }
  return value;
}

function asTurnCount(field: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ConfigLoadError(
      field,
      `${field} must be a whole number of turns, zero or more, for example 8. Found ${show(value)}.`,
    );
  }
  return value;
}

async function asHomeEntries(value: unknown, baseDir: string): Promise<HomeEntry[]> {
  const items = asArray(value, "extraHomes");
  const entries: HomeEntry[] = [];
  for (const [index, item] of items.entries()) {
    const field = `extraHomes[${index}]`;
    const entry = asRecord(
      item,
      field,
      `${field} must be an object with an agent and a home, such as ` +
        '{ "agent": "pi", "home": "~/.pi-work" }.',
    );
    entries.push({
      agent: asAgentId(`${field}.agent`, entry.agent),
      home: await resolveHomePath(asPath(`${field}.home`, entry.home), baseDir),
    });
  }
  // Duplicates are kept: deduplication belongs to the search, which alone sees the
  // adapter defaults an extra home may repeat.
  return entries;
}

function asWindowOverrides(value: unknown): WindowOverride[] {
  const items = asArray(value, "windowOverrides");
  return items.map((item, index) => {
    const field = `windowOverrides[${index}]`;
    const entry = asRecord(
      item,
      field,
      `${field} must be an object with an agent and a windowTokens count, such as ` +
        '{ "agent": "claude-code", "windowTokens": 200000 }.',
    );
    return {
      agent: asAgentId(`${field}.agent`, entry.agent),
      windowTokens: asWindowTokens(`${field}.windowTokens`, entry.windowTokens),
    };
  });
}

function asWindowTokens(field: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ConfigLoadError(
      field,
      `${field} must be a whole number of tokens greater than zero, for example 200000. ` +
        `Found ${show(value)}.`,
    );
  }
  return value;
}

function asAgentId(field: string, value: unknown): AgentId {
  if (typeof value !== "string" || !Object.hasOwn(AGENTS, value)) {
    throw new ConfigLoadError(
      field,
      `${field} must name a known agent: ${Object.keys(AGENTS).join(", ")}. Found ${show(value)}.`,
    );
  }
  return value as AgentId;
}

function asPath(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigLoadError(
      field,
      `${field} must be a path to an agent profile directory. Found ${show(value)}.`,
    );
  }
  return value;
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ConfigLoadError(field, `${field} must be a list. Found ${show(value)}.`);
  }
  return value;
}

function asRecord(value: unknown, field: string, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigLoadError(field, message);
  }
  return value as Record<string, unknown>;
}

function show(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
