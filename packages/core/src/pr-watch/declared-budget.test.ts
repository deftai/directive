import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_WAIT_MINUTES } from "./constants.js";
import {
  ENV_PR_WATCH_MAX_WAIT_MINUTES,
  hasDeclaredWallClockBudget,
  resolveDeclaredWaitBudget,
} from "./declared-budget.js";

describe("resolveDeclaredWaitBudget (#3984)", () => {
  afterEach(() => {
    delete process.env[ENV_PR_WATCH_MAX_WAIT_MINUTES];
  });

  it("defaults without declaration (not a #3153 wall-clock trigger)", () => {
    const r = resolveDeclaredWaitBudget({ env: {} });
    expect(r).toEqual({
      ok: true,
      minutes: DEFAULT_MAX_WAIT_MINUTES,
      source: "default",
      declared: false,
    });
    expect(hasDeclaredWallClockBudget({ env: {} })).toBe(false);
  });

  it("prefers explicit CLI minutes as declared", () => {
    const r = resolveDeclaredWaitBudget({
      cliMinutes: 12,
      env: { [ENV_PR_WATCH_MAX_WAIT_MINUTES]: "45" },
    });
    expect(r).toEqual({
      ok: true,
      minutes: 12,
      source: "cli",
      declared: true,
    });
    expect(hasDeclaredWallClockBudget({ cliMinutes: 12, env: {} })).toBe(true);
  });

  it("reads DEFT_PR_WATCH_MAX_WAIT_MINUTES when CLI omitted", () => {
    const r = resolveDeclaredWaitBudget({
      env: { [ENV_PR_WATCH_MAX_WAIT_MINUTES]: "45" },
    });
    expect(r).toEqual({
      ok: true,
      minutes: 45,
      source: "env",
      declared: true,
    });
  });

  it("returns ok:false for invalid env (no throw)", () => {
    const r = resolveDeclaredWaitBudget({
      env: { [ENV_PR_WATCH_MAX_WAIT_MINUTES]: "nope" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.reason).toContain(ENV_PR_WATCH_MAX_WAIT_MINUTES);
    expect(hasDeclaredWallClockBudget({ env: { [ENV_PR_WATCH_MAX_WAIT_MINUTES]: "nope" } })).toBe(
      false,
    );
  });

  it("rejects env minutes whose seconds conversion is not finite", () => {
    const r = resolveDeclaredWaitBudget({
      env: { [ENV_PR_WATCH_MAX_WAIT_MINUTES]: "1e308" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.reason).toContain(ENV_PR_WATCH_MAX_WAIT_MINUTES);
  });

  it("rejects CLI minutes whose seconds conversion is not finite", () => {
    const r = resolveDeclaredWaitBudget({ cliMinutes: 1e308, env: {} });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.source).toBe("cli");
  });

  it("treats blank env as undeclared default", () => {
    const r = resolveDeclaredWaitBudget({
      env: { [ENV_PR_WATCH_MAX_WAIT_MINUTES]: "  " },
    });
    expect(r).toEqual({
      ok: true,
      minutes: DEFAULT_MAX_WAIT_MINUTES,
      source: "default",
      declared: false,
    });
  });
});
