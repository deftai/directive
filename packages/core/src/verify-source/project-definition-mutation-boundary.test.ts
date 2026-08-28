import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluateProjectDefinitionMutationBoundary,
  extractMutationSections,
  formatMutationBoundaryFindings,
  MUTATION_CAPABILITY_MODULE,
  PRODUCTION_MUTATION_INVENTORY,
} from "./project-definition-mutation-boundary.js";

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error("could not locate the workspace root from the test file");
}

describe("PROJECT-DEFINITION mutation boundary (#3796)", () => {
  const verdict = evaluateProjectDefinitionMutationBoundary(repoRoot());

  it("scans the production TypeScript surface", () => {
    expect(verdict.scan.filesScanned).toBeGreaterThan(200);
  });

  it("passes the fail-closed boundary and census gate", () => {
    expect(verdict.errors.join("\n")).toBe("");
    expect(verdict.ok).toBe(true);
  });

  it("finds no raw resolver, lock, or write bypass in production sources", () => {
    expect(formatMutationBoundaryFindings(verdict.scan.findings)).toBe("");
    expect(verdict.scan.findings).toEqual([]);
  });

  it("matches the recorded per-file mutation inventory", () => {
    expect(verdict.scan.inventory).toEqual(PRODUCTION_MUTATION_INVENTORY);
  });

  it("fails closed on a raw lock call added outside the capability", () => {
    const rule = {
      pattern: /\bprojectDefinitionMutationLock\s*\(/,
      allowedFiles: [MUTATION_CAPABILITY_MODULE],
    };
    const offending = "  return projectDefinitionMutationLock(root, () => undefined);";
    expect(rule.pattern.test(offending)).toBe(true);
    expect(rule.allowedFiles).not.toContain("packages/core/src/policy/resolve.ts");
  });
});

describe("mutation-section extraction", () => {
  it("bounds each section at its own closing paren", () => {
    const text = [
      "before();",
      "withProjectDefinitionMutation(root, (m) => {",
      "  m.persist(m.load());",
      "});",
      "after();",
    ].join("\n");
    const sections = extractMutationSections(text);
    expect(sections).toHaveLength(1);
    const [start, end] = sections[0] as [number, number];
    const body = text.slice(start, end);
    expect(body).toContain("m.persist");
    expect(body).not.toContain("after()");
    expect(body).not.toContain("before()");
  });

  it("does not let braces or parens inside literals or comments end a section", () => {
    const text = [
      "withProjectDefinitionMutation(root, (m) => {",
      '  const s = ")";',
      "  // )",
      "  /* ) */",
      "  const t = `)`;",
      "  m.persist(m.load());",
      "});",
      "tail();",
    ].join("\n");
    const sections = extractMutationSections(text);
    expect(sections).toHaveLength(1);
    const [start, end] = sections[0] as [number, number];
    const body = text.slice(start, end);
    expect(body).toContain("m.persist");
    expect(body).not.toContain("tail()");
  });

  it("finds every section in a file with several", () => {
    const text = [
      "withProjectDefinitionMutation(root, (m) => m.load());",
      "withProjectDefinitionMutation(root, (m) => m.load());",
    ].join("\n");
    expect(extractMutationSections(text)).toHaveLength(2);
  });
});
