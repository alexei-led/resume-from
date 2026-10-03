/**
 * T-ROO-4 to T-ROO-7 — the system-wide invariants.
 *
 * These are the tests that fail when the architecture erodes: the design tree against the source
 * tree, every restatement against its normative home, the coupling assessment recomputed from the
 * folder tree, and the shape of the module graph. None of them can be checked by running the
 * system, and none of them belongs to any single submodule — which is why they are the root's.
 *
 * They are analyses, not assertions about strings written down here twice: every number is
 * recomputed from the tree, and every edge is read out of the documents that claim it.
 */

import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allFolders,
  couplingRows,
  depthOf,
  distanceOf,
  documentOf,
  edgeKey,
  formatRestatementDefects,
  headings,
  type Integration,
  importSpecifiers,
  integrationsOf,
  isInside,
  lcaOf,
  MAX_BALANCED_DISTANCE,
  metadataOf,
  moduleFolders,
  modulePath,
  rankOf,
  repoRelative,
  resolveSpecifier,
  SRC_DIR,
  section,
  shippedSources,
  strengthsIn,
  strictestStrength,
  validateContractRestatements,
} from "./test-support.js";

const MODULES = moduleFolders(SRC_DIR);
const MODULE_PATHS = MODULES.map(modulePath);

/** Every section the module template requires of every module. */
const REQUIRED_SECTIONS = [
  "Purpose",
  "Functional Responsibilities",
  "Subdomain Classification",
  "Encapsulated Knowledge",
  "Public Contract",
  "Integrations",
  "Change Vectors",
  "Constraints and Invariants",
  "Test Specification",
];

/** Required of a module that has submodules: how the parts are put together. */
const PARENT_SECTION = "Internal Design";

/** The deepest module that contains a file — the module the file belongs to. */
const byDepth = [...MODULES].sort((left, right) => right.length - left.length);
const moduleOf = (path: string): string => byDepth.find((dir) => isInside(path, dir)) ?? SRC_DIR;

describe("T-ROO-4 — the design tree matches the source tree", () => {
  it("every folder under src/ is a module with a module.md", () => {
    const folders = allFolders(SRC_DIR).map(repoRelative);
    const documented = MODULE_PATHS.filter((path) => path !== "src");
    expect(folders).toEqual(documented);
  });

  it("is 20 modules", () => {
    expect(MODULES).toHaveLength(20);
  });

  it.each(MODULES.map((dir) => [modulePath(dir), dir] as const))(
    "%s holds every section the template requires",
    (_name, dir) => {
      const text = documentOf(dir);
      const present = headings(text);
      for (const required of REQUIRED_SECTIONS) {
        expect(present, `${modulePath(dir)} is missing ## ${required}`).toContain(required);
        expect(section(text, required)?.trim()).not.toBe("");
      }

      const hasSubmodules = (metadataOf(text).submodules ?? []).length > 0;
      expect(present.includes(PARENT_SECTION), `${modulePath(dir)} — ${PARENT_SECTION}`).toBe(
        hasSubmodules,
      );
    },
  );

  it.each(MODULES.map((dir) => [modulePath(dir), dir] as const))(
    "%s names its real path, parent and submodules",
    (name, dir) => {
      const metadata = metadataOf(documentOf(dir));

      expect(metadata.path).toBe(name);

      const parent = MODULES.filter((other) => other !== dir).find(
        (other) => moduleOf(dir.slice(0, dir.lastIndexOf("/"))) === other,
      );
      if (dir === SRC_DIR) expect(metadata.parent).toMatch(/^none/i);
      else expect(metadata.parent).toBe(parent === undefined ? null : modulePath(parent));

      const children = MODULES.filter(
        (other) => other !== dir && isInside(other, dir) && moduleOf(join(other, "..")) === dir,
      ).map((other) => basename(other));
      expect([...(metadata.submodules ?? [])].sort()).toEqual([...children].sort());
    },
  );
});

describe("T-ROO-5 — every restatement matches its normative home", () => {
  const documents = MODULES.map((dir) => ({
    path: `${modulePath(dir)}/module.md`,
    text: documentOf(dir),
  }));

  it("validates every marker with the project-owned TypeScript validator", () => {
    const defects = validateContractRestatements(documents);
    expect(defects, formatRestatementDefects(defects)).toEqual([]);
  });

  it("reports marker placement and declaration drift with file, line and type", () => {
    const owner = {
      path: "src/owner/module.md",
      text: "## Public Contract\n\n```ts\ninterface Example {\n  value: string;\n}\n```\n\n## Integrations\n",
    };
    const consumer = {
      path: "src/consumer/module.md",
      text:
        "## Public Contract\n\n" +
        "<!-- contract: Example — restated from src/owner/module.md -->\n\n" +
        "```ts\ninterface Example {\n  value: number;\n}\n```\n\n## Integrations\n",
    };
    const defects = validateContractRestatements([owner, consumer]);
    const rendered = formatRestatementDefects(defects);

    expect(rendered).toContain("src/consumer/module.md:");
    expect(rendered).toContain("marker must be immediately followed by a code fence");

    const drift = formatRestatementDefects(
      validateContractRestatements([
        owner,
        { ...consumer, text: consumer.text.replace("-->\n\n```", "-->\n```") },
      ]),
    );
    expect(drift).toContain("[Example]");
    expect(drift).toContain("src/owner/module.md:");
    expect(drift).toContain('expected "  value: string;", got "  value: number;"');
  });
});

describe("T-ROO-6 — the coupling assessment is still true", () => {
  const documented: Integration[] = MODULES.flatMap((dir) => integrationsOf(dir));
  const rows = couplingRows(documentOf(SRC_DIR));

  const named = (integration: Integration): string =>
    `${integration.module} → ${integration.counterpart}`;

  it("every module either documents its integrations or declares it has none", () => {
    for (const dir of MODULES) {
      const stated = integrationsOf(dir).length > 0;
      // Four modules are sinks: they are depended upon and depend on nothing. Their documents
      // say so in words, and T-ROO-7 checks the import graph agrees.
      const declaresNone = /\*\*None\.\*\*/.test(section(documentOf(dir), "Integrations") ?? "");
      expect(stated !== declaresNone, `${modulePath(dir)} — Integrations`).toBe(true);
    }
  });

  it("names only modules that exist", () => {
    const strangers = documented
      .filter((integration) => !MODULE_PATHS.includes(integration.counterpart))
      .map(named);
    expect(strangers).toEqual([]);
    expect(rows.filter((row) => !MODULE_PATHS.includes(row.from)).map((row) => row.from)).toEqual(
      [],
    );
    expect(rows.filter((row) => !MODULE_PATHS.includes(row.to)).map((row) => row.to)).toEqual([]);
  });

  it.each(documented.map((integration) => [named(integration), integration] as const))(
    "%s states the LCA, rank and distance the folder tree gives",
    (_name, integration) => {
      const lca = lcaOf(integration.module, integration.counterpart);
      const rank = rankOf(integration.module, integration.counterpart);
      expect({
        lca: integration.lca,
        rank: integration.rank,
        distance: integration.distance,
      }).toEqual({ lca, rank, distance: distanceOf(rank) });
    },
  );

  it("recomputes every row of the table from the tree", () => {
    const recomputed = rows.map((row) => {
      const rank = rankOf(row.from, row.to);
      return {
        edge: `${row.from} → ${row.to}`,
        lca: lcaOf(row.from, row.to),
        rank,
        distance: distanceOf(rank),
      };
    });
    const claimed = rows.map((row) => ({
      edge: `${row.from} → ${row.to}`,
      lca: row.lca,
      rank: row.rank,
      distance: row.distance,
    }));
    expect(recomputed).toEqual(claimed);
  });

  const everyIntegration = [...documented, ...rows.map(asIntegration)];

  it("no integration exceeds the threshold of its strength", () => {
    const unbalanced = everyIntegration
      .filter((integration) => {
        // The strictest strength named governs: an edge that is contract coupling for its
        // interfaces and model coupling for the values crossing them is bounded by the model half.
        const strength = strictestStrength(integration.strengths);
        expect(strength, `no strength named in ${named(integration)}`).toBeDefined();
        const limit = strength === undefined ? 0 : (MAX_BALANCED_DISTANCE[strength] ?? 0);
        return distanceOf(rankOf(integration.module, integration.counterpart)) > limit;
      })
      .map(named);
    expect(unbalanced).toEqual([]);
  });

  it("has no functional and no intrusive coupling across a folder boundary", () => {
    const forbidden = everyIntegration
      .filter((integration) =>
        integration.strengths.some(
          (strength) => strength === "functional" || strength === "intrusive",
        ),
      )
      .map(named);
    expect(forbidden).toEqual([]);
  });

  it("model coupling never exceeds distance 2 (Decision 1: the tree is flat because of it)", () => {
    const overreaching = everyIntegration
      .filter((integration) => integration.strengths.includes("model"))
      .filter((integration) => distanceOf(rankOf(integration.module, integration.counterpart)) > 2)
      .map(named);
    expect(overreaching).toEqual([]);
    // The depth cap is the same claim seen from the tree: nothing sits deeper than rank 2.
    expect(Math.max(...MODULE_PATHS.map(depthOf))).toBe(2);
  });

  it("the table is the union of the Integrations sections", () => {
    const fromDocuments = new Set(
      documented.map((integration) => edgeKey(integration.module, integration.counterpart)),
    );
    const fromTable = new Set(rows.map((row) => edgeKey(row.from, row.to)));

    expect([...fromTable].filter((edge) => !fromDocuments.has(edge)).sort()).toEqual([]);
    expect([...fromDocuments].filter((edge) => !fromTable.has(edge)).sort()).toEqual([]);
    // One row per edge: a duplicated row would make the union comparison above pass by accident.
    expect(fromTable.size).toBe(rows.length);
  });

  it("agrees with every module document on the strength of a shared edge", () => {
    const disagreements = documented
      .filter((integration) => {
        const row = rows.find(
          (candidate) =>
            edgeKey(candidate.from, candidate.to) ===
            edgeKey(integration.module, integration.counterpart),
        );
        return row !== undefined && !integration.strength.startsWith(row.strength);
      })
      .map(named);
    expect(disagreements).toEqual([]);
  });
});

/** A table row read as an integration, so both sides are checked by the same rules. */
function asIntegration(row: {
  from: string;
  to: string;
  strength: string;
  lca: string;
  rank: number;
  distance: number;
}): Integration {
  return {
    module: row.from,
    counterpart: row.to,
    strength: row.strength,
    strengths: strengthsIn(row.strength),
    claim: `LCA \`${row.lca}\`, rank ${row.rank}, distance ${row.distance}`,
    lca: row.lca,
    rank: row.rank,
    distance: row.distance,
  };
}

describe("T-ROO-7 — the module graph is acyclic and layered", () => {
  const HOST_DIR = join(SRC_DIR, "host");
  const SESSION_DIR = join(SRC_DIR, "session");
  const PLATFORM_DIR = join(SRC_DIR, "platform");
  const CONFIG_DIR = join(PLATFORM_DIR, "config");
  const shipped = shippedSources();

  interface Edge {
    from: string;
    to: string;
    file: string;
    specifier: string;
    target: string;
  }

  const edges: Edge[] = shipped.flatMap((source) =>
    importSpecifiers(source)
      .map((specifier) => ({
        specifier,
        target: resolveSpecifier(source.path, specifier),
      }))
      .filter((reach): reach is { specifier: string; target: string } => reach.target !== undefined)
      .map((reach) => ({
        from: moduleOf(source.path),
        to: moduleOf(reach.target),
        file: repoRelative(source.path),
        specifier: reach.specifier,
        target: reach.target,
      }))
      .filter((edge) => edge.from !== edge.to),
  );

  it("has edges to check", () => {
    expect(shipped.length).toBeGreaterThan(40);
    expect(edges.length).toBeGreaterThan(20);
  });

  it("is acyclic", () => {
    const outgoing = new Map<string, Set<string>>();
    for (const edge of edges) {
      const seen = outgoing.get(edge.from) ?? new Set<string>();
      seen.add(edge.to);
      outgoing.set(edge.from, seen);
    }

    const state = new Map<string, "open" | "done">();
    const cycles: string[] = [];
    const visit = (node: string, trail: string[]): void => {
      if (state.get(node) === "done") return;
      if (state.get(node) === "open") {
        cycles.push([...trail.slice(trail.indexOf(node)), node].map(repoRelative).join(" → "));
        return;
      }
      state.set(node, "open");
      for (const next of outgoing.get(node) ?? []) visit(next, [...trail, node]);
      state.set(node, "done");
    };
    for (const node of outgoing.keys()) visit(node, []);

    expect(cycles).toEqual([]);
  });

  it("nothing imports src/host/ but the root", () => {
    // The root builds the host — that is the one documented edge into the composition root
    // (src → src/host). A submodule reaching it would be the cycle Decision 3 exists to prevent.
    // The host's own two submodules are inside it and are its Internal Design, not an import in.
    const strays = edges
      .filter((edge) => isInside(edge.to, HOST_DIR))
      .filter((edge) => edge.from !== SRC_DIR && !isInside(edge.from, HOST_DIR))
      .map((edge) => `${edge.file} → ${repoRelative(edge.target)}`);
    expect(strays).toEqual([]);
  });

  it("a module whose document declares no integration imports nothing", () => {
    const sinks = MODULES.filter((dir) =>
      /\*\*None\.\*\*/.test(section(documentOf(dir), "Integrations") ?? ""),
    );
    expect(sinks.length).toBeGreaterThan(0);
    const reaching = edges
      .filter((edge) => sinks.includes(edge.from))
      .map((edge) => `${edge.file} → ${edge.specifier}`);
    expect(reaching).toEqual([]);
  });

  it("src/session/ imports nothing", () => {
    const reaches = edges
      .filter((edge) => edge.from === SESSION_DIR)
      .map((edge) => `${edge.file} → ${edge.specifier}`);
    expect(reaches).toEqual([]);

    const external = shipped
      .filter((source) => isInside(source.path, SESSION_DIR))
      .flatMap((source) =>
        importSpecifiers(source)
          .filter((specifier) => !specifier.startsWith("."))
          .map((specifier) => `${repoRelative(source.path)} → ${specifier}`),
      );
    expect(external).toEqual([]);
  });

  it("no service in src/platform/ knows the product's vocabulary, except where the design says", () => {
    const outward = edges
      .filter((edge) => isInside(edge.from, PLATFORM_DIR))
      .filter((edge) => !isInside(edge.to, PLATFORM_DIR));

    // Decision 5: `platform/config/` is the one exception, because configuration is keyed by
    // agent. It restates AgentId and HomePath and nothing else.
    for (const edge of outward) {
      expect(edge.from, `${edge.file} reaches ${repoRelative(edge.target)}`).toBe(CONFIG_DIR);
      expect(edge.to).toBe(SESSION_DIR);
    }

    const restated = shipped
      .filter((source) => isInside(source.path, CONFIG_DIR))
      .flatMap((source) =>
        source.ast.statements
          .filter((statement) => statement.kind !== undefined)
          .flatMap((statement) => {
            const text = statement.getText(source.ast);
            return /session\/contract\.js/.test(text)
              ? [...text.matchAll(/\b(AgentId|HomePath|[A-Z][A-Za-z]+)\b(?=[,\s}])/g)].map(
                  (match) => match[1] ?? "",
                )
              : [];
          }),
      );
    expect([...new Set(restated)].sort()).toEqual(["AgentId", "HomePath"]);
  });

  it("every cross-module import is a contract, or a factory the design allows", () => {
    // The composition root is the one module that may build an implementation it does not own,
    // and which ones is not a list kept here: it is what the coupling assessment already
    // documents as an edge out of `src/host/`.
    const composed = new Set(
      couplingRows(documentOf(SRC_DIR))
        .filter((row) => row.from === repoRelative(HOST_DIR))
        .map((row) => join(SRC_DIR, "..", row.to)),
    );

    const offenders = edges
      .filter((edge) => !edge.specifier.endsWith("/contract.js"))
      .filter((edge) => {
        if (!edge.specifier.endsWith("/index.js")) return true;
        // A parent building its own submodules (its Internal Design), and the composition root
        // building what the design says it constructs (docs/tech-stack.md, Isolation).
        const isParent = isInside(edge.to, edge.from);
        const isCompositionRoot = edge.from === HOST_DIR && composed.has(edge.to);
        return !(isParent || isCompositionRoot);
      })
      .map((edge) => `${edge.file} → ${edge.specifier}`);

    expect(offenders).toEqual([]);
  });
});
