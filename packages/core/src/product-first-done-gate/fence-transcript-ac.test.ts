import { describe, expect, it } from "vitest";
import { captureLiteralAcceptanceCommandsDetailed } from "../literal-acceptance/capture.js";
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

  it("does not silently pass when transcript skip leaves zero commands on a suite floor", () => {
    const overview = [
      "## Acceptance",
      "```bash",
      "FAIL tests/foo.test.ts",
      "Error: expected 1",
      "$ pnpm exec vitest run packages/core/src",
      "$ task check",
      "```",
    ].join("\n");
    const captured = captureLiteralAcceptanceCommandsDetailed(overview);
    expect(captured.commands).toEqual([]);
    expect(captured.rejected).toEqual([]);
    expect(captured.transcriptPromptSkipped).toBeGreaterThan(0);

    const verify = evaluateVerifyAcFromPlan(
      {
        id: "3511-with-floor-transcript-empty",
        title: "transcript skip emptied the fence",
        acceptance: { commands: [], none_stated: true, source_rung: "derived" },
        narratives: { Overview: overview },
        metadata: {
          literal_acceptance_commands: [],
          literal_acceptance_rejected: [],
          swarm: {},
        },
        items: [],
      },
      {
        captureFromNarratives: true,
        hasSuiteFloor: true,
        bankOnPass: false,
        reuseMode: "never",
        runner: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      },
    );
    expect(verify.ok).toBe(false);
    expect(verify.code).toBe(1);
    expect(verify.resolution).not.toBe("empty-pass");
    expect(verify.resolvedCommandCount).toBe(0);
    expect(verify.message).toMatch(/transcript skip left zero captured commands/);
  });
});
