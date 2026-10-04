/**
 * Branch coverage for plan.policy.autonomy (#3144 coverage-debt hairline).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTONOMY_ACTION_ADVANCE,
  AUTONOMY_ACTION_HOLD,
  AUTONOMY_ACTION_RETREAT,
  DEFAULT_AUTONOMY_LEVEL,
  recommendAutonomyLevel,
  resolveAutonomy,
  validateAutonomy,
} from "./autonomy.js";
import {
  DEFT_ALLOW_JUDGMENT_GATE_ENFORCE,
  defaultPromotionContracts,
  evaluatePromotionDecision,
  FLIP_DECISION_SCHEMA,
  OBSERVATION_ENGINE_AUTONOMY,
  OBSERVATION_ENGINE_CAPACITY,
  PROMOTION_GATE_AUTONOMY,
  PROMOTION_GATE_CAPACITY,
  PROMOTION_GATE_JUDGMENT,
  PROMOTION_GATE_SWARM_JUDGMENT,
} from "./capacity.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-autonomy-br-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("validateAutonomy branches (#3144)", () => {
  it("accepts null/undefined as empty errors", () => {
    expect(validateAutonomy(null)).toEqual([]);
    expect(validateAutonomy(undefined)).toEqual([]);
  });

  it("rejects non-object payloads", () => {
    expect(validateAutonomy("x").some((e) => e.includes("must be an object"))).toBe(true);
    expect(validateAutonomy([]).some((e) => e.includes("must be an object"))).toBe(true);
  });

  it("validates enabled, defaultLevel, minSampleSize, and rate fields", () => {
    const errors = validateAutonomy({
      enabled: "yes",
      defaultLevel: "warp",
      minSampleSize: -1,
      advanceOverrideRateMax: 2,
      retreatOverrideRate: -0.1,
      reworkBaseline: "high",
      gates: "not-object",
    });
    expect(errors.some((e) => e.includes("enabled must be a boolean"))).toBe(true);
    expect(errors.some((e) => e.includes("defaultLevel must be one of"))).toBe(true);
    expect(errors.some((e) => e.includes("minSampleSize"))).toBe(true);
    expect(errors.some((e) => e.includes("advanceOverrideRateMax"))).toBe(true);
    expect(errors.some((e) => e.includes("retreatOverrideRate"))).toBe(true);
    expect(errors.some((e) => e.includes("reworkBaseline"))).toBe(true);
    expect(errors.some((e) => e.includes("gates must be an object"))).toBe(true);
  });

  it("validates gate map keys and levels", () => {
    const errors = validateAutonomy({
      gates: {
        "": "observe",
        "merge-ready": "nope",
        ok: "execute",
      },
    });
    expect(errors.some((e) => e.includes("keys must be non-empty"))).toBe(true);
    expect(errors.some((e) => e.includes('gates["merge-ready"]'))).toBe(true);
    expect(errors.some((e) => e.includes('gates["ok"]'))).toBe(false);
  });

  it("accepts a well-formed autonomy object", () => {
    expect(
      validateAutonomy({
        enabled: false,
        defaultLevel: "observe",
        minSampleSize: 10,
        advanceOverrideRateMax: 0.05,
        retreatOverrideRate: 0.2,
        reworkBaseline: 0.15,
        gates: { "l4-owner": "escalate" },
      }),
    ).toEqual([]);
  });
});

describe("resolveAutonomy branches (#3144)", () => {
  it("returns default when PROJECT-DEFINITION is missing", () => {
    const root = tempRoot();
    const pol = resolveAutonomy(root);
    expect(pol.source).toBe("default");
    expect(pol.default_level).toBe(DEFAULT_AUTONOMY_LEVEL);
    expect(pol.error).not.toBeNull();
    expect(pol.configured).toBe(false);
  });

  it("returns default when autonomy key is absent", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: { policy: { wipCap: 20 } } }),
    );
    const pol = resolveAutonomy(root);
    expect(pol.source).toBe("default");
    expect(pol.error).toBeNull();
  });

  it("returns default-on-error for invalid autonomy payload", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: { policy: { autonomy: { defaultLevel: "warp" } } } }),
    );
    const pol = resolveAutonomy(root);
    expect(pol.source).toBe("default-on-error");
    expect(pol.error).toMatch(/defaultLevel/);
  });

  it("resolves typed autonomy with gate levels and overrides", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        plan: {
          policy: {
            autonomy: {
              enabled: false,
              defaultLevel: "observe",
              minSampleSize: 12,
              advanceOverrideRateMax: 0.01,
              retreatOverrideRate: 0.3,
              reworkBaseline: 0.2,
              gates: { "l4-owner": "execute", "pr-watch": "observe" },
            },
          },
        },
      }),
    );
    const pol = resolveAutonomy(root);
    expect(pol.source).toBe("typed");
    expect(pol.enabled).toBe(false);
    expect(pol.default_level).toBe("observe");
    expect(pol.min_sample_size).toBe(12);
    expect(pol.advance_override_max).toBe(0.01);
    expect(pol.retreat_override_rate).toBe(0.3);
    expect(pol.rework_baseline).toBe(0.2);
    expect(pol.gate_levels["l4-owner"]).toBe("execute");
    expect(pol.gate_levels["pr-watch"]).toBe("observe");
    expect(pol.configured).toBe(true);
  });

  it("uses defaults for omitted optional fields on a valid object", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: { policy: { autonomy: { gates: {} } } } }),
    );
    const pol = resolveAutonomy(root);
    expect(pol.source).toBe("typed");
    expect(pol.enabled).toBe(true);
    expect(pol.default_level).toBe(DEFAULT_AUTONOMY_LEVEL);
    expect(pol.min_sample_size).toBe(20);
  });
});

describe("recommendAutonomyLevel branches (#3144)", () => {
  it("retreats on high override rate", () => {
    const r = recommendAutonomyLevel("escalate", {
      override_rate: 0.5,
      rework_rate: 0,
      sample_size: 5,
      gate_id: "g1",
    });
    expect(r.action).toBe(AUTONOMY_ACTION_RETREAT);
    expect(r.recommended_level).toBe("observe");
    expect(r.gate_id).toBe("g1");
    expect(r.advisory).toBe(true);
  });

  it("holds at observe when retreat is triggered at the floor", () => {
    const r = recommendAutonomyLevel("observe", {
      override_rate: 0.9,
      rework_rate: 0,
      sample_size: 1,
      p0_reversal: true,
    });
    expect(r.action).toBe(AUTONOMY_ACTION_HOLD);
    expect(r.recommended_level).toBe("observe");
    expect(r.rationale).toMatch(/P0 reversal/);
  });

  it("retreats on P0 reversal from escalate", () => {
    const r = recommendAutonomyLevel("escalate", {
      override_rate: 0,
      rework_rate: 0,
      sample_size: 50,
      p0_reversal: true,
    });
    expect(r.action).toBe(AUTONOMY_ACTION_RETREAT);
    expect(r.recommended_level).toBe("observe");
  });

  it("advances when criteria are met", () => {
    const r = recommendAutonomyLevel("observe", {
      override_rate: 0,
      rework_rate: 0,
      sample_size: 25,
    });
    expect(r.action).toBe(AUTONOMY_ACTION_ADVANCE);
    expect(r.recommended_level).toBe("escalate");
  });

  it("holds at execute when advance criteria met at the ceiling", () => {
    const r = recommendAutonomyLevel("execute", {
      override_rate: 0,
      rework_rate: 0,
      sample_size: 50,
    });
    expect(r.action).toBe(AUTONOMY_ACTION_HOLD);
    expect(r.recommended_level).toBe("execute");
    expect(r.rationale).toMatch(/most permissive/);
  });

  it("holds when sample size is below min", () => {
    const r = recommendAutonomyLevel("observe", {
      override_rate: 0,
      rework_rate: 0,
      sample_size: 5,
    });
    expect(r.action).toBe(AUTONOMY_ACTION_HOLD);
    expect(r.rationale).toMatch(/advance criteria not met/);
  });

  it("maps invalid current level to policy default", () => {
    const r = recommendAutonomyLevel("warp-speed", {
      override_rate: 0,
      rework_rate: 0,
      sample_size: 5,
    });
    expect(r.current_level).toBe(DEFAULT_AUTONOMY_LEVEL);
  });
});

describe("gate promotion contract (#1511 Prefer-A)", () => {
  it("dispositions gates separately; capacity observes, others hold until producers", () => {
    const contracts = defaultPromotionContracts({ swarmJudgmentPostureWired: false });
    const byId = Object.fromEntries(contracts.map((c) => [c.gate_id, c]));

    expect(byId[PROMOTION_GATE_CAPACITY]?.disposition).toBe("observe");
    expect(byId[PROMOTION_GATE_CAPACITY]?.observation_window_open).toBe(true);
    expect(byId[PROMOTION_GATE_CAPACITY]?.false_positive_numerator).toBeNull();
    expect(byId[PROMOTION_GATE_CAPACITY]?.observation_engine).toBe(OBSERVATION_ENGINE_CAPACITY);

    expect(byId[PROMOTION_GATE_JUDGMENT]?.disposition).toBe("hold");
    expect(byId[PROMOTION_GATE_JUDGMENT]?.observation_window_open).toBe(false);
    expect(byId[PROMOTION_GATE_JUDGMENT]?.emergency_bypasses).toContain(
      DEFT_ALLOW_JUDGMENT_GATE_ENFORCE,
    );

    expect(byId[PROMOTION_GATE_AUTONOMY]?.disposition).toBe("hold");
    expect(byId[PROMOTION_GATE_AUTONOMY]?.observation_engine).toBe(OBSERVATION_ENGINE_AUTONOMY);

    expect(byId[PROMOTION_GATE_SWARM_JUDGMENT]?.disposition).toBe("hold");
    expect(byId[PROMOTION_GATE_SWARM_JUDGMENT]?.observation_window_open).toBe(false);
  });

  it("marks swarm judgment-clearance observe once posture is wired (not promote)", () => {
    const wired = defaultPromotionContracts({ swarmJudgmentPostureWired: true });
    const swarm = wired.find((c) => c.gate_id === PROMOTION_GATE_SWARM_JUDGMENT);
    expect(swarm?.disposition).toBe("observe");
    expect(swarm?.observation_window_open).toBe(true);
    expect(swarm?.denominator_producer).toBe("swarm_launch_judgment_evaluations");
    expect(swarm?.false_positive_numerator).toBeNull();
  });

  it("holds promote when FP numerator is unnamed even with a large denominator (P1-a)", () => {
    const capacity = defaultPromotionContracts().find(
      (c) => c.gate_id === PROMOTION_GATE_CAPACITY,
    )!;
    const flip = evaluatePromotionDecision(capacity, {
      denominator_count: 100,
      false_positive_count: 0,
      min_sample_size: 20,
      now: new Date("2026-10-04T12:00:00Z"),
    });
    expect(flip.schema).toBe(FLIP_DECISION_SCHEMA);
    expect(flip.decision).toBe("hold");
    expect(flip.observation_engine).toBe(OBSERVATION_ENGINE_CAPACITY);
    expect(flip.rationale).toMatch(/false-positive numerator is unnamed/i);
  });

  it("holds judgment and autonomy contracts without inventing producers", () => {
    const contracts = defaultPromotionContracts({ swarmJudgmentPostureWired: true });
    for (const gateId of [PROMOTION_GATE_JUDGMENT, PROMOTION_GATE_AUTONOMY]) {
      const contract = contracts.find((c) => c.gate_id === gateId)!;
      const flip = evaluatePromotionDecision(contract, { denominator_count: 50 });
      expect(flip.decision).toBe("hold");
      expect(flip.rationale.length).toBeGreaterThan(0);
    }
  });

  it("cites policy observation engines, not validate-content twins (P1-b)", () => {
    const contracts = defaultPromotionContracts();
    for (const c of contracts) {
      if (c.observation_engine !== null) {
        expect(c.observation_engine.startsWith("policy/")).toBe(true);
        expect(c.observation_engine.includes("validate-content")).toBe(false);
      }
    }
  });
});

describe("autonomy dial recommend-only (#1511 Prefer-A / P3-a)", () => {
  it("keeps advisory:true and discloses absent decision-event producer on sample 0", () => {
    const rec = recommendAutonomyLevel("escalate", {
      override_rate: 0,
      rework_rate: 0,
      sample_size: 0,
    });
    expect(rec.advisory).toBe(true);
    expect(rec.action).toBe(AUTONOMY_ACTION_HOLD);
    expect(rec.rationale).toMatch(/absent decision-event producer/i);
    expect(rec.rationale).toMatch(/not a clean observation window/i);
  });

  it("sample 0 does not mask P0 reversal retreat", () => {
    const rec = recommendAutonomyLevel("escalate", {
      override_rate: 0,
      rework_rate: 0,
      sample_size: 0,
      p0_reversal: true,
    });
    expect(rec.advisory).toBe(true);
    expect(rec.action).toBe(AUTONOMY_ACTION_RETREAT);
    expect(rec.recommended_level).toBe("observe");
    expect(rec.rationale).toMatch(/P0 reversal/i);
  });

  it("never drops advisory on advance/retreat/hold branches", () => {
    const samples = [
      recommendAutonomyLevel("escalate", {
        override_rate: 0.01,
        rework_rate: 0.01,
        sample_size: 50,
      }),
      recommendAutonomyLevel("escalate", {
        override_rate: 0.5,
        rework_rate: 0,
        sample_size: 10,
      }),
      recommendAutonomyLevel("observe", {
        override_rate: 0.5,
        rework_rate: 0,
        sample_size: 10,
      }),
    ];
    for (const rec of samples) {
      expect(rec.advisory).toBe(true);
    }
  });
});
