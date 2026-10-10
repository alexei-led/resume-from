// The text layout of the numbered list and of the landing outcome.
// Nothing here decides anything: it prints what the pipeline returned.

import type { LandingResult, Listing, SessionDescriptor } from "./contract.js";
import { safeText } from "./presentation.js";

const COLUMN_GAP = "  ";

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
  // Sessions that belong to other repositories are the normal case when a whole home is
  // searched (FR-13): the count is printed, the sessions are not narrated row by row.
  if (listing.excluded > 0) {
    const count = listing.excluded;
    lines.push(
      "",
      `${count} ${count === 1 ? "session" : "sessions"} ${count === 1 ? "does" : "do"} not belong to this repository and ${count === 1 ? "was" : "were"} not listed.`,
    );
  }

  if (listing.rows.length > 0) {
    lines.push("", 'Run "/resume-from <n>" to preview a session.');
  }
  return lines;
}

export function renderLanding(result: LandingResult): string[] {
  const lines = [
    `Imported into ${safeText(result.ref.agent)} (${safeText(result.ref.home)}) as session ${safeText(result.ref.id)}.`,
    `${result.itemsSent} items sent, ${result.itemsStored} stored.`,
  ];
  if (result.switched) {
    lines.push("You are now in the imported session.");
  } else if (result.handover !== null) {
    lines.push(`Open it with: ${safeText(result.handover.command)}`);
  }
  // The marker is always printed: this host has no way to know whether the
  // target can show one itself (FR-47, FR-48), and hiding it would be a rule.
  lines.push("", ...result.marker.lines.map(safeText));
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
