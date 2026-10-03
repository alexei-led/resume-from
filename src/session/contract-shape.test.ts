/**
 * Shape of the vocabulary — T-SES-1, T-SES-2, T-SES-9.
 *
 * These are compile-time assertions first and runtime assertions second: the key lists
 * below are tied to the interfaces in `contract.ts` by `Equals`, so adding, renaming or
 * removing a field fails the build before any test runs. That is the mechanical guard
 * FR-24 and FR-60 depend on — a result body cannot be smuggled in as a new field.
 */

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  AgentId,
  CanonicalSession,
  CanonicalTurn,
  ProvenanceMarker,
  RepoSnapshot,
  SessionDescriptor,
  SessionRef,
  SourceProvenance,
  TargetProfile,
  ToolCallRecord,
} from "./contract.js";

/** True only when A and B are the same type, checked in both directions. */
type Equals<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;

/**
 * Negative control. If `Equals` were mis-written it would answer `true` for everything and
 * every assertion in this file would be vacuous — this line would then fail to compile.
 */
const EQUALS_DISCRIMINATES: Equals<{ a: string }, { a: string; b: string }> = false;

/** Every keyed type of the Public Contract, and the keys module.md declares for it. */
const CONTRACT_KEYS = {
  SessionRef: ["agent", "home", "id"],
  SessionDescriptor: [
    "ref",
    "title",
    "startedAt",
    "updatedAt",
    "turnCount",
    "repoPath",
    "repoPaths",
    "startDirectory",
    "filePath",
  ],
  ToolCallRecord: [
    "toolName",
    "argumentsText",
    "outcomeLine",
    "effect",
    "bodyDropped",
    "resultRecorded",
  ],
  CanonicalTurn: ["index", "role", "kind", "text", "toolCall", "timestamp"],
  RepoSnapshot: ["commit", "branch", "changedPaths"],
  SourceProvenance: ["ref", "title", "startedAt", "updatedAt", "repo"],
  CanonicalSession: ["provenance", "turns"],
  TargetProfile: ["agent", "home", "windowTokens"],
  ProvenanceMarker: [
    "sourceAgent",
    "sourceHome",
    "sourceSessionId",
    "importedAt",
    "droppedSummary",
    "lines",
  ],
} as const;

type Keys<N extends keyof typeof CONTRACT_KEYS> = (typeof CONTRACT_KEYS)[N][number];

/** Each entry compiles only when the list above is exactly that interface's key set. */
const KEY_SETS_ARE_EXACT: [
  Equals<Keys<"SessionRef">, keyof SessionRef>,
  Equals<Keys<"SessionDescriptor">, keyof SessionDescriptor>,
  Equals<Keys<"ToolCallRecord">, keyof ToolCallRecord>,
  Equals<Keys<"CanonicalTurn">, keyof CanonicalTurn>,
  Equals<Keys<"RepoSnapshot">, keyof RepoSnapshot>,
  Equals<Keys<"SourceProvenance">, keyof SourceProvenance>,
  Equals<Keys<"CanonicalSession">, keyof CanonicalSession>,
  Equals<Keys<"TargetProfile">, keyof TargetProfile>,
  Equals<Keys<"ProvenanceMarker">, keyof ProvenanceMarker>,
] = [true, true, true, true, true, true, true, true, true];

/** The runtime form of `AgentId`, tied to the type so a half-added agent fails the build. */
const AGENT_IDS = ["pi", "codex", "claude-code", "kimi-code"] as const;
const AGENT_IDS_ARE_EXACT: Equals<(typeof AGENT_IDS)[number], AgentId> = true;

/**
 * Content excluded by FR-28, NG-7 and NG-8. Matching is whole-key-name and
 * case-insensitive: `windowTokens` is a budget count declared by the contract itself,
 * not a credential.
 */
const EXCLUDED_KEY_NAMES = [
  "reasoning",
  "thinking",
  "systemPrompt",
  "developerPrompt",
  "token",
  "apiKey",
  "env",
  "telemetry",
  "vendorState",
];

const ADAPTERS_DIR = fileURLToPath(new URL("../adapters/", import.meta.url));

describe("contract shape", () => {
  it("discriminates equal from unequal types, so the guards below are not vacuous", () => {
    expect(EQUALS_DISCRIMINATES).toBe(false);
    expect(KEY_SETS_ARE_EXACT.every((exact) => exact)).toBe(true);
    expect(AGENT_IDS_ARE_EXACT).toBe(true);
  });

  it("gives a tool call record no field for a result body (T-SES-1)", () => {
    expect([...CONTRACT_KEYS.ToolCallRecord].sort()).toEqual(
      [
        "toolName",
        "argumentsText",
        "outcomeLine",
        "effect",
        "bodyDropped",
        "resultRecorded",
      ].sort(),
    );
  });

  it("carries no excluded content in any contract type (T-SES-2)", () => {
    const excluded = new Set(EXCLUDED_KEY_NAMES.map((name) => name.toLowerCase()));
    const offenders = Object.entries(CONTRACT_KEYS).flatMap(([typeName, keys]) =>
      keys.filter((key) => excluded.has(key.toLowerCase())).map((key) => `${typeName}.${key}`),
    );
    expect(offenders).toEqual([]);
  });

  it("matches every AgentId value to a folder under src/adapters/ (T-SES-9)", () => {
    const folders = readdirSync(ADAPTERS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);

    expect(folders.sort()).toEqual([...AGENT_IDS].sort());
  });

  it("spells every AgentId value in lowercase kebab-case", () => {
    for (const agent of AGENT_IDS) {
      expect(agent).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});
