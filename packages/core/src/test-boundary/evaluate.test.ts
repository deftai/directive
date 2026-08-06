import { describe, expect, it } from "vitest";
import {
  evaluateTestBoundary,
  isRecognizedTestBasename,
  matchesRootGlob,
  matchesTestFilePattern,
  matchPolicyGlob,
} from "./evaluate.js";
import {
  defaultTestBoundaryPolicy,
  loadTestBoundaryPolicy,
  type TestBoundaryPolicy,
} from "./policy.js";

function enforcePolicy(overrides: Partial<TestBoundaryPolicy> = {}): TestBoundaryPolicy {
  return {
    ...defaultTestBoundaryPolicy("enforce"),
    allow: [],
    source: "file",
    ...overrides,
    enforcementMode: "enforce",
  };
}

describe("test-boundary helpers (#3145)", () => {
  it("recognises Python, C#, and TS/JS test basenames", () => {
    expect(isRecognizedTestBasename("infra/scripts/test_release.py")).toBe(true);
    expect(isRecognizedTestBasename("src/FooTests.cs")).toBe(true);
    expect(isRecognizedTestBasename("src/FooTest.cs")).toBe(true);
    expect(isRecognizedTestBasename("src/foo.test.ts")).toBe(true);
    expect(isRecognizedTestBasename("src/foo.spec.tsx")).toBe(true);
    expect(isRecognizedTestBasename("src/foo.ts")).toBe(false);
  });

  it("matches source and test root globs", () => {
    expect(matchesRootGlob("src/app.ts", "src/**")).toBe(true);
    expect(matchesRootGlob("infra/scripts/x.py", "infra/**")).toBe(true);
    expect(matchesRootGlob("tests/unit/a.py", "tests/**")).toBe(true);
    expect(matchesRootGlob("docs/a.md", "src/**")).toBe(false);
  });

  it("matches nested colocated test globs with **", () => {
    expect(
      matchPolicyGlob("packages/cli/src/agents-refresh.test.ts", "packages/*/src/**/*.test.ts"),
    ).toBe(true);
    expect(
      matchPolicyGlob(
        "packages/cli/src/cli-router/route-argv.test.ts",
        "packages/*/src/**/*.test.ts",
      ),
    ).toBe(true);
    expect(matchesRootGlob("packages/core/src/foo/bar.test.ts", "packages/*/src/**")).toBe(true);
  });

  it("matches configured test file patterns", () => {
    const patterns = ["**/test_*.py", "**/*Tests.cs", "**/*.test.ts", "**/*.spec.ts"];
    expect(matchesTestFilePattern("infra/scripts/test_release.py", patterns)).toBe(true);
    expect(matchesTestFilePattern("Tools/SmokeTests.cs", patterns)).toBe(true);
    expect(matchesTestFilePattern("src/a.test.ts", patterns)).toBe(true);
    expect(matchesTestFilePattern("src/a.ts", patterns)).toBe(false);
  });
});

describe("evaluateTestBoundary (#3145)", () => {
  it("rejects Python test_*.py under production roots", () => {
    const result = evaluateTestBoundary("/tmp/proj", {
      policy: enforcePolicy({ sourceRoots: ["src/**", "infra/**"], testRoots: ["tests/**"] }),
      files: ["infra/scripts/test_release.py", "src/app.py", "tests/test_ok.py"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.path === "infra/scripts/test_release.py")).toBe(true);
    expect(result.findings.some((f) => f.path === "tests/test_ok.py")).toBe(false);
    expect(result.message).toMatch(/remediation/i);
  });

  it("rejects C# *Tests.cs under production roots", () => {
    const result = evaluateTestBoundary("/tmp/proj", {
      policy: enforcePolicy({ sourceRoots: ["Tools/**", "src/**"], testRoots: ["tests/**"] }),
      files: ["Tools/SmokeEvidenceTests.cs", "src/App.cs"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.path).toBe("Tools/SmokeEvidenceTests.cs");
    expect(result.findings[0]?.kind).toBe("test-under-source-root");
  });

  it("rejects TypeScript *.test.* / *.spec.* under production roots", () => {
    const result = evaluateTestBoundary("/tmp/proj", {
      policy: enforcePolicy({
        sourceRoots: ["src/**"],
        testRoots: ["tests/**", "**/__tests__/**"],
      }),
      files: ["src/feature.test.ts", "src/feature.spec.ts", "src/feature.ts"],
    });
    expect(result.exitCode).toBe(1);
    const paths = result.findings.map((f) => f.path).sort();
    expect(paths).toEqual(["src/feature.spec.ts", "src/feature.test.ts"]);
  });

  it("rejects production references to test/fixture roots", () => {
    const contents = new Map<string, string>([
      ["infra/deploy.sh", "#!/bin/sh\ncat tests/fixtures/release-cases.csv\n"],
      ["src/app.ts", "export const x = 1;\n"],
    ]);
    const result = evaluateTestBoundary("/tmp/proj", {
      policy: enforcePolicy({
        sourceRoots: ["src/**", "infra/**"],
        testRoots: ["tests/**"],
        fixtureRoots: ["tests/fixtures/**"],
        productionMayReferenceTestRoots: false,
      }),
      files: ["infra/deploy.sh", "src/app.ts", "tests/fixtures/release-cases.csv"],
      fileContents: contents,
    });
    expect(result.exitCode).toBe(1);
    expect(
      result.findings.some(
        (f) => f.path === "infra/deploy.sh" && f.kind === "production-references-test-root",
      ),
    ).toBe(true);
  });

  it("allows production-liveness classification and explicit exceptions", () => {
    const result = evaluateTestBoundary("/tmp/proj", {
      policy: enforcePolicy({
        sourceRoots: ["src/**", "infra/**"],
        testRoots: ["tests/**"],
        allow: [
          {
            path: "infra/scripts/test_liveness.py",
            kind: "production-liveness",
            reason: "prod health probe",
          },
        ],
      }),
      files: ["infra/scripts/test_liveness.py", "src/app.py"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("warn mode returns exit 0 with findings (migration path)", () => {
    const result = evaluateTestBoundary("/tmp/proj", {
      policy: {
        ...enforcePolicy({ sourceRoots: ["infra/**"], testRoots: ["tests/**"] }),
        enforcementMode: "warn",
      },
      files: ["infra/scripts/test_release.py"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.findings).toHaveLength(1);
    expect(result.message).toMatch(/WARN/i);
  });

  it("default inferred policy is warn-only", () => {
    const p = defaultTestBoundaryPolicy();
    expect(p.enforcementMode).toBe("warn");
    expect(p.source).toBe("defaults");
  });

  it("loadTestBoundaryPolicy returns defaults when no config present", () => {
    const p = loadTestBoundaryPolicy("/nonexistent-project-root-3145");
    expect(p.source).toBe("defaults");
    expect(p.enforcementMode).toBe("warn");
  });

  it("enforce override flips warn policy to fail closed", () => {
    const result = evaluateTestBoundary("/tmp/proj", {
      policy: {
        ...enforcePolicy({ sourceRoots: ["infra/**"], testRoots: ["tests/**"] }),
        enforcementMode: "warn",
      },
      files: ["infra/scripts/test_release.py"],
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
  });

  it("policy load failure returns config exit 2", () => {
    const result = evaluateTestBoundary("/tmp/proj", {
      policyPath: "/no/such/policy-3145.json",
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/policy load failed/i);
  });

  it("does not flag tests under declared test roots", () => {
    const result = evaluateTestBoundary("/tmp/proj", {
      policy: enforcePolicy({ sourceRoots: ["src/**"], testRoots: ["tests/**"] }),
      files: ["tests/test_ok.py", "src/app.py"],
    });
    expect(result.exitCode).toBe(0);
  });

  it("skips binary extensions in production-reference scan", () => {
    const contents = new Map<string, string>([
      ["infra/logo.png", "tests/fixtures/x"],
      ["infra/app.ts", "export const x = 1;\n"],
    ]);
    const result = evaluateTestBoundary("/tmp/proj", {
      policy: enforcePolicy({
        sourceRoots: ["infra/**"],
        testRoots: ["tests/**"],
        fixtureRoots: ["tests/fixtures/**"],
      }),
      files: ["infra/logo.png", "infra/app.ts"],
      fileContents: contents,
    });
    expect(result.findings.every((f) => f.path !== "infra/logo.png")).toBe(true);
  });
});
