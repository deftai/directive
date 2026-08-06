import { describe, expect, it } from "vitest";
import {
  evaluateConsumerCheckContract,
  extractCheckDeps,
  REQUIRED_CONSUMER_ENFORCEMENT_GATES,
  textReferencesGate,
} from "./evaluate.js";

const VERIFY_YML_COMPLETE = `
version: '3'
tasks:
  test-boundary:
    cmds:
      - echo ok
  scope-provenance:
    cmds:
      - echo ok
  consumer-check-contract:
    cmds:
      - echo ok
  branch:
    cmds:
      - echo ok
`;

const VERIFY_YML_MISSING = `
version: '3'
tasks:
  branch:
    cmds:
      - echo ok
`;

const ROOT_WITH_CHECK_DEPS = `
version: '3'
tasks:
  check:
    deps:
      - verify:test-boundary
      - verify:scope-provenance
      - verify:consumer-check-contract
      - verify:branch
`;

const ROOT_MISSING_DEPS = `
version: '3'
tasks:
  check:
    deps:
      - verify:branch
`;

describe("consumer-check-contract helpers (#3145)", () => {
  it("detects gate references in text", () => {
    expect(textReferencesGate("run deft verify:test-boundary", "verify:test-boundary")).toBe(true);
    expect(textReferencesGate("task verify-test-boundary", "verify:test-boundary")).toBe(true);
    expect(textReferencesGate("nothing here", "verify:test-boundary")).toBe(false);
  });

  it("extracts check deps from Taskfile snippet", () => {
    const deps = extractCheckDeps(ROOT_WITH_CHECK_DEPS, "check");
    expect(deps).toContain("verify:test-boundary");
    expect(deps).toContain("verify:scope-provenance");
  });

  it("lists required enforcement gates", () => {
    expect(REQUIRED_CONSUMER_ENFORCEMENT_GATES).toContain("verify:test-boundary");
    expect(REQUIRED_CONSUMER_ENFORCEMENT_GATES).toContain("verify:scope-provenance");
    expect(REQUIRED_CONSUMER_ENFORCEMENT_GATES).toContain("verify:consumer-check-contract");
  });
});

describe("evaluateConsumerCheckContract (#3145)", () => {
  it("fails when verify.yml omits required gates", () => {
    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: ROOT_WITH_CHECK_DEPS,
      verifyTaskfileText: VERIFY_YML_MISSING,
      ciWorkflows: new Map(),
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.gateId === "verify:test-boundary")).toBe(true);
    expect(result.message).toMatch(/remediation|repair|Add/i);
  });

  it("fails when check deps omit required gates", () => {
    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: ROOT_MISSING_DEPS,
      verifyTaskfileText: VERIFY_YML_COMPLETE,
      ciWorkflows: new Map(),
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.surface === "check-task")).toBe(true);
  });

  it("does not treat mere check:consumer name mention as full-check composition", () => {
    // Incomplete deps + incidental check:consumer string must still fail.
    const root = `
version: '3'
tasks:
  check:
    deps:
      - verify:branch
  docs:
    cmds:
      - echo "see check:consumer docs"
`;
    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: root,
      verifyTaskfileText: VERIFY_YML_COMPLETE,
      ciWorkflows: new Map(),
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.surface === "check-task")).toBe(true);
  });

  it("passes when verify.yml defines gates and check composes them", () => {
    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: ROOT_WITH_CHECK_DEPS,
      verifyTaskfileText: VERIFY_YML_COMPLETE,
      ciWorkflows: new Map([[".github/workflows/ci.yml", "run: task check\n"]]),
      enforce: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("soft-warns CI omissions when ciWarnOnly", () => {
    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: ROOT_WITH_CHECK_DEPS,
      verifyTaskfileText: VERIFY_YML_COMPLETE,
      ciWorkflows: new Map([[".github/workflows/ci.yml", "run: echo hi\n"]]),
      ciWarnOnly: true,
      enforce: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/WARN/i);
  });

  it("returns clean when CI runs task check and verify defines gates", () => {
    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: ROOT_WITH_CHECK_DEPS,
      verifyTaskfileText: VERIFY_YML_COMPLETE,
      ciWorkflows: new Map([[".github/workflows/ci.yml", "    - run: task check\n"]]),
      enforce: true,
    });
    expect(result.exitCode).toBe(0);
  });

  it("does not treat prose-only check mentions as CI composition", () => {
    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: ROOT_WITH_CHECK_DEPS,
      verifyTaskfileText: VERIFY_YML_COMPLETE,
      ciWorkflows: new Map([
        [".github/workflows/ci.yml", "# please run deft check manually\n- run: echo hi\n"],
      ]),
      ciWarnOnly: true,
      enforce: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/WARN/i);
  });

  it("enforce off softens missing verify tasks to warn", () => {
    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: ROOT_WITH_CHECK_DEPS,
      verifyTaskfileText: VERIFY_YML_MISSING,
      ciWorkflows: new Map(),
      enforce: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/WARN/i);
  });

  it("config error when root Taskfile text is null inject", () => {
    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: null,
      verifyTaskfileText: VERIFY_YML_COMPLETE,
      enforce: true,
    });
    expect(result.exitCode).toBe(2);
  });
});
