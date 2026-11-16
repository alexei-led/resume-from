import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REFERENCE_SESSION } from "../../../test/fixtures/reference-session.js";
import { createPiAdapter } from "./adapter.js";
import type { PendingFile, SerializedSession, TargetProfile } from "./contract.js";
import {
  makeThrowawayHome,
  markerFixture,
  piAssistantTextDraft,
  piToolCallDraft,
  piToolResultDraft,
  piUserDraft,
  writeFixtureSession,
} from "./fixtures.js";

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

/** What `src/import/landing/` does. The adapter never writes a file itself (FR-49, FR-53). */
function commit(files: PendingFile[]): void {
  for (const file of files) {
    mkdirSync(dirname(file.absolutePath), { recursive: true });
    if (existsSync(file.absolutePath))
      throw new Error(`refusing to overwrite ${file.absolutePath}`);
    writeFileSync(file.absolutePath, file.bytes);
  }
}

function target(home: string): TargetProfile {
  return { agent: "pi", home, windowTokens: 200_000 };
}

function serializeInto(home: string): SerializedSession {
  return createPiAdapter().serialize(REFERENCE_SESSION, target(home), markerFixture(), {
    cwd: CWD,
  });
}

describe("T-PI-8 — read-back reports what Pi holds", () => {
  it("reports the same item count the serializer promised, and an openable session", async () => {
    const home = throwawayHome();
    const serialized = serializeInto(home);
    commit(serialized.files);

    const facts = await createPiAdapter().readBack(home, serialized.sessionId);

    expect(facts.sessionId).toBe(serialized.sessionId);
    expect(facts.itemCount).toBe(serialized.itemCount);
    expect(facts.openable).toBe(true);
  });

  it("reads a committed file outside the home-derived session directory", async () => {
    const home = throwawayHome();
    const serialized = createPiAdapter().serialize(
      REFERENCE_SESSION,
      { ...target(home), sessionDir: join(home, "sessions-work", "custom-project") },
      markerFixture(),
      { cwd: CWD },
    );
    const homeSerialized = serializeInto(home);
    commit([...serialized.files, ...homeSerialized.files]);
    const filePath = serialized.files[0]?.absolutePath ?? "";

    expect(dirname(filePath)).toBe(join(home, "sessions-work", "custom-project"));
    const adapter = createPiAdapter();
    expect((await adapter.readBack(home, serialized.sessionId, filePath)).openable).toBe(true);
    expect((await adapter.listSessions(home, dirname(filePath))).map((row) => row.ref.id)).toEqual(
      expect.arrayContaining([serialized.sessionId, homeSerialized.sessionId]),
    );
    expect(
      (await adapter.findSessions(dirname(filePath), serialized.sessionId, home))[0]?.ref.home,
    ).toBe(home);

    const alias = join(home, "aliased-session-dir");
    symlinkSync(dirname(homeSerialized.files[0]?.absolutePath ?? ""), alias, "dir");
    expect((await adapter.listSessions(home, alias)).map((row) => row.ref.id)).toEqual([
      homeSerialized.sessionId,
    ]);

    const foreignId = "foreign-session";
    writeFileSync(
      join(dirname(filePath), `2026-08-02T10-00-00-000Z_${foreignId}.jsonl`),
      `{"message":"not a Pi session"}\n`,
    );
    expect(await adapter.findSessions(dirname(filePath), foreignId, home)).toEqual([]);
  });

  it("reports a session that was never committed as absent, so FR-52 can catch it", async () => {
    const home = throwawayHome();
    const serialized = serializeInto(home);

    const facts = await createPiAdapter().readBack(home, serialized.sessionId);

    expect(facts.itemCount).toBe(0);
    expect(facts.openable).toBe(false);
    expect(facts.itemCount).not.toBe(serialized.itemCount);
  });

  it("reports a truncated committed session as not openable", async () => {
    const home = throwawayHome();
    const serialized = serializeInto(home);
    commit(serialized.files);
    const file = serialized.files[0];
    if (!file) throw new Error("no file");
    const text = readFileSync(file.absolutePath, "utf8");
    writeFileSync(file.absolutePath, text.slice(0, text.length - 30));

    const facts = await createPiAdapter().readBack(home, serialized.sessionId);
    expect(facts.openable).toBe(false);
  });
});

describe("T-PI-19 — Pi to Pi across homes", () => {
  const BODY = "secret line one\nsecret line two";

  it("leaves both sessions in place and carries no tool result body", async () => {
    const sourceHome = throwawayHome();
    const targetHome = throwawayHome();
    const adapter = createPiAdapter();
    const source = writeFixtureSession(sourceHome, CWD, [
      piUserDraft("make the auth token refresh work"),
      piAssistantTextDraft("Looking at the token store."),
      piToolCallDraft("call-1", "read", { path: "src/auth.ts" }),
      piToolResultDraft("call-1", "read", BODY),
    ]);

    const [descriptor] = await adapter.listSessions(sourceHome);
    if (!descriptor) throw new Error("no descriptor listed");
    const canonical = await adapter.loadSession(descriptor);
    const serialized = adapter.serialize(canonical, target(targetHome), markerFixture(), {
      cwd: CWD,
    });
    expect(adapter.validate(serialized)).toEqual([]);
    commit(serialized.files);

    // Both sessions exist afterwards (FR-4).
    expect(readFileSync(source.filePath, "utf8")).toBe(source.text);
    const facts = await adapter.readBack(targetHome, serialized.sessionId);
    expect(facts.openable).toBe(true);
    expect(facts.itemCount).toBe(serialized.itemCount);

    // No result body crossed, even between two homes of the same agent (FR-24).
    const written = serialized.files[0]?.bytes.toString("utf8") ?? "";
    for (const line of BODY.split("\n")) {
      expect(written).not.toContain(line);
    }
  });

  it("gives the target home its own session id", async () => {
    const sourceHome = throwawayHome();
    const targetHome = throwawayHome();
    const adapter = createPiAdapter();
    const source = writeFixtureSession(sourceHome, CWD, [piUserDraft("hello")]);

    const [descriptor] = await adapter.listSessions(sourceHome);
    if (!descriptor) throw new Error("no descriptor listed");
    const canonical = await adapter.loadSession(descriptor);
    const serialized = adapter.serialize(canonical, target(targetHome), markerFixture(), {
      cwd: CWD,
    });

    expect(serialized.sessionId).not.toBe(source.sessionId);
  });
});
