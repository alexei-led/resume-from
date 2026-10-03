import { expect, it } from "vitest";
import { renderListing } from "./render.js";

it("labels skipped sessions and homes as entries, not unreadable homes", () => {
  const listing = {
    rows: [],
    excluded: 0,
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

it("summarizes non-member sessions as one count, not one line each", () => {
  const one = renderListing({ rows: [], failures: [], excluded: 1 }, "/destination");
  expect(one).toContain("1 session does not belong to this repository and was not listed.");
  const many = renderListing({ rows: [], failures: [], excluded: 112 }, "/destination");
  expect(many).toContain("112 sessions do not belong to this repository and were not listed.");
  expect(many.filter((line) => line.includes("do not belong"))).toHaveLength(1);
});
