import { describe, expect, it } from "vitest";
import { evaluateLiteralAcceptanceFromPlan } from "../literal-acceptance/evaluate.js";
import {
  clauseWalkBlocks,
  formatAcceptanceVerdict,
  resolveAcceptanceGateProfile,
  resolveAcceptanceVerdict,
} from "./acceptance-resolver.js";
import { evaluateVerifyAcFromPlan } from "./evaluate.js";

const greenRunner = () => ({ exitCode: 0, stdout: "", stderr: "" });

const baseOptions = {
  projectRoot: process.cwd(),
  captureFromNarratives: false,
  hasSuiteFloor: true,
  bankOnPass: false,
  reuseMode: "never" as const,
};

/** #3396 refusal reason, verbatim — the text `isNoopRefusalReason` matches. */
const NOOP_REASON =
  "acceptance commands must be able to fail; name a command that exercises the artifact";

function proseRejectedPlan(): Record<string, unknown> {
  return {
    id: "3497-advisory",
    title: "structured beats scraped",
    acceptance: {
      commands: [{ command: "pnpm exec vitest run packages/core/src/swarm/" }],
      none_stated: false,
      source_rung: "derived",
    },
    metadata: {
      literal_acceptance_commands: [
        { command: "pnpm exec vitest run packages/core/src/swarm/", source: "explicit" },
      ],
      literal_acceptance_rejected: [
        { command: "echo done", reason: NOOP_REASON, sourceSpan: "inline@Overview" },
      ],
    },
    items: [],
  };
}

describe("clauseWalkBlocks (#3497 / #3835)", () => {
  it("always blocks a clause the shipped artifact contradicts", () => {
    expect(
      clauseWalkBlocks({
        failed: 1,
        walked: 4,
        adjudicableUnverified: 0,
        hasGreenExecutableRun: true,
      }),
    ).toBe(true);
  });

  it("does not block when every clause with an oracle verified", () => {
    expect(
      clauseWalkBlocks({
        failed: 0,
        walked: 4,
        adjudicableUnverified: 0,
        hasGreenExecutableRun: false,
      }),
    ).toBe(false);
  });

  it("blocks an unmet oracle only when nothing executable ran green", () => {
    expect(
      clauseWalkBlocks({
        failed: 0,
        walked: 4,
        adjudicableUnverified: 4,
        hasGreenExecutableRun: false,
      }),
    ).toBe(true);
    expect(
      clauseWalkBlocks({
        failed: 0,
        walked: 4,
        adjudicableUnverified: 4,
        hasGreenExecutableRun: true,
      }),
    ).toBe(false);
  });

  it("does not block an empty walk", () => {
    expect(
      clauseWalkBlocks({
        failed: 0,
        walked: 0,
        adjudicableUnverified: 0,
        hasGreenExecutableRun: false,
      }),
    ).toBe(false);
  });

  it("does not block when no walked clause is adjudicable (#3826)", () => {
    expect(
      clauseWalkBlocks({
        failed: 0,
        walked: 8,
        adjudicableUnverified: 0,
        hasGreenExecutableRun: false,
      }),
    ).toBe(false);
  });

  it("blocks a verified set that still leaves one oracle unmet (#3835)", () => {
    // Seven verified clauses no longer cover the eighth. As a set predicate,
    // `verified > 0` returned false here.
    expect(
      clauseWalkBlocks({
        failed: 0,
        walked: 8,
        adjudicableUnverified: 1,
        hasGreenExecutableRun: false,
      }),
    ).toBe(true);
  });
});

describe("resolveAcceptanceGateProfile (#3497)", () => {
  it("gives each reader one shared option set", () => {
    expect(resolveAcceptanceGateProfile("complete")).toEqual({
      captureFromNarratives: true,
      checkIntegrated: false,
      reuseMode: "bank",
    });
    expect(resolveAcceptanceGateProfile("check")).toEqual({
      captureFromNarratives: false,
      checkIntegrated: true,
      reuseMode: "auto",
    });
    expect(resolveAcceptanceGateProfile("standalone")).toEqual({
      captureFromNarratives: undefined,
      checkIntegrated: false,
      reuseMode: "auto",
    });
  });
});

describe("resolveAcceptanceVerdict (#3497)", () => {
  it("names executable-pass and reports the runs it read", () => {
    const verdict = resolveAcceptanceVerdict({
      ok: true,
      code: 0,
      message: "verify:ac passed (#3284)",
      resolution: "verified-pass",
      sourceRung: "derived",
      runs: [{ ok: true, command: "pnpm --version" }],
      commands: [{}],
      acceptance: { commands: [{}] },
    });
    expect(verdict.predicate).toBe("executable-pass");
    expect(verdict.observed).toContain("1/1 command(s)");
    expect(formatAcceptanceVerdict(verdict)).toContain("executable-pass");
  });

  it("names clause-walk-failed with the counts it actually read", () => {
    const verdict = resolveAcceptanceVerdict({
      ok: false,
      code: 1,
      message: "verify:ac FAILED (#3284)",
      resolution: "fail",
      sourceRung: "derived",
      runs: [{ ok: true, command: "pnpm --version" }],
      commands: [{}],
      acceptance: { commands: [{}] },
      clauseOutcomes: [
        { id: 1, outcome: "failed" },
        { id: 2, outcome: "unverifiable" },
      ],
    });
    expect(verdict.predicate).toBe("clause-walk-failed");
    expect(verdict.observed).toContain("1 failed");
    expect(verdict.remedy).toContain("#3323");
  });
});

describe("verify:ac honours the #3484 advisory demotion (#3497)", () => {
  it("does not block on a prose-derived safety rejection when structured commands exist", () => {
    const plan = proseRejectedPlan();
    const literal = evaluateLiteralAcceptanceFromPlan(structuredClone(plan), {
      projectRoot: process.cwd(),
      runner: greenRunner,
      captureFromNarratives: false,
    });
    // verify:literal-ac already honoured the demotion (#3484 / PR #3486).
    expect(literal.ok).toBe(true);
    expect(literal.advisoryRejected).toHaveLength(1);
    expect(literal.rejected).toHaveLength(0);

    // verify:ac must now agree — it previously sniffed the advisory ledger text
    // out of its own rendered message and returned rejected-noop.
    const verify = evaluateVerifyAcFromPlan(structuredClone(plan), {
      ...baseOptions,
      runner: greenRunner,
    });
    expect(verify.ok).toBe(true);
    expect(verify.resolution).toBe("verified-pass");
    expect(verify.message).toContain("do NOT block");
    expect(verify.message).not.toContain("verify:ac FAILED");
  });

  it("still blocks a no-op command the plan states structurally", () => {
    const verify = evaluateVerifyAcFromPlan(
      {
        id: "3497-structured-noop",
        title: "structured no-op",
        acceptance: {
          commands: [{ command: "pnpm exec vitest run packages/core/src/swarm/" }],
          none_stated: false,
          source_rung: "derived",
        },
        metadata: {
          literal_acceptance_commands: [
            { command: "pnpm exec vitest run packages/core/src/swarm/", source: "explicit" },
          ],
          // No prose span → structured provenance → never demoted to advisory.
          literal_acceptance_rejected: [
            { command: "echo done", reason: NOOP_REASON, sourceSpan: "swarm.verify_commands" },
          ],
        },
        items: [],
      },
      { ...baseOptions, runner: greenRunner },
    );
    expect(verify.ok).toBe(false);
    expect(verify.resolution).toBe("rejected-noop");
  });
});

describe("verify:ac message agrees with its verdict (#3497)", () => {
  it("never reports 'passed' for a result it refused", () => {
    const verify = evaluateVerifyAcFromPlan(
      {
        id: "3497-label",
        title: "unshipped clause",
        acceptance: {
          commands: [{ command: "pnpm exec vitest run packages/core/src/swarm/" }],
          none_stated: false,
          source_rung: "derived",
          ambiguity_attestation: "none_found",
          clauses: [
            {
              id: 1,
              text: "packages/core/src/not-shipped-3497.ts exists at the stated path",
              artifact_path: "packages/core/src/not-shipped-3497.ts",
              ambiguous: false,
            },
          ],
        },
        metadata: {
          literal_acceptance_commands: [
            { command: "pnpm exec vitest run packages/core/src/swarm/", source: "explicit" },
          ],
          swarm: { file_scope: ["packages/core/src/not-shipped-3497.ts"] },
        },
        items: [],
      },
      { ...baseOptions, runner: greenRunner },
    );
    expect(verify.ok).toBe(false);
    expect(verify.message).toContain("verify:ac FAILED (#3284)");
    expect(verify.message).not.toContain("verify:ac passed (#3284)");
    expect(verify.message).toContain("clause-walk-failed");
  });
});
