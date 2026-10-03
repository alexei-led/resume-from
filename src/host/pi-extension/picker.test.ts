import { describe, expect, it } from "vitest";
import type { AgentId, Listing, SessionDescriptor } from "./contract.js";
import { createKeyPicker, type KeySource, type PickerKey } from "./picker.js";
import type { PiUi } from "./ui.js";

function descriptor(over: Partial<SessionDescriptor> & { agent?: AgentId }): SessionDescriptor {
  const agent = over.agent ?? "pi";
  return {
    ref: { agent, home: over.ref?.home ?? "/Users/me/.pi", id: over.ref?.id ?? "s-1" },
    title: over.title ?? "Some session",
    startedAt: over.startedAt ?? "2026-08-01T09:00:00Z",
    updatedAt: over.updatedAt ?? "2026-08-01T10:00:00Z",
    turnCount: over.turnCount ?? 7,
    repoPath: over.repoPath ?? "/repo",
    repoPaths: over.repoPaths ?? [over.repoPath ?? "/repo"],
    startDirectory: over.startDirectory ?? over.repoPath ?? "/repo",
    filePath: over.filePath ?? "/Users/me/.pi/sessions/s-1.json",
  };
}

function listing(rows: SessionDescriptor[]): Listing {
  return { rows, failures: [], excluded: 0 };
}

function keys(sequence: PickerKey[]): KeySource {
  let index = 0;
  return {
    async next() {
      const key = sequence[index];
      index += 1;
      return key ?? null;
    },
  };
}

function recordingUi(): { ui: PiUi; blocks: string[][] } {
  const blocks: string[][] = [];
  const ui: PiUi = {
    show(lines) {
      blocks.push([...lines]);
    },
    async confirm() {
      throw new Error("the picker must not ask for a confirmation");
    },
  };
  return { ui, blocks };
}

describe("T-PIX-2 — the picker shows every field FR-11 requires", () => {
  it("shows the agent, the home, the time, the title and the turn count of every row", async () => {
    const rows = [
      descriptor({
        agent: "pi",
        ref: { agent: "pi", home: "/Users/me/.pi", id: "pi-1" },
        title: "Refactor the parser",
        updatedAt: "2026-08-03T12:00:00Z",
        turnCount: 41,
      }),
      descriptor({
        agent: "codex",
        ref: { agent: "codex", home: "/Users/me/.codex", id: "cx-1" },
        title: "Chase the flaky test",
        updatedAt: "2026-08-02T08:30:00Z",
        turnCount: 12,
      }),
      descriptor({
        agent: "claude-code",
        ref: { agent: "claude-code", home: "/Users/me/.claude-team", id: "cc-1" },
        title: "Write the release notes",
        updatedAt: "2026-08-01T20:15:00Z",
        turnCount: 3,
      }),
    ];
    const { ui, blocks } = recordingUi();

    await createKeyPicker({ keys: keys(["enter"]), ui }).pick(listing(rows));

    const shown = blocks.flat().join("\n");
    for (const row of rows) {
      expect(shown).toContain(row.ref.agent);
      expect(shown).toContain(row.ref.home);
      expect(shown).toContain(row.updatedAt);
      expect(shown).toContain(row.title);
      expect(shown).toContain(String(row.turnCount));
    }
  });
});

describe("T-PIX-3 — arrow keys move and Enter selects", () => {
  it("selects the third row after down, down, Enter", async () => {
    const rows = [1, 2, 3, 4, 5].map((n) =>
      descriptor({ ref: { agent: "pi", home: "/Users/me/.pi", id: `s-${n}` }, title: `Row ${n}` }),
    );
    const { ui } = recordingUi();

    const result = await createKeyPicker({ keys: keys(["down", "down", "enter"]), ui }).pick(
      listing(rows),
    );

    expect(result.choice).toBe("selected");
    expect(result.selected).toBe(rows[2]);
  });

  it("stops at the first row and at the last row", async () => {
    const rows = [1, 2].map((n) =>
      descriptor({ ref: { agent: "pi", home: "/Users/me/.pi", id: `s-${n}` } }),
    );
    const { ui } = recordingUi();

    const top = await createKeyPicker({ keys: keys(["up", "up", "enter"]), ui }).pick(
      listing(rows),
    );
    const bottom = await createKeyPicker({
      keys: keys(["down", "down", "down", "enter"]),
      ui,
    }).pick(listing(rows));

    expect(top.selected).toBe(rows[0]);
    expect(bottom.selected).toBe(rows[1]);
  });
});

describe("T-PIX-4 — Escape cancels", () => {
  it("reports a cancelled choice and selects nothing", async () => {
    const rows = [descriptor({})];
    const { ui } = recordingUi();

    const result = await createKeyPicker({ keys: keys(["down", "escape"]), ui }).pick(
      listing(rows),
    );

    expect(result.choice).toBe("cancelled");
    expect(result.selected).toBeNull();
  });

  it("treats an exhausted key source as a cancel", async () => {
    const { ui } = recordingUi();

    const result = await createKeyPicker({ keys: keys([]), ui }).pick(listing([descriptor({})]));

    expect(result.choice).toBe("cancelled");
    expect(result.selected).toBeNull();
  });
});
