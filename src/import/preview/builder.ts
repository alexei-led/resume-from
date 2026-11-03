import type {
  PreviewBuilder,
  PreviewContent,
  PreviewWarning,
  RepoIdentity,
  RepoReader,
  TransferPlan,
} from "./contract.js";
import { formatTokens, oneLine, plural } from "./format.js";
import { directoryWarning, planWarnings, repoWarning, sortWarnings } from "./warnings.js";

/** Paths are longer than titles and are not shortened to the same length. */
const MAX_PATH_LENGTH = 160;
const MAX_REASON_LENGTH = 200;

// Each blockedReason now carries its own cause-specific advice (FR-33, FR-56), so no
// single fallback string is accurate for all block causes.

/**
 * The shared restore header the pipeline renders, then only what the preview adds: the target
 * and the turn counts. The source agent, home, time, title, destination and branch come from the
 * one summary builder, so the preview cannot drift from the native and landing summaries.
 */
function headerLines(plan: TransferPlan, summary: readonly string[]): string[] {
  const target = oneLine(plan.target.home, MAX_PATH_LENGTH);
  return [...summary, `Target: ${plan.target.agent} (${target})`, countLine(plan)];
}

/** FR-17: both counts, and both come from the plan. */
function countLine(plan: TransferPlan): string {
  const kept = plan.keptTurnCount;
  const crossing =
    kept === 0
      ? "Nothing would cross over"
      : `${kept} ${plural(kept, "turn crosses", "turns cross")} over`;
  return plan.droppedTurnCount > 0 ? `${crossing}, ${plan.droppedTurnCount} dropped` : crossing;
}

/** FR-35. A plan that dropped nothing produces no line at all — never "0 turns dropped". */
function dropLines(plan: TransferPlan): string[] {
  const lines: string[] = [];
  const budgetDrops = plan.drops.filter((drop) => drop.reason === "budget").length;
  if (budgetDrops > 0) {
    lines.push(`${budgetDrops} older ${plural(budgetDrops, "turn", "turns")} dropped`);
  }
  if (plan.bodiesDropped > 0) {
    lines.push(
      `${plan.bodiesDropped} tool result ${plural(plan.bodiesDropped, "body", "bodies")} dropped`,
    );
  }
  return lines;
}

function blockedLines(blockedReason: string | null): string[] {
  if (blockedReason === null) return [];
  return [`✖ The import cannot run: ${oneLine(blockedReason, MAX_REASON_LENGTH)}`];
}

/**
 * Builds the preview from a plan and the repository state read at the moment of the call.
 * It writes nothing (FR-16) and renders one shape for every direction (FR-21).
 */
export function createPreviewBuilder(
  repo: RepoReader,
  cwd: string,
  canonicalCwd: string = cwd,
  identity?: RepoIdentity,
  recordedDirectories: readonly string[] = [],
): PreviewBuilder {
  return {
    async build(plan: TransferPlan, summary: readonly string[]): Promise<PreviewContent> {
      const collected: PreviewWarning[] = planWarnings(plan);
      const fromDirectory = await directoryWarning(recordedDirectories, canonicalCwd);
      if (fromDirectory !== null) collected.push(fromDirectory);
      const fromRepo = await repoWarning(plan, repo, cwd, identity);
      if (fromRepo !== null) collected.push(fromRepo);
      const warnings = sortWarnings(collected);

      const header = headerLines(plan, summary);
      const budgetLine = `Budget: ${formatTokens(plan.estimatedTokens)} tokens of a ${formatTokens(plan.target.windowTokens)} window`;
      const drops = dropLines(plan);
      const blocked = plan.blockedReason !== null;

      return {
        headerLines: header,
        budgetLine,
        warnings,
        dropLines: drops,
        blocked,
        blockedReason: plan.blockedReason,
        lines: [
          ...header,
          budgetLine,
          ...warnings.map((warning) => warning.line),
          ...drops,
          ...blockedLines(plan.blockedReason),
        ],
      };
    },
  };
}
