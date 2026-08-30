/**
 * Merge-chokepoint gate scoping in the consumer check contract (#3893).
 *
 * Composing `verify:orphan-active` unscoped on a check aggregate re-imports the
 * defect: a repo-wide lifecycle scan that fails a candidate for residue another
 * merge stranded.
 */

import { describe, expect, it } from "vitest";
import {
  cliArgsCarry,
  depEntryCliArgs,
  evaluateConsumerCheckContract,
  extractCheckDepEntries,
  extractCheckDeps,
  MERGE_CHOKEPOINT_SCOPED_GATE_ARGS,
  parseYamlScalar,
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

/** Flag present as text only -- the gate still receives the unscoped form. */
const DECOY_COMMENT_ENTRY = `      - task: verify:orphan-active
        # someday pass --changed-only here
        vars:
          CLI_ARGS: "--skip-gh"
`;

const DECOY_SIBLING_VAR_ENTRY = `      - task: verify:orphan-active
        vars:
          NOTE: "--changed-only"
`;

const INLINE_SCOPED_ENTRY = `      - task: verify:orphan-active
        vars: { CLI_ARGS: "--changed-only" }
`;

const TRAILING_COMMENT_ENTRY = `      - task: verify:orphan-active
        vars:
          CLI_ARGS: "--changed-only" # merge chokepoint
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

describe("depEntryCliArgs (#3893)", () => {
  function argsFor(entry: string): string | null {
    const entries = extractCheckDepEntries(rootTaskfile(entry), "check:consumer");
    const orphan = entries.find((row) => row.name === "verify:orphan-active");
    return orphan === undefined ? null : depEntryCliArgs(orphan.body);
  }

  it("reads the block form", () => {
    expect(argsFor(SCOPED_ENTRY)).toBe("--changed-only");
  });

  it("reads the inline flow form", () => {
    expect(argsFor(INLINE_SCOPED_ENTRY)).toBe("--changed-only");
  });

  it("drops a trailing YAML comment", () => {
    expect(argsFor(TRAILING_COMMENT_ENTRY)).toBe("--changed-only");
  });

  it("returns null for a bare dep", () => {
    expect(argsFor(UNSCOPED_ENTRY)).toBeNull();
  });

  it("ignores the flag in a comment or a sibling variable", () => {
    expect(argsFor(DECOY_COMMENT_ENTRY)).toBe("--skip-gh");
    expect(argsFor(DECOY_SIBLING_VAR_ENTRY)).toBeNull();
  });

  it("unquotes scalars and strips trailing comments", () => {
    expect(parseYamlScalar('"--changed-only"')).toBe("--changed-only");
    expect(parseYamlScalar("'--changed-only'")).toBe("--changed-only");
    expect(parseYamlScalar("--changed-only # note")).toBe("--changed-only");
    expect(parseYamlScalar('"unterminated')).toBe("unterminated");
  });

  it("matches on token boundaries, not substrings", () => {
    expect(cliArgsCarry("--changed-only", "--changed-only")).toBe(true);
    expect(cliArgsCarry("--skip-gh --changed-only", "--changed-only")).toBe(true);
    expect(cliArgsCarry("--changed-only=1", "--changed-only")).toBe(true);
    expect(cliArgsCarry("--changed-only-later", "--changed-only")).toBe(false);
    expect(cliArgsCarry(null, "--changed-only")).toBe(false);
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

  it("fails closed when the flag is only a comment or a sibling variable", () => {
    for (const entry of [DECOY_COMMENT_ENTRY, DECOY_SIBLING_VAR_ENTRY]) {
      const result = evaluateRoot(entry, true);
      expect(result.exitCode).toBe(1);
      expect(result.findings.some((row) => row.gateId === "verify:orphan-active")).toBe(true);
    }
  });

  it("accepts the inline flow form", () => {
    expect(evaluateRoot(INLINE_SCOPED_ENTRY, true).exitCode).toBe(0);
  });

  it("fails closed when a bare duplicate follows a scoped entry", () => {
    const result = evaluateRoot(`${SCOPED_ENTRY}${UNSCOPED_ENTRY}`, true);
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((row) => row.gateId === "verify:orphan-active")).toBe(true);
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
