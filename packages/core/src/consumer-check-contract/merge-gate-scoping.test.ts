/**
 * Merge-chokepoint gate scoping in the consumer check contract (#3893).
 *
 * Composing `verify:orphan-active` unscoped on a check aggregate re-imports the
 * defect: a repo-wide lifecycle scan that fails a candidate for residue another
 * merge stranded.
 */

import { describe, expect, it } from "vitest";
import {
  evaluateConsumerCheckContract,
  extractCheckDepEntries,
  extractCheckDeps,
  MERGE_CHOKEPOINT_SCOPED_GATE_ARGS,
} from "./evaluate.js";

const VERIFY_YML = `
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
  orphan-active:
    cmds:
      - echo ok
`;

const SCOPED_ENTRY = `      - task: verify:orphan-active
        vars:
          CLI_ARGS: "--changed-only"
`;

const UNSCOPED_ENTRY = `      - verify:orphan-active
`;

function rootTaskfile(orphanEntry: string): string {
  return `version: '3'
tasks:
  check:consumer:
    deps:
      - verify:test-boundary
      - verify:scope-provenance
      - verify:consumer-check-contract
${orphanEntry}    cmds:
      - echo ok
`;
}

function evaluateRoot(orphanEntry: string, frameworkSource: boolean) {
  return evaluateConsumerCheckContract("/repo", {
    rootTaskfileText: rootTaskfile(orphanEntry),
    verifyTaskfileText: VERIFY_YML,
    ciWorkflows: new Map(),
    frameworkSource,
  });
}

describe("extractCheckDepEntries (#3893)", () => {
  it("keeps the YAML nested under an object-form dep", () => {
    const entries = extractCheckDepEntries(rootTaskfile(SCOPED_ENTRY), "check:consumer");
    const orphan = entries.find((entry) => entry.name === "verify:orphan-active");
    expect(orphan?.body).toContain('CLI_ARGS: "--changed-only"');
  });

  it("gives a bare dep an empty body", () => {
    const entries = extractCheckDepEntries(rootTaskfile(UNSCOPED_ENTRY), "check:consumer");
    expect(entries.find((entry) => entry.name === "verify:orphan-active")?.body).toBe("");
  });

  it("keeps extractCheckDeps returning bare names", () => {
    expect(extractCheckDeps(rootTaskfile(SCOPED_ENTRY), "check:consumer")).toEqual([
      "verify:test-boundary",
      "verify:scope-provenance",
      "verify:consumer-check-contract",
      "verify:orphan-active",
    ]);
  });
});

describe("merge-chokepoint gate scoping (#3893)", () => {
  it("names verify:orphan-active --changed-only as the scoped composition", () => {
    expect(MERGE_CHOKEPOINT_SCOPED_GATE_ARGS.get("verify:orphan-active")).toBe("--changed-only");
  });

  it("passes when the aggregate carries the scoping argument", () => {
    const result = evaluateRoot(SCOPED_ENTRY, true);
    expect(result.exitCode).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("fails closed on framework source when the aggregate composes it unscoped", () => {
    const result = evaluateRoot(UNSCOPED_ENTRY, true);
    expect(result.exitCode).toBe(1);
    const finding = result.findings.find((row) => row.gateId === "verify:orphan-active");
    expect(finding?.surface).toBe("check-task");
    expect(finding?.detail).toContain("without --changed-only");
    expect(finding?.remediation).toContain("CLI_ARGS");
  });

  it("warns rather than fails for a consumer deposit still on the unscoped form", () => {
    const result = evaluateRoot(UNSCOPED_ENTRY, false);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("WARN");
    expect(result.findings.some((row) => row.gateId === "verify:orphan-active")).toBe(true);
  });

  it("says nothing when the aggregate does not compose the gate at all", () => {
    const result = evaluateRoot("", true);
    expect(result.exitCode).toBe(0);
    expect(result.findings).toEqual([]);
  });
});
