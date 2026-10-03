/**
 * T-ADA-13 to T-ADA-20 — the Boundary Tests of the conformance suite.
 *
 * They are the tests of what an adapter may never do: create a file, touch a source, open a
 * connection, place unchecked bytes, mint a colliding id, or guess at a file it cannot read.
 *
 * Also holds the redaction-copy guard (Finding 2): the three redaction.ts copies are
 * byte-identical by design, and this test fails immediately if they drift.
 */

import { readFileSync } from "node:fs";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PendingFile, SerializedSession, SessionDescriptor } from "./contract.js";
import {
  ALL_ADAPTERS,
  cleanupHomes,
  clearNetworkAttempts,
  commit,
  hasRole,
  installNetworkTripwire,
  land,
  markerFor,
  networkAttempts,
  REFERENCE_SESSION,
  restoreNetwork,
  seedSource,
  sessionText,
  snapshot,
  targetProfile,
  throwawayHome,
  UNKNOWN_MARKER,
} from "./test-support.js";

beforeAll(() => {
  installNetworkTripwire();
});
afterAll(async () => {
  restoreNetwork();
  expect(networkAttempts()).toEqual([]);
  await cleanupHomes();
});

const cases = ALL_ADAPTERS.map((entry) => [entry.id, entry] as const);

// First in the file, so nothing an adapter did is cleared with the canary's own trip.
it("T-ADA-15 — the network tripwire is armed for the whole suite", () => {
  expect(() => globalThis.fetch("https://example.invalid")).toThrow(/network/);
  expect(networkAttempts()).toEqual(["fetch"]);
  clearNetworkAttempts();
});

describe.each(cases)("T-ADA-13 — %s: no adapter writes a file", (_id, entry) => {
  it("leaves the target home byte-identical around serialize and validate", async () => {
    const adapter = entry.create();
    if (!hasRole(adapter, "target")) return;

    // A home that already holds a session, so the checksum has something to protect.
    const seeded = await seedSource(entry, REFERENCE_SESSION);
    const before = await snapshot(seeded.home);
    expect(before.size).toBeGreaterThan(0);

    for (let round = 0; round < 3; round++) {
      const serialized = adapter.serialize(
        REFERENCE_SESSION,
        targetProfile(adapter, seeded.home),
        markerFor(REFERENCE_SESSION),
        { cwd: "/repo" },
      );
      expect(adapter.validate(serialized)).toEqual([]);
    }

    expect(await snapshot(seeded.home)).toEqual(before);
  });
});

describe.each(cases)("T-ADA-15 — %s: no adapter opens a network connection", (_id, entry) => {
  it("runs a whole cycle with the network failing on any use (FR-8)", async () => {
    const adapter = entry.create();
    const seeded = await seedSource(entry, REFERENCE_SESSION);
    const descriptors = await adapter.listSessions(seeded.home);
    const descriptor = descriptors[0];
    if (descriptor === undefined) throw new Error(`${entry.id} listed nothing`);
    const session = await adapter.loadSession(descriptor);

    const home = await throwawayHome(`net-${entry.id}`);
    const serialized = adapter.serialize(
      session,
      targetProfile(adapter, home),
      markerFor(session),
      { cwd: "/repo" },
    );
    expect(adapter.validate(serialized)).toEqual([]);
    await commit(serialized.files);
    await adapter.readBack(home, serialized.sessionId);

    expect(networkAttempts()).toEqual([]);
  });
});

/** A serialized session, and the target home it was minted for. */
async function serializeInto(
  entry: (typeof ALL_ADAPTERS)[number],
): Promise<{ home: string; serialized: SerializedSession }> {
  const adapter = entry.create();
  const home = await throwawayHome(`damage-${entry.id}`);
  const serialized = adapter.serialize(
    REFERENCE_SESSION,
    targetProfile(adapter, home),
    markerFor(REFERENCE_SESSION),
    { cwd: "/repo" },
  );
  return { home, serialized };
}

describe.each(cases)("T-ADA-16 — %s: validation catches a missing required field", (_id, entry) => {
  it("names the path, and the landing stops before placement (FR-50)", async () => {
    const adapter = entry.create();
    if (!hasRole(adapter, "target")) return;
    // A home that already holds a good session, so "nothing was placed" is a real comparison.
    const { home, serialized } = await serializeInto(entry);
    await commit(serialized.files);
    const before = await snapshot(home);
    expect(before.size).toBeGreaterThan(0);

    const damaged = entry.damage(
      adapter.serialize(
        REFERENCE_SESSION,
        targetProfile(adapter, home),
        markerFor(REFERENCE_SESSION),
        { cwd: "/repo" },
      ),
      1,
    );
    const defects = adapter.validate(damaged);
    expect(defects.length).toBeGreaterThanOrEqual(1);
    for (const defect of defects) {
      expect(defect.path.length).toBeGreaterThan(0);
      expect(defect.message.length).toBeGreaterThan(0);
    }

    const landed = await land(adapter, damaged);
    expect(landed.defects).toBe(defects.length);
    expect(landed.createdPaths).toEqual([]);
    expect(await snapshot(home)).toEqual(before);
  });
});

describe.each(cases)("T-ADA-17 — %s: validation reports every defect", (_id, entry) => {
  it("returns three defects for three damaged fields, not one", async () => {
    const adapter = entry.create();
    if (!hasRole(adapter, "target")) return;
    const { serialized } = await serializeInto(entry);

    const defects = adapter.validate(entry.damage(serialized, 3));
    expect(defects.length).toBeGreaterThanOrEqual(3);
    expect(new Set(defects.map((defect) => defect.path)).size).toBeGreaterThanOrEqual(3);
  });
});

describe.each(cases)("T-ADA-18 — %s: a minted session ID does not collide", (_id, entry) => {
  it("mints 1000 new paths against a home already holding 100 sessions (FR-49)", async () => {
    const adapter = entry.create();
    if (!hasRole(adapter, "target")) return;

    const home = await throwawayHome(`mint-${entry.id}`);
    const profile = targetProfile(adapter, home);
    const marker = markerFor(REFERENCE_SESSION);

    const existing: PendingFile[] = [];
    for (let n = 0; n < 100; n++) {
      const files = adapter.serialize(REFERENCE_SESSION, profile, marker, { cwd: "/repo" }).files;
      expect(files.length).toBeGreaterThanOrEqual(1);
      existing.push(...files);
      await commit(files);
    }

    const taken = new Set(existing.map((file) => file.absolutePath));
    const minted = new Set<string>();
    const ids = new Set<string>();
    for (let n = 0; n < 1000; n++) {
      const serialized = adapter.serialize(REFERENCE_SESSION, profile, marker, { cwd: "/repo" });
      ids.add(serialized.sessionId);
      for (const file of serialized.files) {
        expect(taken.has(file.absolutePath)).toBe(false);
        expect(minted.has(file.absolutePath)).toBe(false);
        minted.add(file.absolutePath);
      }
    }
    expect(ids.size).toBe(1000);
  }, 30_000);
});

describe.each(cases)(
  "T-ADA-20 — %s: a corrupt source session is reported, not guessed",
  (_id, entry) => {
    it("refuses to load a session file cut mid-entry, naming the file", async () => {
      const adapter = entry.create();
      if (!hasRole(adapter, "source") || !hasRole(adapter, "target")) return;

      const home = await throwawayHome(`cut-${entry.id}`);
      const serialized = adapter.serialize(
        REFERENCE_SESSION,
        targetProfile(adapter, home),
        markerFor(REFERENCE_SESSION),
        { cwd: "/repo" },
      );
      const whole = serialized.files[0];
      if (whole === undefined) throw new Error("nothing to cut");
      const cut = whole.bytes.subarray(0, whole.bytes.length - 40);
      await commit([{ absolutePath: whole.absolutePath, bytes: cut }]);

      const listed = await adapter.listSessions(home);
      const descriptor: SessionDescriptor = listed.find(
        (item) => item.filePath === whole.absolutePath,
      ) ?? {
        ref: {
          agent: adapter.capabilities().agent,
          home,
          id: serialized.sessionId,
        },
        title: "",
        startedAt: "",
        updatedAt: "",
        turnCount: 0,
        repoPath: null,
        repoPaths: [],
        startDirectory: null,
        filePath: whole.absolutePath,
      };

      // Nothing is guessed: the file never becomes a shorter session.
      await expect(adapter.loadSession(descriptor)).rejects.toThrow(
        new RegExp(path.basename(whole.absolutePath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    });

    it("skips an entry type it does not know instead of failing or guessing", async () => {
      const adapter = entry.create();
      if (!hasRole(adapter, "source")) return;

      const clean = await seedSource(entry, REFERENCE_SESSION);
      const strange = await seedSource(entry, REFERENCE_SESSION, {
        unknown: true,
      });

      const cleanTurns = (
        await adapter.loadSession(
          (
            await adapter.listSessions(clean.home)
          ).find((item) => item.ref.id === clean.sessionId) as SessionDescriptor,
        )
      ).turns.length;

      const listed = (await adapter.listSessions(strange.home)).find(
        (item) => item.ref.id === strange.sessionId,
      );
      expect(listed).toBeDefined();
      const loaded = await adapter.loadSession(listed as SessionDescriptor);

      expect(loaded.turns).toHaveLength(cleanTurns);
      expect(sessionText(loaded)).not.toContain(UNKNOWN_MARKER);
    });
  },
);

/**
 * Finding 2 (P2, design): the four redaction.ts copies are byte-identical.
 * Consolidating into a shared module is blocked: src/adapters/contract.ts is types-only, and
 * importing behaviour from src/platform/ would be rejected by T-ROO-7 (adapter imports from a
 * non-parent, non-composition-root module must end in /contract.js — which exports only types).
 * The four files are kept in sync by policy. This test enforces that policy mechanically.
 */
describe("redaction implementations are byte-identical across adapter submodules", () => {
  // fileURLToPath, not .pathname: a checkout path with spaces or non-ASCII must not
  // percent-encode into an ENOENT that would disguise itself as a drift failure.
  const ADAPTERS_DIR = fileURLToPath(new URL(".", import.meta.url));
  const REDACTION_FILES = [
    join(ADAPTERS_DIR, "claude-code", "redaction.ts"),
    join(ADAPTERS_DIR, "codex", "redaction.ts"),
    join(ADAPTERS_DIR, "kimi-code", "redaction.ts"),
    join(ADAPTERS_DIR, "pi", "redaction.ts"),
  ];

  it("all four redaction.ts files are byte-identical (edit all four together)", () => {
    const [first, ...rest] = REDACTION_FILES.map((file) => readFileSync(file, "utf8"));
    for (const content of rest) {
      expect(content).toBe(first);
    }
  });
});
