import { describe, expect, it } from "vitest";
import { evaluateVerifyAcFromPlan } from "./evaluate.js";

/**
 * verify:ac must agree with the #3511 demotion: a fat fence@ / inline@ ledger
 * on a brief with no structured commands does not fail the product-first gate.
 */

const REJECTED_3502 = [
  {
    command:
      "[1/13] Pre-flight git status... FAIL (working tree is dirty; commit/stash or pass --allow-dirty)",
    reason: 'shell metacharacter "(" is not allowed in literal AC commands',
    sourceSpan: "fence@L13",
  },
  {
    command: "pnpm run lint",
    reason:
      "package-manager args must be test|exec vitest|run test|run check|--version (arbitrary scripts/network install denied for ambient-authority)",
    sourceSpan: "inline@L22",
  },
];

describe("verify:ac does not block fenced-transcript phantoms (#3511)", () => {
  it("passes the #3502 none_stated + fence@/inline@ ledger", () => {
    const verify = evaluateVerifyAcFromPlan(
      {
        id: "3511-3502-fixture",
        title: "agent-host working dirs",
        acceptance: { commands: [], none_stated: true, source_rung: "derived" },
        metadata: {
          literal_acceptance_commands: [],
          literal_acceptance_rejected: REJECTED_3502,
          swarm: {},
        },
        items: [],
      },
      {
        projectRoot: process.cwd(),
        captureFromNarratives: false,
        hasSuiteFloor: true,
        bankOnPass: false,
        reuseMode: "never",
        runner: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      },
    );
    expect(verify.ok).toBe(true);
    expect(verify.resolution).not.toBe("rejected-noop");
    expect(verify.message).not.toContain("verify:ac FAILED");
  });
});
