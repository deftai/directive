import { describe, expect, it } from "vitest";
import {
  describeShadowedPlanExtension,
  detectShadowedPlanExtensions,
  LEGACY_PLAN_COMPLETED_NOTE_KEY,
  LEGACY_PLAN_POLICY_KEY,
  migrateLegacyPolicyKey,
  PLAN_COMPLETED_NOTE_KEY,
  PLAN_ONBOARDING_KEY,
  PLAN_POLICY_KEY,
  readPlanCompletedNote,
  readPlanOnboarding,
  readPlanPolicy,
  SHADOWABLE_PLAN_EXTENSIONS,
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

  it("reads the namespaced onboarding decision block (#1694)", () => {
    expect(PLAN_ONBOARDING_KEY).toBe("x-directive/onboarding");
    expect(
      readPlanOnboarding({ [PLAN_ONBOARDING_KEY]: { wipCapDecided: true, acceptedDefault: true } }),
    ).toEqual({ wipCapDecided: true, acceptedDefault: true });
    expect(readPlanOnboarding({})).toBeUndefined();
    expect(readPlanOnboarding(null)).toBeUndefined();
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

describe("plan-extension shadow detection (#2301)", () => {
  it("covers both the policy and completedNote key pairs", () => {
    const pairs = SHADOWABLE_PLAN_EXTENSIONS.map((p) => [p.namespacedKey, p.legacyKey]);
    expect(pairs).toContainEqual([PLAN_POLICY_KEY, LEGACY_PLAN_POLICY_KEY]);
    expect(pairs).toContainEqual([PLAN_COMPLETED_NOTE_KEY, LEGACY_PLAN_COMPLETED_NOTE_KEY]);
  });

  it("returns [] when only the namespaced key exists", () => {
    expect(detectShadowedPlanExtensions({ [PLAN_POLICY_KEY]: { wipCap: 8 } })).toEqual([]);
  });

  it("returns [] when only the legacy bare key exists (un-migrated is fine)", () => {
    expect(detectShadowedPlanExtensions({ policy: { wipCap: 3 } })).toEqual([]);
  });

  it("detects a bare plan.policy shadowed by the namespaced form and lists sub-keys", () => {
    const shadows = detectShadowedPlanExtensions({
      [PLAN_POLICY_KEY]: { wipCap: 9 },
      policy: { triageScope: [], wipCap: 1 },
    });
    expect(shadows).toHaveLength(1);
    expect(shadows[0]?.namespacedKey).toBe(PLAN_POLICY_KEY);
    expect(shadows[0]?.legacyKey).toBe(LEGACY_PLAN_POLICY_KEY);
    expect(shadows[0]?.shadowedSubKeys).toEqual(["triageScope", "wipCap"]);
  });

  it("detects multiple shadowed keys at once", () => {
    const shadows = detectShadowedPlanExtensions({
      [PLAN_POLICY_KEY]: {},
      policy: {},
      [PLAN_COMPLETED_NOTE_KEY]: "n",
      completedNote: "legacy",
    });
    expect(shadows.map((s) => s.legacyKey).sort()).toEqual(
      [LEGACY_PLAN_COMPLETED_NOTE_KEY, LEGACY_PLAN_POLICY_KEY].sort(),
    );
  });

  it("reports no sub-keys when the shadowed bare value is not an object", () => {
    const shadows = detectShadowedPlanExtensions({
      [PLAN_COMPLETED_NOTE_KEY]: "current",
      completedNote: "legacy string",
    });
    expect(shadows).toHaveLength(1);
    expect(shadows[0]?.shadowedSubKeys).toEqual([]);
  });

  it("returns [] for non-object plans", () => {
    expect(detectShadowedPlanExtensions(null)).toEqual([]);
    expect(detectShadowedPlanExtensions([1, 2])).toEqual([]);
    expect(detectShadowedPlanExtensions("nope")).toEqual([]);
  });

  it("describes the shadow with a fold/delete remediation and sub-key list", () => {
    const [shadow] = detectShadowedPlanExtensions({
      [PLAN_POLICY_KEY]: {},
      policy: { triageScope: [] },
    });
    const message = describeShadowedPlanExtension(
      shadow ?? {
        namespacedKey: PLAN_POLICY_KEY,
        legacyKey: LEGACY_PLAN_POLICY_KEY,
        shadowedSubKeys: [],
      },
    );
    expect(message).toContain("bare `plan.policy`");
    expect(message).toContain("x-directive/policy");
    expect(message).toContain("IGNORED");
    expect(message).toContain("plan.policy.triageScope");
    expect(message).toContain("Fold");
  });
});
