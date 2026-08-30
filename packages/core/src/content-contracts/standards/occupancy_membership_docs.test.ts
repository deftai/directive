/** Content contract for honest occupancy boundary naming (#3755). */
import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

const MODULE = "packages/core/src/session/occupancy.ts";

describe("occupancy boundary naming (#3755)", () => {
  it("names the module boundary as cooperative bearer-id rather than lineage", () => {
    const text = readText(MODULE);
    for (const token of [
      "cooperative bearer-id boundary, not a",
      "lineage",
      "Nothing here observes parentage",
      "inherited the holder's rights",
      "admits writes only",
    ]) {
      expect(text, `occupancy module missing ${token}`).toContain(token);
    }
  });

  it("documents membership and the owner-only split in commands.md", () => {
    const text = readText("commands.md");
    for (const token of [
      "cooperative bearer-id boundary, not a lineage",
      "Lease membership (#3755)",
      "deft occupancy:grant",
      "--child-session-id",
      "owner id, child id, worktree, role and expiry",
      "release, steal, heartbeat and cohort close-out stay owner-only",
      "An expired grant is refused on read",
    ]) {
      expect(text, `commands.md missing ${token}`).toContain(token);
    }
    // The parked join verb was never implemented, so remediation must not send
    // a blocked caller to it.
    expect(text).not.toContain("Join (`occupancy:request`) is named in remediation only");
  });

  // Searched over the whole file, not the Unreleased section: a release cut
  // moves the entry into the cut section, so a section-bounded search is a
  // scheduled failure. The changelog is append-only, so exactly-one holds
  // wherever the entry lives (#3930).
  it("carries exactly one changelog entry for the membership change", () => {
    const changelog = readText("CHANGELOG.md");
    const entries = changelog
      .split("\n")
      .filter((line) => line.includes("Closes #3755") && line.includes("occupancy:grant"));
    expect(entries).toHaveLength(1);
  });
});
