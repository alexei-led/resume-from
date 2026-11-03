// The text layout of the numbered list and of the landing outcome.
// Nothing here decides anything: it prints what the pipeline returned.

import type { LandingResult, Listing, Place, SessionDescriptor } from "./contract.js";
import { safeText } from "./presentation.js";

const COLUMN_GAP = "  ";

/** Every warning as its own `⚠` line. */
export function renderWarnings(warnings: readonly string[]): string[] {
  return warnings.map((warning) => `⚠ ${safeText(warning)}`);
}

/** The native mode output: summary, warnings, and the command that resumes the session. */
export function renderNative(summary: string[], place: Place, command: string): string[] {
  return [
    ...summary.map(safeText),
    ...renderWarnings(place.warnings),
    `Resume: ${safeText(command)}`,
  ];
}

/** The output before a recovery runs: summary, warnings, each command, and the re-run token. */
export function renderRecovery(summary: string[], place: Place, confirmCommand: string): string[] {
  const commands = place.recovery?.commands ?? [];
  return [
    ...summary.map(safeText),
    ...renderWarnings(place.warnings),
    ...commands.map((command) => `Recover: ${safeText(command.display)}`),
    `Confirm: ${safeText(confirmCommand)}`,
  ];
}

/** `--context`: the summary, the conversation an import would keep, and the directory. */
export function renderContext(summary: string[], place: Place, turns: readonly string[]): string[] {
  return [
    ...summary.map(safeText),
    ...renderWarnings(place.warnings),
    ...turns.map(safeText),
    `Directory: ${safeText(place.directory === "" ? "(no recorded directory)" : place.directory)}`,
  ];
}

/** The import preview and the command that confirms it, with the stable Confirm label. */
export function renderPreview(report: readonly string[], confirmCommand: string): string[] {
  return [...report.map(safeText), "", `Confirm: ${confirmCommand}`];
}

export function renderListing(listing: Listing, destinationCwd: string): string[] {
  const lines: string[] =
    listing.rows.length === 0
      ? [`No session of ${safeText(destinationCwd)} was found.`]
      : renderRows(listing.rows);

  // Skipped homes and sessions are printed, never hidden.
  if (listing.failures.length > 0) {
    const count = listing.failures.length;
    lines.push("", `${count} ${count === 1 ? "entry" : "entries"} skipped:`);
    for (const failure of listing.failures) {
      lines.push(
        `  ${safeText(failure.agent)}${COLUMN_GAP}${safeText(failure.home)}${COLUMN_GAP}${safeText(failure.message)}`,
      );
    }
  }

  if (listing.rows.length > 0) {
    lines.push("", 'Run "/resume-from <n>" to preview a session.');
  }
  return lines;
}

export function renderLanding(result: LandingResult): string[] {
  // The provenance summary is the landing's own three lines (FR-47, FR-48), and the
  // Resume label is what the skill and the user parse (FR-61).
  const lines = result.marker.lines.map(safeText);
  if (result.switched) {
    lines.push("Switched.");
  } else if (result.handover !== null) {
    lines.push(`Resume: ${safeText(result.handover.command)}`);
  }
  return lines;
}

/** Rows are 1-based and keep the order the pipeline produced (FR-10, FR-14). */
function renderRows(rows: SessionDescriptor[]): string[] {
  const cells = rows.map((row, index) => [
    `${index + 1}`,
    safeText(row.ref.agent),
    safeText(row.ref.home),
    formatTime(row.updatedAt),
    `${row.turnCount} turns`,
    safeText(row.title),
  ]);
  const widths = cells.reduce<number[]>((widest, cell) => {
    cell.forEach((value, column) => {
      widest[column] = Math.max(widest[column] ?? 0, value.length);
    });
    return widest;
  }, []);

  return cells.map((cell) =>
    cell
      .map((value, column) => {
        if (column === cell.length - 1) return value;
        const width = widths[column] ?? value.length;
        return column === 0 ? value.padStart(width) : value.padEnd(width);
      })
      .join(COLUMN_GAP),
  );
}

/** ISO-8601 UTC, shortened to the minute. Unknown shapes are printed as they came. */
function formatTime(updatedAt: string): string {
  const safe = safeText(updatedAt);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(safe);
  if (match === null) return safe;
  return `${match[1]} ${match[2]}Z`;
}
