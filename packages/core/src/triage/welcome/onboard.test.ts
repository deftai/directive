import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runOnboardMode } from "./onboard.js";
import { subscriptionPreset } from "./writers.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seedProject(): { root: string; out: string[] } {
  const root = mkdtempSync(join(tmpdir(), "onboard-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: { policy: {} } }),
    "utf8",
  );
  return { root, out: [] };
}

function readPolicy(root: string): Record<string, unknown> {
  const data = JSON.parse(
    readFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "utf8"),
  );
  return data.plan["x-directive/policy"] ?? {};
}

const noHeal = () => {};

describe("runOnboardMode (#2295)", () => {
  it("writes the default preset and exits 0 (no more not-implemented stub)", () => {
    const { root, out } = seedProject();
    const outcome = runOnboardMode(root, {
      writeHistory: false,
      selfHealFn: noHeal,
      output: (l) => out.push(l),
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.presetApplied).toBe("small");
    expect(readPolicy(root).triageScope).toEqual(subscriptionPreset("small"));
    expect(out.some((l) => l.includes("Onboarding applied"))).toBe(true);
    expect(out.some((l) => l.includes("triage:bootstrap"))).toBe(true);
  });

  it("honors an explicit --preset", () => {
    const { root, out } = seedProject();
    const outcome = runOnboardMode(root, {
      preset: "mid",
      writeHistory: false,
      selfHealFn: noHeal,
      output: (l) => out.push(l),
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.presetApplied).toBe("mid");
    expect(readPolicy(root).triageScope).toEqual(subscriptionPreset("mid"));
  });

  it("persists a non-default wipCap", () => {
    const { root, out } = seedProject();
    const outcome = runOnboardMode(root, {
      wipCap: 8,
      writeHistory: false,
      selfHealFn: noHeal,
      output: (l) => out.push(l),
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.wipCapApplied).toBe(8);
    expect(readPolicy(root).wipCap).toBe(8);
  });

  it("rejects an unknown preset without writing", () => {
    const { root, out } = seedProject();
    const outcome = runOnboardMode(root, {
      preset: "enormous",
      selfHealFn: noHeal,
      output: (l) => out.push(l),
    });
    expect(outcome.exitCode).toBe(2);
    expect(readPolicy(root).triageScope).toBeUndefined();
    expect(out.some((l) => l.includes("Unknown --preset"))).toBe(true);
  });

  it("rejects a non-positive wipCap without writing", () => {
    const { root, out } = seedProject();
    const outcome = runOnboardMode(root, {
      wipCap: 0,
      selfHealFn: noHeal,
      output: (l) => out.push(l),
    });
    expect(outcome.exitCode).toBe(2);
    expect(readPolicy(root).triageScope).toBeUndefined();
    expect(out.some((l) => l.includes("--wip-cap must be a positive integer"))).toBe(true);
  });

  it("fails cleanly when no project definition exists", () => {
    const root = mkdtempSync(join(tmpdir(), "onboard-empty-"));
    temps.push(root);
    const out: string[] = [];
    const outcome = runOnboardMode(root, { selfHealFn: noHeal, output: (l) => out.push(l) });
    expect(outcome.exitCode).toBe(2);
    expect(out.some((l) => l.includes("No project definition found"))).toBe(true);
  });
});
