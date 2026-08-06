import { describe, expect, it } from "vitest";
import {
  evaluateConsumerCheckContract,
  extractCheckDeps,
  extractWorkflowRunCommands,
  isPureAssignmentLine,
  REQUIRED_CONSUMER_ENFORCEMENT_GATES,
  runCommandIsFullCheck,
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

  it("does not let a single CI gate satisfy the whole trio", () => {
    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: ROOT_WITH_CHECK_DEPS,
      verifyTaskfileText: VERIFY_YML_COMPLETE,
      ciWorkflows: new Map([[".github/workflows/ci.yml", "- run: task verify:test-boundary\n"]]),
      ciWarnOnly: false,
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
    expect(
      result.findings.some(
        (f) => f.gateId === "verify:scope-provenance" && f.surface === "ci-workflow",
      ),
    ).toBe(true);
  });

  it("fails empty check aggregates without full orchestrator", () => {
    const root = `
version: '3'
tasks:
  check:
    cmds:
      - echo only
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

  it("does not treat verify:consumer-check-contract as full check:consumer", () => {
    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: ROOT_WITH_CHECK_DEPS,
      verifyTaskfileText: VERIFY_YML_COMPLETE,
      ciWorkflows: new Map([
        [".github/workflows/ci.yml", "- run: task verify:consumer-check-contract\n"],
      ]),
      ciWarnOnly: false,
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.gateId === "verify:test-boundary")).toBe(true);
  });

  it("does not treat echo of check:consumer as full check", () => {
    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: ROOT_WITH_CHECK_DEPS,
      verifyTaskfileText: VERIFY_YML_COMPLETE,
      ciWorkflows: new Map([
        [".github/workflows/ci.yml", '- run: echo "see check:consumer docs"\n'],
      ]),
      ciWarnOnly: false,
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
  });

  it("does not grant check trust from echo task check in aggregate body", () => {
    // Greptile conf=3 P1: non-executing "task check" phrase must not trustFullCheck.
    const root = `
version: '3'
tasks:
  check:
    cmds:
      - echo "run task check before release"
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

  it("does not treat echo of gate ids as direct CI gate invocation", () => {
    // Greptile conf=3 P1: substring mentions in echo must not satisfy each gate.
    const ci = `
jobs:
  build:
    steps:
      - run: echo "verify:test-boundary verify:scope-provenance verify:consumer-check-contract"
`;
    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: ROOT_WITH_CHECK_DEPS,
      verifyTaskfileText: VERIFY_YML_COMPLETE,
      ciWorkflows: new Map([[".github/workflows/ci.yml", ci]]),
      ciWarnOnly: false,
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.surface === "ci-workflow")).toBe(true);
  });

  it("accepts block-scalar CI that runs task check", () => {
    const ci = `
jobs:
  build:
    steps:
      - name: check
        run: |
          task check
`;
    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: ROOT_WITH_CHECK_DEPS,
      verifyTaskfileText: VERIFY_YML_COMPLETE,
      ciWorkflows: new Map([[".github/workflows/ci.yml", ci]]),
      enforce: true,
    });
    expect(result.exitCode).toBe(0);
  });

  it("does not count substring dep names as required gates", () => {
    // Greptile conf=3: noop-verify:test-boundary must not impersonate verify:test-boundary
    const root = `
version: '3'
tasks:
  check:
    deps:
      - noop-verify:test-boundary
      - noop-verify:scope-provenance
      - noop-verify:consumer-check-contract
`;
    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: root,
      verifyTaskfileText: VERIFY_YML_COMPLETE,
      ciWorkflows: new Map(),
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.gateId === "verify:test-boundary")).toBe(true);
  });

  it("does not let sibling aggregate conceal omissions on incomplete check", () => {
    // Greptile conf=3: full check:consumer must not mask incomplete check deps
    const root = `
version: '3'
tasks:
  check:
    deps:
      - verify:branch
  check:consumer:
    deps:
      - verify:test-boundary
      - verify:scope-provenance
      - verify:consumer-check-contract
`;
    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: root,
      verifyTaskfileText: VERIFY_YML_COMPLETE,
      ciWorkflows: new Map(),
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
    expect(
      result.findings.some(
        (f) => f.surface === "check-task" && f.detail.includes("aggregate 'check'"),
      ),
    ).toBe(true);
  });

  it("does not grant trust from pure assignment of task check", () => {
    // Greptile conf=1: CHECK_CMD="task check" must not satisfy composition
    const root = `
version: '3'
tasks:
  check:
    cmds:
      - CHECK_CMD="task check"
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

  it("does not treat failure-masked task check as full check", () => {
    expect(runCommandIsFullCheck("task check || true")).toBe(false);
    expect(runCommandIsFullCheck("deft check || :")).toBe(false);
    expect(runCommandIsFullCheck("deft check || echo ignored")).toBe(false);
    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: ROOT_WITH_CHECK_DEPS,
      verifyTaskfileText: VERIFY_YML_COMPLETE,
      ciWorkflows: new Map([
        [".github/workflows/ci.yml", "- run: task check || true\n"],
      ]),
      ciWarnOnly: false,
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
  });

  it("does not treat backgrounded task check as full check (Greptile conf=3/4)", () => {
    expect(runCommandIsFullCheck("task check &")).toBe(false);
    expect(runCommandIsFullCheck("deft check&")).toBe(false);
    expect(runCommandIsFullCheck("task check & # fire and forget")).toBe(false);
    expect(runCommandIsFullCheck("task check & echo done")).toBe(false);
    // Foreground chained form remains trusted when deps already gate.
    expect(runCommandIsFullCheck("task check")).toBe(true);
    // Fd redirection is not job-control backgrounding.
    expect(runCommandIsFullCheck("task check 2>&1")).toBe(true);
    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: ROOT_WITH_CHECK_DEPS,
      verifyTaskfileText: VERIFY_YML_COMPLETE,
      ciWorkflows: new Map([
        [".github/workflows/ci.yml", "- run: task check &\n"],
      ]),
      ciWarnOnly: false,
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
  });

  it("does not trust inert dispatchTaskCheck argument text", () => {
    const root = `
version: '3'
tasks:
  check:
    cmds:
      - echo "call dispatchTaskCheck later"
      - true dispatchTaskCheck
`;
    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: root,
      verifyTaskfileText: VERIFY_YML_COMPLETE,
      ciWorkflows: new Map(),
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
  });

  it("does not trust commented engine:invoke + ENGINE_CMD markers", () => {
    const root = `
version: '3'
tasks:
  check:
    cmds:
      - echo only
      # - task: engine:invoke
      #   vars:
      #     ENGINE_CMD: 'check --project-root .'
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

  it("does not trust inert ENGINE_CMD without engine:invoke", () => {
    const root = `
version: '3'
tasks:
  check:
    cmds:
      - ENGINE_CMD: 'check --project-root .'
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

  it("trusts engine:invoke + ENGINE_CMD check orchestrator", () => {
    const root = `
version: '3'
tasks:
  check:
    cmds:
      - task: engine:invoke
        vars:
          ENGINE_CMD: 'check --project-root .'
`;
    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: root,
      verifyTaskfileText: VERIFY_YML_COMPLETE,
      ciWorkflows: new Map(),
      enforce: true,
    });
    expect(result.exitCode).toBe(0);
  });

  it("does not treat printf of task check as full check", () => {
    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: ROOT_WITH_CHECK_DEPS,
      verifyTaskfileText: VERIFY_YML_COMPLETE,
      ciWorkflows: new Map([
        [".github/workflows/ci.yml", "- run: printf 'task check'\\n"],
      ]),
      ciWarnOnly: false,
      enforce: true,
    });
    expect(runCommandIsFullCheck("printf 'task check'")).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.surface === "ci-workflow")).toBe(true);
  });

  it("does not treat assignment-only CI as full check", () => {
    const wf = '- run: CHECK_CMD="task check"\n';
    const cmds = extractWorkflowRunCommands(wf);
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds[0]).toBe('CHECK_CMD="task check"');
    expect(isPureAssignmentLine(cmds[0] ?? "")).toBe(true);
    expect(runCommandIsFullCheck(cmds[0] ?? "")).toBe(false);

    const result = evaluateConsumerCheckContract("/tmp/consumer", {
      rootTaskfileText: ROOT_WITH_CHECK_DEPS,
      verifyTaskfileText: VERIFY_YML_COMPLETE,
      ciWorkflows: new Map([[".github/workflows/ci.yml", wf]]),
      ciWarnOnly: false,
      enforce: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.surface === "ci-workflow")).toBe(true);
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
