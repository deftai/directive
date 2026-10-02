/**
 * PR gate-reachability fixtures for verify:consumer-check-contract (#4015).
 */
import { describe, expect, it } from "vitest";
import {
  evaluateConsumerCheckContract,
  extractWorkflowRunCommands,
  runCommandInvokesGate,
  runCommandIsFullCheck,
} from "./evaluate.js";
import {
  attachRunCommands,
  classifyPullRequestCondition,
  findingsForWorkflowGraph,
  type JobGateCarry,
  parseWorkflowJobGraph,
} from "./reachability.js";

const VERIFY_YML_COMPLETE = `
version: '3'
tasks:
  test-boundary:
    cmds:
      - echo ok
  class-checks:
    cmds:
      - echo ok
  scope-provenance:
    cmds:
      - echo ok
  consumer-check-contract:
    cmds:
      - echo ok
  evaluator-surface:
    cmds:
      - echo ok
  observable-scope:
    cmds:
      - echo ok
  intent-constraint:
    cmds:
      - echo ok
  presentation-ceiling:
    cmds:
      - echo ok
  durable-effect-acquisition:
    cmds:
      - echo ok
  presentation-coverage:
    cmds:
      - echo ok
`;

const ROOT_WITH_CHECK_DEPS = `
version: '3'
tasks:
  check:
    deps:
      - verify:test-boundary
      - verify:class-checks
      - verify:scope-provenance
      - verify:consumer-check-contract
      - verify:evaluator-surface
      - verify:observable-scope
      - verify:intent-constraint
      - verify:presentation-ceiling
      - verify:durable-effect-acquisition
      - verify:presentation-coverage
`;

const REQUIRED = [
  "verify:test-boundary",
  "verify:class-checks",
  "verify:scope-provenance",
  "verify:consumer-check-contract",
  "verify:evaluator-surface",
  "verify:observable-scope",
  "verify:intent-constraint",
  "verify:presentation-ceiling",
  "verify:durable-effect-acquisition",
  "verify:presentation-coverage",
] as const;

function evaluateCi(ci: string) {
  return evaluateConsumerCheckContract("/tmp/consumer", {
    rootTaskfileText: ROOT_WITH_CHECK_DEPS,
    verifyTaskfileText: VERIFY_YML_COMPLETE,
    ciWorkflows: new Map([[".github/workflows/ci.yml", ci]]),
    requiredGates: REQUIRED,
    enforce: true,
    ciWarnOnly: true,
  });
}

function reachabilityOf(ci: string) {
  const graph = parseWorkflowJobGraph(ci);
  const jobs = graph.jobs.map((job) =>
    attachRunCommands(job, extractWorkflowRunCommands(job.body)),
  );
  const carry = new Map<string, JobGateCarry>();
  for (const job of jobs) {
    const gates: string[] = [];
    let fullCheck = false;
    for (const cmd of job.runCommands) {
      if (runCommandIsFullCheck(cmd)) fullCheck = true;
      for (const gateId of REQUIRED) {
        if (runCommandInvokesGate(cmd, gateId) && !gates.includes(gateId)) gates.push(gateId);
      }
    }
    carry.set(job.id, { fullCheck, gates });
  }
  return findingsForWorkflowGraph(".github/workflows/ci.yml", { ...graph, jobs }, carry);
}

describe("classifyPullRequestCondition (#4015)", () => {
  it("accepts absent, always(), true, and PR-true-by-construction", () => {
    expect(classifyPullRequestCondition(null)).toBe("accept");
    expect(classifyPullRequestCondition("always()")).toBe("accept");
    expect(classifyPullRequestCondition("$" + "{{ always() }}")).toBe("accept");
    expect(classifyPullRequestCondition("true")).toBe("accept");
    expect(classifyPullRequestCondition("github.event_name == 'pull_request'")).toBe("accept");
    expect(classifyPullRequestCondition("$" + "{{ github.event_name == 'pull_request' }}")).toBe(
      "accept",
    );
  });

  it("flags skippable predicates and unknown event/vars/secrets", () => {
    expect(classifyPullRequestCondition("github.event_name == 'push'")).toBe("skippable");
    expect(classifyPullRequestCondition("success()")).toBe("skippable");
    expect(classifyPullRequestCondition("github.event.pull_request.draft == false")).toBe(
      "unknown",
    );
    expect(classifyPullRequestCondition("vars.RUN_GATES == 'true'")).toBe("unknown");
    expect(classifyPullRequestCondition("secrets.TOKEN != ''")).toBe("unknown");
  });

  it("accepts always() && needs.* lifecycle coordination (out of scope)", () => {
    expect(
      classifyPullRequestCondition("always() && needs.changes.outputs.artifact_only != 'true'"),
    ).toBe("accept");
  });
});

describe("parseWorkflowJobGraph (#4015)", () => {
  it("associates run: commands with job nodes (not concatenated text)", () => {
    const wf = `
on:
  pull_request:
jobs:
  lint:
    steps:
      - run: echo lint
  check:
    steps:
      - run: task check
`;
    const graph = parseWorkflowJobGraph(wf);
    expect(graph.jobs.map((j) => j.id)).toEqual(["lint", "check"]);
    const checkJob = graph.jobs.find((j) => j.id === "check");
    expect(checkJob).toBeDefined();
    if (checkJob === undefined) return;
    const check = attachRunCommands(checkJob, extractWorkflowRunCommands(checkJob.body));
    expect(check.runCommands.some((c) => runCommandIsFullCheck(c))).toBe(true);
  });
});

describe("consumer-check-contract PR reachability (#4015)", () => {
  it("fixture: unconditional gate job reports clean", () => {
    const ci = `
on:
  pull_request:
jobs:
  check:
    steps:
      - run: task check
`;
    const result = evaluateCi(ci);
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/clean/i);
    expect(reachabilityOf(ci)).toEqual([]);
  });

  it("fixture: job-level if: that can be false on pull_request is flagged", () => {
    const ci = `
on:
  pull_request:
jobs:
  check:
    if: github.event_name == 'push'
    steps:
      - run: task check
`;
    const result = evaluateCi(ci);
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/WARN/i);
    expect(result.findings.some((f) => f.detail.includes("can evaluate false"))).toBe(true);
    expect(result.findings.some((f) => f.remediation.includes("job 'check'"))).toBe(true);
  });

  it("fixture: continue-on-error: true on the gate job is flagged", () => {
    const ci = `
on:
  pull_request:
jobs:
  check:
    continue-on-error: true
    steps:
      - run: task check
`;
    const result = evaluateCi(ci);
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/WARN/i);
    expect(result.findings.some((f) => f.detail.includes("continue-on-error"))).toBe(true);
  });

  it("fixture: workflow-level paths: filter is flagged with pending-required-check consequence", () => {
    const ci = `
on:
  pull_request:
    paths:
      - 'packages/**'
jobs:
  check:
    steps:
      - run: task check
`;
    const result = evaluateCi(ci);
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/WARN/i);
    expect(result.findings.some((f) => f.detail.includes("paths"))).toBe(true);
    expect(result.findings.some((f) => f.detail.includes("pending"))).toBe(true);
  });

  it("fixture: if: always() reports clean", () => {
    const ci = `
on:
  pull_request:
jobs:
  check:
    if: always()
    steps:
      - run: task check
`;
    const result = evaluateCi(ci);
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/clean/i);
  });

  it("fixture: uses: indirection reports unknown with reason, never clean", () => {
    const ci = `
on:
  pull_request:
jobs:
  check:
    uses: org/repo/.github/workflows/reusable-check.yml@v1
`;
    const result = evaluateCi(ci);
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/WARN/i);
    // Verdict line is WARN…, not the clean composition success line.
    expect(result.message).not.toMatch(/verify_consumer_check_contract:\s*clean\b/i);
    expect(
      result.findings.some(
        (f) => f.detail.includes("unknown") && f.detail.toLowerCase().includes("uses"),
      ),
    ).toBe(true);
  });

  it("flags matrix exclude on a gate job", () => {
    const ci = `
on:
  pull_request:
jobs:
  check:
    strategy:
      matrix:
        os: [ubuntu-latest]
        exclude:
          - os: ubuntu-latest
    steps:
      - run: task check
`;
    const kinds = reachabilityOf(ci).map((f) => f.kind);
    expect(kinds).toContain("matrix-exclude");
  });
});
