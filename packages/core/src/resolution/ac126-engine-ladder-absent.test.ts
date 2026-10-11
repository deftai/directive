/**
 * AC12.6 / D4.12 / ENG-LADDER — engine ladder + skew escape hatches must not
 * exist in resolution source (and therefore not ship inside runtime).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as resolution from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("AC12.6 engine ladder / skew surfaces absent (ENG-LADDER)", () => {
  it("engine-ladder.ts and skew-policy.ts source modules are deleted", () => {
    expect(existsSync(join(HERE, "engine-ladder.ts"))).toBe(false);
    expect(existsSync(join(HERE, "skew-policy.ts"))).toBe(false);
    expect(existsSync(join(HERE, "engine-ladder.test.ts"))).toBe(false);
    expect(existsSync(join(HERE, "skew-policy.test.ts"))).toBe(false);
  });

  it("resolution barrel does not export ladder / skew escape-hatch symbols", () => {
    const bag = resolution as Record<string, unknown>;
    expect(bag.decideEngineLadder).toBeUndefined();
    expect(bag.ACCEPT_ENGINE_SKEW_ENV).toBeUndefined();
    expect(bag.DEFAULT_ENGINE_SKEW_WINDOW).toBeUndefined();
    // Flag / env names must not appear as string constants on the barrel.
    const dumped = JSON.stringify(Object.keys(bag));
    expect(dumped).not.toMatch(/ACCEPT_ENGINE|acceptEngineJump|engine-ladder|skew-policy/i);
  });

  it("plan remediation never teaches retired engine-jump escape hatches", () => {
    const facts = resolution.classify("/nonexistent-ac126", {
      isDir: () => false,
      isFile: () => false,
      readText: () => null,
      engineProbe: () => ({ reachable: true, version: "0.70.0" }),
      preCutoverProbe: () => false,
    });
    // Force a deposit+pin shape so plan reaches engine/pin reconciliation.
    const withDeposit = {
      ...facts,
      hasDeftCore: true,
      pinVersion: "0.65.0",
      engineReachable: true,
      engineVersion: "0.70.0",
      deftCorePayloadVersion: "0.65.0",
    };
    const p = resolution.plan(withDeposit);
    const blob = JSON.stringify(p);
    expect(blob).not.toMatch(/accept-engine-jump/i);
    expect(blob).not.toMatch(/DEFT_ACCEPT_ENGINE_SKEW/);
    expect(blob).not.toMatch(/engine ladder/i);
    expect(blob).not.toMatch(/skew window/i);
  });
});
