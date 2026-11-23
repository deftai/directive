import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAgentHookDeposit } from "../init-deposit/agent-hooks.js";
import { classifyExtraPath } from "../scope-provenance/extra-path-admission.js";
import { evaluateTestBoundary } from "../test-boundary/evaluate.js";
import {
  DEFAULT_TEST_ROOTS,
  defaultTestBoundaryPolicy,
  type TestBoundaryPolicy,
} from "../test-boundary/policy.js";
import {
  type ClassCheckOptions,
  contentMarksTestOnly,
  evaluateClassChecks,
  parseClassChecksFromProjectDefinition,
  scanTestIdentityInInfra,
} from "./evaluate.js";
import { DEFAULT_PROTECTED_GLOBS, defaultClassChecksPolicy } from "./policy.js";

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
    expect(result.message).toMatch(/Move the path under a test root, or declare it/);
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

  it("does not fail a first PR solely because the ceiling artifact is unprotected (#5079)", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: [".deft/presentation-ceiling.json", "src/View.tsx"],
      baseTestBoundaryPolicy: baseTb({ sourceRoots: ["src/**"], testRoots: ["tests/**"] }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([
        [".deft/presentation-ceiling.json", '{"schema":"deft.presentation-ceiling.v1"}\n'],
        ["src/View.tsx", "export const View = () => null;\n"],
      ]),
    });
    expect(result.findings.some((f) => f.kind === "protected-glob")).toBe(false);
    expect(result.findings.some((f) => f.path === ".deft/presentation-ceiling.json")).toBe(false);
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

  it("allows protected + exact composition-registration companions", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: [
        "packages/core/src/class-checks/evaluate.ts",
        "packages/core/src/check/gate-lists.ts",
        "packages/runtime/src/dispatch.ts",
        "packages/core/src/consumer-check-contract/evaluate.ts",
        "packages/core/src/evaluator-surface/evaluate.ts",
        "packages/core/src/check/named-cause.ts",
      ],
      baseTestBoundaryPolicy: baseTb({
        sourceRoots: ["packages/*/src/**"],
        testRoots: ["packages/*/src/**/*.test.*"],
      }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([
        ["packages/core/src/class-checks/evaluate.ts", "export {}\n"],
        ["packages/core/src/check/gate-lists.ts", "export {}\n"],
        ["packages/runtime/src/dispatch.ts", "export {}\n"],
        ["packages/core/src/consumer-check-contract/evaluate.ts", "export {}\n"],
        ["packages/core/src/evaluator-surface/evaluate.ts", "export {}\n"],
        ["packages/core/src/check/named-cause.ts", "export {}\n"],
      ]),
    });
    expect(result.exitCode).toBe(0);
    expect(result.findings.filter((f) => f.kind === "protected-glob")).toHaveLength(0);
  });

  it("allows protected authz + CLI authz companion (#4233)", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: [
        "packages/core/src/authz/store.ts",
        "packages/cli/src/authz.ts",
        "CHANGELOG.md",
      ],
      baseTestBoundaryPolicy: baseTb({
        sourceRoots: ["packages/*/src/**"],
        testRoots: ["packages/*/src/**/*.test.*"],
      }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([
        ["packages/core/src/authz/store.ts", "export {}\n"],
        ["packages/cli/src/authz.ts", "export {}\n"],
        ["CHANGELOG.md", "## Unreleased\n"],
      ]),
    });
    expect(result.exitCode).toBe(0);
    expect(result.findings.filter((f) => f.kind === "protected-glob")).toHaveLength(0);
  });

  it("fails when CLI authz mixes with non-authz protected (#4233)", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: [".githooks/pre-commit", "packages/cli/src/authz.ts"],
      baseTestBoundaryPolicy: baseTb({
        sourceRoots: ["packages/*/src/**"],
        testRoots: ["packages/*/src/**/*.test.*"],
      }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([
        [".githooks/pre-commit", "#!/bin/sh\n"],
        ["packages/cli/src/authz.ts", "export {}\n"],
      ]),
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "protected-glob")).toBe(true);
  });

  it("allows protected githooks + setup-wiring companions (#4980 Lane A)", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: [
        ".githooks/pre-commit",
        ".githooks/pre-push",
        "packages/runtime/src/setup-wiring.ts",
        "packages/core/src/init-deposit/agent-hooks.ts",
        "packages/core/src/install-health/constants.ts",
        "CHANGELOG.md",
      ],
      baseTestBoundaryPolicy: baseTb({
        sourceRoots: ["packages/*/src/**"],
        testRoots: ["packages/*/src/**/*.test.*"],
      }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([
        [".githooks/pre-commit", "#!/bin/sh\n"],
        [".githooks/pre-push", "#!/bin/sh\n"],
        ["packages/runtime/src/setup-wiring.ts", "export {}\n"],
        ["packages/core/src/init-deposit/agent-hooks.ts", "export {}\n"],
        ["packages/core/src/install-health/constants.ts", "export {}\n"],
        ["CHANGELOG.md", "## Unreleased\n"],
      ]),
    });
    expect(result.exitCode).toBe(0);
    expect(result.findings.filter((f) => f.kind === "protected-glob")).toHaveLength(0);
  });

  it("allows protected host-hook deposits + #5994 generator companions", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: [
        ".cursor/hooks.json",
        ".cursor/hooks/deft-hook-deadbeef.mjs",
        ".githooks/_directive-run.sh",
        "packages/runtime/src/setup-wiring.ts",
        "packages/runtime/src/doctor-diagnose.ts",
        "packages/runtime/src/pre-pr-run.ts",
        "packages/core/src/init-deposit/agent-hooks.ts",
        "packages/core/src/init-deposit/host-hook-outer.ts",
        "packages/core/src/init-deposit/hygiene.ts",
        "packages/core/src/install-health/wiring.ts",
        "packages/core/src/coverage-applicability/evaluate.ts",
        "CHANGELOG.md",
      ],
      baseTestBoundaryPolicy: baseTb({
        sourceRoots: ["packages/*/src/**"],
        testRoots: ["packages/*/src/**/*.test.*"],
      }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([
        [".cursor/hooks.json", "{}\n"],
        [".cursor/hooks/deft-hook-deadbeef.mjs", "export {}\n"],
        [".githooks/_directive-run.sh", "#!/bin/sh\n"],
        ["packages/runtime/src/setup-wiring.ts", "export {}\n"],
        ["packages/runtime/src/doctor-diagnose.ts", "export {}\n"],
        ["packages/runtime/src/pre-pr-run.ts", "export {}\n"],
        ["packages/core/src/init-deposit/agent-hooks.ts", "export {}\n"],
        ["packages/core/src/init-deposit/host-hook-outer.ts", "export {}\n"],
        ["packages/core/src/init-deposit/hygiene.ts", "export {}\n"],
        ["packages/core/src/install-health/wiring.ts", "export {}\n"],
        ["packages/core/src/coverage-applicability/evaluate.ts", "export {}\n"],
        ["CHANGELOG.md", "## Unreleased\n"],
      ]),
    });
    expect(result.exitCode).toBe(0);
    expect(result.findings.filter((f) => f.kind === "protected-glob")).toHaveLength(0);
  });

  it("fails when setup-wiring mixes with non-githooks protected (#4980 Lane A)", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: ["packages/core/src/authz/store.ts", "packages/runtime/src/setup-wiring.ts"],
      baseTestBoundaryPolicy: baseTb({
        sourceRoots: ["packages/*/src/**"],
        testRoots: ["packages/*/src/**/*.test.*"],
      }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([
        ["packages/core/src/authz/store.ts", "export {}\n"],
        ["packages/runtime/src/setup-wiring.ts", "export {}\n"],
      ]),
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "protected-glob")).toBe(true);
  });

  it("fails class 4 when protected mixes with check runtime outside registration", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: [".githooks/pre-commit", "packages/core/src/check/orchestrator.ts"],
      baseTestBoundaryPolicy: baseTb({
        sourceRoots: ["packages/*/src/**"],
        testRoots: ["packages/*/src/**/*.test.*"],
      }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([
        [".githooks/pre-commit", "#!/bin/sh\n"],
        ["packages/core/src/check/orchestrator.ts", "export const run = () => 1;\n"],
      ]),
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "protected-glob")).toBe(true);
  });

  it("fails when githooks + setup-wiring mixes with unrelated story product (#4980 Lane A)", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: [
        ".githooks/pre-commit",
        "packages/runtime/src/setup-wiring.ts",
        "packages/core/src/check/orchestrator.ts",
      ],
      baseTestBoundaryPolicy: baseTb({
        sourceRoots: ["packages/*/src/**"],
        testRoots: ["packages/*/src/**/*.test.*"],
      }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([
        [".githooks/pre-commit", "#!/bin/sh\n"],
        ["packages/runtime/src/setup-wiring.ts", "export {}\n"],
        ["packages/core/src/check/orchestrator.ts", "export const run = () => 1;\n"],
      ]),
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.kind === "protected-glob")).toBe(true);
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

  describe("lifecycle artifacts are not pipeline infra (#5159)", () => {
    const class2Needle = '{ "seed": "tests/fixtures/seed.json" }\n';
    const class3Needle = '{ "identity": { "name": "smoke-test-identity" } }\n';
    const bothNeedles =
      '{ "seed": "tests/fixtures/seed.json", "identity": { "name": "smoke-test-identity" } }\n';
    const yamlNeedles = "seed: tests/fixtures/seed.json\nname: 'smoke-test-identity'\n";
    const lifecycleFolders = ["proposed", "pending", "active", "completed", "cancelled"] as const;
    const pipelineSlug = "2026-10-14-5159-ci-pipeline-fix.xbrief.json";

    function run(changedFiles: string[], fileContents: Map<string, string>) {
      return evaluateClassChecks("/tmp/proj", {
        baseRef: "origin/master",
        changedFiles,
        baseTestBoundaryPolicy: baseTb({
          sourceRoots: ["src/**"],
          testRoots: ["tests/**"],
          fixtureRoots: ["tests/fixtures/**"],
        }),
        classChecksPolicy: classPolicy,
        fileContents,
      });
    }

    it("cleans class 2 needles on pipeline-named lifecycle artifacts in every folder", () => {
      for (const folder of lifecycleFolders) {
        const path = `xbrief/${folder}/${pipelineSlug}`;
        const result = run([path], new Map([[path, class2Needle]]));
        expect(result.findings.filter((f) => f.kind === "production-references-test-root")).toEqual(
          [],
        );
        expect(result.exitCode).toBe(0);
      }
    });

    it("cleans class 3 needles on pipeline-named lifecycle artifacts in every folder", () => {
      for (const folder of lifecycleFolders) {
        const path = `xbrief/${folder}/${pipelineSlug}`;
        const result = run([path], new Map([[path, class3Needle]]));
        expect(result.findings.filter((f) => f.kind === "test-identity-in-infra")).toEqual([]);
        expect(result.exitCode).toBe(0);
      }
    });

    it("cleans leftover-complete rename onto completed/", () => {
      const dest = `xbrief/completed/${pipelineSlug}`;
      const result = run([dest], new Map([[dest, bothNeedles]]));
      expect(result.exitCode).toBe(0);
      expect(result.findings).toEqual([]);
    });

    it("keeps the same needles clean at a non-pipeline xBRIEF path", () => {
      const path = "xbrief/completed/2026-10-14-5159-neutral-slug.xbrief.json";
      const result = run([path], new Map([[path, bothNeedles]]));
      expect(result.exitCode).toBe(0);
      expect(result.findings).toEqual([]);
    });

    it("still fails class 2 and 3 independently on ci/pipelines/prod.json and pipeline.json", () => {
      for (const path of ["ci/pipelines/prod.json", "pipeline.json"]) {
        const class2 = run([path], new Map([[path, class2Needle]]));
        expect(class2.findings.some((f) => f.kind === "production-references-test-root")).toBe(
          true,
        );
        const class3 = run([path], new Map([[path, class3Needle]]));
        expect(class3.findings.some((f) => f.kind === "test-identity-in-infra")).toBe(true);
        const both = run([path], new Map([[path, bothNeedles]]));
        expect(both.exitCode).toBe(1);
        expect(both.findings.some((f) => f.kind === "production-references-test-root")).toBe(true);
        expect(both.findings.some((f) => f.kind === "test-identity-in-infra")).toBe(true);
      }
    });

    it("still fails class 2 and 3 on root-level azure/bitbucket pipelines", () => {
      for (const path of ["azure-pipelines.yml", "bitbucket-pipelines.yml"]) {
        const result = run([path], new Map([[path, yamlNeedles]]));
        expect(result.exitCode).toBe(1);
        expect(result.findings.some((f) => f.kind === "production-references-test-root")).toBe(
          true,
        );
        expect(result.findings.some((f) => f.kind === "test-identity-in-infra")).toBe(true);
      }
    });

    it("preserves class 2 on ordinary GitHub release workflows without adding class 3", () => {
      const path = ".github/workflows/release.yml";
      const result = run([path], new Map([[path, yamlNeedles]]));
      expect(result.findings.some((f) => f.kind === "production-references-test-root")).toBe(true);
      expect(result.findings.some((f) => f.kind === "test-identity-in-infra")).toBe(false);
    });

    it("keeps non-artifact pipeline JSON under xbrief/ eligible", () => {
      const path = "xbrief/pipeline-notes.json";
      const result = run([path], new Map([[path, bothNeedles]]));
      expect(result.exitCode).toBe(1);
      expect(result.findings.some((f) => f.kind === "production-references-test-root")).toBe(true);
      expect(result.findings.some((f) => f.kind === "test-identity-in-infra")).toBe(true);
    });

    it("cleans a legacy vbrief/completed pipeline artifact outside tests/**", () => {
      const path = "vbrief/completed/2026-04-21-51-ci-pipeline-bootstrap.vbrief.json";
      const result = run([path], new Map([[path, bothNeedles]]));
      expect(result.exitCode).toBe(0);
      expect(result.findings).toEqual([]);
    });

    it("cleans a leftover-complete change set that only adds a 720-shaped completed xBRIEF", () => {
      const path = "xbrief/completed/2026-04-28-720-release-e2e-pipeline-mirror.xbrief.json";
      const content = JSON.stringify({
        plan: { narratives: { Test: "Verification: tests/cli/test_release_e2e.py" } },
      });
      const result = run([path], new Map([[path, content]]));
      expect(result.exitCode).toBe(0);
      expect(result.findings).toEqual([]);
    });

    it("does not add xbrief/** to DEFAULT_PROTECTED_GLOBS or default test roots", () => {
      expect(DEFAULT_PROTECTED_GLOBS.some((g) => g.includes("xbrief"))).toBe(false);
      expect(DEFAULT_TEST_ROOTS.some((r) => r.includes("xbrief"))).toBe(false);
    });
  });

  it("allows GitHub Actions workflows to reference declared fixture roots (#5097)", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: [".github/workflows/ci.yml"],
      baseTestBoundaryPolicy: baseTb({
        sourceRoots: ["src/**"],
        testRoots: ["tests/**"],
        fixtureRoots: ["tests/fixtures/**"],
      }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([
        [
          ".github/workflows/ci.yml",
          "Copy-Item tests\\fixtures\\pre_cutover_customized\\* $fixtureDir -Recurse\n",
        ],
      ]),
    });
    expect(
      result.findings.filter((f) => f.kind === "production-references-test-root"),
    ).toHaveLength(0);
  });

  it("keeps class 2 on release/publish workflows (#5097)", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: [".github/workflows/release.yml"],
      baseTestBoundaryPolicy: baseTb({
        sourceRoots: ["src/**"],
        testRoots: ["tests/**"],
        fixtureRoots: ["tests/fixtures/**"],
      }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([
        [".github/workflows/release.yml", "cp tests/fixtures/seed.json ./dist/\n"],
      ]),
    });
    expect(result.findings.some((f) => f.kind === "production-references-test-root")).toBe(true);
  });

  it("unknown workflow names stay class-2 fail-closed (#5097)", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: [".github/workflows/release-prod.yml"],
      baseTestBoundaryPolicy: baseTb({
        sourceRoots: ["src/**"],
        testRoots: ["tests/**"],
        fixtureRoots: ["tests/fixtures/**"],
      }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([
        [".github/workflows/release-prod.yml", "cp tests/fixtures/seed.json ./dist/\n"],
      ]),
    });
    expect(result.findings.some((f) => f.kind === "production-references-test-root")).toBe(true);
  });

  it("docs-site.yml stays class-2 (Pages deploy) (#5097)", () => {
    const result = evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: [".github/workflows/docs-site.yml"],
      baseTestBoundaryPolicy: baseTb({
        sourceRoots: ["src/**"],
        testRoots: ["tests/**"],
        fixtureRoots: ["tests/fixtures/**"],
      }),
      classChecksPolicy: classPolicy,
      fileContents: new Map([
        [".github/workflows/docs-site.yml", "cp tests/fixtures/seed.json docs-site/\n"],
      ]),
    });
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

describe("candidate tree: working tree against the merge base (#6336)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function git(root: string, ...args: string[]): string {
    return execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  }

  function put(root: string, rel: string, text: string): void {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }

  /** master holds the base; branch `story` adds a protected path and story product. */
  function seed(): string {
    const root = mkdtempSync(join(tmpdir(), "class-checks-candidate-"));
    roots.push(root);
    git(root, "init", "-q", "-b", "master");
    put(root, "src/app.py", "x = 1\n");
    put(root, "protected/gate.txt", "base\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    git(root, "checkout", "-q", "-b", "story");
    put(root, "src/app.py", "x = 2\n");
    put(root, "protected/gate.txt", "changed\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "story");
    return root;
  }

  const options = {
    baseRef: "master",
    baseTestBoundaryPolicy: baseTb({
      sourceRoots: ["src/**", "infra/**"],
      testRoots: ["tests/**"],
      enforcementMode: "enforce",
    }),
    classChecksPolicy: { ...defaultClassChecksPolicy(), protectedGlobs: ["protected/**"] },
  };

  it("fails a committed protected path mixed with story product", () => {
    const root = seed();
    const result = evaluateClassChecks(root, options);
    expect(result.exitCode).toBe(1);
    expect(result.findings.map((f) => f.kind)).toContain("protected-glob");
  });

  it("passes once the protected path is reverted in the working tree, before commit", () => {
    const root = seed();
    put(root, "protected/gate.txt", "base\n");
    const result = evaluateClassChecks(root, options);
    expect(result.findings.filter((f) => f.kind === "protected-glob")).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("fails an untracked file that breaks a class rule", () => {
    const root = seed();
    put(root, "protected/gate.txt", "base\n");
    put(root, "infra/scripts/test_release.py", "print(1)\n");
    const result = evaluateClassChecks(root, options);
    expect(result.exitCode).toBe(1);
    expect(result.findings.map((f) => f.path)).toContain("infra/scripts/test_release.py");
  });

  it("leaves base-only commits out when the branch is behind its base", () => {
    const root = seed();
    put(root, "protected/gate.txt", "base\n");
    git(root, "commit", "-q", "-am", "revert protected");
    git(root, "checkout", "-q", "master");
    put(root, "protected/other.txt", "base-only\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base moves on");
    git(root, "checkout", "-q", "story");
    const result = evaluateClassChecks(root, options);
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/clean|0 finding|no finding/i);
  });
});

describe("class 4 counts Directive wiring only by what is committed (D-026 / #6616)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function git(root: string, ...args: string[]): string {
    return execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.autocrlf=false",
        ...args,
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  }

  function put(root: string, rel: string, text: string): void {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }

  /** master holds Directive's git hook; branch `story` commits a story product change. */
  function seed(): string {
    const root = mkdtempSync(join(tmpdir(), "class-checks-wiring-"));
    roots.push(root);
    git(root, "init", "-q", "-b", "master");
    put(root, "src/app.py", "x = 1\n");
    put(root, ".githooks/pre-commit", "#!/bin/sh\necho old\n");
    put(root, ".githooks/my-team-check", "#!/bin/sh\necho team\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    git(root, "checkout", "-q", "-b", "story");
    put(root, "src/app.py", "x = 2\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "story");
    return root;
  }

  const options = {
    baseRef: "master",
    baseTestBoundaryPolicy: baseTb({
      sourceRoots: ["src/**"],
      testRoots: ["tests/**"],
      enforcementMode: "enforce",
    }),
    classChecksPolicy: defaultClassChecksPolicy(),
  };

  const notCountedLine = (path: string): string =>
    `Not counted: \`${path}\` (uncommitted change to Directive wiring, for example by automatic setup).`;

  it("passes an uncommitted rewrite of Directive's .githooks/pre-commit and names it", () => {
    const root = seed();
    put(root, ".githooks/pre-commit", "#!/bin/sh\necho refreshed\n");
    const result = evaluateClassChecks(root, options);
    expect(result.findings).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.notCounted).toEqual([".githooks/pre-commit"]);
    expect(result.message).toContain(notCountedLine(".githooks/pre-commit"));
  });

  it("passes an untracked Directive-owned .cursor/hooks outer", () => {
    const root = seed();
    put(root, ".cursor/hooks/deft-hook-0123abcd.mjs", "// outer\n");
    const result = evaluateClassChecks(root, options);
    expect(result.exitCode).toBe(0);
    expect(result.notCounted).toEqual([".cursor/hooks/deft-hook-0123abcd.mjs"]);
    expect(result.message).toContain(notCountedLine(".cursor/hooks/deft-hook-0123abcd.mjs"));
  });

  it("fails a committed edit to .githooks/pre-commit mixed with story product", () => {
    const root = seed();
    put(root, ".githooks/pre-commit", "#!/bin/sh\necho edited\n");
    git(root, "commit", "-q", "-am", "edit hook");
    const result = evaluateClassChecks(root, options);
    expect(result.exitCode).toBe(1);
    expect(result.findings.map((f) => [f.path, f.kind])).toContainEqual([
      ".githooks/pre-commit",
      "protected-glob",
    ]);
    expect(result.notCounted).toBeUndefined();
    expect(result.message).not.toContain("Not counted");
  });

  it("fails an uncommitted change to a non-Directive file under .githooks/", () => {
    const root = seed();
    put(root, ".githooks/my-team-check", "#!/bin/sh\necho changed\n");
    const result = evaluateClassChecks(root, options);
    expect(result.exitCode).toBe(1);
    expect(result.findings.map((f) => f.path)).toContain(".githooks/my-team-check");
    expect(result.notCounted).toBeUndefined();
  });

  it("fails an uncommitted change to a non-wiring protected path (class-checks/**)", () => {
    const root = seed();
    put(root, "packages/core/src/class-checks/policy.ts", "export const x = 1;\n");
    const result = evaluateClassChecks(root, options);
    expect(result.exitCode).toBe(1);
    expect(result.findings.map((f) => f.path)).toContain(
      "packages/core/src/class-checks/policy.ts",
    );
  });

  it("still counts an uncommitted .cursor/hooks.json change that adds a non-Directive hook", () => {
    const root = seed();
    put(
      root,
      ".cursor/hooks.json",
      `${JSON.stringify({ version: 1, hooks: { stop: [{ command: "./my-script.sh" }] } }, null, 2)}\n`,
    );
    const result = evaluateClassChecks(root, options);
    expect(result.exitCode).toBe(1);
    expect(result.findings.map((f) => f.path)).toContain(".cursor/hooks.json");
  });

  it("counts every wiring path when changedFiles is injected (no working tree to compare)", () => {
    const result = evaluateClassChecks("/tmp/injected", {
      ...options,
      changedFiles: ["src/app.py", ".githooks/pre-commit"],
      fileContents: new Map<string, string>(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.map((f) => f.path)).toContain(".githooks/pre-commit");
  });

  it("passes a CI-shaped run: pin bump committed, then automatic setup rewrites Cursor hooks", () => {
    const root = mkdtempSync(join(tmpdir(), "class-checks-ci-"));
    roots.push(root);
    git(root, "init", "-q", "-b", "master");
    put(root, "src/app.py", "x = 1\n");
    put(root, "package.json", `${JSON.stringify({ name: "app", version: "1.0.0" }, null, 2)}\n`);
    // The committed wiring an older Directive version wrote: same shape, older outer.
    writeAgentHookDeposit(root);
    const hooksDir = join(root, ".cursor", "hooks");
    const outer = readdirSync(hooksDir).find((n) => /^deft-hook-[a-f0-9]{8}\.mjs$/.test(n));
    expect(outer).toBeDefined();
    const currentSha8 = (outer as string).slice("deft-hook-".length, -".mjs".length);
    renameSync(join(hooksDir, outer as string), join(hooksDir, "deft-hook-00000000.mjs"));
    const hooksJsonPath = join(root, ".cursor", "hooks.json");
    writeFileSync(
      hooksJsonPath,
      readFileSync(hooksJsonPath, "utf8").replaceAll(currentSha8, "00000000"),
    );
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base with older Directive wiring");
    git(root, "checkout", "-q", "-b", "story");
    put(root, "src/app.py", "x = 2\n");
    put(
      root,
      "package.json",
      `${JSON.stringify({ name: "app", version: "1.0.0", devDependencies: { "@deftai/directive-runtime": "0.129.15" } }, null, 2)}\n`,
    );
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "story + pin bump");
    expect(git(root, "status", "--porcelain")).toBe("");

    // Automatic setup in CI refreshes Directive's wiring before the check.
    writeAgentHookDeposit(root);
    expect(existsSync(join(hooksDir, outer as string))).toBe(true);
    expect(git(root, "status", "--porcelain")).toContain(".cursor/hooks.json");

    const result = evaluateClassChecks(root, options);
    expect(result.findings).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.notCounted).toContain(".cursor/hooks.json");
    expect(result.notCounted).toContain(`.cursor/hooks/${outer as string}`);
  });
});

describe("class 2 scans only added lines (#7077)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function git(root: string, ...args: string[]): string {
    return execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.autocrlf=false",
        ...args,
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  }

  function put(root: string, rel: string, text: string): void {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }

  const REF = '  roots: ["tests/**"],';
  const BASE = ["export const gate = {", REF, "  mode: 1,", "};", ""].join("\n");

  /** master holds src/gate.ts with a test-root reference; branch `story` is checked out. */
  function seed(): string {
    const root = mkdtempSync(join(tmpdir(), "class-checks-added-"));
    roots.push(root);
    git(root, "init", "-q", "-b", "master");
    put(root, "src/gate.ts", BASE);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    git(root, "checkout", "-q", "-b", "story");
    return root;
  }

  const tb = baseTb({
    sourceRoots: ["src/**"],
    testRoots: ["tests/**"],
    fixtureRoots: [],
    enforcementMode: "enforce",
  });
  const options = {
    baseRef: "master",
    baseTestBoundaryPolicy: tb,
    headTestBoundaryPolicy: null,
    classChecksPolicy: { ...defaultClassChecksPolicy(), protectedGlobs: ["protected/**"] },
  };

  function class2(root: string): string[] {
    return evaluateClassChecks(root, options)
      .findings.filter((f) => f.kind === "production-references-test-root")
      .map((f) => f.path);
  }

  it("passes an edit to another line of a file whose base already holds a reference", () => {
    const root = seed();
    put(root, "src/gate.ts", BASE.replace("mode: 1", "mode: 2"));
    const result = evaluateClassChecks(root, options);
    expect(result.findings).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("fails a new line that adds a test-root reference, naming the file and line", () => {
    const root = seed();
    put(
      root,
      "src/gate.ts",
      BASE.replace("  mode: 1,", '  mode: 1,\n  extra: "tests/fixtures/x",'),
    );
    const result = evaluateClassChecks(root, options);
    expect(result.exitCode).toBe(1);
    const finding = result.findings.find((f) => f.kind === "production-references-test-root");
    expect(finding?.path).toBe("src/gate.ts");
    expect(finding?.detail).toMatch(/on line 4 /);
  });

  it("fails when the reference line is deleted and the same text added elsewhere", () => {
    const root = seed();
    put(root, "src/gate.ts", ["export const gate = {", "  mode: 1,", REF, "};", ""].join("\n"));
    expect(class2(root)).toEqual(["src/gate.ts"]);
  });

  it("fails when the reference line is only re-indented", () => {
    const root = seed();
    put(root, "src/gate.ts", BASE.replace(REF, `    ${REF.trimStart()}`));
    expect(class2(root)).toEqual(["src/gate.ts"]);
  });

  it("fails an untracked production file with a reference", () => {
    const root = seed();
    put(root, "src/new.ts", 'export const r = "tests/fixtures/a";\n');
    expect(class2(root)).toEqual(["src/new.ts"]);
  });

  it("fails a committed new production file with a reference", () => {
    const root = seed();
    put(root, "src/new.ts", 'export const r = "tests/fixtures/a";\n');
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "new file");
    expect(class2(root)).toEqual(["src/new.ts"]);
  });

  it("verify:test-boundary still reports the pre-existing reference", () => {
    const root = seed();
    put(root, "src/gate.ts", BASE.replace("mode: 1", "mode: 2"));
    git(root, "commit", "-q", "-am", "unrelated edit");
    expect(class2(root)).toEqual([]);
    const tbResult = evaluateTestBoundary(root, { policy: tb });
    expect(tbResult.findings.map((f) => f.path)).toContain("src/gate.ts");
  });

  it("injected mode never reads git: no addedLines entry scans every line", () => {
    const root = seed();
    put(root, "src/gate.ts", BASE.replace("mode: 1", "mode: 2"));
    const result = evaluateClassChecks(root, {
      ...options,
      changedFiles: ["src/gate.ts"],
      fileContents: new Map([["src/gate.ts", BASE.replace("mode: 1", "mode: 2")]]),
    });
    expect(result.findings.map((f) => f.kind)).toEqual(["production-references-test-root"]);
  });

  it("injected addedLines: fails only when a reference is on a listed line", () => {
    const injected = (lines: number[]) =>
      evaluateClassChecks("/tmp/proj", {
        ...options,
        changedFiles: ["src/gate.ts"],
        fileContents: new Map([["src/gate.ts", BASE]]),
        addedLines: new Map([["src/gate.ts", new Set(lines)]]),
      });
    expect(injected([3]).exitCode).toBe(0);
    expect(injected([]).exitCode).toBe(0);
    const hit = injected([2, 3]);
    expect(hit.exitCode).toBe(1);
    expect(hit.findings[0]?.detail).toMatch(/on line 2 /);
  });

  it("strips one trailing CR per line and does not normalise whitespace", () => {
    const crlf = BASE.split("\n").join("\r\n");
    const result = evaluateClassChecks("/tmp/proj", {
      ...options,
      changedFiles: ["src/gate.ts"],
      fileContents: new Map([["src/gate.ts", crlf]]),
      addedLines: new Map([["src/gate.ts", new Set([2])]]),
    });
    expect(result.exitCode).toBe(1);
  });
});

describe("co-located tests and the class 2 import rule (#6668)", () => {
  const classPolicy = defaultClassChecksPolicy();
  const suite = "describe('a', () => {\n  it('b', () => {\n    expect(1).toBe(1);\n  });\n});\n";
  const run = (files: Record<string, string>, extra: Partial<ClassCheckOptions> = {}) =>
    evaluateClassChecks("/tmp/proj", {
      baseRef: "origin/master",
      changedFiles: Object.keys(files),
      baseTestBoundaryPolicy: baseTb(),
      classChecksPolicy: classPolicy,
      fileContents: new Map(Object.entries(files)),
      ...extra,
    });
  const kinds = (r: ReturnType<typeof run>, path: string) =>
    r.findings.filter((f) => f.path === path).map((f) => f.kind);

  it("reports no class 1 finding for added and edited co-located Vitest files", () => {
    const result = run({
      "src/ui/A.plan-wide.test.tsx": suite,
      "src/ui/B.test.ts": suite,
    });
    expect(result.findings).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("reports neither class 1 nor class 2 for a .test.mjs that names a fixture", () => {
    const result = run({
      "src/shared/c.test.mjs": `${suite}const f = readFileSync("tests/fixtures/x.json");\n`,
    });
    expect(result.findings).toEqual([]);
  });

  it("still reports a neutral-named helper with suite content, naming the policy route", () => {
    const result = run({ "src/helpers/smoke.ts": suite });
    expect(kinds(result, "src/helpers/smoke.ts")).toEqual(["test-under-source-root"]);
    const remediation = result.findings[0]?.remediation ?? "";
    expect(remediation).toMatch(/\.deft\/test-boundary\.policy\.json/);
    expect(remediation).toMatch(/plan\.policy\.testBoundary/);
    expect(remediation).toMatch(/narrow allow entry/);
    expect(remediation).toMatch(/testRoots list replaces every default root/);
    expect(remediation).toMatch(/read from the base ref/);
    expect(remediation).not.toMatch(/no approve, skip, or phrase/);
    expect(result.message).not.toMatch(/scope:record-approved-scope/);
  });

  it("names only the policy file when the base ref has one", () => {
    const result = run(
      { "src/helpers/smoke.ts": suite },
      { baseTestBoundaryPolicy: baseTb({ source: "file" }) },
    );
    const remediation = result.findings[0]?.remediation ?? "";
    expect(remediation).toMatch(/base-ref \.deft\/test-boundary\.policy\.json/);
    expect(remediation).not.toMatch(/plan\.policy\.testBoundary/);
  });

  it("still reports Python test names under a source root", () => {
    const result = run({
      "src/test_helpers.py": "x = 1\n",
      "infra/scripts/test_release.py": "print('hi')\n",
    });
    expect(kinds(result, "src/test_helpers.py")).toEqual(["test-under-source-root"]);
    expect(kinds(result, "infra/scripts/test_release.py")).toEqual(["test-under-source-root"]);
  });

  it("passes class 1 but keeps class 3 for a test-named infra file", () => {
    const path = "infra/smoke/prod-health.spec.ts";
    const result = run({ [path]: `${suite}const identity = { name: "smoke-test-identity" };\n` });
    expect(kinds(result, path)).toEqual(["test-identity-in-infra"]);
  });

  it.each([
    ['import { Fake } from "./fakeGateway.test";', "./fakeGateway.test"],
    ['const x = require("./x.spec.js");', "./x.spec.js"],
    ['const y = await import("./y.test.mjs");', "./y.test.mjs"],
    ['} from "../shared/z.spec";', "../shared/z.spec"],
    ['import "./side-effect.test.ts";', "./side-effect.test.ts"],
    ["export * from './w.TEST.tsx';", "./w.TEST.tsx"],
    [
      'const load = () => import(/* webpackChunkName: "checks" */ "./checks.test");',
      "./checks.test",
    ],
    ['/* lead */ import { b } from "./b.spec";', "./b.spec"],
    ['*/ const c = require("./c.test.cjs");', "./c.test.cjs"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source line under test
    ["const label = `${require('./labels.test').title}`;", "./labels.test"],
    ["const m = await import(`./t.test.js`);", "./t.test.js"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source line under test
    ["const n = `a ${`b ${import('./n.spec')}`}`;", "./n.spec"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source line under test
    ["const v = import(`./${name}.test`);", "./${name}.test"],
    ['const d = a / 2; const t = require("./t.spec");', "./t.spec"],
  ])("class 2 reports a production line importing a test module: %s", (line, spec) => {
    const content = `export const a = 1;\n${line}\n`;
    const result = run(
      { "src/payments/index.ts": content },
      { addedLines: new Map([["src/payments/index.ts", new Set([2])]]) },
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("production-references-test-root");
    expect(result.findings[0]?.detail).toBe(
      `imports co-located test module '${spec}' on line 2 (class 2)`,
    );
  });

  it("does not report an unchanged import line", () => {
    const content = 'import { Fake } from "./fakeGateway.test";\nexport const a = 1;\n';
    const result = run(
      { "src/payments/index.ts": content },
      { addedLines: new Map([["src/payments/index.ts", new Set([2])]]) },
    );
    expect(result.findings).toEqual([]);
  });

  it.each([
    '// import { Fake } from "./fakeGateway.test";',
    ' * see require("./x.spec.js")',
    'const s = "./a.test";',
    'const t = readFileSync("./a.test.ts", "utf8");',
    "const u = \"import x from './a.test'\";",
    'import { latest } from "./latest";',
    'import { spec } from "./spec";',
    "const example = \"require('./fake.test')\";",
    'const x = 1; // require("./fake.test")',
    'const y = 1; /* import("./fake.test") */',
    "const z = `import x from './fake.spec'`;",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source line under test
    "const w = `${name} require('./fake.test')`;",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source line under test
    "const label = `${/require('fake.test')/.source}`;",
    'const r = /import\\("x\\.test"\\)/g.test(src);',
    "if (ok) return /[/]require('a.test')/i;",
  ])("class 2 ignores a line that is not a test-module import: %s", (line) => {
    const result = run({ "src/payments/index.ts": `${line}\n` });
    expect(result.findings).toEqual([]);
  });

  it("leaves Directive's own co-located package tests unchanged", () => {
    const result = run(
      { "packages/core/src/x/y.test.ts": suite },
      { baseTestBoundaryPolicy: baseTb() },
    );
    expect(result.findings).toEqual([]);
    expect(DEFAULT_TEST_ROOTS).toContain("packages/*/src/**/*.test.*");
  });

  it("keeps the scope and write fences classing a co-located test as production", () => {
    expect(classifyExtraPath("src/ui/A.test.tsx")).toBe("production");
  });
});
