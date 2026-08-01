import { describe, expect, it } from "vitest";
import { isFile, readText } from "./_helpers.js";

const CODING = "coding/coding.md";
const PATTERN = "patterns/in-band-signaling.md";

describe("in-band signaling / absence is not a decision (#1695)", () => {
  it("coding.md carries the State & Data Modeling block", () => {
    const text = readText(CODING);
    expect(text).toContain("**State & Data Modeling (#1695):**");
    expect(text).toContain("in-band signaling");
    expect(text).toContain("Absence is not a decision");
    expect(text).toMatch(/^- ! /m);
    expect(text).toContain("⊗");
    expect(text).toContain("../patterns/in-band-signaling.md");
  });

  it("patterns/in-band-signaling.md exists with required sections", () => {
    expect(isFile(PATTERN)).toBe(true);
    const text = readText(PATTERN);
    expect(text).toContain("# No in-band signaling / absence is not a decision (#1695)");
    expect(text).toContain("!=MUST, ~=SHOULD");
    expect(text).toContain("## The pattern");
    expect(text).toContain("## The orthogonality test");
    expect(text).toContain("## Three kinds of provenance in directive");
    expect(text).toContain("## Canonical worked example — wipCap onboarding (#1694)");
    expect(text).toContain("x-directive/onboarding");
    expect(text).toContain("decision-provenance");
  });
});
