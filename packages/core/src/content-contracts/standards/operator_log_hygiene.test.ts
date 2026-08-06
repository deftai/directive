import { describe, expect, it } from "vitest";
import { isFile, readText } from "./_helpers.js";

const PATTERN = "patterns/operator-log-hygiene.md";
const CHECKLIST = "docs/operator-log-hygiene-checklist.md";
const STUB = "docs/operator-log-hygiene-consumer-pack-stub.md";

describe("operator-log hygiene thin v1 (#1940)", () => {
  it("pattern exists with failure modes, anti-patterns, and non-goals", () => {
    expect(isFile(PATTERN)).toBe(true);
    const text = readText(PATTERN);
    expect(text).toContain("# Operator-log hygiene");
    expect(text).toContain("## Failure modes (case study)");
    expect(text).toContain("Happy-path-only terminals");
    expect(text).toContain("Missing correlation context");
    expect(text).toContain("## Anti-patterns");
    expect(text).toContain("## Explicit non-goals (thin v1)");
    expect(text).toContain("plan.observability");
    expect(text).toContain("Product Insights");
    expect(text).toContain("SLizard");
    expect(text).toMatch(/external reference/i);
    expect(text).toContain("!=MUST, ~=SHOULD");
  });

  it("checklist is copy-paste usable and discoverable from pattern", () => {
    expect(isFile(CHECKLIST)).toBe(true);
    const checklist = readText(CHECKLIST);
    expect(checklist).toContain("Terminal / completion events");
    expect(checklist).toContain("Correlation IDs");
    expect(checklist).toContain("```markdown");
    // Strength markers align with pattern MUST/SHOULD/MAY
    expect(checklist).toMatch(/- \[ \] ! Terminal/);
    expect(checklist).toMatch(/- \[ \] ~ Operator-visible/);
    expect(checklist).toMatch(/- \[ \] \? Optional/);
    const pattern = readText(PATTERN);
    expect(pattern).toContain("operator-log-hygiene-checklist.md");
  });

  it("optional consumer pack stub documents consumer-owned schema", () => {
    expect(isFile(STUB)).toBe(true);
    const text = readText(STUB);
    expect(text).toContain("operator-log:validate");
    expect(text).toContain("Consumer-owned");
    expect(text).toMatch(/does not.*hard-fail|MUST NOT claim framework/i);
  });

  it("REFERENCES.md indexes operator-log discovery keywords", () => {
    // REFERENCES.md is root-resident; resolveContentPath falls back to repo root.
    const text = readText("REFERENCES.md");
    expect(text).toContain("patterns/operator-log-hygiene.md");
    expect(text).toMatch(/operator log/i);
    expect(text).toContain("operator-log-hygiene-checklist.md");
  });
});
