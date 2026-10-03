/**
 * T-ADA-6 to T-ADA-8 — the Integration Contract Tests of the conformance suite.
 *
 * Every body runs against every adapter, and every decision it makes reads a capability. No
 * body names an agent (FR-58, FR-60).
 */

import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALL_ADAPTERS,
  cleanupHomes,
  commit,
  filesUnder,
  hasRole,
  installNetworkTripwire,
  markerFor,
  networkAttempts,
  REFERENCE_SESSION,
  restoreNetwork,
  seedSource,
  targetProfile,
  throwawayHome,
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
const ISO = /^\d{4}-\d{2}-\d{2}T/;

describe.each(cases)("T-ADA-6 — %s: a declared capability is a capability it has", (_id, entry) => {
  it("performs the landing its declaration promises", async () => {
    const adapter = entry.create();
    const landing = adapter.capabilities().landing;
    const seeded = await seedSource(entry, REFERENCE_SESSION);

    if (landing === "create-and-switch") {
      const runtime = entry.runtime("switch");
      expect(runtime).not.toBeNull();
      await expect(adapter.switchTo(seeded.home, seeded.sessionId, runtime)).resolves.toEqual({
        switched: true,
        cancelled: false,
      });
      return;
    }

    // "create-only": the call fails naming the capability, before anything is committed —
    // never after a session is already in the user's home (FR-43).
    expect(entry.runtime("switch")).toBeNull();
    await expect(adapter.switchTo(seeded.home, seeded.sessionId, null)).rejects.toThrow(
      /create-only/,
    );
  });

  it("reports a user who declined instead of claiming a switch", async () => {
    const adapter = entry.create();
    if (adapter.capabilities().landing !== "create-and-switch") return;
    const seeded = await seedSource(entry, REFERENCE_SESSION);
    await expect(
      adapter.switchTo(seeded.home, seeded.sessionId, entry.runtime("cancel")),
    ).resolves.toEqual({ switched: false, cancelled: true });
  });
});

describe.each(cases)("T-ADA-7 — %s: a source adapter lists and loads", (_id, entry) => {
  it("returns one fully populated descriptor per session, and loads each", async () => {
    const adapter = entry.create();
    if (!hasRole(adapter, "source")) return;

    const home = await throwawayHome(`three-${entry.id}`);
    const ids: string[] = [];
    for (let n = 0; n < 3; n++) {
      ids.push((await seedSource(entry, REFERENCE_SESSION, { home })).sessionId);
    }

    const descriptors = await adapter.listSessions(home);
    expect(descriptors).toHaveLength(3);
    expect(descriptors.map((item) => item.ref.id).sort()).toEqual([...ids].sort());

    for (const descriptor of descriptors) {
      expect(descriptor.ref.agent).toBe(adapter.capabilities().agent);
      expect(descriptor.ref.home).toBe(home);
      expect(descriptor.title.trim().length).toBeGreaterThan(0);
      expect(descriptor.startedAt).toMatch(ISO);
      expect(descriptor.updatedAt).toMatch(ISO);
      expect(descriptor.turnCount).toBeGreaterThan(0);
      expect(descriptor.repoPaths).toEqual([descriptor.repoPath]);
      expect(descriptor.repoPath).not.toBeNull();
      expect(path.isAbsolute(descriptor.repoPath ?? "")).toBe(true);
      expect(path.isAbsolute(descriptor.filePath)).toBe(true);
      expect(descriptor.filePath.startsWith(home)).toBe(true);

      const session = await adapter.loadSession(descriptor);
      expect(session.turns).toHaveLength(descriptor.turnCount);
      expect(session.provenance.ref).toEqual(descriptor.ref);
    }
  });

  it("sorts the listing newest first (FR-14)", async () => {
    const adapter = entry.create();
    if (!hasRole(adapter, "source")) return;
    const home = await throwawayHome(`sorted-${entry.id}`);
    for (let n = 0; n < 3; n++) await seedSource(entry, REFERENCE_SESSION, { home });

    const updated = (await adapter.listSessions(home)).map((item) => item.updatedAt);
    expect([...updated].sort().reverse()).toEqual(updated);
  });
});

describe.each(cases)(
  "T-ADA-8 — %s: a target adapter serializes, validates, reads back",
  (_id, entry) => {
    it("produces bytes that validate, commit, and read back item for item", async () => {
      const adapter = entry.create();
      if (!hasRole(adapter, "target")) return;

      const home = await throwawayHome(`target-${entry.id}`);
      const serialized = adapter.serialize(
        REFERENCE_SESSION,
        targetProfile(adapter, home),
        markerFor(REFERENCE_SESSION),
        { cwd: "/repo" },
      );

      // One file for every agent but Kimi Code, whose native session is a wire.jsonl plus a
      // state.json; the landing commits them one at a time, ordered so no prefix is a session
      // the agent would list (Kimi Code: wire first — without state.json the directory is
      // invisible to its index).
      expect(serialized.files.length).toBeGreaterThanOrEqual(1);
      expect(serialized.itemCount).toBeGreaterThan(0);
      expect(serialized.sessionId.length).toBeGreaterThan(0);
      for (const file of serialized.files) {
        expect(path.isAbsolute(file.absolutePath)).toBe(true);
        expect(file.absolutePath.startsWith(home)).toBe(true);
        expect(file.bytes.length).toBeGreaterThan(0);
      }
      expect(adapter.validate(serialized)).toEqual([]);

      // Nothing exists yet: serializing produced bytes and nothing else (FR-49, FR-53).
      expect(await filesUnder(home)).toEqual([]);

      await commit(serialized.files);
      const facts = await adapter.readBack(home, serialized.sessionId);
      expect(facts).toEqual({
        sessionId: serialized.sessionId,
        itemCount: serialized.itemCount,
        openable: true,
      });
    });

    it("reports a session the home does not hold as not openable (FR-51)", async () => {
      const adapter = entry.create();
      if (!hasRole(adapter, "target")) return;
      const home = await throwawayHome(`absent-${entry.id}`);
      const facts = await adapter.readBack(home, "no-such-session-0001");
      expect(facts.openable).toBe(false);
      expect(facts.itemCount).toBe(0);
    });
  },
);
