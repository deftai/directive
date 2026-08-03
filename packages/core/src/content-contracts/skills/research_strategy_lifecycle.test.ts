import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

const researchText = readRepoFile("strategies/research.md");
const setupText = readRepoFile("skills/deft-directive-setup/SKILL.md");

function sectionBetween(
  text: string,
  startNeedle: string,
  endNeedle: string,
  sourceLabel: string,
): string {
  const start = text.indexOf(startNeedle);
  if (start === -1) {
    throw new Error(`Missing ${JSON.stringify(startNeedle)} in ${sourceLabel}.`);
  }
  const end = text.indexOf(endNeedle, start + startNeedle.length);
  if (end === -1) {
    throw new Error(
      `Missing ${JSON.stringify(endNeedle)} after ${JSON.stringify(startNeedle)} in ${sourceLabel}.`,
    );
  }
  return text.slice(start, end);
}

describe("research strategy lifecycle (#1273)", () => {
  const scopeGate = sectionBetween(
    researchText,
    "## Scope Confirmation Gate (#1273)",
    "## Output",
    "strategies/research.md",
  );
  const researchChaining = sectionBetween(
    researchText,
    "## Then: Chaining Gate",
    "! **Standalone context:**",
    "strategies/research.md",
  );
  const setupDispatch = sectionBetween(
    setupText,
    "**Dispatch:**",
    "---",
    "skills/deft-directive-setup/SKILL.md",
  );
  const setupSpecStructure = sectionBetween(
    setupText,
    "**Spec Structure (both paths):**",
    "### Lifecycle Bridge to Downstream Skills",
    "skills/deft-directive-setup/SKILL.md",
  );

  it("requires a blocking scope-confirmation prompt before autonomous research", () => {
    expect(scopeGate).toContain("Before autonomous research begins");
    expect(scopeGate).toContain("blocking scope-confirmation prompt");
    expect(scopeGate).toContain("sample data, artifacts, constraints, or sensitive areas");
    expect(scopeGate).toContain("4. Discuss");
    expect(scopeGate).toContain("5. Back");
    expect(scopeGate.indexOf("4. Discuss")).toBeLessThan(scopeGate.indexOf("5. Back"));
    expect(scopeGate).toContain("Start the survey from project description alone");
    expect(scopeGate).toContain("follow-up free-form question");
    expect(scopeGate).toContain("On option **2**");
    expect(scopeGate).toContain("On option **3**");
    expect(scopeGate).toContain("Confirmed-scope postcondition");
    expect(scopeGate).toContain("free-form answer **is** the confirmation");
    expect(scopeGate).toContain("Leave research blocked after option 2");
    expect(scopeGate).toContain("Leave research blocked after option 3");
  });

  it("blocks spec or scope generation until the post-research chaining gate selection", () => {
    expect(researchChaining).toContain("blocking question");
    expect(researchChaining).toContain(
      "before any spec generation or additional scope vBRIEF generation",
    );
    expect(researchChaining).toContain("completedStrategies");
    expect(researchChaining).toContain("planning artifact in the scope lifecycle");
    expect(researchChaining).toContain("Generate implementation scope vBRIEFs directly");
  });

  it("setup dispatch preserves research strategy ownership instead of falling through", () => {
    expect(setupDispatch).toContain("For `research`");
    expect(setupDispatch).toContain("Scope Confirmation Gate (#1273)");
    expect(setupDispatch).toContain("Then: Chaining Gate");
    expect(setupDispatch).toContain("do NOT create scope xBRIEFs from research output");
    expect(setupDispatch).toContain("fall through to the interview output path");
  });

  it("setup requires machine-readable dependency ordering for generated scope batches", () => {
    expect(setupSpecStructure).toContain("plan.metadata.dependencies");
    expect(setupSpecStructure).toContain("plan.metadata.swarm.depends_on");
    expect(setupSpecStructure).toContain("Story-shaped scopes");
    expect(setupSpecStructure).toContain("**only** this field");
    expect(setupSpecStructure).toContain("When multiple scopes are produced");
    expect(setupSpecStructure).toContain("machine-readable dependency ordering");
    expect(setupSpecStructure).toContain(
      "only `plan.metadata.dependencies` / `edges` / `references`",
    );
    expect(setupSpecStructure).toContain("resolvable story identifiers");
    expect(setupSpecStructure).toContain("filename stem");
    expect(setupSpecStructure).toContain("plan.id");
    expect(setupSpecStructure).toContain("do not resolve");
  });
});
