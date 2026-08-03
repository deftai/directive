import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHECK_GRAPH_REQUIRED_NAMESPACES,
  CONSUMER_GATE_INTEGRITY_RECOVERY,
  checkGraphOptionalIncludeViolations,
  evaluateConsumerGateIntegrity,
  formatConsumerGateIntegrityFailure,
  gateLocalName,
  gateNamespace,
  includeTaskfileRel,
  parseTaskfileIncludes,
  requiredNamespacesForGates,
  taskDefinedInTaskfileYaml,
} from "./consumer-gate-integrity.js";
import { CONSUMER_CHECK_GATES, checkGateId } from "./gate-lists.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempDeposit(): string {
  const dir = mkdtempSync(join(tmpdir(), "deft-3070-"));
  tempDirs.push(dir);
  return dir;
}

describe("gate id helpers (#3070)", () => {
  it("splits namespaced gates", () => {
    expect(gateNamespace("verify:orphan-active")).toBe("verify");
    expect(gateLocalName("verify:orphan-active")).toBe("orphan-active");
    expect(includeTaskfileRel("verify")).toBe("tasks/verify.yml");
  });

  it("treats bare root tasks as non-namespaced", () => {
    expect(gateNamespace("doctor")).toBeNull();
    expect(gateLocalName("doctor")).toBe("doctor");
    expect(gateNamespace("verify-strategy-output")).toBeNull();
  });

  it("derives required namespaces from CONSUMER_CHECK_GATES", () => {
    const ns = requiredNamespacesForGates();
    expect(ns).toContain("verify");
    expect(ns).toContain("toolchain");
    expect(ns).toContain("vbrief");
    for (const required of CHECK_GRAPH_REQUIRED_NAMESPACES) {
      expect(ns).toContain(required);
    }
  });
});

describe("taskDefinedInTaskfileYaml (#3070)", () => {
  it("detects top-level task keys", () => {
    const yaml = `version: '3'\ntasks:\n  orphan-active:\n    cmds: [echo ok]\n  nested:\n    cmds: []\n`;
    expect(taskDefinedInTaskfileYaml(yaml, "orphan-active")).toBe(true);
    expect(taskDefinedInTaskfileYaml(yaml, "missing")).toBe(false);
  });
});

describe("parseTaskfileIncludes (#3070)", () => {
  it("reads taskfile path and optional flag", () => {
    const text = `
version: '3'
includes:
  verify:
    taskfile: ./tasks/verify.yml
    optional: true
  swarm:
    taskfile: ./tasks/swarm.yml
    optional: false
  toolchain:
    taskfile: ./tasks/toolchain.yml
`;
    const map = parseTaskfileIncludes(text);
    expect(map.get("verify")).toEqual({ taskfile: "./tasks/verify.yml", optional: true });
    expect(map.get("swarm")).toEqual({ taskfile: "./tasks/swarm.yml", optional: false });
    expect(map.get("toolchain")?.optional).toBe(false);
  });
});

describe("evaluateConsumerGateIntegrity (#3070)", () => {
  it("passes against the real framework checkout", () => {
    const result = evaluateConsumerGateIntegrity(repoRoot);
    expect(result.ok, formatConsumerGateIntegrityFailure(result)).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("every CONSUMER_CHECK_GATES id is covered by the integrity pass on shipped tree", () => {
    const result = evaluateConsumerGateIntegrity(repoRoot);
    expect(result.ok).toBe(true);
    for (const gate of CONSUMER_CHECK_GATES.map(checkGateId)) {
      expect(result.findings.find((f) => f.gateId === gate)).toBeUndefined();
    }
  });

  it("skips (ok) when root Taskfile is absent", () => {
    const dir = tempDeposit();
    const result = evaluateConsumerGateIntegrity(dir);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("fails loud when tasks/verify.yml is missing (regression fixture)", () => {
    const dir = tempDeposit();
    mkdirSync(join(dir, "tasks"), { recursive: true });
    writeFileSync(
      join(dir, "Taskfile.yml"),
      `version: '3'
includes:
  verify:
    taskfile: ./tasks/verify.yml
    optional: true
  toolchain:
    taskfile: ./tasks/toolchain.yml
    optional: true
  vbrief:
    taskfile: ./tasks/vbrief.yml
    optional: true
tasks:
  doctor:
    cmds: [echo doctor]
  verify-strategy-output:
    cmds: [echo strategy]
`,
      "utf8",
    );
    // toolchain + vbrief present; verify.yml intentionally missing
    writeFileSync(
      join(dir, "tasks", "toolchain.yml"),
      "version: '3'\ntasks:\n  check-consumer:\n    cmds: [echo ok]\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "tasks", "vbrief.yml"),
      "version: '3'\ntasks:\n  validate:\n    cmds: [echo ok]\n",
      "utf8",
    );

    const result = evaluateConsumerGateIntegrity(dir);
    expect(result.ok).toBe(false);
    const orphan = result.findings.find((f) => f.gateId === "verify:orphan-active");
    expect(orphan).toBeDefined();
    expect(orphan?.kind).toBe("missing-include-file");
    expect(orphan?.detail).toMatch(/verify\.yml/);
    expect(result.recovery).toBe(CONSUMER_GATE_INTEGRITY_RECOVERY);
    const formatted = formatConsumerGateIntegrityFailure(result);
    expect(formatted).toContain("consumer gate integrity failed");
    expect(formatted).toContain("deft update");
    expect(formatted).not.toMatch(/exit status 20[01]/);
  });

  it("fails when verify.yml exists but orphan-active task is absent", () => {
    const dir = tempDeposit();
    mkdirSync(join(dir, "tasks"), { recursive: true });
    writeFileSync(
      join(dir, "Taskfile.yml"),
      `version: '3'
includes:
  verify:
    taskfile: ./tasks/verify.yml
    optional: false
  toolchain:
    taskfile: ./tasks/toolchain.yml
  vbrief:
    taskfile: ./tasks/vbrief.yml
tasks:
  doctor:
    cmds: [echo doctor]
  verify-strategy-output:
    cmds: [echo strategy]
`,
      "utf8",
    );
    writeFileSync(
      join(dir, "tasks", "verify.yml"),
      "version: '3'\ntasks:\n  branch:\n    cmds: [echo branch]\n  cache-fresh:\n    cmds: [echo cache]\n  wip-cap:\n    cmds: [echo wip]\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "tasks", "toolchain.yml"),
      "version: '3'\ntasks:\n  check-consumer:\n    cmds: [echo ok]\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "tasks", "vbrief.yml"),
      "version: '3'\ntasks:\n  validate:\n    cmds: [echo ok]\n",
      "utf8",
    );

    const result = evaluateConsumerGateIntegrity(dir);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.gateId === "verify:orphan-active")).toBe(true);
    expect(result.findings.find((f) => f.gateId === "verify:orphan-active")?.kind).toBe(
      "missing-task-definition",
    );
  });
});

describe("checkGraphOptionalIncludeViolations (#3070)", () => {
  it("flags optional: true on check-graph namespaces", () => {
    const text = `
includes:
  verify:
    taskfile: ./tasks/verify.yml
    optional: true
  toolchain:
    taskfile: ./tasks/toolchain.yml
    optional: false
  vbrief:
    taskfile: ./tasks/vbrief.yml
    optional: true
`;
    const bad = checkGraphOptionalIncludeViolations(text, ["verify", "toolchain", "vbrief"]);
    expect(bad.some((b) => b.startsWith("verify"))).toBe(true);
    expect(bad.some((b) => b.startsWith("vbrief"))).toBe(true);
    expect(bad.some((b) => b.startsWith("toolchain"))).toBe(false);
  });

  it("framework Taskfile keeps check-graph includes non-optional", () => {
    const text = readRepoTaskfile();
    const bad = checkGraphOptionalIncludeViolations(text);
    expect(bad, `optional check-graph includes: ${bad.join("; ")}`).toEqual([]);
  });
});

function readRepoTaskfile(): string {
  return readFileSync(join(repoRoot, "Taskfile.yml"), "utf8");
}
