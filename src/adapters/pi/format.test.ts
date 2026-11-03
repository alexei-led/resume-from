import { describe, expect, it } from "vitest";
import { encodeCwd, homeOfSessionFile } from "./format.js";

const HOME = "/Users/amy/.pi/agent";

describe("homeOfSessionFile", () => {
  it("reads a session under an encoded project directory", () => {
    const directory = `${HOME}/sessions/${encodeCwd("/Users/amy/Workspace/app")}`;
    expect(homeOfSessionFile(`${directory}/2026-10-26T10-00-00_abc.jsonl`)).toBe(HOME);
  });

  it('is not fooled by a project path that contains "sessions"', () => {
    // Pi encodes the cwd into `--…--`: the encoded directory itself matches a naive
    // "sessions" ancestor search, but the home is still the agent directory above it.
    const directory = `${HOME}/sessions/${encodeCwd("/Users/amy/Workspace/sessions-service")}`;
    expect(homeOfSessionFile(`${directory}/2026-10-26T10-00-00_abc.jsonl`)).toBe(HOME);
  });

  it("reads a session under a named session directory", () => {
    const directory = `${HOME}/sessions-work/${encodeCwd("/Users/amy/Workspace/app")}`;
    expect(homeOfSessionFile(`${directory}/2026-10-26T10-00-00_abc.jsonl`)).toBe(HOME);
  });
});
