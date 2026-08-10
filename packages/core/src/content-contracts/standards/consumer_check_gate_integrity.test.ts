/**
 * Content/deposit integrity for CONSUMER_CHECK_GATES (#3070).
 *
 * Guards the shipped Taskfile.yml + tasks/ tree so every consumer check gate
 * (including verify:orphan-active) resolves without optional silent omit.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkGraphOptionalIncludeViolations,
  evaluateConsumerGateIntegrity,
  formatConsumerGateIntegrityFailure,
  requiredNamespacesForGates,
} from "../../check/consumer-gate-integrity.js";
import { CONSUMER_CHECK_GATES, checkGateId } from "../../check/gate-lists.js";
import { repoRoot } from "./_helpers.js";

describe("consumer check-gate integrity (#3070)", () => {
  it("every CONSUMER_CHECK_GATES entry resolves in the shipped Taskfile+includes", () => {
    const result = evaluateConsumerGateIntegrity(repoRoot());
    expect(result.ok, formatConsumerGateIntegrityFailure(result)).toBe(true);
  });

  it("ships verify:orphan-active on the consumer gate list", () => {
    expect(CONSUMER_CHECK_GATES.map(checkGateId)).toContain("verify:orphan-active");
  });

  it("ships verify:completed-tracked on the consumer gate list (#3264)", () => {
    expect(CONSUMER_CHECK_GATES.map(checkGateId)).toContain("verify:completed-tracked");
  });

  it("makes check-graph namespaces non-optional in root Taskfile.yml", () => {
    const text = readFileSync(join(repoRoot(), "Taskfile.yml"), "utf8");
    const bad = checkGraphOptionalIncludeViolations(text, requiredNamespacesForGates());
    expect(bad, `optional check-graph includes: ${bad.join("; ")}`).toEqual([]);
  });

  it("Taskfile check:consumer deps include verify:orphan-active", () => {
    const text = readFileSync(join(repoRoot(), "Taskfile.yml"), "utf8");
    expect(text).toMatch(/check:consumer:[\s\S]*?verify:orphan-active/);
  });

  it("Taskfile check:consumer deps include verify:completed-tracked (#3264)", () => {
    const text = readFileSync(join(repoRoot(), "Taskfile.yml"), "utf8");
    expect(text).toMatch(/check:consumer:[\s\S]*?verify:completed-tracked/);
  });

  it("content package prepack ships tasks/ (incl. verify.yml) with Taskfile", () => {
    const pkg = readFileSync(join(repoRoot(), "packages", "content", "package.json"), "utf8");
    expect(pkg).toContain("Taskfile.yml");
    expect(pkg).toContain("tasks");
    expect(pkg).toMatch(/'\.githooks',\s*'Taskfile\.yml',\s*'tasks'/);
  });
});
