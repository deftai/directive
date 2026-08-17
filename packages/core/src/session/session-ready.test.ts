import { describe, expect, it, vi } from "vitest";
import type { OccupancyDecision } from "./occupancy.js";
import {
  inferSessionReadyRepo,
  isCacheFreshFailure,
  isGatedVerifyActuallyReady,
  runSessionReady,
  SESSION_READY_FAILED,
  SESSION_READY_FAST_PATH,
  SESSION_READY_RECOVERED,
  SESSION_READY_VERIFIED,
  type SessionReadyOptions,
} from "./session-ready.js";
import type { SessionStartResult } from "./session-start.js";
import type { VerifyResult } from "./verify-session-ritual.js";

function stubOccupancy(): OccupancyDecision {
  return {
    action: "claimed",
    sessionId: "ready-session",
    record: null,
    path: "/proj/.deft/occupancy.json",
    message: "occupancy claimed session ready-session (intent=mutation)",
    code: 0,
  };
}

function ready(projectRoot: string, options: SessionReadyOptions = {}) {
  return runSessionReady(projectRoot, { applyOccupancy: stubOccupancy, ...options });
}

function okVerify(overrides: Partial<VerifyResult> = {}): VerifyResult {
  return {
    code: 0,
    message: "OK session ritual gated tier is fresh.",
    tier: "gated",
    statePath: "/p/.deft/ritual-state.json",
    bypassed: false,
    wouldFailCode: null,
    posture: "mutation",
    ritualStateRequired: true,
    ...overrides,
  };
}

function failVerify(message: string, overrides: Partial<VerifyResult> = {}): VerifyResult {
  return okVerify({ code: 1, message, ...overrides });
}

describe("isCacheFreshFailure", () => {
  it("matches cache_fresh step failures", () => {
    expect(isCacheFreshFailure("session ritual gated step 'cache_fresh' failed: stale")).toBe(true);
  });

  it("matches evaluate-style cache-fresh messages", () => {
    expect(isCacheFreshFailure("❌ deft cache-fresh: stale age 30h")).toBe(true);
    expect(isCacheFreshFailure("stale-by-drift -- 2 issues")).toBe(true);
    expect(isCacheFreshFailure("run `deft cache fetch-all --source github-issue`")).toBe(true);
  });

  it("does not match doctor-only failures", () => {
    expect(isCacheFreshFailure("session ritual gated step 'doctor' failed")).toBe(false);
  });
});

describe("isGatedVerifyActuallyReady (#3003 hairline)", () => {
  it("requires code 0 and not bypassed", () => {
    expect(isGatedVerifyActuallyReady(okVerify())).toBe(true);
    expect(isGatedVerifyActuallyReady(okVerify({ bypassed: true, wouldFailCode: 1 }))).toBe(false);
    expect(isGatedVerifyActuallyReady(failVerify("nope"))).toBe(false);
  });
});

describe("inferSessionReadyRepo", () => {
  it("prefers DEFT_TRIAGE_REPO", () => {
    expect(inferSessionReadyRepo("/tmp/x", { DEFT_TRIAGE_REPO: "acme/widgets" })).toBe(
      "acme/widgets",
    );
  });

  it("returns null when env empty and git fails", () => {
    expect(inferSessionReadyRepo("/nonexistent-path-no-git", {})).toBeNull();
  });
});

describe("runSessionReady (#2993)", () => {
  it("fast path refreshes hook readiness without starting or fetching", () => {
    const inspectRitual = vi.fn(() => okVerify());
    const verifyRitual = vi.fn(() => okVerify());
    const runStart = vi.fn();
    const fetchAll = vi.fn();

    const result = ready("/proj", {
      inspectRitual,
      verifyRitual,
      runStart,
      fetchAll,
      sessionStartOptions: { writeHistory: true },
    });

    expect(result.code).toBe(0);
    expect(result.path).toBe(SESSION_READY_FAST_PATH);
    expect(result.message).toContain("already fresh");
    expect(result.steps).toEqual(["verify:session-ritual:gated"]);
    expect(runStart).not.toHaveBeenCalled();
    expect(verifyRitual).toHaveBeenCalledWith(
      "/proj",
      expect.objectContaining({ forceGatedSteps: ["agent_hooks"] }),
    );
    expect(fetchAll).not.toHaveBeenCalled();
    expect(inspectRitual).toHaveBeenCalledTimes(1);
  });

  it("does not report the fast path ready when the forced hook gate fails", () => {
    const result = ready("/proj", {
      inspectRitual: () => okVerify(),
      verifyRitual: () => failVerify("session ritual gated step 'agent_hooks' failed"),
      runStart: vi.fn(),
      fetchAll: vi.fn(),
    });

    expect(result.code).toBe(1);
    expect(result.path).toBe(SESSION_READY_FAILED);
    expect(result.message).toContain("agent_hooks");
  });

  it("refuses a bypassed forced hook gate on the fast path", () => {
    const result = ready("/proj", {
      inspectRitual: () => okVerify(),
      verifyRitual: () =>
        okVerify({
          bypassed: true,
          wouldFailCode: 1,
          message: "session ritual gated step 'agent_hooks' failed",
        }),
    });

    expect(result.code).toBe(1);
    expect(result.path).toBe(SESSION_READY_FAILED);
    expect(result.message).toContain("refuses bypassed verification");
  });

  it("runs session:start when quick is not ready, then verifies gated", () => {
    const inspectRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("ritual state missing")) // gated
      .mockReturnValueOnce(failVerify("ritual state missing", { tier: "quick" })); // quick
    const startResult: SessionStartResult = {
      code: 0,
      payload: {},
      lines: ["alignment ok"],
    };
    const runStart = vi.fn(() => startResult);
    const verifyRitual = vi.fn(() => okVerify());
    const fetchAll = vi.fn();

    const result = ready("/proj", {
      inspectRitual,
      verifyRitual,
      runStart,
      fetchAll,
      sessionStartOptions: { writeHistory: true },
    });

    expect(result.code).toBe(0);
    expect(result.path).toBe(SESSION_READY_VERIFIED);
    expect(result.steps).toEqual(["session:start", "verify:session-ritual:gated"]);
    expect(runStart).toHaveBeenCalledTimes(1);
    expect(runStart).toHaveBeenCalledWith("/proj", expect.objectContaining({ writeHistory: true }));
    expect(verifyRitual).toHaveBeenCalledTimes(1);
    expect(fetchAll).not.toHaveBeenCalled();
  });

  it("skips session:start when quick is fresh but gated steps need verify", () => {
    const inspectRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("session ritual gated step 'cache_fresh' is missing"))
      .mockReturnValueOnce(okVerify({ tier: "quick", message: "OK quick" }));
    const runStart = vi.fn();
    const verifyRitual = vi.fn(() => okVerify());
    const fetchAll = vi.fn();

    const result = ready("/proj", {
      inspectRitual,
      verifyRitual,
      runStart,
      fetchAll,
    });

    expect(result.code).toBe(0);
    expect(result.path).toBe(SESSION_READY_VERIFIED);
    expect(result.steps).toEqual(["verify:session-ritual:gated"]);
    expect(runStart).not.toHaveBeenCalled();
    expect(fetchAll).not.toHaveBeenCalled();
  });

  it("recovers cache_fresh failures with fetch-all then re-verify", () => {
    const inspectRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("gated not ready"))
      .mockReturnValueOnce(okVerify({ tier: "quick" }));
    const verifyRitual = vi
      .fn()
      .mockReturnValueOnce(
        failVerify("session ritual gated step 'cache_fresh' failed: stale age 30h"),
      )
      .mockReturnValueOnce(okVerify());
    const fetchAll = vi.fn(() => ({ issues_written: 3 }));
    const runStart = vi.fn();

    const result = ready("/proj", {
      inspectRitual,
      verifyRitual,
      runStart,
      fetchAll,
      repo: "deftai/directive",
    });

    expect(result.code).toBe(0);
    expect(result.path).toBe(SESSION_READY_RECOVERED);
    expect(result.message).toContain("recovered via cache refresh");
    expect(result.steps).toEqual([
      "verify:session-ritual:gated",
      "cache:fetch-all",
      "verify:session-ritual:gated:retry",
    ]);
    expect(fetchAll).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "github-issue",
        repo: "deftai/directive",
        force: true,
      }),
    );
    expect(runStart).not.toHaveBeenCalled();
  });

  it("refuses a bypassed verification after cache recovery", () => {
    const inspectRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("gated"))
      .mockReturnValueOnce(okVerify({ tier: "quick" }));
    const verifyRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("session ritual gated step 'cache_fresh' failed"))
      .mockReturnValueOnce(
        okVerify({
          bypassed: true,
          wouldFailCode: 1,
          message: "session ritual gated step 'agent_hooks' failed",
        }),
      );

    const result = ready("/proj", {
      inspectRitual,
      verifyRitual,
      fetchAll: vi.fn(() => ({ issues_written: 1 })),
      inferRepo: () => "o/r",
    });

    expect(result.code).toBe(1);
    expect(result.path).toBe(SESSION_READY_FAILED);
    expect(result.message).toContain("refuses bypassed verification");
  });

  it("does not fetch-all when doctor fails", () => {
    const inspectRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("gated not ready"))
      .mockReturnValueOnce(okVerify({ tier: "quick" }));
    const verifyRitual = vi.fn(() =>
      failVerify("session ritual gated step 'doctor' failed: tools missing"),
    );
    const fetchAll = vi.fn();

    const result = ready("/proj", {
      inspectRitual,
      verifyRitual,
      fetchAll,
      repo: "a/b",
    });

    expect(result.code).toBe(1);
    expect(result.path).toBe(SESSION_READY_FAILED);
    expect(result.message).toContain("doctor");
    expect(result.message).toContain("Remaining blocker");
    expect(fetchAll).not.toHaveBeenCalled();
  });

  it("fails when session:start fails", () => {
    const inspectRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("missing"))
      .mockReturnValueOnce(failVerify("missing", { tier: "quick" }));
    const runStart = vi.fn(
      (): SessionStartResult => ({
        code: 2,
        payload: {},
        lines: ["USER.md missing"],
      }),
    );

    const result = ready("/proj", {
      inspectRitual,
      runStart,
      verifyRitual: vi.fn(),
      fetchAll: vi.fn(),
    });

    expect(result.code).toBe(2);
    expect(result.path).toBe(SESSION_READY_FAILED);
    expect(result.message).toContain("USER.md missing");
  });

  it("provides a fallback when session:start fails without output", () => {
    const inspectRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("missing"))
      .mockReturnValueOnce(failVerify("missing", { tier: "quick" }));
    const result = ready("/proj", {
      inspectRitual,
      runStart: () => ({ code: 2, payload: {}, lines: [] }),
    });

    expect(result.code).toBe(2);
    expect(result.message).toContain("session:start failed (exit 2)");
  });

  it("fails when cache recovery cannot resolve repo", () => {
    const inspectRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("gated"))
      .mockReturnValueOnce(okVerify({ tier: "quick" }));
    const verifyRitual = vi.fn(() => failVerify("session ritual gated step 'cache_fresh' failed"));

    const result = ready("/proj", {
      inspectRitual,
      verifyRitual,
      repo: null,
      inferRepo: () => null,
      fetchAll: vi.fn(),
    });

    expect(result.code).toBe(1);
    expect(result.path).toBe(SESSION_READY_FAILED);
    expect(result.message).toContain("DEFT_TRIAGE_REPO");
  });

  it("refuses DEFT_SESSION_RITUAL_SKIP bypass as false readiness (Greptile P1)", () => {
    const inspectRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("gated not ready"))
      .mockReturnValueOnce(okVerify({ tier: "quick" }));
    const verifyRitual = vi.fn(() =>
      okVerify({
        bypassed: true,
        wouldFailCode: 1,
        message: "session ritual gated step 'cache_fresh' failed",
      }),
    );

    const result = ready("/proj", {
      inspectRitual,
      verifyRitual,
      fetchAll: vi.fn(),
      repo: "a/b",
    });

    expect(result.code).toBe(1);
    expect(result.path).toBe(SESSION_READY_FAILED);
    expect(result.message).toContain("refuses bypassed verification");
    expect(result.message).toContain("DEFT_SESSION_RITUAL_SKIP");
  });

  it("surfaces fetch-all throw as recovery failure", () => {
    const inspectRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("gated"))
      .mockReturnValueOnce(okVerify({ tier: "quick" }));
    const verifyRitual = vi.fn(() => failVerify("session ritual gated step 'cache_fresh' failed"));
    const fetchAll = vi.fn(() => {
      throw new Error("rate limited");
    });

    const result = ready("/proj", {
      inspectRitual,
      verifyRitual,
      fetchAll,
      repo: "o/r",
    });

    expect(result.code).toBe(1);
    expect(result.path).toBe(SESSION_READY_FAILED);
    expect(result.message).toContain("rate limited");
    expect(result.message).toContain("cache fetch-all");
  });

  it("skipCacheRecovery leaves cache_fresh as blocker without fetch (#3003)", () => {
    const inspectRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("gated"))
      .mockReturnValueOnce(okVerify({ tier: "quick" }));
    const verifyRitual = vi.fn(() => failVerify("session ritual gated step 'cache_fresh' failed"));
    const fetchAll = vi.fn();

    const result = ready("/proj", {
      inspectRitual,
      verifyRitual,
      fetchAll,
      repo: "o/r",
      skipCacheRecovery: true,
    });

    expect(result.code).toBe(1);
    expect(result.path).toBe(SESSION_READY_FAILED);
    expect(fetchAll).not.toHaveBeenCalled();
    expect(result.message).toContain("cache_fresh");
  });

  it("surfaces non-Error fetch throw as string cause (#3003)", () => {
    const inspectRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("gated"))
      .mockReturnValueOnce(okVerify({ tier: "quick" }));
    const verifyRitual = vi.fn(() => failVerify("session ritual gated step 'cache_fresh' failed"));
    const fetchAll = vi.fn(() => {
      throw "boom-string";
    });

    const result = ready("/proj", {
      inspectRitual,
      verifyRitual,
      fetchAll,
      repo: "o/r",
    });

    expect(result.code).toBe(1);
    expect(result.message).toContain("boom-string");
  });

  it("uses empty bypass message fallback when verify message blank (#3003)", () => {
    const inspectRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("gated"))
      .mockReturnValueOnce(okVerify({ tier: "quick" }));
    const verifyRitual = vi.fn(() =>
      okVerify({
        bypassed: true,
        wouldFailCode: 1,
        message: "   ",
      }),
    );

    const result = ready("/proj", {
      inspectRitual,
      verifyRitual,
      fetchAll: vi.fn(),
      repo: "a/b",
    });

    expect(result.code).toBe(1);
    expect(result.message).toMatch(/bypassed|DEFT_SESSION_RITUAL_SKIP/i);
  });
});
