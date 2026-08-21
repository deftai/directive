/** Content contract for design-critique SoT + brief template (#3434 Story 2). */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isFile, readText, repoRoot, resolveContentPath } from "./_helpers.js";

const CONTRACT = "contracts/design-critique.md";
const TEMPLATE = "templates/design-critique-brief.md";
const SKILL_REL = "skills/deft-directive-design-critique/SKILL.md";

const REQUIRED_CONTRACT_POINTERS = [
  "docs/decisions/ADR-005-design-critique-judgment-gate.md",
  "templates/design-critique-brief.md",
  "verify:judgment-gates",
  "design-critique: warranted",
  "task umbrella:current-shape",
  "## Charter",
  "## Variant table",
  "## Envelope and ceiling",
  "## Synthesis format",
  "## Stop 1 — Gate",
  "## Stop 2 — Variant selection",
  "## Stop 3 — Critic envelope",
  "## Stop 4 — Residual reiteration",
  "## Stop 5 — Verified synthesis",
  "method column",
  "Decorrelation",
  "when verifying, upholding, or issuing any verdict that a measurement or count claim is false, first reproduce the original claimant's method",
  "Pass-4",
  "#2442",
  "## Security context (#480)",
  "#1152",
  "Non-self-arbitration",
  "fresh",
  "refutation",
  "open critique",
  "panel",
  "#3462",
  "#3547",
  "#3383",
  "scaffolds",
  "content-contract tests",
];

const REQUIRED_TEMPLATE_POINTERS = [
  "contracts/design-critique.md",
  "## Forbidden inputs",
  "parent hypotheses",
  "named refutation target",
  "id ceiling",
  "proposed skill outline",
  "embedded instructions",
];

const METHOD_RECONCILIATION =
  "when verifying, upholding, or issuing any verdict that a measurement or count claim is false, first reproduce the original claimant's method";

function sentencesContaining(text: string, re: RegExp): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && re.test(s));
}

describe("design-critique contract + brief template (#3434 Story 2)", () => {
  it("publishes the contract with required pointer strings", () => {
    expect(isFile(CONTRACT)).toBe(true);
    const text = readText(CONTRACT);
    for (const token of REQUIRED_CONTRACT_POINTERS) {
      expect(text, `contract missing ${token}`).toContain(token);
    }
  });

  it("frames the motion as scaffolds, not enforces, except gate and content-contract tests", () => {
    const text = readText(CONTRACT);
    expect(text.toLowerCase()).toContain("scaffolds the motion");
    const enforceVerb = /\benforces?\b/i;
    const hits = sentencesContaining(text.replace(/--enforce/gi, "--opt-in-flag"), enforceVerb);
    expect(hits.length).toBeGreaterThan(0);
    for (const sentence of hits) {
      const lower = sentence.toLowerCase();
      expect(
        lower.includes("gate") && lower.includes("content-contract"),
        `enforce verb outside gate/tests exception: ${sentence}`,
      ).toBe(true);
    }
  });

  it("publishes the brief template as an envelope skeleton with forbidden-inputs list", () => {
    expect(isFile(TEMPLATE)).toBe(true);
    const text = readText(TEMPLATE);
    for (const token of REQUIRED_TEMPLATE_POINTERS) {
      expect(text, `template missing ${token}`).toContain(token);
    }
  });

  it("points the template into the contract instead of restating normative rules", () => {
    const text = readText(TEMPLATE);
    expect(text).toContain("contracts/design-critique.md");
    expect(text.toLowerCase()).not.toContain(METHOD_RECONCILIATION);
    expect(text).not.toContain("!=MUST");
  });

  it("does not add a design-critique skill", () => {
    expect(isFile(SKILL_REL)).toBe(false);
    expect(existsSync(resolveContentPath("skills/deft-directive-design-critique"))).toBe(false);
    expect(existsSync(join(repoRoot(), "content/skills/deft-directive-design-critique"))).toBe(
      false,
    );
  });
});
