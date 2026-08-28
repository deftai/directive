import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractMutationSections,
  formatMutationBoundaryFindings,
  MUTATION_CAPABILITY_MODULE,
  PARITY_HARNESS_CALL_EXPRESSIONS,
  PREVIOUSLY_LOCKED_CORE_CALL_EXPRESSIONS,
  PREVIOUSLY_LOCKED_CORE_FILES,
  PREVIOUSLY_UNLOCKED_CLI_WRITERS,
  PRODUCTION_MUTATION_INVENTORY,
  scanProjectDefinitionMutationBoundary,
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
  const scan = scanProjectDefinitionMutationBoundary(repoRoot());

  it("scans the production TypeScript surface", () => {
    expect(scan.filesScanned).toBeGreaterThan(200);
  });

  it("finds no raw resolver, lock, or write bypass in production sources", () => {
    expect(formatMutationBoundaryFindings(scan.findings)).toBe("");
    expect(scan.findings).toEqual([]);
  });

  it("matches the recorded per-file mutation inventory", () => {
    expect(scan.inventory).toEqual(PRODUCTION_MUTATION_INVENTORY);
  });

  it("accounts for every call expression in the #3796 census", () => {
    const total = Object.values(scan.inventory).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(
      PREVIOUSLY_LOCKED_CORE_CALL_EXPRESSIONS +
        PREVIOUSLY_UNLOCKED_CLI_WRITERS +
        PARITY_HARNESS_CALL_EXPRESSIONS,
    );

    const cliCalls = Object.entries(scan.inventory)
      .filter(([path]) => path.startsWith("packages/cli/"))
      .reduce((sum, [, n]) => sum + n, 0);
    expect(cliCalls).toBe(PREVIOUSLY_UNLOCKED_CLI_WRITERS);

    const coreFiles = Object.keys(scan.inventory).filter(
      (path) => path.startsWith("packages/core/") && !path.includes("parity-scenarios"),
    );
    expect(coreFiles).toHaveLength(PREVIOUSLY_LOCKED_CORE_FILES);
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
