/**
 * Completed-arc record drives auto-stamp chip (#4298). Spec-path: is a lean
 * token, not a chip selector. Recut: is a permanent alias. No NLP of lean prose.
 */
import { describe, expect, it } from "vitest";
import {
  leanCarriesRecutToken,
  leanCarriesSpecPathToken,
  resolveAutoStampCatalogChip,
} from "./auto-stamp-chip.js";
import {
  type DesignCritiqueCatalogChip,
  remainingSetAfterDesignCritiqueChip,
} from "./exclusive-chip.js";

const PATH_SELECTOR_STEMS = ["Spec-path:", "Recut:"] as const;

function pathSelectorSpellings(stem: string): readonly string[] {
  const wraps = ["", "*", "**"] as const;
  return wraps.flatMap((left) => wraps.map((right) => `${left}${stem}${right}`));
}

const ISSUE_4200_ENGLISH_RECUT_LEAN =
  "**Lean:** recut of 5555695949. Repo-wide lookup or drop cross-issue overlap; add a task verb.\n";

describe("resolveAutoStampCatalogChip (#4298)", () => {
  it("stamps ingest-ready after a complete record, Recut token or not", () => {
    expect(resolveAutoStampCatalogChip("**Lean:** next-build is this body.\n")).toBe(
      "design-critique:ingest-ready",
    );
    expect(leanCarriesSpecPathToken("**Lean:** next-build is this body.\n")).toBe(false);
    expect(leanCarriesRecutToken("**Lean:** next-build is this body.\n")).toBe(false);
    expect(resolveAutoStampCatalogChip()).toBe("design-critique:ingest-ready");
  });

  it("does not classify recut from lean English (#4200 fixture, no NLP)", () => {
    expect(resolveAutoStampCatalogChip(ISSUE_4200_ENGLISH_RECUT_LEAN)).toBe(
      "design-critique:ingest-ready",
    );
    expect(leanCarriesSpecPathToken(ISSUE_4200_ENGLISH_RECUT_LEAN)).toBe(false);
    expect(leanCarriesRecutToken(ISSUE_4200_ENGLISH_RECUT_LEAN)).toBe(false);
  });

  it("detects Spec-path: and Recut: as line-starts in all nine spellings without selecting a chip", () => {
    for (const stem of PATH_SELECTOR_STEMS) {
      for (const spelling of pathSelectorSpellings(stem)) {
        const body = `**Lean:** next-build is not this body.\n\n${spelling}\n`;
        expect(leanCarriesSpecPathToken(body), spelling).toBe(true);
        expect(leanCarriesRecutToken(body), spelling).toBe(true);
        expect(resolveAutoStampCatalogChip(body), spelling).toBe("design-critique:ingest-ready");
      }
    }
  });

  it("does not treat a fenced Spec-path: or Recut: example as the closed token", () => {
    const fencedRecut = "**Lean:** next-build is this body.\n\n```\nRecut:\n```\n";
    const fencedSpec = "**Lean:** next-build is this body.\n\n```\nSpec-path:\n```\n";
    const quotedRecut = "**Lean:** next-build is this body.\n\n> Recut:\n";
    expect(leanCarriesSpecPathToken(fencedRecut)).toBe(false);
    expect(leanCarriesSpecPathToken(fencedSpec)).toBe(false);
    expect(leanCarriesSpecPathToken(quotedRecut)).toBe(false);
    expect(leanCarriesRecutToken(fencedRecut)).toBe(false);
  });

  it("does not treat Spec-path: or Recut: inside a Lean: line as the closed token", () => {
    const recutInside = "**Lean:** Recut: this is still lean English, not a Recut line-start.\n";
    const specInside =
      "**Lean:** Spec-path: this is still lean English, not a Spec-path line-start.\n";
    expect(leanCarriesSpecPathToken(recutInside)).toBe(false);
    expect(leanCarriesSpecPathToken(specInside)).toBe(false);
    expect(leanCarriesRecutToken(recutInside)).toBe(false);
    expect(resolveAutoStampCatalogChip(recutInside)).toBe("design-critique:ingest-ready");
  });

  it("empty-disagreement recut lean still remaining-set-replaces ingest-ready", () => {
    const lean =
      "**Lean:** next-build is recut.\n\n**Recut:**\n\n## In plain English\n\nDo not implement this body.\n";
    const chip: DesignCritiqueCatalogChip = resolveAutoStampCatalogChip(lean);
    expect(chip).toBe("design-critique:ingest-ready");
    const remaining = remainingSetAfterDesignCritiqueChip(
      ["bug", "design-critique:mechanism-shaped", "area:skills"],
      chip,
    );
    expect(remaining).toEqual(["bug", "area:skills", "design-critique:ingest-ready"]);
    expect(remaining).not.toContain("design-critique:triage-ready");
    expect(remaining).not.toContain("design-critique:recut-needed");
    expect(remaining).not.toContain("design-critique:mechanism-shaped");
  });
});
