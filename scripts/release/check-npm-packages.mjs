import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const rootManifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const version = rootManifest.version;

const piTui = "@earendil-works/pi-tui";
const piTuiRange = "^1.0.2";
if (rootManifest.dependencies?.[piTui] !== undefined || rootManifest.peerDependencies?.[piTui] !== piTuiRange) {
  throw new Error(`${piTui} must be a "${piTuiRange}" peer dependency, not a runtime dependency.`);
}

const packages = [
  {
    name: "resume-from",
    directory: repoRoot,
    expected: [
      "package.json",
      "README.md",
      "LICENSE",
      "dist/bin.js",
      "dist/index.d.ts",
      "dist/host/pi-extension/index.js",
      "shims/pi/extensions/resume-from.js",
    ],
    maxUnpackedBytes: 500_000,
    forbidden: (path) => path.startsWith("assets/") || path.endsWith(".map"),
  },
  {
    name: "@alexeiled/resume-from-claude",
    directory: resolve(repoRoot, "build/npm/claude"),
    expected: [
      "package.json",
      "README.md",
      "LICENSE",
      ".claude-plugin/plugin.json",
      "commands/resume-from.md",
    ],
    maxUnpackedBytes: 20_000,
    forbidden: (path) => path.startsWith("dist/"),
  },
  {
    name: "@alexeiled/resume-from-codex",
    directory: resolve(repoRoot, "build/npm/codex"),
    expected: [
      "package.json",
      "README.md",
      "LICENSE",
      ".codex-plugin/plugin.json",
      "skills/resume-from/SKILL.md",
    ],
    maxUnpackedBytes: 20_000,
    forbidden: (path) => path.startsWith("dist/"),
  },
];

function packedPackage(directory, destination) {
  const output = execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", destination],
    {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const result = JSON.parse(output);
  const packed = Array.isArray(result)
    ? result.length === 1
      ? result[0]
      : undefined
    : Object.values(result).find((value) => value && typeof value === "object" && "files" in value);
  if (packed === undefined || !Array.isArray(packed.files) || typeof packed.filename !== "string") {
    throw new Error(`unexpected npm pack output in ${directory}`);
  }
  return {
    files: new Set(packed.files.map((file) => file.path)),
    packedBytes: packed.size,
    unpackedBytes: packed.unpackedSize,
    tarball: resolve(destination, packed.filename),
  };
}

function requireFile(files, packageName, path) {
  if (!files.has(path)) throw new Error(`${packageName} tarball is missing ${path}`);
}

function requireMatchingField(manifest, field, packageName) {
  if (JSON.stringify(manifest[field]) !== JSON.stringify(rootManifest[field])) {
    throw new Error(`${packageName} ${field} does not match the root package.`);
  }
}

function installPackage(tarball, directory, name) {
  const consumer = resolve(directory, `consumer-${name}`);
  mkdirSync(consumer);
  writeFileSync(
    resolve(consumer, "package.json"),
    `${JSON.stringify({ name: "resume-from-package-smoke", private: true, type: "module" })}\n`,
  );
  execFileSync(
    "npm",
    ["install", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", tarball],
    { cwd: consumer, stdio: "pipe" },
  );
  return consumer;
}

function smokeTestRoot(tarball, directory) {
  const consumer = installPackage(tarball, directory, "root");
  if (existsSync(resolve(consumer, "node_modules", piTui))) {
    throw new Error("Pi-managed installs must not install a separate pi-tui runtime.");
  }
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'const root = await import("resume-from"); const pi = await import("resume-from/pi-extension"); if (typeof root.createHost !== "function" || typeof pi.formatRow !== "function") throw new Error("package exports are unavailable");',
    ],
    { cwd: consumer, stdio: "pipe" },
  );
  execFileSync(resolve(consumer, "node_modules/.bin/resume-from"), ["--help"], {
    cwd: consumer,
    stdio: "pipe",
  });
}

function assertNoRawArgumentInterpolation(path) {
  const contents = readFileSync(path, "utf8");
  const unsafeLine = contents
    .split(/\r?\n/u)
    .find(
      (line) =>
        line.includes("$ARGUMENTS") &&
        (line.includes("!`") || /\b(?:node|npx|resume-from)\b/u.test(line)),
    );
  if (unsafeLine !== undefined) {
    throw new Error(`${path} interpolates raw $ARGUMENTS into an executable command.`);
  }
}

const temporaryRoot = mkdtempSync(resolve(tmpdir(), "resume-from-packages-"));
try {
  const tarballs = new Map();
  for (const spec of packages) {
    const manifest = JSON.parse(readFileSync(resolve(spec.directory, "package.json"), "utf8"));
    if (manifest.name !== spec.name) throw new Error(`expected ${spec.name}, got ${manifest.name}`);
    if (manifest.version !== version) throw new Error(`${spec.name} version does not match ${version}`);

    if (spec.name === "@alexeiled/resume-from-claude") {
      requireMatchingField(manifest, "type", spec.name);
      requireMatchingField(manifest, "engines", spec.name);
    }

    const packed = packedPackage(spec.directory, temporaryRoot);
    tarballs.set(spec.name, packed.tarball);
    for (const path of spec.expected) requireFile(packed.files, spec.name, path);
    const forbidden = [...packed.files].filter(spec.forbidden);
    if (forbidden.length > 0) {
      throw new Error(`${spec.name} tarball contains forbidden files: ${forbidden.join(", ")}`);
    }
    if (packed.unpackedBytes > spec.maxUnpackedBytes) {
      throw new Error(
        `${spec.name} tarball is ${packed.unpackedBytes} unpacked bytes; limit is ${spec.maxUnpackedBytes}`,
      );
    }
    console.log(
      `${spec.name}@${version}: ${packed.files.size} files, ${packed.packedBytes} packed bytes, ` +
        `${packed.unpackedBytes} unpacked bytes`,
    );
  }

  const rootTarball = tarballs.get("resume-from");
  if (rootTarball === undefined) throw new Error("root package tarball was not created");
  smokeTestRoot(rootTarball, temporaryRoot);
  console.log("isolated install and runtime smoke checks passed");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

const claudeMarketplace = JSON.parse(
  readFileSync(resolve(repoRoot, ".claude-plugin/marketplace.json"), "utf8"),
);
const codexMarketplace = JSON.parse(
  readFileSync(resolve(repoRoot, ".agents/plugins/marketplace.json"), "utf8"),
);
const claudeEntry = claudeMarketplace.plugins[0];
if (
  claudeMarketplace.version !== version ||
  claudeEntry?.version !== version ||
  claudeEntry?.source?.source !== "git-subdir" ||
  claudeEntry.source.path !== "shims/claude-code" ||
  claudeEntry.source.ref !== `v${version}`
) {
  throw new Error("The Claude marketplace must pin the git-subdir source to this release tag.");
}
if (codexMarketplace.version !== version || codexMarketplace.plugins[0]?.source?.version !== version) {
  throw new Error("Codex marketplace version does not match the packages.");
}

for (const [target, manifestPath] of [
  ["claude", "build/npm/claude/.claude-plugin/plugin.json"],
  ["codex", "build/npm/codex/.codex-plugin/plugin.json"],
]) {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, manifestPath), "utf8"));
  if (manifest.version !== version) throw new Error(`${target} plugin manifest has a stale version.`);
}

const claudeCommand = readFileSync(
  resolve(repoRoot, "build/npm/claude/commands/resume-from.md"),
  "utf8",
);
if (!claudeCommand.includes(`npx --yes resume-from@${version} --target-agent claude-code`)) {
  throw new Error("Claude command does not pin the matching core CLI version.");
}
assertNoRawArgumentInterpolation(resolve(repoRoot, "build/npm/claude/commands/resume-from.md"));

const codexSkill = readFileSync(
  resolve(repoRoot, "build/npm/codex/skills/resume-from/SKILL.md"),
  "utf8",
);
if (codexSkill.includes("__RESUME_FROM_VERSION__") || !codexSkill.includes(`resume-from@${version}`)) {
  throw new Error("Codex skill does not pin the matching core CLI version.");
}
assertNoRawArgumentInterpolation(resolve(repoRoot, "build/npm/codex/skills/resume-from/SKILL.md"));

// Check the actual staged instructions, including Codex's sole intentional transformation.
for (const [contents, source] of [
  [claudeCommand, "shims/claude-code/commands/resume-from.md"],
  [codexSkill, "shims/codex/skills/resume-from/SKILL.md"],
]) {
  const expected = readFileSync(resolve(repoRoot, source), "utf8")
    .replaceAll("__RESUME_FROM_VERSION__", version);
  if (contents !== expected) throw new Error(`${source} was not faithfully packaged.`);
  for (const required of [
    "Split them into a selector",
    "git worktree add",
    "--to <dir>",
    "shell-quoted argv item after `--`",
    "`Confirm:`",
    "`Resume in place:`",
    "`Resume:`",
    "`Switched.`",
    "Do not start a new terminal",
    '--prompt "<instructions>"',
    "verbatim",
    "Never delete anything, never force git, never edit a session file",
    "Never pass `--confirm` with a token you did not just read",
  ]) {
    if (!contents.includes(required)) throw new Error(`${source} is missing instruction: ${required}`);
  }
  if (contents.includes("agtermctl")) throw new Error(`${source} still launches an agterm session.`);
}

// Both plugins run the version-pinned core package, so the worktree preview ships with it.
const previewRuntime = readFileSync(resolve(repoRoot, "dist/import/preview/warnings.js"), "utf8");
if (!previewRuntime.includes("The source session records a different directory")) {
  throw new Error("dist/import/preview/warnings.js is missing the worktree preview runtime.");
}
console.log("packaged instruction sources and worktree preview runtime checks passed");
