import { describe, expect, it } from "vitest";
import { defaultTestBoundaryPolicy, type TestBoundaryPolicy } from "../test-boundary/policy.js";
import {
  contentMarksTestOnly,
  evaluateClassChecks,
  parseClassChecksFromProjectDefinition,
  scanTestIdentityInInfra,
} from "./evaluate.js";
import { defaultClassChecksPolicy } from "./policy.js";

function baseTb(overrides: Partial<TestBoundaryPolicy> = {}): TestBoundaryPolicy {
  return {
    ...defaultTestBoundaryPolicy("warn"),
    allow: [],
    source: "defaults",
    ...overrides,
  };
}

describe("scanTestIdentityInInfra (#4980 class 3)", () => {
  it("flags smoke-test identity in bicep", () => {
    const content = `
resource smokeId 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'smoke-test-identity'
}
`;
    const finding = scanTestIdentityInInfra("infra/main.bicep", content, [
      "smoke",
      "test",
      "fixture",
    ]);
    expect(finding).not.toBeNull();
    expect(finding?.kind).toBe("test-identity-in-infra");
  });

  it("does not flag production canary name without identity keyword (class 3)", () => {
    const content = `
resource canaryApi 'Microsoft.Web/sites@2022-09-01' = {
  name: 'canary-api'
}
`;
    expect(
      scanTestIdentityInInfra("infra/main.bicep", content, ["smoke", "test", "canary"]),
    ).toBeNull();
  });

  it("still flags smoke-test-identity via resource/decl match", () => {
    const content = "name: 'smoke-test-identity'\n";
    expect(scanTestIdentityInInfra("infra/main.bicep", content, ["smoke", "test"])).not.toBeNull();
  });

  it("ignores production identity names without markers", () => {
    const content = `
resource appId 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'app-prod-identity'
}
`;
    expect(scanTestIdentityInInfra("infra/main.bicep", content, ["smoke", "test"])).toBeNull();
  });

  it("does not reject production identity when an unrelated marker is nearby", () => {
    const content = `
resource appId 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'app-prod-identity'
  tags: {
    stage: 'canary'
    purpose: 'smoke rollout'
  }
}
// adjacent comment mentions test fixtures for docs only
`;
    expect(
      scanTestIdentityInInfra("infra/main.bicep", content, ["smoke", "test", "canary"]),
    ).toBeNull();
  });

  it("does not treat a resource label marker as a bound test identity", () => {
    const content = `
resource "azurerm_user_assigned_identity" "test" {
  name = "app-prod-identity"
}
`;
    expect(
      scanTestIdentityInInfra("infra/main.tf", content, ["smoke", "test", "canary"]),
    ).toBeNull();
  });
});

describe("evaluateClassChecks (#4980)", () => {
  const classPolicy = defaultClassChecksPolicy();

  it("fails class 1: test artifact under production root", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: ["infra/scripts/test_release.py", "src/app.py"],
      baseTestBoundaryPolicy: baseTb({
        sourceRoots: ["src/**", "infra/**"],
        testRoots: ["tests/**"],
      }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([
        ["infra/scripts/test_release.py", "print('hi')\n"],
        ["src/app.py", "x = 1\n"],
      ]),
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "test-under-source-root")).toBe(true);
    expect(result.message).not.toMatch(/scope:record-approved-scope/);
    expect(result.message).toMatch(/Move or remove/);
  });

  it("fails class 2: production reference to test root", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: ["infra/deploy.sh"],
      baseTestBoundaryPolicy: baseTb({
        sourceRoots: ["infra/**"],
        testRoots: ["tests/**"],
        fixtureRoots: ["tests/fixtures/**"],
      }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([["infra/deploy.sh", "cp tests/fixtures/seed.json /tmp/\n"]]),
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "production-references-test-root")).toBe(true);
  });

  it("fails class 3: test identity in infra", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: ["infra/main.bicep"],
      baseTestBoundaryPolicy: baseTb({ sourceRoots: ["infra/**"], testRoots: ["tests/**"] }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([
        [
          "infra/main.bicep",
          "resource id 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = { name: 'smoke-test-identity' }\n",
        ],
      ]),
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "test-identity-in-infra")).toBe(true);
  });

  it("fails class 4 when a story change set touches a protected glob", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: [".githooks/pre-commit", "src/feature.ts"],
      baseTestBoundaryPolicy: baseTb({ sourceRoots: ["src/**"], testRoots: ["tests/**"] }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([
        [".githooks/pre-commit", "#!/bin/sh\n"],
        ["src/feature.ts", "export const x = 1;\n"],
      ]),
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "protected-glob")).toBe(true);
    expect(result.findings.some((f) => f.path === ".githooks/pre-commit")).toBe(true);
  });

  it("allows a pure protected-glob landing (own diff, no story product)", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: [
        "packages/core/src/class-checks/policy.ts",
        "CHANGELOG.md",
        "content/docs/scope-provenance.md",
      ],
      baseTestBoundaryPolicy: baseTb({
        sourceRoots: ["src/**", "packages/*/src/**"],
        testRoots: ["tests/**", "packages/*/src/**/*.test.*"],
      }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([
        ["packages/core/src/class-checks/policy.ts", "export {}\n"],
        ["CHANGELOG.md", "## Unreleased\n"],
        ["content/docs/scope-provenance.md", "# docs\n"],
      ]),
    });
    expect(result.exitCode).toBe(0);
    expect(result.findings.filter((f) => f.kind === "protected-glob")).toHaveLength(0);
  });

  it("exempts test-root paths and CHANGELOG.md", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: ["tests/unit/test_ok.py", "CHANGELOG.md"],
      baseTestBoundaryPolicy: baseTb({
        sourceRoots: ["src/**", "infra/**"],
        testRoots: ["tests/**"],
      }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([
        ["tests/unit/test_ok.py", "def test_ok(): pass\n"],
        ["CHANGELOG.md", "- note\n"],
      ]),
    });
    expect(result.exitCode).toBe(0);
  });

  it("ignores pre-existing tree violations not in the change set", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: ["src/app.py"],
      baseTestBoundaryPolicy: baseTb({
        sourceRoots: ["src/**", "infra/**"],
        testRoots: ["tests/**"],
      }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([["src/app.py", "x = 1\n"]]),
    });
    expect(result.exitCode).toBe(0);
  });

  it("fails same-PR allow that would clear a class-1 hit", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: ["infra/scripts/test_release.py", ".deft/test-boundary.policy.json"],
      baseTestBoundaryPolicy: baseTb({
        sourceRoots: ["infra/**"],
        testRoots: ["tests/**"],
        allow: [],
      }),
      headTestBoundaryPolicy: baseTb({
        sourceRoots: ["infra/**"],
        testRoots: ["tests/**"],
        allow: [{ path: "infra/scripts/test_release.py", kind: "exception" }],
        enforcementMode: "enforce",
        source: "file",
      }),
      classChecksPolicy: classPolicy,
      policyEditPath: ".deft/test-boundary.policy.json",
      fileContents: new Map([
        ["infra/scripts/test_release.py", "print(1)\n"],
        [".deft/test-boundary.policy.json", "{}\n"],
      ]),
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "same-pr-policy-edit")).toBe(true);
    expect(result.findings.some((f) => f.path === ".deft/test-boundary.policy.json")).toBe(true);
  });

  it("fails class 1 when content marks a neutral-named file as test-only", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: ["src/helpers/seed_data.ts"],
      baseTestBoundaryPolicy: baseTb({ sourceRoots: ["src/**"], testRoots: ["tests/**"] }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([
        [
          "src/helpers/seed_data.ts",
          "describe('seed', () => {\n  it('loads', () => {\n    expect(1).toBe(1);\n  });\n});\n",
        ],
      ]),
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "test-under-source-root")).toBe(true);
  });

  it("treats pipeline ancestor dirs as deploy infra for class 2/3", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: ["ci/pipelines/prod.json"],
      baseTestBoundaryPolicy: baseTb({
        sourceRoots: ["src/**"],
        testRoots: ["tests/**"],
        fixtureRoots: ["tests/fixtures/**"],
      }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([
        ["ci/pipelines/prod.json", '{ "seed": "tests/fixtures/seed.json" }\n'],
      ]),
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "production-references-test-root")).toBe(true);
  });

  it("fails closed on malformed merge-base PROJECT-DEFINITION classChecks", () => {
    const badJson = parseClassChecksFromProjectDefinition("{ not json");
    expect(badJson.ok).toBe(false);
    if (!badJson.ok) expect(badJson.message).toMatch(/not valid JSON/);
    const badShape = parseClassChecksFromProjectDefinition(
      JSON.stringify({ plan: { policy: { classChecks: ["nope"] } } }),
    );
    expect(badShape.ok).toBe(false);
    if (!badShape.ok) expect(badShape.message).toMatch(/must be a JSON object/);
    const missing = parseClassChecksFromProjectDefinition(JSON.stringify({ plan: { policy: {} } }));
    expect(missing).toEqual({ ok: true, policy: null });
    expect(contentMarksTestOnly("export const x = 1;\n")).toBe(false);
    expect(
      contentMarksTestOnly("describe('x', () => { it('y', () => { expect(1).toBe(1); }); });\n"),
    ).toBe(true);
  });

  it("skips class 2 content scan on protected verifier paths", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: ["packages/core/src/test-boundary/evaluate.ts"],
      baseTestBoundaryPolicy: baseTb({
        sourceRoots: ["packages/*/src/**", "src/**"],
        testRoots: ["tests/**"],
      }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([
        [
          "packages/core/src/test-boundary/evaluate.ts",
          'const example = "tests/fixtures/seed.json";\n',
        ],
      ]),
    });
    expect(
      result.findings.filter((f) => f.kind === "production-references-test-root"),
    ).toHaveLength(0);
  });

  it("does not honor working-tree warn mode; still fails closed", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: ["infra/scripts/test_release.py"],
      baseTestBoundaryPolicy: baseTb({
        sourceRoots: ["infra/**"],
        testRoots: ["tests/**"],
        enforcementMode: "warn",
      }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([["infra/scripts/test_release.py", "print(1)\n"]]),
    });
    expect(result.exitCode).toBe(1);
  });
});
