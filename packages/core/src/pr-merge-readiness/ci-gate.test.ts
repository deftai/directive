import { describe, expect, it } from "vitest";
import { evaluateCiGate, isBotReviewCheck } from "./ci-gate.js";
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
    expect(result.failures.join(" ")).toContain("authoritative aggregator");
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
