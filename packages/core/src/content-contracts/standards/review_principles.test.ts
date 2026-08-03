import { describe, expect, it } from "vitest";
import { contentAfterBanner, isFile, readText } from "./_helpers.js";

/** Content contracts for coding/review.md principle promotion (#1471 / #212). */

const REVIEW = "coding/review.md";
const CODING = "coding/coding.md";
const SKILL = "skills/deft-directive-review-cycle/SKILL.md";
const MAX_LINES = 120;

const REQUIRED_DIRECTIVE_MARKERS = [
  "ALL review findings MUST be read",
  "P0",
  "P1",
  "P2",
  "single batch commit",
  "grepped across all PR files",
  "validated locally",
  "while a review is in progress",
  "no P0 or P1 remaining",
  "closing keywords",
] as const;

describe("coding/review.md principles (#1471)", () => {
  it("review.md exists", () => {
    expect(isFile(REVIEW)).toBe(true);
  });

  it("review.md stays lean (principle surface, not adapter)", () => {
    expect(readText(REVIEW).split("\n").length).toBeLessThanOrEqual(MAX_LINES);
  });

  it("carries RFC2119 legend", () => {
    const head = contentAfterBanner(readText(REVIEW)).split("\n").slice(0, 15).join("\n");
    expect(head).toContain("!=MUST");
    expect(head).toContain("~=SHOULD");
  });

  it("documents universal requirements and anti-patterns", () => {
    const text = readText(REVIEW);
    expect(text).toContain("## Universal Requirements");
    expect(text).toContain("## Anti-Patterns");
    expect(text).toContain("- ! ");
    expect(text).toContain("- ⊗ ");
  });

  for (const marker of REQUIRED_DIRECTIVE_MARKERS) {
    it(`pins principle marker: ${marker}`, () => {
      expect(readText(REVIEW).toLowerCase()).toContain(marker.toLowerCase());
    });
  }

  it("coding.md quality chain links to review.md", () => {
    const text = readText(CODING);
    expect(text.includes("review.md") || text.includes("coding/review.md")).toBe(true);
    expect(text).toContain("#1471");
  });

  it("REFERENCES.md registers review.md", () => {
    expect(readText("REFERENCES.md")).toContain("coding/review.md");
  });

  it("main.md discoverability includes review.md", () => {
    expect(readText("main.md")).toContain("coding/review.md");
  });
});

describe("deft-directive-review-cycle is Greptile adapter (#1471)", () => {
  it("Principle Authority cross-refs coding/review.md", () => {
    const text = readText(SKILL);
    expect(text).toContain("Principle Authority");
    expect(text).toContain("coding/review.md");
    expect(text).toContain("#1471");
  });

  it("declares Greptile + GitHub adapter role", () => {
    const text = readText(SKILL);
    expect(text.toLowerCase()).toMatch(/greptile \+ github adapter|greptile \/ github adapter/);
    expect(text).toContain("adapter");
  });

  it("does not restate the full universal principle list as Step 2 bullets", () => {
    const text = readText(SKILL);
    const step2Start = text.indexOf("### Step 2: Analyze ALL findings before changing anything");
    const step3Start = text.indexOf("### Step 3: Fix all findings in ONE batch commit");
    expect(step2Start).toBeGreaterThan(-1);
    expect(step3Start).toBeGreaterThan(step2Start);
    const step2 = text.slice(step2Start, step3Start);
    // Universal list lives in coding/review.md; Step 2 must point there, not expand severity table.
    expect(step2).toContain("coding/review.md");
    expect(step2).not.toContain(
      "Categorize by severity (P0, P1, P2 — where P0 is critical/blocking, P1 is a real defect, P2 is a style or non-blocking suggestion)",
    );
  });

  it("Step 3 points at coding/review.md for batch/grep rules", () => {
    const text = readText(SKILL);
    const step3Start = text.indexOf("### Step 3: Fix all findings in ONE batch commit");
    const step3bStart = text.indexOf("### Step 3b:");
    expect(step3Start).toBeGreaterThan(-1);
    const step3 = text.slice(step3Start, step3bStart === -1 ? undefined : step3bStart);
    expect(step3).toContain("coding/review.md");
    // Adapter-specific fail-loud remains
    expect(step3).toContain("#1006");
  });
});
