import { rmSync } from "node:fs";
import { basename, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REFERENCE_SESSION } from "../../../test/fixtures/reference-session.js";
import { createPiAdapter } from "./adapter.js";
import type { TargetProfile } from "./contract.js";
import {
  checksumTree,
  entriesOf,
  makeThrowawayHome,
  markerFixture,
  piUserDraft,
  writeFixtureSession,
} from "./fixtures.js";
import { MARKER_CUSTOM_TYPE, PI_SESSION_VERSION, sessionDirFor } from "./format.js";

const homes: string[] = [];

function throwawayHome(): string {
  const created = makeThrowawayHome();
  homes.push(created);
  return created;
}

afterEach(() => {
  while (homes.length > 0) {
    const dir = homes.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const CWD = "/Users/testuser/Workspace/demo";

function fixedAdapter() {
  let entry = 0;
  return createPiAdapter({
    now: () => new Date("2026-08-02T10:00:00.000Z"),
    newSessionId: () => "01998877-6655-4433-2211-000000000001",
    newEntryId: () => {
      entry += 1;
      return `e${entry.toString().padStart(7, "0")}`;
    },
  });
}

function target(home: string): TargetProfile {
  return { agent: "pi", home, windowTokens: 200_000 };
}

describe("T-PI-4 — serialization produces a header and one entry per turn", () => {
  const home = "/tmp/does-not-need-to-exist";
  const serialized = fixedAdapter().serialize(REFERENCE_SESSION, target(home), markerFixture(), {
    cwd: CWD,
  });
  const file = serialized.files[0];
  const entries = entriesOf(file?.bytes.toString("utf8") ?? "");

  it("produces exactly one file, in Pi's own session directory", () => {
    expect(serialized.files).toHaveLength(1);
    expect(dirname(file?.absolutePath ?? "")).toBe(sessionDirFor(home, CWD));
    expect(basename(file?.absolutePath ?? "")).toContain(serialized.sessionId);
    expect(basename(file?.absolutePath ?? "").endsWith(".jsonl")).toBe(true);
  });

  it("starts with a session header", () => {
    expect(entries[0]).toMatchObject({
      type: "session",
      version: PI_SESSION_VERSION,
      id: serialized.sessionId,
      cwd: CWD,
    });
  });

  it("writes one message entry per canonical turn", () => {
    const messages = entries.filter((entry) => entry.type === "message");
    expect(messages).toHaveLength(REFERENCE_SESSION.turns.length);
  });

  it("counts every entry it expects Pi to store, header excluded", () => {
    expect(serialized.itemCount).toBe(entries.length - 1);
    expect(serialized.itemCount).toBe(REFERENCE_SESSION.turns.length + 1);
  });

  it("chains the entries into one branch Pi can walk", () => {
    const seen = new Set<string>();
    let parent: string | null = null;
    for (const entry of entries.slice(1)) {
      expect(entry.parentId).toBe(parent);
      expect(typeof entry.id).toBe("string");
      expect(seen.has(entry.id as string)).toBe(false);
      seen.add(entry.id as string);
      parent = entry.id as string;
      expect(new Date(entry.timestamp as string).toISOString()).toBe(entry.timestamp);
    }
  });

  it("never writes a compaction entry, which would hide the imported turns", () => {
    expect(entries.some((entry) => entry.type === "compaction")).toBe(false);
  });

  it("never writes a tool call block, which would need a result body it dropped", () => {
    const blocks = entries.flatMap((entry) => {
      const message = entry.message as { content?: { type: string }[] } | undefined;
      return message?.content ?? [];
    });
    expect(blocks.some((block) => block.type === "toolCall")).toBe(false);
    expect(blocks.every((block) => block.type === "text")).toBe(true);
  });

  it("carries every canonical turn's visible text", () => {
    const text = entriesOf(file?.bytes.toString("utf8") ?? "")
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    for (const turn of REFERENCE_SESSION.turns) {
      const expected = turn.kind === "tool-call" ? turn.toolCall?.outcomeLine : turn.text;
      expect(expected).toBeTruthy();
      expect(text).toContain(JSON.stringify(expected ?? "").slice(1, -1));
    }
  });

  it("writes the provenance marker as an entry Pi does not send to the model", () => {
    const marker = entries.find((entry) => entry.customType === MARKER_CUSTOM_TYPE);
    expect(marker?.type).toBe("custom");
    const messages = entries.filter((entry) => entry.type === "message");
    for (const line of markerFixture().lines) {
      expect(JSON.stringify(messages)).not.toContain(line);
    }
  });
});

describe("T-PI-5 — every assistant message carries a usage object", () => {
  const serialized = fixedAdapter().serialize(
    REFERENCE_SESSION,
    target("/tmp/does-not-need-to-exist"),
    markerFixture(),
    { cwd: CWD },
  );
  const entries = entriesOf(serialized.files[0]?.bytes.toString("utf8") ?? "");
  const assistants = entries.filter(
    (entry) => (entry.message as { role?: string } | undefined)?.role === "assistant",
  );

  it("has at least one assistant entry to check", () => {
    expect(assistants.length).toBeGreaterThan(0);
  });

  it.each(["input", "output", "cacheRead", "cacheWrite", "totalTokens"])(
    "gives every assistant entry a numeric usage.%s (C-11)",
    (field) => {
      for (const entry of assistants) {
        const usage = (entry.message as { usage?: Record<string, unknown> }).usage;
        expect(usage).toBeTruthy();
        expect(Number.isFinite(usage?.[field])).toBe(true);
      }
    },
  );

  it("gives every assistant entry a numeric usage.cost.total", () => {
    for (const entry of assistants) {
      const usage = (entry.message as { usage?: { cost?: Record<string, unknown> } }).usage;
      expect(Number.isFinite(usage?.cost?.total)).toBe(true);
    }
  });

  it("marks imported turns so Pi does not try to restore a model", () => {
    // Pi's `getBranchSelection` skips an assistant turn whose api is `pi-virtual`. Without
    // this marker an interactive resume prints "Could not restore model …" (Pi 1.5.0).
    for (const entry of assistants) {
      expect((entry.message as { api?: string }).api).toBe("pi-virtual");
    }
  });

  it("passes its own validation", () => {
    expect(fixedAdapter().validate(serialized)).toEqual([]);
  });
});

describe("T-PI-11 — the module never writes", () => {
  it("leaves the home byte-identical across serialize and validate", () => {
    const home = throwawayHome();
    writeFixtureSession(home, CWD, [piUserDraft("a session that was already there")]);
    const adapter = fixedAdapter();
    const before = checksumTree(home);
    expect(before.size).toBeGreaterThan(0);

    const serialized = adapter.serialize(REFERENCE_SESSION, target(home), markerFixture(), {
      cwd: CWD,
    });
    adapter.validate(serialized);

    expect([...checksumTree(home).entries()]).toEqual([...before.entries()]);
  });
});
