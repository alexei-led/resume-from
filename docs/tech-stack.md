# Tech stack — resume-from

**Status:** normative. This file is the single home of every technology decision. The design tree
(`src/**/module.md`) says _what_ to build; this file says _what with_. Neither restates the other.

**Rule:** every implementer reads this file plus the one `module.md` of the module they are building.
Nothing else. Any new stack decision — made while planning or while implementing — is written back
here immediately.

---

## Decided

| Area                | Choice     | Why                                                                                                                                                     |
| ------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Language**        | TypeScript | Pi extensions are JavaScript/TypeScript, and the Claude Code and Codex shims call a Node binary. One language covers all three hosts.                   |
| **Runtime**         | Node.js    | The tool runs inside three Node-based CLIs.                                                                                                             |
| **Code root**       | `src/`     | Root module's `module.md` sits at `src/module.md`. The design tree is the source tree.                                                                  |
| **Package manager** | pnpm       | Strict about phantom dependencies, which the module-boundary tests rely on.                                                                             |
| **Test runner**     | Vitest     | TypeScript-native with no transpile step. `test.each` covers the many table-driven specs; temporary-directory and checksum tests need no extra tooling. |
| **Lint + format**   | Biome      | One tool for both, no plugin stack.                                                                                                                     |
| **Build**           | `tsc`      | Emits to `dist/`; `.gitignore` already excludes `dist/` and `*.tsbuildinfo`.                                                                            |

## Development toolchain

Use Node 24 LTS and the pnpm version pinned in `package.json`.
TypeScript 7 builds and type-checks the project. The `typescript-compiler-api` alias
stays on TypeScript 6.0.3 because the boundary tests use its JavaScript compiler API,
which TypeScript 7 does not ship. Node type declarations stay on the Node 24 line.
Vitest 5 runs the test suite; Biome and ESLint check source and configuration.

The tokenizer uses the ESM `gpt-tokenizer/encoding/o200k_base` entry point. The
root package declares it as a dependency; the Claude Code and Codex plugins run that package
through `npx` and bundle nothing.

## Delivery shape

Decided in the design (`src/module.md`, Decision 4) and recorded here because it constrains the
build:

- **One library**, wired by `src/host/`.
- **One command binary** — `src/host/cli/`. The Codex skill file and the Claude Code slash-command
  file call it through `npx`.
- **One in-process extension** — `src/host/pi-extension/`. Pi loads it, so it must be importable as a
  module, not only executable as a binary.

The build therefore produces both a `bin` entry and a library entry point.

## Conventions

- **ES modules.** Pi loads the extension in-process; a CLI binary and an importable module in one
  package are simplest as ESM.
- **Strict TypeScript.** `strict: true`. The design leans on the type system to enforce rules —
  `ToolCallRecord` having no field for a result body is the load-bearing example (FR-24, FR-60).
- **No runtime dependency may be added without recording it here**, with the module that needs it and
  why. The design classifies `src/platform/` as generic precisely so its dependencies stay swappable.
- **Tests live beside the module they test**, inside that module's folder. A module's folder holds its
  code and its tests; only `src/platform/store/` may create files at runtime.
- **Test fixtures shared across modules** live in `test/fixtures/`, outside `src/`, so they add no
  module to the design tree. The conformance suite's fake fourth agent lives at
  `test/fixtures/fixture-agent/` (see `src/adapters/module.md`, Constraints).
- **Contract type declarations are transcribed, not invented.** Each module's `Public Contract`
  section is emitted verbatim into a types-only file in that module's own folder (`contract.ts`).
  The scaffold task does this for all 19 modules at once, so every wave-0 task compiles against the
  contracts it restates and the tasks in a wave stay independent — which is what lets them run in
  parallel. A `contract.ts` holds declarations only: no behaviour, no defaults, no logic.
  **The `module.md` block stays normative.** If the two disagree, the document wins and the file is
  corrected — never the reverse.

## Isolation conventions

These two answers make parallel, folder-isolated implementation safe. Follow them exactly; do not
invent an alternative.

**How one module imports another.** Relative ESM specifiers with an explicit `.js` extension, and
**only ever to another module's `contract.js`**:

```ts
// in src/import/transfer/rules.ts
import type {
  CanonicalSession,
  TargetProfile,
} from "../../session/contract.js";
import type { TokenEstimator } from "../../platform/tokens/contract.js";
```

No path aliases, no bundler, no `paths` mapping — `tsc` emits ESM that Node resolves directly. The
rule has a mechanical form: **a cross-module import whose specifier does not end in
`/contract.js` is a boundary violation.** That is the check the boundary tests assert (T-PLA-1,
T-PLA-2, T-HOS-17, T-ROO-7). Importing a sibling's implementation file is never correct; importing
its contract is exactly what the design's contract coupling means.

A module's own files import each other with plain relative paths and no restriction — inside one
folder there is no boundary.

**Factories, and who may import one.** A contract declares types, not constructors, so a module that
must _build_ a collaborator needs more than `contract.js`. Exactly two cases may import another
module's `index.js`:

1. **A parent importing its own submodules.** That is the parent's Internal Design — `src/import/`
   builds its four stages, `src/host/` builds its two entry points, `src/` builds the host.
2. **`src/host/`, the composition root**, importing the modules the design says it constructs: every
   `src/adapters/*` and every `src/platform/*`. `src/host/module.md` states this is the only place
   that knows which implementations exist, and it is why the agent list lives there.

Everything else takes its collaborators **by injection** and imports types only. A leaf never
constructs another module: `src/import/landing/` receives a `FileCommitter`, it does not build one.

**Every module with behaviour ships an `index.ts`**, and it is the module's only entry point: it
re-exports the module's types from `contract.js` and its factory functions from wherever they are
implemented. A consumer allowed to construct a collaborator imports `index.js` and nothing deeper —
so `estimator.ts`, `rules.ts`, `loader.ts` and their siblings stay private to their folder.

A module with **no** behaviour has no `index.ts`, because there is nothing to construct.
`src/session/` is the only such module: it is types and invariants, and its consumers import
`contract.js` directly.

So the complete rule for a cross-module import specifier:

| Ends in        | Who may write it                                                                             |
| -------------- | -------------------------------------------------------------------------------------------- |
| `/contract.js` | any module                                                                                   |
| `/index.js`    | a parent importing its own submodule; `src/host/` importing an adapter or a platform service |
| anything else  | nobody — it reaches into another module's internals                                          |

This is what the boundary tests assert. A test that forbids every non-`contract.js` import would make
the composition root unimplementable, which is not what the design says.

**How one module's tests are run in isolation.** Scoped by path, never repo-wide:

```
pnpm vitest run src/<module-path>
```

For example `pnpm vitest run src/import/transfer`. Parallel tasks each run only their own scope, so
they never collide and never see each other's failures. The full suite (`pnpm vitest run`) is the
orchestrator's to run, at the end.

Tests live beside the code they test, inside the module's folder, named `*.test.ts`.

**How live tests are gated.** A test a `module.md` marks **live** needs an installed agent and a
throwaway home. Write it in full, then gate it so it does not run by default:

```ts
const live = process.env.RESUME_FROM_LIVE === "1";
describe.skipIf(!live)("live: Pi resume", () => {
  /* ... */
});
```

Gated is not skipped: the test exists, is type-checked, and runs under
`RESUME_FROM_LIVE=1 pnpm vitest run src/<module-path>`. Default-off exists because parallel tasks
must never touch an agent home concurrently, and because C-3 states a bad write can damage the user's
real sessions.

**A live test builds its own throwaway home and never touches a real one.** Create a temporary
directory, point the agent at it (`CLAUDE_CONFIG_DIR` for Claude Code, the equivalent home argument
for Pi and Codex), and remove it afterwards. A live test that reads or writes `~/.claude`, `~/.codex`
or the user's Pi home is a defect, not a stronger test.

**Claude Code needs an authenticated throwaway home, and the tests never authenticate it.** A fresh
`CLAUDE_CONFIG_DIR` has no account reference, so the CLI answers `Not logged in · Please run /login`
and exits 1 — which makes any test that asks it to create or open a session fail. Pi and Codex are
unaffected; Codex's `thread/start` works with no login (C-7).

The resolution is out of band, and deliberately so:

```
CLAUDE_CONFIG_DIR="$HOME/.resume-from-live-home" claude    # log in once, interactively
RESUME_FROM_LIVE=1 pnpm vitest run src/adapters/claude-code
```

The tests read `RESUME_FROM_LIVE_CLAUDE_HOME` (default `$HOME/.resume-from-live-home`), use it when
it exists and is authenticated, and **skip with an explicit message naming this procedure** when it
is not. They never create it and never log in.

**No test may read the user's credential store.** Not `~/.claude.json`, not the Keychain, not an
account reference copied from one home into another. A suite that reads credentials to authenticate
itself is a worse artefact than a suite that skips: it would run on every machine that later checks
out this repository. The one-time interactive login keeps the credential entirely outside test code,
and the pre-authenticated home is still a throwaway — it is not the user's real `~/.claude`, so C-3
holds unchanged.

## Boundary enforcement

Several tests are static checks of the import graph rather than behaviour: T-PLA-1, T-PLA-2, T-PLA-7,
T-STO-15, T-TOK-11, T-REP-14, T-HOS-13, T-HOS-14, T-HOS-17, T-CLI-20, T-PIX-17, T-PIX-18, T-ROO-7,
T-ROO-8, T-ROO-10.

Implement them as Vitest tests that read the import graph, not as lint configuration. Two reasons:
they are named deliverables of module documents, and a lint rule can be disabled inline while a
failing test cannot be. Biome's own rules may be added as a second, redundant guard.

## Runtime dependencies

| Package         | Needed by              | Why                                                                                                                                           |
| --------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `gpt-tokenizer` | `src/platform/tokens/` | Pure JavaScript, no native binary and no wasm, so the tool stays loadable inside three other CLIs. Covers the `gpt` estimator family exactly. |

That is the whole runtime dependency list. Adding to it is a decision recorded here first, with the
module that needs it and why.

## Closed — decisions made during build preflight

- **Node version floor: 24.** Set in `package.json` `engines`. The tool runs inside three other Node
  CLIs, so the floor is deliberately conservative.
- **Tokenizer for `src/platform/tokens/`:** `gpt-tokenizer` for the `gpt` family. There is no
  official JavaScript tokenizer for the Claude family, so `claude` and `generic` use a documented
  character-ratio heuristic, and the module states its margin. This is sound because FR-29 budgets a
  _share_ of the window rather than all of it — the margin is what the share pays for. The estimator
  is behind an interface, so replacing either half is local (T-IMP-26).
- **Git access for `src/platform/repo/`:** spawn the `git` binary with `node:child_process`, always
  passing an **argument array, never a shell string**. No dependency, and it is what makes T-REP-11
  pass for free: a hostile revision string is an argument, never something a shell can interpret.

## Open

Nothing. Every question this file listed as open has been answered above.
