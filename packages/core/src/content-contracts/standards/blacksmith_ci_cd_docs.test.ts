/**
 * Content contracts for optional Blacksmith CI/CD migration docs (#448).
 */
import { describe, expect, it } from "vitest";
import { isDir, isFile, readText } from "./_helpers.js";

describe("blacksmith ci-cd docs (#448)", () => {
  it("ci-cd layer and blacksmith module paths exist", () => {
    expect(isDir("ci-cd")).toBe(true);
    expect(isFile("ci-cd/README.md")).toBe(true);
    expect(isFile("ci-cd/blacksmith/README.md")).toBe(true);
    expect(isFile("ci-cd/blacksmith/overview.md")).toBe(true);
    expect(isFile("ci-cd/blacksmith/runner-tiers.md")).toBe(true);
    expect(isFile("ci-cd/blacksmith/migration-prompt.md")).toBe(true);
    expect(isFile("ci-cd/blacksmith/examples/lint-vs-test-split.md")).toBe(true);
  });

  it("runner-tiers documents 4 / 8 / 32 decision rules", () => {
    const text = readText("ci-cd/blacksmith/runner-tiers.md");
    for (const tok of [
      "blacksmith-4vcpu-ubuntu-2404",
      "blacksmith-8vcpu-ubuntu-2404",
      "blacksmith-32vcpu-ubuntu-2404",
      "task check",
      "semgrep",
      "Split monolithic",
    ]) {
      expect(text, `runner-tiers missing ${tok}`).toContain(tok);
    }
  });

  it("migration-prompt is agent drop-in with tiers and leave-alone rules", () => {
    const text = readText("ci-cd/blacksmith/migration-prompt.md");
    for (const tok of [
      "ubuntu-latest",
      "macos-",
      "windows-",
      "blacksmith-4vcpu-ubuntu-2404",
      "blacksmith-32vcpu-ubuntu-2404",
      ".github/workflows/",
    ]) {
      expect(text, `migration-prompt missing ${tok}`).toContain(tok);
    }
  });

  it("ci-cd README frames optional layer parallel to deployments", () => {
    const text = readText("ci-cd/README.md");
    expect(text).toMatch(/optional/i);
    expect(text).toContain("deployments/");
    expect(text).toContain("blacksmith/");
    expect(text).toMatch(/AGENTS\.md/);
  });

  it("deployments README cross-links ci-cd", () => {
    const text = readText("deployments/README.md");
    expect(text).toContain("ci-cd/");
  });

  it("REFERENCES task-based loading includes Blacksmith CI paths", () => {
    // REFERENCES.md is root-resident; resolveContentPath falls back to repo root.
    const text = readText("REFERENCES.md");
    expect(text).toContain("When Migrating CI Runners");
    expect(text).toContain("ci-cd/blacksmith/runner-tiers.md");
    expect(text).toContain("ci-cd/blacksmith/migration-prompt.md");
  });
});
