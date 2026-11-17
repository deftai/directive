import { describe, expect, it } from "vitest";
import {
  advisoryBotReviewFailures,
  buildCiSummaryLine,
  evaluateCiGate,
  isBotReviewCheck,
  isRedCompletedRun,
  newestRunPerCheck,
} from "./ci-gate.js";
import type { CheckRunRecord } from "./gh.js";
import { DEFAULT_CAPACITY_STALL_MS } from "./runner-capacity-stall.js";

const NOW = Date.parse("2026-07-20T20:00:00.000Z");

function run(partial: Partial<CheckRunRecord> & Pick<CheckRunRecord, "name">): CheckRunRecord {
  return {
    status: "completed",
    conclusion: "success",
    created_at: new Date(NOW - 60_000).toISOString(),
    started_at: new Date(NOW - 50_000).toISOString(),
    ...partial,
  };
}

describe("isBotReviewCheck (#3167)", () => {
  it("matches greptile / slizard / coderabbit", () => {
    expect(isBotReviewCheck("Greptile Review")).toBe(true);
    expect(isBotReviewCheck("SLizard")).toBe(true);
    expect(isBotReviewCheck("CodeRabbit")).toBe(true);
    expect(isBotReviewCheck("TypeScript (build + lint + test)")).toBe(false);
  });
});

describe("evaluateCiGate (#2169 / #2672 / #3167)", () => {
  it("returns ready when all required checks passed", () => {
    const result = evaluateCiGate(
      [run({ name: "TypeScript (build + lint + test)" }), run({ name: "Go (test + build)" })],
      { nowMs: NOW },
    );
    expect(result.summary.ready_state).toBe("ready");
    expect(result.failures).toEqual([]);
  });

  it("returns not_ready_yet for queued under budget", () => {
    const result = evaluateCiGate(
      [
        run({
          name: "TypeScript (build + lint + test)",
          status: "queued",
          conclusion: "none",
          created_at: new Date(NOW - 5 * 60 * 1000).toISOString(),
          started_at: null,
        }),
      ],
      { nowMs: NOW },
    );
    expect(result.summary.ready_state).toBe("not_ready_yet");
    expect(result.summary.capacity_stalled_required).toEqual([]);
  });

  it("returns runner_capacity_stall when all pending required are stalled", () => {
    const result = evaluateCiGate(
      [
        run({
          name: "TypeScript (build + lint + test)",
          status: "queued",
          conclusion: "none",
          created_at: new Date(NOW - DEFAULT_CAPACITY_STALL_MS - 1000).toISOString(),
          started_at: null,
        }),
      ],
      { nowMs: NOW },
    );
    expect(result.summary.ready_state).toBe("runner_capacity_stall");
    expect(result.summary.capacity_stalled_required).toEqual(["TypeScript (build + lint + test)"]);
    expect(result.failures.join(" ")).toContain("runner_capacity_stall");
    expect(result.failures.join(" ")).toContain("do NOT use --skip-ci");
  });

  it("keeps not_ready_yet when a sibling is in_progress past budget", () => {
    const result = evaluateCiGate(
      [
        run({
          name: "TypeScript (build + lint + test)",
          status: "queued",
          conclusion: "none",
          created_at: new Date(NOW - DEFAULT_CAPACITY_STALL_MS - 1000).toISOString(),
          started_at: null,
        }),
        run({
          name: "Go (test + build)",
          status: "in_progress",
          conclusion: "none",
          created_at: new Date(NOW - DEFAULT_CAPACITY_STALL_MS * 2).toISOString(),
          started_at: new Date(NOW - 60_000).toISOString(),
        }),
      ],
      { nowMs: NOW },
    );
    expect(result.summary.ready_state).toBe("not_ready_yet");
    expect(result.summary.capacity_stalled_required).toEqual(["TypeScript (build + lint + test)"]);
  });

  it("returns ci_failures on failed required checks (#3167)", () => {
    const result = evaluateCiGate(
      [
        run({
          name: "TypeScript (build + lint + test)",
          status: "completed",
          conclusion: "failure",
        }),
      ],
      { nowMs: NOW },
    );
    expect(result.summary.ready_state).toBe("ci_failures");
    expect(result.summary.failed_required).toEqual(["TypeScript (build + lint + test) (failure)"]);
    expect(result.failures.join(" ")).toContain("ci_failures");
  });

  it("returns ci_never_scheduled when check-runs are empty (#3167)", () => {
    const result = evaluateCiGate([], { nowMs: NOW });
    expect(result.summary.ready_state).toBe("ci_never_scheduled");
    expect(result.failures.join(" ")).toContain("ci_never_scheduled");
  });

  it("returns ci_never_scheduled when only bot review checks are present (#3167)", () => {
    const result = evaluateCiGate(
      [
        run({ name: "Greptile Review", conclusion: "success" }),
        run({ name: "SLizard", conclusion: "success" }),
      ],
      { nowMs: NOW },
    );
    expect(result.summary.ready_state).toBe("ci_never_scheduled");
    expect(result.summary.checked_count).toBe(0);
  });

  it("returns ci_cancelled_no_failover when only cancelled required remain (#3167)", () => {
    const result = evaluateCiGate(
      [
        run({
          name: "TypeScript (blacksmith primary)",
          status: "completed",
          conclusion: "cancelled",
        }),
      ],
      { nowMs: NOW },
    );
    expect(result.summary.ready_state).toBe("ci_cancelled_no_failover");
    expect(result.summary.cancelled_required).toEqual([
      "TypeScript (blacksmith primary) (cancelled)",
    ]);
    expect(result.failures.join(" ")).toContain("ci_cancelled_no_failover");
  });

  it("stays ready when cancelled primary has a green required sibling (#3167)", () => {
    const result = evaluateCiGate(
      [
        run({
          name: "TypeScript (blacksmith primary)",
          status: "completed",
          conclusion: "cancelled",
        }),
        run({ name: "TypeScript (build + lint + test)", conclusion: "success" }),
      ],
      { nowMs: NOW },
    );
    expect(result.summary.ready_state).toBe("ready");
    expect(result.failures).toEqual([]);
    expect(result.summary.cancelled_required).toEqual([
      "TypeScript (blacksmith primary) (cancelled)",
    ]);
  });

  it("does not clear cancelled suite when only unrelated checks are green (#3167 P1)", () => {
    const result = evaluateCiGate(
      [
        run({
          name: "TypeScript (blacksmith primary)",
          status: "completed",
          conclusion: "cancelled",
        }),
        run({ name: "CodeQL", conclusion: "success" }),
        run({ name: "Socket Security: Project Report", conclusion: "success" }),
      ],
      { nowMs: NOW },
    );
    expect(result.summary.ready_state).toBe("ci_cancelled_no_failover");
    expect(result.failures.join(" ")).toContain("ci_cancelled_no_failover");
    expect(result.failures.join(" ")).toContain("authoritative suite aggregator");
  });

  it("does not clear cancelled TypeScript via green Go sibling only (#3167 P1)", () => {
    const result = evaluateCiGate(
      [
        run({
          name: "TypeScript (blacksmith primary)",
          status: "completed",
          conclusion: "cancelled",
        }),
        run({ name: "Go (test + build)", conclusion: "success" }),
      ],
      { nowMs: NOW },
    );
    expect(result.summary.ready_state).toBe("ci_cancelled_no_failover");
  });

  it("does not clear cancelled aggregator via green primary/failover only (#3167 P1)", () => {
    const result = evaluateCiGate(
      [
        run({
          name: "TypeScript (build + lint + test)",
          status: "completed",
          conclusion: "cancelled",
        }),
        run({ name: "TypeScript (Blacksmith primary)", conclusion: "success" }),
        run({ name: "TypeScript (GH-hosted failover)", conclusion: "success" }),
      ],
      { nowMs: NOW },
    );
    expect(result.summary.ready_state).toBe("ci_cancelled_no_failover");
  });

  it("clears cancelled primary when authoritative aggregator is green (#3167)", () => {
    const result = evaluateCiGate(
      [
        run({
          name: "TypeScript (Blacksmith primary)",
          status: "completed",
          conclusion: "cancelled",
        }),
        run({ name: "TypeScript (build + lint + test)", conclusion: "success" }),
      ],
      { nowMs: NOW },
    );
    expect(result.summary.ready_state).toBe("ready");
  });

  it("does not clear cancel via operator-ignored aggregator (#3167 P1)", () => {
    const result = evaluateCiGate(
      [
        run({
          name: "TypeScript (Blacksmith primary)",
          status: "completed",
          conclusion: "cancelled",
        }),
        run({ name: "TypeScript (build + lint + test)", conclusion: "success" }),
      ],
      {
        nowMs: NOW,
        ignoreCheckNames: ["TypeScript (build + lint + test)"],
      },
    );
    expect(result.summary.ready_state).toBe("ci_cancelled_no_failover");
  });

  it("does not drop non-suite cancellations when suite aggregator is green (#3167 P1)", () => {
    const result = evaluateCiGate(
      [
        run({
          name: "TypeScript (Blacksmith primary)",
          status: "completed",
          conclusion: "cancelled",
        }),
        run({
          name: "Security policy gate",
          status: "completed",
          conclusion: "cancelled",
        }),
        run({ name: "TypeScript (build + lint + test)", conclusion: "success" }),
      ],
      { nowMs: NOW },
    );
    expect(result.summary.ready_state).toBe("ci_cancelled_no_failover");
    expect(result.summary.cancelled_required.join(" ")).toContain("Security policy gate");
  });

  it("does not clear cancel via skipped authoritative aggregator (#3167 P1)", () => {
    const result = evaluateCiGate(
      [
        run({
          name: "TypeScript (Blacksmith primary)",
          status: "completed",
          conclusion: "cancelled",
        }),
        run({
          name: "TypeScript (build + lint + test)",
          status: "completed",
          conclusion: "skipped",
        }),
      ],
      { nowMs: NOW },
    );
    expect(result.summary.ready_state).toBe("ci_cancelled_no_failover");
  });

  it("prefers ci_failures over cancelled when both present (#3167)", () => {
    const result = evaluateCiGate(
      [
        run({
          name: "TypeScript (blacksmith primary)",
          status: "completed",
          conclusion: "cancelled",
        }),
        run({
          name: "TypeScript (build + lint + test)",
          status: "completed",
          conclusion: "failure",
        }),
      ],
      { nowMs: NOW },
    );
    expect(result.summary.ready_state).toBe("ci_failures");
  });

  it("prefers pending over cancelled while failover may still arm (#3167)", () => {
    const result = evaluateCiGate(
      [
        run({
          name: "TypeScript (blacksmith primary)",
          status: "completed",
          conclusion: "cancelled",
        }),
        run({
          name: "TypeScript (GH-hosted failover)",
          status: "queued",
          conclusion: "none",
          created_at: new Date(NOW - 60_000).toISOString(),
          started_at: null,
        }),
      ],
      { nowMs: NOW },
    );
    expect(result.summary.ready_state).toBe("not_ready_yet");
  });

  it("honors skipCi", () => {
    const result = evaluateCiGate([run({ name: "TypeScript (build + lint + test)" })], {
      skipCi: true,
    });
    expect(result.summary.ready_state).toBe("skipped");
  });

  it("stays ready when all non-bot checks are operator-ignored (not never_scheduled)", () => {
    const result = evaluateCiGate([run({ name: "Flaky Optional", conclusion: "failure" })], {
      ignoreCheckNames: ["Flaky Optional"],
      nowMs: NOW,
    });
    expect(result.summary.ready_state).toBe("ready");
    expect(result.failures).toEqual([]);
  });
});

describe("evaluateCiGate absent required contexts (#3234)", () => {
  it("fails closed when observed checks are green but a ruleset context is absent", () => {
    const result = evaluateCiGate(
      [
        run({ name: "TypeScript (build + lint + test)" }),
        run({ name: "Go (test + build)" }),
        run({ name: "Greptile Review" }),
      ],
      {
        nowMs: NOW,
        requiredContexts: [
          "TypeScript (build + lint + test)",
          "terraform-plan",
          "terraform-apply-staging",
        ],
      },
    );
    expect(result.summary.ready_state).toBe("ci_absent_required");
    expect(result.summary.absent_required).toEqual(["terraform-plan", "terraform-apply-staging"]);
    expect(result.summary.required_contexts).toContain("terraform-plan");
    expect(result.failures.join(" ")).toContain("ci_absent_required");
    expect(result.failures.join(" ")).toContain("terraform-plan");
    expect(result.failures.join(" ")).toContain("#3234");
  });

  it("stays ready when every required context has a matching HEAD check-run", () => {
    const result = evaluateCiGate(
      [run({ name: "TypeScript (build + lint + test)" }), run({ name: "terraform-plan" })],
      {
        nowMs: NOW,
        requiredContexts: ["TypeScript (build + lint + test)", "terraform-plan"],
      },
    );
    expect(result.summary.ready_state).toBe("ready");
    expect(result.summary.absent_required).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("prefers product failures over absent-required as ready_state", () => {
    const result = evaluateCiGate(
      [
        run({
          name: "TypeScript (build + lint + test)",
          status: "completed",
          conclusion: "failure",
        }),
      ],
      {
        nowMs: NOW,
        requiredContexts: ["TypeScript (build + lint + test)", "terraform-plan"],
      },
    );
    expect(result.summary.ready_state).toBe("ci_failures");
    expect(result.summary.absent_required).toEqual(["terraform-plan"]);
    expect(result.failures.some((f) => f.includes("ci_absent_required"))).toBe(true);
  });

  it("reports ci_absent_required (not never_scheduled) when only bots observed and required missing", () => {
    const result = evaluateCiGate([run({ name: "Greptile Review" })], {
      nowMs: NOW,
      requiredContexts: ["terraform-plan"],
    });
    expect(result.summary.ready_state).toBe("ci_absent_required");
    expect(result.summary.absent_required).toEqual(["terraform-plan"]);
    expect(result.failures.join(" ")).not.toContain("ci_never_scheduled");
  });

  it("honors operator ignore for a required context name", () => {
    const result = evaluateCiGate([run({ name: "TypeScript (build + lint + test)" })], {
      nowMs: NOW,
      requiredContexts: ["TypeScript (build + lint + test)", "flaky-optional"],
      ignoreCheckNames: ["flaky-optional"],
    });
    expect(result.summary.ready_state).toBe("ready");
    expect(result.summary.absent_required).toEqual([]);
  });

  it("includes absent count in the summary line", () => {
    const result = evaluateCiGate([run({ name: "TypeScript (build + lint + test)" })], {
      nowMs: NOW,
      requiredContexts: ["TypeScript (build + lint + test)", "missing-a", "missing-b"],
    });
    expect(buildCiSummaryLine(result.summary)).toContain("2 absent-required");
    expect(buildCiSummaryLine(result.summary)).toContain("ci_absent_required");
  });

  it("requires app-bound context to match check-run app id (#3234)", () => {
    const result = evaluateCiGate([run({ name: "modern-ci", appId: 999 })], {
      nowMs: NOW,
      requiredContexts: [{ name: "modern-ci", appId: 1 }],
    });
    expect(result.summary.ready_state).toBe("ci_absent_required");
    expect(result.summary.absent_required).toEqual(["modern-ci (app:1)"]);
  });

  it("accepts app-bound context when app id matches (#3234)", () => {
    const result = evaluateCiGate([run({ name: "modern-ci", appId: 1, conclusion: "success" })], {
      nowMs: NOW,
      requiredContexts: [{ name: "modern-ci", appId: 1 }],
    });
    expect(result.summary.ready_state).toBe("ready");
    expect(result.summary.absent_required).toEqual([]);
  });
});

describe("newest run per (app id, check name) (#6336)", () => {
  const GHA = 15368;

  it("an older failed run and a newer passed run of one check count as passing", () => {
    const runs = [
      run({ name: "closing-keywords", appId: GHA, runId: 100, conclusion: "failure" }),
      run({ name: "closing-keywords", appId: GHA, runId: 200, conclusion: "success" }),
    ];
    const result = evaluateCiGate(runs, { nowMs: NOW });
    expect(result.summary.ready_state).toBe("ready");
    expect(result.summary.failed_required).toEqual([]);
    expect(result.summary.checked_count).toBe(1);
  });

  it("keeps the newest created_at before the run id", () => {
    const older = run({
      name: "docs-impact",
      appId: GHA,
      runId: 900,
      created_at: new Date(NOW - 120_000).toISOString(),
      conclusion: "success",
    });
    const newer = run({
      name: "docs-impact",
      appId: GHA,
      runId: 800,
      created_at: new Date(NOW - 60_000).toISOString(),
      conclusion: "failure",
    });
    expect(newestRunPerCheck([older, newer])).toEqual([newer]);
    expect(newestRunPerCheck([newer, older])).toEqual([newer]);
  });

  it("uses the higher run id when created_at is equal or absent", () => {
    const a = run({ name: "smoke", appId: GHA, runId: 5, created_at: null, conclusion: "failure" });
    const b = run({ name: "smoke", appId: GHA, runId: 6, created_at: null, conclusion: "success" });
    expect(newestRunPerCheck([b, a])).toEqual([b]);
    const noId = run({ name: "smoke", appId: GHA, created_at: null, conclusion: "failure" });
    expect(newestRunPerCheck([noId, a])).toEqual([a]);
    expect(newestRunPerCheck([a, noId])).toEqual([a]);
  });

  it("a newest run that is skipped counts as passing", () => {
    const runs = [
      run({ name: "Merge gate (GH-hosted failover)", appId: GHA, runId: 1, conclusion: "failure" }),
      run({ name: "Merge gate (GH-hosted failover)", appId: GHA, runId: 2, conclusion: "skipped" }),
    ];
    expect(evaluateCiGate(runs, { nowMs: NOW }).summary.ready_state).toBe("ready");
  });

  it("a failed check from one app is not cleared by a passing same-name check from another app", () => {
    const runs = [
      run({ name: "Analyze (go)", appId: GHA, runId: 1, conclusion: "failure" }),
      run({ name: "Analyze (go)", appId: 57789, runId: 2, conclusion: "success" }),
    ];
    const result = evaluateCiGate(runs, { nowMs: NOW });
    expect(result.summary.ready_state).toBe("ci_failures");
    expect(result.summary.failed_required).toEqual(["Analyze (go) (failure)"]);
  });

  it("reads PR #6319's inventory (older red runs, newer green runs) as ready", () => {
    const pairs: [string, number, string][] = [
      ["Merge gate (task check)", 132675144619, "failure"],
      ["Merge gate (task check)", 132676320336, "success"],
      ["closing-keywords", 132675005865, "failure"],
      ["closing-keywords", 132676039469, "success"],
      ["docs-impact", 132675005882, "failure"],
      ["docs-impact", 132676039640, "success"],
      ["Merge gate (Blacksmith primary)", 132675073310, "failure"],
      ["Merge gate (Blacksmith primary)", 132676319882, "success"],
    ];
    const runs = pairs.map(([name, runId, conclusion]) =>
      run({ name, appId: GHA, runId, conclusion, created_at: null }),
    );
    const result = evaluateCiGate(runs, { nowMs: NOW });
    expect(result.summary.ready_state).toBe("ready");
    expect(result.failures).toEqual([]);
  });
});

describe("every red conclusion is a named failure (#6336)", () => {
  for (const conclusion of ["startup_failure", "action_required", "stale"]) {
    it(`counts a completed ${conclusion} run as failed`, () => {
      const result = evaluateCiGate([run({ name: "Merge gate (task check)", conclusion })], {
        nowMs: NOW,
      });
      expect(result.summary.ready_state).toBe("ci_failures");
      expect(result.summary.failed_required).toEqual([`Merge gate (task check) (${conclusion})`]);
      expect(result.failures.join(" ")).toContain("Merge gate (task check)");
    });
  }

  it("a red check that is not a required context still counts", () => {
    const result = evaluateCiGate(
      [run({ name: "smoke", conclusion: "failure" }), run({ name: "required-ci" })],
      { nowMs: NOW, requiredContexts: ["required-ci"] },
    );
    expect(result.summary.ready_state).toBe("ci_failures");
    expect(result.summary.failed_required).toEqual(["smoke (failure)"]);
  });

  it("isRedCompletedRun keeps success, neutral, skipped, cancelled and pending out", () => {
    for (const conclusion of ["success", "neutral", "skipped", "cancelled", "none"]) {
      expect(isRedCompletedRun(run({ name: "x", conclusion }))).toBe(false);
    }
    expect(isRedCompletedRun(run({ name: "x", status: "in_progress", conclusion: "none" }))).toBe(
      false,
    );
    expect(isRedCompletedRun(run({ name: "x", conclusion: "" }))).toBe(false);
    expect(isRedCompletedRun(run({ name: "x", conclusion: "timed_out" }))).toBe(true);
  });

  it("a red bot review check is advisory and not counted", () => {
    const runs = [
      run({ name: "SLizard", appId: 3532919, conclusion: "failure" }),
      run({ name: "TypeScript (build + lint + test)" }),
    ];
    expect(evaluateCiGate(runs, { nowMs: NOW }).summary.ready_state).toBe("ready");
    expect(advisoryBotReviewFailures(runs)).toEqual(["SLizard (failure)"]);
    expect(advisoryBotReviewFailures([run({ name: "Greptile Review" })])).toEqual([]);
  });
});
