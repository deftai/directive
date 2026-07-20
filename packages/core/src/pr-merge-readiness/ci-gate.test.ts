import { describe, expect, it } from "vitest";
import { evaluateCiGate } from "./ci-gate.js";
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

describe("evaluateCiGate (#2169 / #2672)", () => {
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

  it("returns blocked on failed required checks", () => {
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
    expect(result.summary.ready_state).toBe("blocked");
  });

  it("honors skipCi", () => {
    const result = evaluateCiGate([run({ name: "TypeScript (build + lint + test)" })], {
      skipCi: true,
    });
    expect(result.summary.ready_state).toBe("skipped");
  });
});
