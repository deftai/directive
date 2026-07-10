import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

describe("consumer-first onboarding (#1813)", () => {
  it("QUICK-START opens with consumer detect-project-state, not a contributor fork", () => {
    const text = readText("QUICK-START.md");
    expect(text).toContain("## Step 1 — Detect project state");
    expect(text).not.toContain("## Step 1 — Who are you?");
    expect(text).not.toContain(
      "Are you (1) using deft in your project, or (2) working on deft itself?",
    );
  });

  it("QUICK-START carries a non-blocking contributor pointer", () => {
    const text = readText("QUICK-START.md");
    expect(text).toContain("Contributor pointer (non-blocking)");
    expect(text).toContain("CONTRIBUTING.md");
    expect(text).toContain("--maintainer");
  });

  it("deft-directive-setup skill defaults to consumer-first flow", () => {
    const text = readText("skills/deft-directive-setup/SKILL.md");
    expect(text).toContain("## Consumer-first default (#1813)");
    expect(text).toContain("do NOT open with a contributor-vs-consumer fork");
    expect(text).toContain("## Contributor / framework-maintainer path (secondary)");
    expect(text).toContain("--maintainer");
  });
});
