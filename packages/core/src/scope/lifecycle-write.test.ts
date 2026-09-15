import { describe, expect, it } from "vitest";
import {
  hasCompleteTransitionWrite,
  hasTransitionWrite,
  LEFTOVER_LAND_PR_REMEDIATION,
  stampLifecycleWrite,
  transitionWriteFitsFolder,
} from "./lifecycle-write.js";

describe("lifecycle-write (#3679)", () => {
  it("stamps a complete write that hasTransitionWrite accepts", () => {
    const plan: Record<string, unknown> = { status: "completed" };
    stampLifecycleWrite(plan, "complete", "2026-08-25T00:00:00Z");
    expect(hasTransitionWrite(plan)).toBe(true);
    const meta = plan.metadata as { lifecycleWrite: { action: string; writtenAt: string } };
    expect(meta.lifecycleWrite.action).toBe("complete");
    expect(meta.lifecycleWrite.writtenAt).toBe("2026-08-25T00:00:00Z");
  });

  it("treats legacy completedAt as verb evidence", () => {
    expect(
      hasTransitionWrite({
        status: "completed",
        metadata: { completedAt: "2026-08-20T00:00:00Z" },
      }),
    ).toBe(true);
  });

  it("treats failed status as verb evidence so scope:fail stays green", () => {
    expect(hasTransitionWrite({ status: "failed" })).toBe(true);
  });

  it("does not treat fail/failed/cancel as complete-move authorization (#4508)", () => {
    expect(hasCompleteTransitionWrite({ status: "failed" })).toBe(false);
    expect(hasCompleteTransitionWrite({ status: "running" })).toBe(false);
    const failed: Record<string, unknown> = { status: "failed" };
    stampLifecycleWrite(failed, "fail", "2026-09-15T00:00:00Z");
    expect(hasCompleteTransitionWrite(failed)).toBe(false);
    const cancelled: Record<string, unknown> = { status: "cancelled" };
    stampLifecycleWrite(cancelled, "cancel", "2026-09-15T00:00:00Z");
    expect(hasCompleteTransitionWrite(cancelled)).toBe(false);
  });

  it("accepts complete stamp or legacy completedAt for complete-move authorization (#4508)", () => {
    const completed: Record<string, unknown> = { status: "running" };
    stampLifecycleWrite(completed, "complete", "2026-09-15T00:00:00Z");
    expect(hasCompleteTransitionWrite(completed)).toBe(true);
    expect(
      hasCompleteTransitionWrite({
        status: "running",
        metadata: { completedAt: "2026-08-20T00:00:00Z" },
      }),
    ).toBe(true);
  });

  it("stamps a cancel write that hasTransitionWrite accepts", () => {
    const plan: Record<string, unknown> = { status: "cancelled" };
    stampLifecycleWrite(plan, "cancel", "2026-08-25T00:00:00Z");
    expect(hasTransitionWrite(plan)).toBe(true);
    const meta = plan.metadata as { lifecycleWrite: { action: string } };
    expect(meta.lifecycleWrite.action).toBe("cancel");
  });

  it("does not treat cancelled status alone as verb evidence", () => {
    expect(hasTransitionWrite({ status: "cancelled" })).toBe(false);
  });

  it("rejects a cancel stamp under completed/ and a complete stamp under cancelled/", () => {
    const cancelled: Record<string, unknown> = { status: "cancelled" };
    stampLifecycleWrite(cancelled, "cancel", "2026-08-25T00:00:00Z");
    expect(transitionWriteFitsFolder(cancelled, "cancelled")).toBe(true);
    expect(transitionWriteFitsFolder(cancelled, "completed")).toBe(false);
    const completed: Record<string, unknown> = { status: "completed" };
    stampLifecycleWrite(completed, "complete", "2026-08-25T00:00:00Z");
    expect(transitionWriteFitsFolder(completed, "completed")).toBe(true);
    expect(transitionWriteFitsFolder(completed, "cancelled")).toBe(false);
  });

  it("rejects a cancel action with no writtenAt", () => {
    expect(
      transitionWriteFitsFolder(
        { status: "cancelled", metadata: { lifecycleWrite: { action: "cancel" } } },
        "cancelled",
      ),
    ).toBe(false);
  });

  it("rejects a completed husk with no stamp", () => {
    expect(
      hasTransitionWrite({
        status: "completed",
        metadata: { kind: "fix", capacityBucket: "S" },
      }),
    ).toBe(false);
  });

  it("names the leftover land PR in worker-facing remediation", () => {
    expect(LEFTOVER_LAND_PR_REMEDIATION).toMatch(/leftover land PR \(#3476\)/);
    expect(LEFTOVER_LAND_PR_REMEDIATION).toMatch(/scope:complete/);
  });
});
