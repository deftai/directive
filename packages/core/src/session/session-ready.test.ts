import { describe, expect, it, vi } from "vitest";
import {
  type ApplyOccupancyInput,
  type OccupancyDecision,
  resolveOccupancySessionId,
} from "./occupancy.js";
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
  return runSessionReady(projectRoot, {
    applyOccupancy: stubOccupancy,
    env: {},
    ...options,
    sessionStartOptions: {
      newSessionId: () => "ready-session",
      ...options.sessionStartOptions,
    },
  });
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
    boundSessionId: "ready-session",
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
    expect(result.sessionId).toBe("ready-session");
    expect(result.path).toBe(SESSION_READY_FAST_PATH);
    expect(result.message).toContain("already fresh");
    expect(result.steps).toEqual(["verify:session-ritual:gated"]);
    expect(runStart).not.toHaveBeenCalled();
    expect(verifyRitual).toHaveBeenCalledWith(
      "/proj",
      expect.objectContaining({
        forceGatedSteps: ["agent_hooks", "cache_fresh"],
        checkClassCacheFresh: true,
      }),
    );
    expect(fetchAll).not.toHaveBeenCalled();
    expect(inspectRitual).toHaveBeenCalledTimes(2);
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
      .mockReturnValueOnce(failVerify("ritual state missing", { tier: "quick" })) // quick
      .mockReturnValue(okVerify()); // post-claim
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
    expect(result.sessionId).toBe("ready-session");
    expect(result.path).toBe(SESSION_READY_VERIFIED);
    expect(result.steps).toEqual(["session:start", "verify:session-ritual:gated"]);
    expect(runStart).toHaveBeenCalledTimes(1);
    expect(runStart).toHaveBeenCalledWith("/proj", expect.objectContaining({ writeHistory: true }));
    expect(verifyRitual).toHaveBeenCalledTimes(1);
    expect(fetchAll).not.toHaveBeenCalled();
  });

  it("resolves one identity for preview, nested start, and final claim (#3611)", () => {
    const inspectRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("ritual state missing"))
      .mockReturnValueOnce(failVerify("ritual state missing", { tier: "quick" }))
      .mockReturnValue(okVerify({ boundSessionId: "resolved-ready-session" }));
    const newSessionId = vi
      .fn<() => string>()
      .mockReturnValueOnce("resolved-ready-session")
      .mockReturnValueOnce("unexpected-nested-session")
      .mockReturnValueOnce("unexpected-final-session");
    const occupancyInputs: ApplyOccupancyInput[] = [];
    const applyOccupancy = vi.fn(
      (_projectRoot: string, input: ApplyOccupancyInput): OccupancyDecision => {
        occupancyInputs.push(input);
        return {
          action: input.write === false ? "claimed" : "heartbeat",
          sessionId: resolveOccupancySessionId(input),
          record: null,
          path: "/proj/.deft/occupancy.json",
          message: "occupancy ready",
          code: 0,
        };
      },
    );
    const runStart = vi.fn(
      (
        _projectRoot: string,
        options: Parameters<NonNullable<SessionReadyOptions["runStart"]>>[1],
      ) => ({
        code: 0,
        payload: {
          occupancy: {
            session_id: resolveOccupancySessionId(options),
          },
        },
        lines: ["alignment ok"],
      }),
    );

    const result = ready("/proj", {
      env: {},
      inspectRitual,
      verifyRitual: () => okVerify({ boundSessionId: "resolved-ready-session" }),
      runStart,
      applyOccupancy,
      sessionStartOptions: { newSessionId },
    });

    expect(result.code).toBe(0);
    expect(newSessionId).toHaveBeenCalledTimes(1);
    expect(result.sessionId).toBe("resolved-ready-session");
    expect(occupancyInputs.map((input) => input.sessionId)).toEqual([
      "resolved-ready-session",
      "resolved-ready-session",
    ]);
    expect(occupancyInputs.map((input) => input.write)).toEqual([false, true]);
    expect(runStart).toHaveBeenCalledWith(
      "/proj",
      expect.objectContaining({ sessionId: "resolved-ready-session" }),
    );
  });

  it("rejects a nested session:start result that reports a different owner (#3611)", () => {
    const inspectRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("ritual state missing"))
      .mockReturnValueOnce(failVerify("ritual state missing", { tier: "quick" }));
    const occupancyInputs: ApplyOccupancyInput[] = [];
    const result = ready("/proj", {
      sessionId: "host:codex:v1:ZXhwZWN0ZWQ",
      inspectRitual,
      runStart: () => ({
        code: 0,
        payload: { occupancy: { session_id: "host:codex:v1:Zm9yZWlnbg" } },
        lines: ["unexpected owner"],
      }),
      applyOccupancy: (_projectRoot, input) => {
        occupancyInputs.push(input);
        return { ...stubOccupancy(), sessionId: input.sessionId ?? "missing" };
      },
    });

    expect(result.code).toBe(1);
    expect(result.message).toContain("nested session:start owner");
    expect(result.message).toContain("Refusing to claim a mismatched lease");
    expect(occupancyInputs.map((input) => input.write)).toEqual([false]);
  });

  it("uses an explicit ready identity instead of environment or minting (#3611)", () => {
    const newSessionId = vi.fn(() => "unexpected-minted-session");
    const occupancyInputs: ApplyOccupancyInput[] = [];
    const applyOccupancy = vi.fn(
      (_projectRoot: string, input: ApplyOccupancyInput): OccupancyDecision => {
        occupancyInputs.push(input);
        return {
          ...stubOccupancy(),
          sessionId: resolveOccupancySessionId(input),
        };
      },
    );

    const result = ready("/proj", {
      sessionId: "host:cursor:v1:Y29udmVyc2F0aW9u",
      env: { DEFT_SESSION_ID: "foreign-environment-id" },
      sessionStartOptions: { newSessionId },
      inspectRitual: () => okVerify({ boundSessionId: "host:cursor:v1:Y29udmVyc2F0aW9u" }),
      verifyRitual: () => okVerify({ boundSessionId: "host:cursor:v1:Y29udmVyc2F0aW9u" }),
      applyOccupancy,
    });

    expect(result.code).toBe(0);
    expect(newSessionId).not.toHaveBeenCalled();
    expect(result.sessionId).toBe("host:cursor:v1:Y29udmVyc2F0aW9u");
    expect(occupancyInputs.map((input) => input.sessionId)).toEqual([
      "host:cursor:v1:Y29udmVyc2F0aW9u",
      "host:cursor:v1:Y29udmVyc2F0aW9u",
    ]);
  });

  it("realigns a fresh foreign ritual before claiming the resolved owner (#3611)", () => {
    const owner = "host:claude:v1:bmV3LXNlc3Npb24";
    const inspectRitual = vi
      .fn()
      .mockReturnValueOnce(okVerify({ boundSessionId: "released-old-owner" }))
      .mockReturnValueOnce(okVerify({ boundSessionId: "released-old-owner" }))
      .mockReturnValue(okVerify({ boundSessionId: owner }));
    const runStart = vi.fn(
      (): SessionStartResult => ({
        code: 0,
        payload: { occupancy: { session_id: owner } },
        lines: ["ritual realigned"],
      }),
    );

    const result = ready("/proj", {
      sessionId: owner,
      inspectRitual,
      verifyRitual: () => okVerify({ boundSessionId: owner }),
      runStart,
    });

    expect(result.code).toBe(0);
    expect(result.path).toBe(SESSION_READY_VERIFIED);
    expect(inspectRitual).toHaveBeenCalledTimes(3);
    expect(runStart).toHaveBeenCalledWith("/proj", expect.objectContaining({ sessionId: owner }));
  });

  it("refuses readiness when the verified ritual owner changes before claim (#3611)", () => {
    const owner = "host:codex:v1:b3duZXItYQ";
    const occupancyInputs: ApplyOccupancyInput[] = [];
    const result = ready("/proj", {
      sessionId: owner,
      inspectRitual: () => okVerify({ boundSessionId: owner }),
      verifyRitual: () => okVerify({ boundSessionId: "host:codex:v1:b3duZXItYg" }),
      applyOccupancy: (_projectRoot, input) => {
        occupancyInputs.push(input);
        return { ...stubOccupancy(), sessionId: owner };
      },
    });

    expect(result.code).toBe(1);
    expect(result.path).toBe(SESSION_READY_FAILED);
    expect(result.message).toContain("Refusing to claim a mismatched lease");
    expect(occupancyInputs.map((input) => input.write)).toEqual([false]);
  });

  it("fails closed when ritual ownership changes during the final occupancy claim (#3611)", () => {
    const ownerA = "host:codex:v1:b3duZXItYQ";
    const ownerB = "host:codex:v1:b3duZXItYg";
    let ritualOwner = ownerA;
    const occupancyInputs: ApplyOccupancyInput[] = [];
    const result = ready("/proj", {
      sessionId: ownerA,
      inspectRitual: () => okVerify({ boundSessionId: ritualOwner }),
      verifyRitual: () => okVerify({ boundSessionId: ownerA }),
      applyOccupancy: (_projectRoot, input) => {
        occupancyInputs.push(input);
        if (input.write === true) ritualOwner = ownerB;
        return { ...stubOccupancy(), sessionId: ownerA };
      },
    });

    expect(result).toMatchObject({ code: 1, path: SESSION_READY_FAILED, sessionId: ownerA });
    expect(result.message).toContain(`post-claim ritual owner ${ownerB}`);
    expect(result.message).toContain("Readiness remains fail-closed");
    expect(occupancyInputs.map((input) => input.write)).toEqual([false, true]);
  });

  it("does not repeat a confirmed steal after nested session:start claimed occupancy (#3611)", () => {
    const inspectRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("ritual state missing"))
      .mockReturnValueOnce(failVerify("ritual state missing", { tier: "quick" }))
      .mockReturnValue(okVerify({ boundSessionId: "host:codex:v1:c3RlYWw" }));
    const occupancyInputs: ApplyOccupancyInput[] = [];
    const applyOccupancy = vi.fn(
      (_projectRoot: string, input: ApplyOccupancyInput): OccupancyDecision => {
        occupancyInputs.push(input);
        return {
          ...stubOccupancy(),
          action: input.steal === true ? "stolen" : "heartbeat",
          sessionId: input.sessionId ?? "missing-session-id",
        };
      },
    );
    const runStart = vi.fn(
      (): SessionStartResult => ({
        code: 0,
        payload: { occupancy: { session_id: "host:codex:v1:c3RlYWw" } },
        lines: ["steal completed"],
      }),
    );

    const result = ready("/proj", {
      sessionId: "host:codex:v1:c3RlYWw",
      env: {},
      inspectRitual,
      verifyRitual: () => okVerify({ boundSessionId: "host:codex:v1:c3RlYWw" }),
      runStart,
      applyOccupancy,
      sessionStartOptions: {
        steal: true,
        confirm: true,
        occupant: "legacy-session",
      },
    });

    expect(result.code).toBe(0);
    expect(runStart).toHaveBeenCalledWith(
      "/proj",
      expect.objectContaining({
        sessionId: "host:codex:v1:c3RlYWw",
        steal: true,
        confirm: true,
        occupant: "legacy-session",
      }),
    );
    expect(occupancyInputs.map(({ write, steal }) => ({ write, steal }))).toEqual([
      { write: false, steal: true },
      { write: true, steal: false },
    ]);
  });

  it("does not fast-path a confirmed steal over a green legacy ritual (#3611)", () => {
    const occupancyInputs: ApplyOccupancyInput[] = [];
    const applyOccupancy = vi.fn(
      (_projectRoot: string, input: ApplyOccupancyInput): OccupancyDecision => {
        occupancyInputs.push(input);
        return {
          ...stubOccupancy(),
          action: input.steal === true ? "stolen" : "heartbeat",
          sessionId: input.sessionId ?? "missing-session-id",
        };
      },
    );
    const runStart = vi.fn(
      (): SessionStartResult => ({
        code: 0,
        payload: { occupancy: { session_id: "host:codex:v1:bmV3LW93bmVy" } },
        lines: ["aligned lease and ritual"],
      }),
    );

    const result = ready("/proj", {
      sessionId: "host:codex:v1:bmV3LW93bmVy",
      env: {},
      inspectRitual: vi
        .fn()
        .mockReturnValueOnce(okVerify({ boundSessionId: "legacy-owner" }))
        .mockReturnValueOnce(okVerify({ boundSessionId: "legacy-owner" }))
        .mockReturnValue(okVerify({ boundSessionId: "host:codex:v1:bmV3LW93bmVy" })),
      verifyRitual: () => okVerify({ boundSessionId: "host:codex:v1:bmV3LW93bmVy" }),
      runStart,
      applyOccupancy,
      sessionStartOptions: {
        steal: true,
        confirm: true,
        occupant: "legacy-owner",
      },
    });

    expect(result.code).toBe(0);
    expect(result.path).toBe(SESSION_READY_VERIFIED);
    expect(runStart).toHaveBeenCalledTimes(1);
    expect(occupancyInputs.map(({ write, steal }) => ({ write, steal }))).toEqual([
      { write: false, steal: true },
      { write: true, steal: false },
    ]);
  });

  it("skips session:start when quick is fresh but gated steps need verify", () => {
    const inspectRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("session ritual gated step 'cache_fresh' is missing"))
      .mockReturnValueOnce(okVerify({ tier: "quick", message: "OK quick" }))
      .mockReturnValue(okVerify());
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

  it("VERIFIED path specifies check-class cache_fresh so skip-drift argv cannot hide stale-by-drift (#4399)", () => {
    const inspectRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("session ritual gated step 'cache_fresh' is missing"))
      .mockReturnValueOnce(okVerify({ tier: "quick", message: "OK quick" }))
      .mockReturnValue(okVerify());
    const verifyRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("stale-by-drift -- 3 cached-open issues absent"))
      .mockReturnValueOnce(okVerify());
    const fetchAll = vi.fn(() => ({ issues_written: 3 }));
    const refreshClosed = vi.fn();
    const runStart = vi.fn();

    const result = ready("/proj", {
      inspectRitual,
      verifyRitual,
      runStart,
      fetchAll,
      refreshClosed,
      repo: "deftai/directive",
    });

    expect(result.code).toBe(0);
    expect(result.path).toBe(SESSION_READY_RECOVERED);
    expect(result.steps).toEqual([
      "verify:session-ritual:gated",
      "cache:fetch-all",
      "verify:session-ritual:gated:retry",
    ]);
    expect(runStart).not.toHaveBeenCalled();
    expect(verifyRitual).toHaveBeenNthCalledWith(
      1,
      "/proj",
      expect.objectContaining({
        forceGatedSteps: ["agent_hooks", "cache_fresh"],
        checkClassCacheFresh: true,
      }),
    );
    expect(fetchAll).toHaveBeenCalledTimes(1);
    expect(refreshClosed).toHaveBeenCalledTimes(1);
  });

  it("does not lock AC1 on inspect-green after start (#4399)", () => {
    const inspectRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("session ritual gated step 'cache_fresh' failed"))
      .mockReturnValueOnce(failVerify("ritual state missing", { tier: "quick" }))
      .mockReturnValue(okVerify());
    const verifyRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("stale-by-drift -- 2 issues"))
      .mockReturnValueOnce(okVerify());
    const fetchAll = vi.fn(() => ({ issues_written: 2 }));
    const refreshClosed = vi.fn();

    const result = ready("/proj", {
      inspectRitual,
      verifyRitual,
      runStart: () => ({ code: 0, payload: {}, lines: ["[deft orientation] cache_fresh: dirty"] }),
      fetchAll,
      refreshClosed,
      repo: "deftai/directive",
    });

    expect(result.path).toBe(SESSION_READY_RECOVERED);
    expect(result.steps).toEqual([
      "session:start",
      "verify:session-ritual:gated",
      "cache:fetch-all",
      "verify:session-ritual:gated:retry",
    ]);
    expect(result.message).toContain("recovered via cache refresh");
    expect(verifyRitual.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ checkClassCacheFresh: true }),
    );
  });

  it("recovers check-class stale-by-drift even when inspect is already green (#4399)", () => {
    const inspectRitual = vi.fn(() => okVerify());
    const verifyRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("stale-by-drift -- 3 cached-open issues absent"))
      .mockReturnValueOnce(okVerify());
    const fetchAll = vi.fn(() => ({ issues_written: 3 }));
    const refreshClosed = vi.fn();
    const runStart = vi.fn();

    const result = ready("/proj", {
      inspectRitual,
      verifyRitual,
      runStart,
      fetchAll,
      refreshClosed,
      repo: "deftai/directive",
    });

    expect(result.code).toBe(0);
    expect(result.path).toBe(SESSION_READY_RECOVERED);
    expect(runStart).not.toHaveBeenCalled();
    expect(fetchAll).toHaveBeenCalledTimes(1);
    expect(refreshClosed).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "github-issue",
        repo: "deftai/directive",
        cacheRoot: expect.stringMatching(/[\\/]\.deft-cache$/),
      }),
    );
    expect(result.steps).toEqual([
      "verify:session-ritual:gated",
      "cache:fetch-all",
      "verify:session-ritual:gated:retry",
    ]);
  });

  it("reconciles cached-open closed-upstream entries during fetch-all recovery (#4399)", () => {
    const inspectRitual = vi.fn(() => okVerify());
    const verifyRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("stale-by-drift -- 1 cached-open issue absent"))
      .mockReturnValueOnce(okVerify());
    const fetchAll = vi.fn(() => ({ issues_written: 1 }));
    const refreshClosed = vi.fn();

    const result = ready("/proj", {
      inspectRitual,
      verifyRitual,
      fetchAll,
      refreshClosed,
      repo: "deftai/directive",
    });

    expect(result.path).toBe(SESSION_READY_RECOVERED);
    expect(fetchAll.mock.invocationCallOrder[0]).toBeLessThan(
      refreshClosed.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(refreshClosed).toHaveBeenCalledTimes(1);
  });

  it("recovers cache_fresh failures with fetch-all then re-verify", () => {
    const inspectRitual = vi
      .fn()
      .mockReturnValueOnce(failVerify("gated not ready"))
      .mockReturnValueOnce(okVerify({ tier: "quick" }))
      .mockReturnValue(okVerify());
    const verifyRitual = vi
      .fn()
      .mockReturnValueOnce(
        failVerify("session ritual gated step 'cache_fresh' failed: stale age 30h"),
      )
      .mockReturnValueOnce(okVerify());
    const fetchAll = vi.fn(() => ({ issues_written: 3 }));
    const refreshClosed = vi.fn();
    const runStart = vi.fn();

    const result = ready("/proj", {
      inspectRitual,
      verifyRitual,
      runStart,
      fetchAll,
      refreshClosed,
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
    expect(refreshClosed).toHaveBeenCalledTimes(1);
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
      refreshClosed: vi.fn(),
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
