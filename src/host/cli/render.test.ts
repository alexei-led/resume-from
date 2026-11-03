import { expect, it } from "vitest";
import type { Place } from "./contract.js";
import { renderListing, renderNative, renderRecovery } from "./render.js";

it("labels skipped sessions and homes as entries, not unreadable homes", () => {
  const listing = {
    rows: [],
    failures: [
      {
        agent: "pi" as const,
        home: "/readable",
        message: "session ambiguous has conflicting repository identity evidence",
      },
    ],
  };
  const lines = renderListing(listing, "/destination");
  expect(lines).toContain("1 entry skipped:");
  expect(lines.join("\n")).toContain(listing.failures[0]?.message);
  expect(
    renderListing(
      { ...listing, failures: [...listing.failures, ...listing.failures] },
      "/destination",
    ),
  ).toContain("2 entries skipped:");
});

const ESCAPE = "\u001b[31m";

function place(overrides: Partial<Place> = {}): Place {
  return {
    state: "present",
    directory: "/work/app",
    branch: "main",
    warnings: [],
    recovery: null,
    reason: null,
    ...overrides,
  };
}

it("sanitises the Resume command a session's own data supplied", () => {
  const lines = renderNative(["↻ codex abc"], place(), `cd /work/${ESCAPE}red && codex resume abc`);
  const resume = lines.find((line) => line.startsWith("Resume: "));
  expect(resume).toBe("Resume: cd /work/ red && codex resume abc");
  expect(lines.join("\n")).not.toContain("\u001b");
});

it("sanitises Recover and Confirm commands, and the recovery warnings", () => {
  const lines = renderRecovery(
    ["↻ codex abc"],
    place({
      state: "recoverable",
      directory: "/gone/app",
      warnings: [`branch ${ESCAPE}red no longer exists`],
      recovery: {
        repoRoot: "/work/app",
        directory: "/gone/app",
        commands: [
          {
            cwd: "/work/app",
            argv: ["worktree", "add", `/gone/${ESCAPE}red`, "main"],
            display: `git -C /work/app worktree add /gone/${ESCAPE}red main`,
          },
        ],
        warnings: [],
      },
    }),
    `resume-from ${ESCAPE}abc --confirm v1-sha256-${"0".repeat(64)}`,
  );

  expect(lines).toContain("⚠ branch  red no longer exists");
  expect(lines).toContain("Recover: git -C /work/app worktree add /gone/ red main");
  expect(lines).toContain(`Confirm: resume-from  abc --confirm v1-sha256-${"0".repeat(64)}`);
  expect(lines.join("\n")).not.toContain("\u001b");
});
