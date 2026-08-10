import { describe, expect, it } from "vitest";
import { computeGateResult } from "./compute.js";
import type { CheckRunRecord } from "./gh.js";
import {
  evaluateSlizardGate,
  isSlizardCheck,
  parseSlizardVerdict,
  SLIZARD_CHECK_NAME,
} from "./slizard-gate.js";
import { withGraphqlInlineStub } from "./test-gh-fixtures.helpers.js";
import type { RunGhFn } from "./types.js";

const BLOCKING_SUMMARY = [
  "Decision: request_changes",
  "Merge impact: blocking",
  "Findings: 2 (P0: 0, P1: 1, P2: 0, P3: 0)",
  "Important files: packages/core/src/doctor/network-gate.test.ts (P1, 2 finding(s))",
].join("\n");

const CLEAN_SUMMARY = ["Decision: approve", "Merge impact: non-blocking", "Findings: 0"].join("\n");

function slizardRun(overrides: Partial<CheckRunRecord> = {}): CheckRunRecord {
  return {
    name: SLIZARD_CHECK_NAME,
    status: "completed",
    conclusion: "success",
    summary: CLEAN_SUMMARY,
    ...overrides,
  };
}

describe("isSlizardCheck", () => {
  it("matches the canonical name and case-insensitive variants", () => {
    expect(isSlizardCheck("SLizard")).toBe(true);
    expect(isSlizardCheck("slizard review")).toBe(true);
    expect(isSlizardCheck("TypeScript (build + lint + test)")).toBe(false);
  });
});

describe("parseSlizardVerdict", () => {
  it("extracts decision, merge impact, and severity counts", () => {
    const v = parseSlizardVerdict(BLOCKING_SUMMARY);
    expect(v.decision).toBe("request_changes");
    expect(v.mergeImpact).toBe("blocking");
    expect(v.p0Count).toBe(0);
    expect(v.p1Count).toBe(1);
    expect(v.p2Count).toBe(0);
  });

  it("returns nulls for a missing/empty summary", () => {
    const v = parseSlizardVerdict(undefined);
    expect(v.decision).toBeNull();
    expect(v.mergeImpact).toBeNull();
    expect(v.p0Count).toBeNull();
  });
});

describe("evaluateSlizardGate", () => {
  it("blocks on a request_changes decision", () => {
    const result = evaluateSlizardGate([slizardRun({ summary: BLOCKING_SUMMARY })]);
    expect(result.summary.ready_state).toBe("blocked");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("SLizard review is blocking");
    expect(result.failures[0]).toContain("decision=request_changes");
    expect(result.failures[0]).toContain("P1=1");
  });

  it("blocks on a blocking merge impact even with a non-failure conclusion", () => {
    const summary = ["Decision: comment", "Merge impact: blocking"].join("\n");
    const result = evaluateSlizardGate([slizardRun({ conclusion: "neutral", summary })]);
    expect(result.summary.ready_state).toBe("blocked");
    expect(result.failures[0]).toContain("merge impact=blocking");
  });

  it("blocks on a failed conclusion", () => {
    const result = evaluateSlizardGate([slizardRun({ conclusion: "failure", summary: undefined })]);
    expect(result.summary.ready_state).toBe("blocked");
    expect(result.failures[0]).toContain("conclusion=failure");
  });

  it("passes a clean approve verdict", () => {
    const result = evaluateSlizardGate([slizardRun()]);
    expect(result.summary.ready_state).toBe("ready");
    expect(result.failures).toHaveLength(0);
  });

  it("treats an in-progress SLizard run as not-ready-yet", () => {
    const result = evaluateSlizardGate([
      slizardRun({ status: "in_progress", conclusion: "none", summary: undefined }),
    ]);
    expect(result.summary.ready_state).toBe("not_ready_yet");
    expect(result.failures[0]).toContain("still in progress");
  });

  it("skips (no block) when no SLizard check-run is present", () => {
    const other: CheckRunRecord = {
      name: "TypeScript (build + lint + test)",
      status: "completed",
      conclusion: "success",
    };
    const result = evaluateSlizardGate([other]);
    expect(result.summary.ready_state).toBe("skipped");
    expect(result.summary.present).toBe(false);
    expect(result.failures).toHaveLength(0);
  });

  it("skips when --skip-slizard is set even if the verdict is blocking", () => {
    const result = evaluateSlizardGate([slizardRun({ summary: BLOCKING_SUMMARY })], {
      skipSlizard: true,
    });
    expect(result.summary.ready_state).toBe("skipped");
    expect(result.failures).toHaveLength(0);
  });
});

const HEAD = "abc1234567890def1234567890abcdef12345678";

function fakeRunGh(slizardSummary: string, slizardConclusion = "failure"): RunGhFn {
  return withGraphqlInlineStub((cmd) => {
    const joined = cmd.join(" ");
    if (joined.includes("headRefOid")) {
      return { returncode: 0, stdout: `${HEAD}\n`, stderr: "" };
    }
    if (joined.includes("/comments")) {
      return {
        returncode: 0,
        stdout:
          "## Greptile Summary\n\n**Confidence Score: 5/5**\n\n" +
          `Last reviewed commit: [x](https://github.com/deftai/directive/commit/${HEAD})\n`,
        stderr: "",
      };
    }
    if (joined.includes("/check-runs")) {
      return {
        returncode: 0,
        stdout: JSON.stringify({
          check_runs: [
            {
              name: "TypeScript (build + lint + test)",
              status: "completed",
              conclusion: "success",
            },
            {
              name: "SLizard",
              status: "completed",
              conclusion: slizardConclusion,
              output: { summary: slizardSummary },
            },
          ],
        }),
        stderr: "",
      };
    }
    if (joined.includes("/rules/branches/") || joined.includes("/protection")) {
      return { returncode: 1, stdout: "", stderr: "HTTP 404: Not Found" };
    }
    if (joined.includes("/pulls/")) {
      return {
        returncode: 0,
        stdout: JSON.stringify({
          head: { sha: HEAD },
          base: { ref: "master" },
          mergeable: true,
          mergeable_state: "clean",
        }),
        stderr: "",
      };
    }
    return { returncode: 1, stdout: "", stderr: "unexpected" };
  });
}

describe("computeGateResult SLizard integration", () => {
  it("blocks merge when SLizard requests changes even though Greptile + CI are clean", () => {
    const result = computeGateResult(1, "deftai/directive", fakeRunGh(BLOCKING_SUMMARY));
    expect(result.failures.some((f) => f.includes("SLizard review is blocking"))).toBe(true);
    const slizard = result.partialData.slizard as Record<string, unknown>;
    expect(slizard.ready_state).toBe("blocked");
    // SLizard must be excluded from the generic CI required set (no double-count).
    const ci = result.partialData.ci as Record<string, unknown>;
    expect(ci.ignored_checks).toContain("SLizard");
    expect(ci.ready_state).toBe("ready");
  });

  it("is merge-ready when SLizard approves", () => {
    const result = computeGateResult(1, "deftai/directive", fakeRunGh(CLEAN_SUMMARY, "success"));
    expect(result.failures).toHaveLength(0);
    const slizard = result.partialData.slizard as Record<string, unknown>;
    expect(slizard.ready_state).toBe("ready");
  });

  it("--skip-slizard overrides a blocking SLizard verdict", () => {
    const result = computeGateResult(1, "deftai/directive", fakeRunGh(BLOCKING_SUMMARY), {
      skipSlizard: true,
    });
    expect(result.failures.some((f) => f.includes("SLizard"))).toBe(false);
  });
});
