import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const outputRoot = resolve(repoRoot, "build/npm");
const rootPackage = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const version = rootPackage.version;
const repository = "https://github.com/alexei-led/resume-from";

/** Carries the licence of every dependency the Claude bundle inlines. */
const NOTICES_FILE = "THIRD-PARTY-NOTICES.md";

/** The names a package may give its licence file. */
const LICENCE_FILENAMES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md"];

const packages = [
  {
    target: "claude",
    name: "@alexeiled/resume-from-claude",
    description: "Claude Code plugin for resuming a session from another coding agent.",
    files: [".claude-plugin", "commands", "dist", NOTICES_FILE],
    install:
      "claude plugin marketplace add alexei-led/resume-from\nclaude plugin install resume-from@alexei-led-resume-from",
  },
  {
    target: "codex",
    name: "@alexeiled/resume-from-codex",
    description: "Codex plugin skill for resuming a session from another coding agent.",
    files: [".codex-plugin", "skills"],
    install:
      "codex plugin marketplace add alexei-led/resume-from\ncodex plugin add resume-from@alexei-led-resume-from",
  },
];

function packageManifest(spec) {
  const manifest = {
    name: spec.name,
    version,
    description: spec.description,
    type: rootPackage.type,
    engines: rootPackage.engines,
    license: "MIT",
    repository: { type: "git", url: `git+${repository}.git` },
    homepage: `${repository}#readme`,
    bugs: { url: `${repository}/issues` },
    keywords: [`${spec.target}-plugin`, "session", "handoff", "coding-agent"],
    files: spec.files,
    publishConfig: { access: "public" },
  };

  if (spec.target === "claude") {
    manifest.dependencies = rootPackage.dependencies;
  }

  return manifest;
}

function packageReadme(spec) {
  return `# ${spec.name}\n\n${spec.description}\n\nGenerated from [resume-from](${repository}).\n\n## Install\n\n\`\`\`sh\n${spec.install}\n\`\`\`\n\n## License\n\nMIT\n`;
}

/**
 * Claude Code installs a plugin by unpacking the tarball alone: the cache directory holds no
 * node_modules, so a bare `gpt-tokenizer` import in the published bin.js fails to resolve at
 * runtime. The Claude package therefore ships one self-contained bundle instead of the tsc
 * output. Every other consumer — the root npm package, the Codex skill, the Pi shim — is
 * installed by a package manager that resolves dependencies, and keeps the unbundled build.
 */
function bundleClaudeBinary(destination) {
  const result = buildSync({
    entryPoints: [resolve(repoRoot, "src/bin.ts")],
    outfile: resolve(destination, "dist/bin.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    metafile: true,
  });
  writeFileSync(resolve(destination, NOTICES_FILE), thirdPartyNotices(result.metafile));
}

/**
 * The packages whose source esbuild copied into the bundle, read back from the build itself so a
 * change of dependency cannot leave the notices behind.
 */
function bundledPackages(metafile) {
  const marker = "node_modules/";
  const roots = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    // The last marker wins: pnpm stores a package at .pnpm/<name>@<version>/node_modules/<name>,
    // so the first one would name the store directory rather than the package.
    const at = input.lastIndexOf(marker);
    if (at < 0) continue;
    const segments = input.slice(at + marker.length).split("/");
    const name = segments[0].startsWith("@") ? `${segments[0]}/${segments[1]}` : segments[0];
    roots.set(name, input.slice(0, at + marker.length) + name);
  }
  return [...roots.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function licenceText(name, root) {
  for (const filename of LICENCE_FILENAMES) {
    const path = resolve(repoRoot, root, filename);
    if (existsSync(path)) return readFileSync(path, "utf8").trim();
  }
  // Shipping the code without its licence is the thing this file exists to prevent, so a package
  // that hides its licence stops the release rather than being dropped from the notices.
  throw new Error(`${name} is bundled but has no licence file to redistribute with it.`);
}

/**
 * Bundling copies dependency source into our own artifact, so their licences have to travel with
 * it. MIT and the like require the notice in every copy, and the copy is no longer node_modules.
 */
function thirdPartyNotices(metafile) {
  const sections = bundledPackages(metafile).map(
    ([name, root]) => `## ${name}\n\n\`\`\`\n${licenceText(name, root)}\n\`\`\`\n`,
  );
  return (
    "# Third-party notices\n\n" +
    "`dist/bin.js` is a bundle. It contains source from the packages below, " +
    "redistributed under their own licences.\n\n" +
    `${sections.join("\n")}`
  );
}

function stagePackage(spec) {
  const destination = resolve(outputRoot, spec.target);
  const shim = resolve(repoRoot, "shims", spec.target === "claude" ? "claude-code" : "codex");
  cpSync(shim, destination, { recursive: true });
  cpSync(resolve(repoRoot, "LICENSE"), resolve(destination, "LICENSE"));
  if (spec.target === "claude") {
    bundleClaudeBinary(destination);
  } else {
    const promptPath = resolve(destination, "skills/resume-from/SKILL.md");
    const prompt = readFileSync(promptPath, "utf8").replaceAll("__RESUME_FROM_VERSION__", version);
    writeFileSync(promptPath, prompt);
  }
  writeFileSync(
    resolve(destination, "package.json"),
    `${JSON.stringify(packageManifest(spec), null, 2)}\n`,
  );
  writeFileSync(resolve(destination, "README.md"), packageReadme(spec));
}

function main() {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) {
    throw new Error(`package version must be valid semver: ${version}`);
  }
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  for (const spec of packages) stagePackage(spec);
}

main();
