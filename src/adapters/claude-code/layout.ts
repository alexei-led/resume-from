/**
 * Where Claude Code keeps its sessions inside a home.
 *
 * A home holds `projects/<encoded repository path>/<session id>.jsonl`. The encoding and the
 * default home are facts about the installed version, not assumptions: the live boundary test
 * T-CC-16 lands a real session and compares it with what this file computes.
 */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { HomePath, SessionId } from "./contract.js";

/** Session files live one directory per repository, under this directory of the home. */
export const PROJECTS_DIR = "projects";
export const SESSION_FILE_SUFFIX = ".jsonl";
/** Claude Code reads this before falling back to ~/.claude. It is how `~/.claude-team` is named. */
export const CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";
export const DEFAULT_HOME_BASENAME = ".claude";

/** The home used when the user names none (FR-3). Absolute, resolved. */
export function resolveDefaultHome(
  env: Record<string, string | undefined> = process.env,
  userHome: string = homedir(),
): HomePath {
  const configured = env[CONFIG_DIR_ENV];
  if (configured !== undefined && configured !== "" && path.isAbsolute(configured)) {
    return path.resolve(configured);
  }
  return path.join(path.resolve(userHome), DEFAULT_HOME_BASENAME);
}

/**
 * The project directory name of a repository: the absolute path with every character that is
 * not a letter or a digit replaced by a dash.
 */
export function encodeProjectPath(repoPath: string): string {
  return path.resolve(repoPath).replace(/[^a-zA-Z0-9]/g, "-");
}

export function projectsDir(home: HomePath): string {
  return path.join(home, PROJECTS_DIR);
}

export function projectDir(home: HomePath, repoPath: string): string {
  return path.join(projectsDir(home), encodeProjectPath(repoPath));
}

export function sessionFilePath(home: HomePath, repoPath: string, id: SessionId): string {
  return path.join(projectDir(home, repoPath), `${id}${SESSION_FILE_SUFFIX}`);
}

export function sessionIdOf(filePath: string): SessionId {
  return path.basename(filePath, SESSION_FILE_SUFFIX);
}

/**
 * Where a global lookup searches: the configured home (`CLAUDE_CONFIG_DIR`) and every
 * `~/.claude*` profile. These are glob patterns; `src/import/discovery/` expands them.
 */
export function searchRoots(
  env: Record<string, string | undefined> = process.env,
  userHome: string = homedir(),
): string[] {
  const roots: string[] = [];
  const configured = env[CONFIG_DIR_ENV];
  if (configured !== undefined && configured !== "" && path.isAbsolute(configured)) {
    roots.push(path.join(path.resolve(configured), PROJECTS_DIR));
  }
  roots.push(path.join(path.resolve(userHome), ".claude*", PROJECTS_DIR));
  return roots;
}

/** The profile home a session file belongs to: `<home>/projects/<project>/<id>.jsonl`. */
export function homeOfSessionFile(filePath: string): HomePath {
  return path.dirname(path.dirname(path.dirname(filePath)));
}

/** Every session file below one `projects` directory. */
export async function listSessionFilesIn(projectsRoot: string): Promise<string[]> {
  let projects: string[];
  try {
    projects = (await readdir(projectsRoot, { withFileTypes: true }))
      .filter((item) => item.isDirectory())
      .map((item) => item.name);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const project of projects) {
    const dir = path.join(projectsRoot, project);
    try {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        if (item.isFile() && item.name.endsWith(SESSION_FILE_SUFFIX)) {
          files.push(path.join(dir, item.name));
        }
      }
    } catch {
      // A project directory that cannot be read holds no session this tool can offer.
    }
  }
  return files;
}

/** Every session file of a home, across all of its project directories. */
export function listSessionFiles(home: HomePath): Promise<string[]> {
  return listSessionFilesIn(projectsDir(home));
}

/** The file of one session id, or null when the home does not hold it. */
export async function findSessionFile(home: HomePath, id: SessionId): Promise<string | null> {
  const wanted = `${id}${SESSION_FILE_SUFFIX}`;
  for (const file of await listSessionFiles(home)) {
    if (path.basename(file) === wanted) return file;
  }
  return null;
}
