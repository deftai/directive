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

function seedProject(policy: Record<string, unknown> = {}): { root: string; out: string[] } {
  const root = mkdtempSync(join(tmpdir(), "onboard-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { policy } }),
    "utf8",
  );
  return { root, out: [] };
}

/** Seed an old (demote-eligible) pending scope artifact so WIP relief fires. */
function seedPendingScope(root: string, name: string, updated = "2020-01-01T00:00:00Z"): void {
  mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "pending", name),
    JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { updated } }),
    "utf8",
  );
}

function readPolicy(root: string): Record<string, unknown> {
  const payload: unknown = JSON.parse(
    readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
  );
  if (payload === null || typeof payload !== "object") return {};
  const plan = (payload as { plan?: unknown }).plan;
  if (plan === null || typeof plan !== "object") return {};
  return ((plan as Record<string, unknown>)["x-directive/policy"] as Record<string, unknown>) ?? {};
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

  it("records wipCap default decision without materializing the field (#1694)", () => {
    const { root, out } = seedProject();
    const outcome = runOnboardMode(root, {
      writeHistory: false,
      selfHealFn: noHeal,
      output: (l) => out.push(l),
    });
    expect(outcome.exitCode).toBe(0);
    expect(readPolicy(root).wipCap).toBeUndefined();
    const payload: unknown = JSON.parse(
      readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
    );
    const plan = (payload as { plan?: Record<string, unknown> }).plan ?? {};
    expect(plan["x-directive/onboarding"]).toMatchObject({
      wipCapDecided: true,
      acceptedDefault: true,
    });
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

  it("offers scope:demote relief when WIP is at/over cap (#2295 coverage)", () => {
    // Pre-populate WIP above a low cap with a demote-eligible (old) pending
    // scope so the relief branch in runOnboardMode actually fires.
    const { root, out } = seedProject({ wipCap: 1 });
    seedPendingScope(root, "2020-01-01-old-scope.xbrief.json");
    const outcome = runOnboardMode(root, {
      writeHistory: false,
      selfHealFn: noHeal,
      taskPrefix: "task",
      output: (l) => out.push(l),
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.reliefOffered).toBe(true);
    const reliefLine = out.find((l) => l.includes("demote-eligible"));
    expect(reliefLine).toBeDefined();
    expect(reliefLine).toContain("at/over cap");
    expect(reliefLine).toContain("scope:demote");
  });

  it("does not offer relief when WIP is under cap", () => {
    const { root, out } = seedProject({ wipCap: 10 });
    seedPendingScope(root, "2020-01-01-old-scope.xbrief.json");
    const outcome = runOnboardMode(root, {
      writeHistory: false,
      selfHealFn: noHeal,
      output: (l) => out.push(l),
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.reliefOffered).toBe(false);
    expect(out.some((l) => l.includes("demote-eligible"))).toBe(false);
  });
});
