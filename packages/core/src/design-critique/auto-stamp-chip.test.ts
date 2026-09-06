/**
 * Closed Recut: token drives auto-stamp chip (#4205). No NLP of lean prose.
 */
import { describe, expect, it } from "vitest";
import { leanCarriesRecutToken, resolveAutoStampCatalogChip } from "./auto-stamp-chip.js";
import {
  type DesignCritiqueCatalogChip,
  remainingSetAfterDesignCritiqueChip,
} from "./exclusive-chip.js";

const RECUT_TOKEN_SPELLINGS = [
  "Recut:",
  "*Recut:",
  "**Recut:",
  "Recut:*",
  "Recut:**",
  "*Recut:*",
  "*Recut:**",
  "**Recut:*",
  "**Recut:**",
] as const;

/** #4200-shaped English recut without the closed token. */
const ISSUE_4200_ENGLISH_RECUT_LEAN =
  "**Lean:** recut of 5555695949. Repo-wide lookup or drop cross-issue overlap; add a task verb.\n";

describe("resolveAutoStampCatalogChip (#4205)", () => {
  it("stamps triage-ready when the successor lean has no Recut: token", () => {
    expect(resolveAutoStampCatalogChip("**Lean:** next-build is this body.\n")).toBe(
      "design-critique:triage-ready",
    );
    expect(leanCarriesRecutToken("**Lean:** next-build is this body.\n")).toBe(false);
  });

  it("does not classify recut from lean English (#4200 fixture, no NLP)", () => {
    expect(resolveAutoStampCatalogChip(ISSUE_4200_ENGLISH_RECUT_LEAN)).toBe(
      "design-critique:triage-ready",
    );
    expect(leanCarriesRecutToken(ISSUE_4200_ENGLISH_RECUT_LEAN)).toBe(false);
  });

  it("stamps recut-needed when Recut: is a line-start, in all nine spellings", () => {
    for (const spelling of RECUT_TOKEN_SPELLINGS) {
      const body = `**Lean:** next-build is not this body.\n\n${spelling}\n`;
      expect(leanCarriesRecutToken(body), spelling).toBe(true);
      expect(resolveAutoStampCatalogChip(body), spelling).toBe("design-critique:recut-needed");
    }
  });

  it("does not treat Recut: inside a Lean: line as the closed token", () => {
    const body = "**Lean:** Recut: this is still lean English, not a Recut line-start.\n";
    expect(leanCarriesRecutToken(body)).toBe(false);
    expect(resolveAutoStampCatalogChip(body)).toBe("design-critique:triage-ready");
  });

  it("empty-disagreement recut lean with Recut: does not leave triage-ready on the list", () => {
    const lean =
      "**Lean:** next-build is recut.\n\n**Recut:**\n\n## In plain English\n\nDo not implement this body.\n";
    const chip: DesignCritiqueCatalogChip = resolveAutoStampCatalogChip(lean);
    expect(chip).toBe("design-critique:recut-needed");
    const remaining = remainingSetAfterDesignCritiqueChip(
      ["bug", "design-critique:mechanism-shaped", "area:skills"],
      chip,
    );
    expect(remaining).toEqual(["bug", "area:skills", "design-critique:recut-needed"]);
    expect(remaining).not.toContain("design-critique:triage-ready");
    expect(remaining).not.toContain("design-critique:mechanism-shaped");
  });
});
