import { describe, expect, it } from "vitest";
import {
  LEGACY_PLAN_COMPLETED_NOTE_KEY,
  LEGACY_PLAN_POLICY_KEY,
  migrateLegacyPolicyKey,
  PLAN_COMPLETED_NOTE_KEY,
  PLAN_POLICY_KEY,
  readPlanCompletedNote,
  readPlanPolicy,
} from "./plan-extensions.js";

describe("plan-extensions namespaced accessors (#1650)", () => {
  it("uses x-directive/ namespaced keys", () => {
    expect(PLAN_POLICY_KEY).toBe("x-directive/policy");
    expect(PLAN_COMPLETED_NOTE_KEY).toBe("x-directive/completedNote");
    expect(LEGACY_PLAN_POLICY_KEY).toBe("policy");
    expect(LEGACY_PLAN_COMPLETED_NOTE_KEY).toBe("completedNote");
  });

  it("reads the namespaced policy block", () => {
    const plan = { [PLAN_POLICY_KEY]: { wipCap: 7 } };
    expect(readPlanPolicy(plan)).toEqual({ wipCap: 7 });
  });

  it("falls back to the legacy bare policy key when namespaced is absent", () => {
    const plan = { policy: { wipCap: 3 } };
    expect(readPlanPolicy(plan)).toEqual({ wipCap: 3 });
  });

  it("prefers the namespaced policy block over a legacy bare one", () => {
    const plan = { [PLAN_POLICY_KEY]: { wipCap: 9 }, policy: { wipCap: 1 } };
    expect(readPlanPolicy(plan)).toEqual({ wipCap: 9 });
  });

  it("returns undefined when no policy key is present", () => {
    expect(readPlanPolicy({})).toBeUndefined();
  });

  it("returns undefined for non-object plans", () => {
    expect(readPlanPolicy(null)).toBeUndefined();
    expect(readPlanPolicy([1, 2])).toBeUndefined();
    expect(readPlanPolicy("nope")).toBeUndefined();
  });

  it("reads the namespaced completedNote with bare fallback", () => {
    expect(readPlanCompletedNote({ [PLAN_COMPLETED_NOTE_KEY]: "done" })).toBe("done");
    expect(readPlanCompletedNote({ completedNote: "legacy" })).toBe("legacy");
    expect(readPlanCompletedNote({})).toBeUndefined();
  });

  it("migrates a legacy bare policy key to the namespaced key in place", () => {
    const plan: Record<string, unknown> = { policy: { wipCap: 5 } };
    migrateLegacyPolicyKey(plan);
    expect(plan[PLAN_POLICY_KEY]).toEqual({ wipCap: 5 });
    expect(LEGACY_PLAN_POLICY_KEY in plan).toBe(false);
  });

  it("is a no-op when the namespaced key already exists", () => {
    const plan: Record<string, unknown> = {
      [PLAN_POLICY_KEY]: { wipCap: 8 },
      policy: { wipCap: 2 },
    };
    migrateLegacyPolicyKey(plan);
    expect(plan[PLAN_POLICY_KEY]).toEqual({ wipCap: 8 });
    expect(plan.policy).toEqual({ wipCap: 2 });
  });

  it("is a no-op when no policy key is present", () => {
    const plan: Record<string, unknown> = {};
    migrateLegacyPolicyKey(plan);
    expect(PLAN_POLICY_KEY in plan).toBe(false);
    expect(LEGACY_PLAN_POLICY_KEY in plan).toBe(false);
  });
});
