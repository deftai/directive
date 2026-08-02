/**
 * Content contracts for setup skill Revisit experimental rules (#46).
 */
import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

const SETUP_SKILL = "skills/deft-directive-setup/SKILL.md";

describe("setup revisit experimental rules (#46)", () => {
  const text = readRepoFile(SETUP_SKILL);

  it("documents Returning-user re-entry with Revisit experimental rules", () => {
    expect(text).toContain("### Returning-user re-entry (#46)");
    expect(text).toContain("## Revisit experimental rules (#46)");
    expect(text).toContain("**Revisit experimental rules**");
  });

  it("lists experimental-meta triggers in When to Use", () => {
    expect(text).toContain("revisit experimental rules");
    expect(text).toContain("toggle experimental meta");
  });

  it("shows current state and reuses Phase 1 5a–5c explainers", () => {
    expect(text).toContain("current state");
    expect(text).toContain("5a–5c");
    expect(text).toContain("meta/SOUL.md");
    expect(text).toContain("meta/morals.md");
    expect(text).toContain("meta/code-field.md");
  });

  it("requires non-clobber of Personal and Defaults on toggle", () => {
    expect(text).toContain("byte-identical");
    expect(text).toContain("Personal");
    expect(text).toContain("Defaults");
    expect(text).toContain("UTF-8");
  });

  it("forbids inventing a deft config verb family for this slice", () => {
    expect(text).toContain("deft config");
    expect(text).toMatch(/⊗ Invent.*deft config|setup skill re-entry is the product surface/i);
  });

  it("points at applyExperimentalRulesState helper", () => {
    expect(text).toContain("applyExperimentalRulesState");
    expect(text).toContain("experimental-rules.ts");
  });

  it("keeps revisit section before Phase 2", () => {
    const revisit = text.indexOf("## Revisit experimental rules (#46)");
    const phase2 = text.indexOf("## Phase 2 — Project Configuration");
    expect(revisit).toBeGreaterThan(0);
    expect(phase2).toBeGreaterThan(revisit);
  });
});
