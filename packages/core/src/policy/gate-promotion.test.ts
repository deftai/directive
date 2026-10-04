/**
 * Prefer-A #1511: per-gate observation→promotion contract.
 */
import { describe, expect, it } from "vitest";
import { AUTONOMY_ACTION_HOLD, recommendAutonomyLevel } from "./autonomy.js";
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
