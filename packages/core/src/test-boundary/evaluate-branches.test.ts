/**
 * Branch coverage for test-boundary evaluate helpers (#3185 coverage-debt hairline).
 */
import { describe, expect, it } from "vitest";
import {
  evaluateTestBoundary,
  isRecognizedTestBasename,
  matchesRootGlob,
  matchesTestFilePattern,
  matchPolicyGlob,
} from "./evaluate.js";
import { defaultTestBoundaryPolicy, type TestBoundaryPolicy } from "./policy.js";

function policy(overrides: Partial<TestBoundaryPolicy> = {}): TestBoundaryPolicy {
  return {
    ...defaultTestBoundaryPolicy("enforce"),
    allow: [],
    source: "file",
    ...overrides,
    enforcementMode: overrides.enforcementMode ?? "enforce",
  };
}

describe("matchPolicyGlob / matchesRootGlob branches (#3185)", () => {
  it("handles ?, escaped regex chars, and trailing **", () => {
    expect(matchPolicyGlob("src/a.ts", "src/?.ts")).toBe(true);
    expect(matchPolicyGlob("src/ab.ts", "src/?.ts")).toBe(false);
    expect(matchPolicyGlob("src/foo+bar.ts", "src/foo+bar.ts")).toBe(true);
    expect(matchPolicyGlob("deep/nested/x", "deep/**")).toBe(true);
    expect(matchPolicyGlob("x", "**")).toBe(true);
  });

  it("matches packages/*/src/** ancestor prefixes", () => {
    expect(matchesRootGlob("packages/core/src/foo.ts", "packages/*/src/**")).toBe(true);
    expect(matchesRootGlob("packages/core", "packages/*/src/**")).toBe(false);
    expect(matchesRootGlob("src", "src/**")).toBe(true);
    expect(matchesRootGlob("other/file.ts", "src/**")).toBe(false);
    expect(matchesRootGlob("cmd/x_test.go", "**/*_test.go")).toBe(true);
  });

  it("matchesTestFilePattern checks full path and basename", () => {
    expect(matchesTestFilePattern("lib/foo_test.go", ["**/*_test.go"])).toBe(true);
    expect(matchesTestFilePattern("lib/foo.go", ["**/*_test.go"])).toBe(false);
    expect(matchesTestFilePattern("a/b/test_x.py", ["**/test_*.py"])).toBe(true);
  });

  it("recognises Go _test.go and rejects non-tests", () => {
    expect(isRecognizedTestBasename("pkg/foo_test.go")).toBe(true);
    expect(isRecognizedTestBasename("pkg/foo.go")).toBe(false);
    expect(isRecognizedTestBasename("src/foo.test.js")).toBe(true);
    expect(isRecognizedTestBasename("src/foo.spec.jsx")).toBe(true);
  });
});

describe("evaluateTestBoundary edge branches (#3185)", () => {
  it("returns config error when injected policyPath is missing", () => {
    const result = evaluateTestBoundary("/tmp/tb-missing", {
      policyPath: "/tmp/does-not-exist-tb-policy-3185.json",
      files: [],
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/policy load failed/i);
  });

  it("honors enforce override to warn mode", () => {
    const result = evaluateTestBoundary("/tmp/tb-warn", {
      policy: policy({
        sourceRoots: ["src/**"],
        testRoots: ["tests/**"],
        enforcementMode: "enforce",
      }),
      enforce: false,
      files: ["src/foo.test.ts"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.findings).toHaveLength(1);
    expect(result.message).toMatch(/WARN/i);
  });

  it("honors enforce override to enforce mode", () => {
    const result = evaluateTestBoundary("/tmp/tb-enforce", {
      policy: policy({
        sourceRoots: ["src/**"],
        testRoots: ["tests/**"],
        enforcementMode: "warn",
      }),
      enforce: true,
      files: ["src/foo.test.ts"],
    });
    expect(result.exitCode).toBe(1);
  });

  it("skips allowlisted test files under source roots", () => {
    const result = evaluateTestBoundary("/tmp/tb-allow", {
      policy: policy({
        sourceRoots: ["src/**"],
        testRoots: ["tests/**"],
        allow: [{ path: "src/**/*.test.ts", kind: "exception" }],
      }),
      files: ["src/foo.test.ts", "src/bar.ts"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("skips production reference scan when productionMayReferenceTestRoots is true", () => {
    const contents = new Map([["src/app.ts", 'import x from "tests/fixtures/data.json";\n']]);
    const result = evaluateTestBoundary("/tmp/tb-ref-ok", {
      policy: policy({
        sourceRoots: ["src/**"],
        testRoots: ["tests/**"],
        fixtureRoots: ["tests/fixtures/**"],
        productionMayReferenceTestRoots: true,
      }),
      files: ["src/app.ts"],
      fileContents: contents,
    });
    expect(result.exitCode).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("skips binary-ish paths and missing content map entries in reference scan", () => {
    const contents = new Map<string, string>([["src/app.ts", "ok"]]);
    const result = evaluateTestBoundary("/tmp/tb-bin", {
      policy: policy({
        sourceRoots: ["src/**"],
        testRoots: ["tests/**"],
        productionMayReferenceTestRoots: false,
      }),
      files: ["src/logo.png", "src/missing.ts", "src/app.ts"],
      fileContents: contents,
    });
    expect(result.exitCode).toBe(0);
  });

  it("flags production reference to tests/ fixtures path", () => {
    const contents = new Map([
      ["src/deploy.ts", 'const path = "tests/fixtures/seed.json";\nexport {}\n'],
    ]);
    const result = evaluateTestBoundary("/tmp/tb-ref", {
      policy: policy({
        sourceRoots: ["src/**"],
        testRoots: ["tests/**"],
        fixtureRoots: ["tests/fixtures/**"],
      }),
      files: ["src/deploy.ts"],
      fileContents: contents,
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "production-references-test-root")).toBe(true);
  });

  it("scans deploy-shaped paths outside sourceRoots for test refs", () => {
    const contents = new Map([[".github/workflows/ci.yml", 'path: "tests/unit/setup"\n']]);
    const result = evaluateTestBoundary("/tmp/tb-gh", {
      policy: policy({
        sourceRoots: ["src/**"],
        testRoots: ["tests/**"],
      }),
      files: [".github/workflows/ci.yml"],
      fileContents: contents,
    });
    expect(result.findings.some((f) => f.kind === "production-references-test-root")).toBe(true);
  });

  it("truncates long diagnostic lists in warn mode", () => {
    const files = Array.from({ length: 20 }, (_, i) => `src/f${i}.test.ts`);
    const result = evaluateTestBoundary("/tmp/tb-trunc", {
      policy: policy({
        sourceRoots: ["src/**"],
        testRoots: ["tests/**"],
        enforcementMode: "warn",
      }),
      files,
    });
    expect(result.exitCode).toBe(0);
    expect(result.findings).toHaveLength(20);
    expect(result.message).toMatch(/and \d+ more/i);
  });

  it("does not flag test files under declared test roots", () => {
    const result = evaluateTestBoundary("/tmp/tb-ok", {
      policy: policy({
        sourceRoots: ["src/**"],
        testRoots: ["tests/**", "packages/*/src/**/*.test.ts"],
      }),
      files: ["tests/unit/a.test.ts", "packages/core/src/a.test.ts", "src/prod.ts"],
    });
    // packages/*/src/**/*.test.ts is a test root so colocated under packages is fine
    expect(result.findings.filter((f) => f.kind === "test-under-source-root")).toHaveLength(0);
  });
});
