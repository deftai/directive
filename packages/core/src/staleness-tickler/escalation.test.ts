import { describe, expect, it } from "vitest";
import { DEFAULT_STALENESS_TICKLER_POLICY } from "../policy/staleness-tickler.js";
import { holdTierOnUnverified, resolveTier, scoreDrift, snoozeWindowMs } from "./escalation.js";
import type { DriftInputs, StalenessTicklerState } from "./types.js";

const policy = DEFAULT_STALENESS_TICKLER_POLICY;

function inputs(overrides: Partial<DriftInputs> = {}): DriftInputs {
  return {
    directive: {
      availability: {
        status: "available",
        installedVersion: "1.0.0",
        latestVersion: "1.2.0",
        resolver: "npm-view",
      },
      majorBehind: false,
      minorDistance: 2,
      patchDistance: 0,
      stale: true,
      ...overrides.directive,
    },
    xbrief: {
      declaredVersion: "0.8",
      targetVersion: "0.8",
      distance: "current",
      stale: false,
      ...overrides.xbrief,
    },
    ageMs: 0,
    deferralCount: 0,
    ...overrides,
  };
}

describe("staleness tickler escalation (#2489)", () => {
  it("quiet tier for one minor behind with current schema", () => {
    const tier = resolveTier(
      inputs({
        directive: {
          availability: {
            status: "available",
            installedVersion: "1.0.0",
            latestVersion: "1.1.0",
            resolver: "npm-view",
          },
          majorBehind: false,
          minorDistance: 1,
          patchDistance: 0,
          stale: true,
        },
      }),
      policy,
    );
    expect(tier).toBe("quiet");
  });

  it("notice tier for two minors behind", () => {
    expect(resolveTier(inputs(), policy)).toBe("notice");
  });

  it("notice tier for schema behind-minor", () => {
    expect(
      resolveTier(
        inputs({
          directive: {
            availability: {
              status: "current",
              installedVersion: "1.0.0",
              latestVersion: "1.0.0",
              resolver: "npm-view",
            },
            majorBehind: false,
            minorDistance: 0,
            patchDistance: 0,
            stale: false,
          },
          xbrief: {
            declaredVersion: "0.7",
            targetVersion: "0.8",
            distance: "behind-minor",
            stale: true,
          },
        }),
        policy,
      ),
    ).toBe("notice");
  });

  it("strong tier for schema behind-major", () => {
    expect(
      resolveTier(
        inputs({
          xbrief: {
            declaredVersion: "0.6",
            targetVersion: "0.8",
            distance: "behind-major",
            stale: true,
          },
        }),
        policy,
      ),
    ).toBe("strong");
  });

  it("assert tier when deferrals exceed cap on strong drift", () => {
    expect(
      resolveTier(
        inputs({
          directive: {
            availability: {
              status: "available",
              installedVersion: "1.0.0",
              latestVersion: "2.0.0",
              resolver: "npm-view",
            },
            majorBehind: true,
            minorDistance: 0,
            patchDistance: 0,
            stale: true,
          },
          deferralCount: policy.tiers.assertDeferralCap,
        }),
        policy,
      ),
    ).toBe("assert");
  });

  it("widens snooze with deferrals up to the cap", () => {
    const base = snoozeWindowMs("notice", 0, policy);
    const widened = snoozeWindowMs("notice", 3, policy);
    expect(widened).toBeGreaterThan(base);
    expect(snoozeWindowMs("notice", 100, policy)).toBe(
      Math.round(base * policy.snooze.maxWidenMultiplier),
    );
  });

  it("holds tier on unverified detection", () => {
    const state: StalenessTicklerState = {
      lastTier: "strong",
      lastScore: 20,
    };
    const held = holdTierOnUnverified("quiet", 1, state, true);
    expect(held.tier).toBe("strong");
    expect(held.score).toBe(20);
  });

  it("increases score with age and deferrals", () => {
    const young = scoreDrift(inputs(), policy);
    const aged = scoreDrift(inputs({ ageMs: 10 * 24 * 60 * 60 * 1000, deferralCount: 2 }), policy);
    expect(aged).toBeGreaterThan(young);
  });
});
