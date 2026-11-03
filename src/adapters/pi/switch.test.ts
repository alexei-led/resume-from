import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiAdapter } from "./adapter.js";
import type { PiSwitchContext } from "./contract.js";
import { checksumTree, makeThrowawayHome, piUserDraft, writeFixtureSession } from "./fixtures.js";

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

function committedSession(): { home: string; sessionId: string; filePath: string } {
  const home = throwawayHome();
  const written = writeFixtureSession(home, CWD, [piUserDraft("imported turn")], {
    id: "01998877-6655-4433-2211-000000000001",
  });
  return { home, sessionId: written.sessionId, filePath: written.filePath };
}

function workingContext(cancelled = false): PiSwitchContext & {
  calls: { path: string; withSession: () => void }[];
} {
  const calls: { path: string; withSession: () => void }[] = [];
  return {
    calls,
    switchSession: async (path, options) => {
      calls.push({ path, withSession: options.withSession });
      options.withSession();
      return { cancelled };
    },
  };
}

describe("T-PI-9 — the switch narrows the runtime handle", () => {
  it("switches when the handle is a PiSwitchContext", async () => {
    const { home, sessionId, filePath } = committedSession();
    const context = workingContext();

    const outcome = await createPiAdapter().switchTo(home, sessionId, context);

    expect(outcome).toEqual({ switched: true, cancelled: false });
    expect(context.calls).toHaveLength(1);
    expect(context.calls[0]?.path).toBe(filePath);
  });

  const rejected: [string, unknown][] = [
    ["null", null],
    ["an object without switchSession", { resume: () => undefined }],
    ["a handle meant for another agent", { configDir: "~/.claude", resumeCommand: "claude -r" }],
    ["a switchSession that is not a function", { switchSession: "yes please" }],
  ];

  it.each(rejected)("refuses %s, naming what it expected", async (_name, handle) => {
    const { home, sessionId } = committedSession();

    await expect(createPiAdapter().switchTo(home, sessionId, handle)).rejects.toThrow(
      /PiSwitchContext|switchSession/,
    );
  });

  it("inspects nothing beyond the shape it declares", async () => {
    const { home, sessionId } = committedSession();
    const probe = vi.fn(() => undefined);
    const handle = new Proxy(workingContext(), {
      get(target, property, receiver) {
        if (property !== "switchSession" && property !== "calls") probe();
        return Reflect.get(target, property, receiver);
      },
    });

    await createPiAdapter().switchTo(home, sessionId, handle);

    expect(probe).not.toHaveBeenCalled();
  });

  it("switches to the given source file even when the home search would not find it", async () => {
    const { home, sessionId } = committedSession();
    const context = workingContext();
    const elsewhere = join(throwawayHome(), "sessions", "--other--", `${sessionId}.jsonl`);

    const outcome = await createPiAdapter().switchTo(home, sessionId, context, elsewhere);

    expect(outcome).toEqual({ switched: true, cancelled: false });
    expect(context.calls[0]?.path).toBe(elsewhere);
  });

  it("refuses a session id that is not in the home, naming the id", async () => {
    const { home } = committedSession();

    await expect(
      createPiAdapter().switchTo(home, "no-such-session", workingContext()),
    ).rejects.toThrow("no-such-session");
  });
});

describe("T-PI-10 — a cancelled switch keeps the session", () => {
  it("reports the cancellation without rolling anything back", async () => {
    const { home, sessionId } = committedSession();
    const before = checksumTree(home);

    const outcome = await createPiAdapter().switchTo(home, sessionId, workingContext(true));

    expect(outcome).toEqual({ switched: false, cancelled: true });
    expect([...checksumTree(home).entries()]).toEqual([...before.entries()]);
  });

  it("still finds the session afterwards, so the user can open it later", async () => {
    const { home, sessionId } = committedSession();

    await createPiAdapter().switchTo(home, sessionId, workingContext(true));

    const facts = await createPiAdapter().readBack(home, sessionId);
    expect(facts.openable).toBe(true);
  });
});
