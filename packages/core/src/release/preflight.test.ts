import { describe, expect, it, vi } from "vitest";
import { dispatchCachedTaskCheck, remainingForDeadline } from "../check/cached-orchestrator.js";
import {
  ENV_CHECK_AC_ONLY,
  ENV_CHECK_MODE,
  ENV_HYGIENE_ADVISORY,
  resolveProductFirstCheckMode,
} from "../product-first-done-gate/index.js";
import { SKIP_NOTICE } from "../ts-check-lane/run-lane.js";
import { RELEASE_CHECK_TIMEOUT_MS } from "./constants.js";
import { releaseCheckEnv, runReleaseCheck } from "./preflight.js";

describe("releaseCheckEnv", () => {
  it("sets preflight env and scrubs ambient coverage debt", () => {
    const env = releaseCheckEnv({
      base: { DEFT_ALLOW_COVERAGE_DEBT: "999" },
      allowCoverageDebtIssue: null,
    });
    expect(env.DEFT_RELEASE_PREFLIGHT).toBe("1");
    expect(env.DEFT_ALLOW_COVERAGE_DEBT).toBeUndefined();
  });

  it("forwards allow-coverage-debt issue when supplied", () => {
    const env = releaseCheckEnv({ allowCoverageDebtIssue: 2573 });
    expect(env.DEFT_ALLOW_COVERAGE_DEBT).toBe("2573");
  });

  it("pins DEFT_CHECK_MODE=full and deletes AC-only and hygiene-advisory (#4230)", () => {
    const env = releaseCheckEnv({
      base: {
        [ENV_CHECK_MODE]: "rapid",
        [ENV_CHECK_AC_ONLY]: "1",
        [ENV_HYGIENE_ADVISORY]: "1",
      },
    });
    expect(env[ENV_CHECK_MODE]).toBe("full");
    expect(env[ENV_CHECK_AC_ONLY]).toBeUndefined();
    expect(env[ENV_HYGIENE_ADVISORY]).toBeUndefined();
    const resolved = resolveProductFirstCheckMode({
      environ: env,
      ceremonyDepth: "rapid",
      hardBudgetDetected: true,
    });
    expect(resolved.mode).toBe("full");
  });
});

describe("runReleaseCheck", () => {
  it("returns ok when task check exits 0", () => {
    const [ok, msg] = runReleaseCheck("/proj", {
      dispatchCheck: () => 0,
    });
    expect(ok).toBe(true);
    expect(msg).toContain("task check");
  });

  it("returns timeout message on exit 124 (#2652)", () => {
    const [ok, msg] = runReleaseCheck("/proj", {
      dispatchCheck: (_fw, _proj, seams) => {
        expect(seams?.timeoutMs).toBe(RELEASE_CHECK_TIMEOUT_MS);
        return 124;
      },
    });
    expect(ok).toBe(false);
    expect(msg).toContain("timed out");
    expect(msg).toContain("RELEASING.md");
  });

  it("returns generic failure for other non-zero exits", () => {
    const [ok, msg] = runReleaseCheck("/proj", {
      dispatchCheck: () => 42,
    });
    expect(ok).toBe(false);
    expect(msg).toContain("exit 42");
  });

  it("does not treat SKIP_NOTICE plus status run as suite-ran", () => {
    const [ok, msg] = runReleaseCheck("/proj", {
      dispatchCheck: (_fw, _proj, seams) => {
        seams?.onCheckComplete?.({
          exitCode: 0,
          gates: [{ id: "ts:check-lane", status: "run", exit_code: 0 }],
          suiteTeeText: SKIP_NOTICE,
        });
        return 0;
      },
    });
    expect(ok).toBe(false);
    expect(msg).toMatch(/did not run|SKIP_NOTICE/);
  });

  it("stamps a successful full-suite when the collector reports run without SKIP_NOTICE", () => {
    const [ok] = runReleaseCheck("/proj", {
      dispatchCheck: (_fw, _proj, seams) => {
        seams?.onCheckComplete?.({
          exitCode: 0,
          gates: [{ id: "ts:check-lane", status: "run", exit_code: 0 }],
          suiteTeeText: "Tests  12 passed\n",
        });
        return 0;
      },
    });
    expect(ok).toBe(true);
  });
});

describe("remainingForDeadline (#4801)", () => {
  it("returns undefined when no deadline is minted", () => {
    expect(remainingForDeadline(undefined, 10)).toBeUndefined();
  });

  it("clamps exhausted budget to 0", () => {
    expect(remainingForDeadline(5, 10)).toBe(0);
  });

  it("returns remaining time before the deadline", () => {
    expect(remainingForDeadline(1_000, 400)).toBe(600);
  });
});

describe("runReleaseCheck hang bound (#4801)", () => {
  it("pins RELEASE_CHECK_TIMEOUT_MS at 30m (#5022)", () => {
    expect(RELEASE_CHECK_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  it("mints one absolute deadline at entry", () => {
    const now = 5_000_000;
    let seen: number | undefined;
    runReleaseCheck("/proj", {
      nowMs: () => now,
      dispatchCheck: (_fw, _proj, seams) => {
        seen = seams?.deadlineAtMs;
        expect(seams?.timeoutMs).toBe(RELEASE_CHECK_TIMEOUT_MS);
        expect(seams?.noCache).toBeUndefined();
        expect(seams?.useTaskCache).toBeUndefined();
        return 0;
      },
    });
    expect(seen).toBe(now + RELEASE_CHECK_TIMEOUT_MS);
  });

  it("names the timed-out gate from completion.gates", () => {
    const [ok, msg] = runReleaseCheck("/proj", {
      dispatchCheck: (_fw, _proj, seams) => {
        seams?.onCheckComplete?.({
          exitCode: 124,
          gates: [{ id: "verify:ac", status: "failed", exit_code: 124 }],
          suiteTeeText: "",
        });
        return 124;
      },
    });
    expect(ok).toBe(false);
    expect(msg).toContain("verify:ac");
    expect(msg).not.toMatch(/vitest coverage hang/i);
    expect(msg).toContain("RELEASING.md");
  });
});

describe("cached remaining-time hang kill (#4801)", () => {
  it("passes remaining time to non-suite gates and refuses before spawn at 0", () => {
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let now = 1_000_000;
    const timed: number[] = [];
    let completionGates: Array<{ id: string; exit_code?: number }> = [];
    const code = dispatchCachedTaskCheck("/fw-4801-remain", "/fw-4801-remain", {
      noCache: true,
      preflight: null,
      emitRunSummary: false,
      deadlineAtMs: 1_001_000,
      nowMs: () => now,
      superviseTimed: (plan) => {
        timed.push(plan.timeoutMs ?? -1);
        now += 400;
        return {
          exitCode: 0,
          timedOut: false,
          signal: null,
          stdout: "ok",
          stderr: "",
          teePath: "",
          teeRel: "",
        };
      },
      onCheckComplete: (snap) => {
        completionGates = snap.gates.map((g) => ({ id: g.id, exit_code: g.exit_code }));
      },
    });
    expect(timed[0]).toBe(1000);
    expect(timed[1]).toBe(600);
    expect(timed[2]).toBe(200);
    expect(timed.length).toBe(3);
    expect(code).toBe(124);
    expect(completionGates.some((g) => g.exit_code === 124)).toBe(true);
    errWrite.mockRestore();
  });

  it("refuses the first gate when the deadline is already exhausted", () => {
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const timed: string[] = [];
    let hung: string | undefined;
    const code = dispatchCachedTaskCheck("/fw-4801-first", "/fw-4801-first", {
      noCache: true,
      preflight: null,
      emitRunSummary: false,
      deadlineAtMs: 1,
      nowMs: () => 2,
      superviseTimed: () => {
        timed.push("spawned");
        return {
          exitCode: 0,
          timedOut: false,
          signal: null,
          stdout: "",
          stderr: "",
          teePath: "",
          teeRel: "",
        };
      },
      onCheckComplete: (snap) => {
        hung = snap.gates.find((g) => g.exit_code === 124)?.id;
      },
    });
    expect(timed).toEqual([]);
    expect(code).toBe(124);
    expect(hung).toBe("verify:ac");
    errWrite.mockRestore();
  });

  it("keeps runSupervisedGate on the suite gate when a deadline is armed", () => {
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const now = 1_000_000;
    let suiteTimeout: number | undefined;
    let timedCount = 0;
    const code = dispatchCachedTaskCheck("/fw-4801-suite", "/fw-4801-suite", {
      noCache: true,
      preflight: null,
      emitRunSummary: false,
      deadlineAtMs: now + 5_000,
      nowMs: () => now,
      superviseTimed: () => {
        timedCount += 1;
        return {
          exitCode: 0,
          timedOut: false,
          signal: null,
          stdout: "ok",
          stderr: "",
          teePath: "",
          teeRel: "",
        };
      },
      superviseSuite: (plan) => {
        suiteTimeout = plan.timeoutMs;
        return {
          exitCode: 0,
          timedOut: false,
          signal: null,
          stdout: "suite",
          stderr: "",
          teePath: "",
          teeRel: "",
        };
      },
    });
    expect(code).toBe(0);
    expect(timedCount).toBeGreaterThan(0);
    expect(suiteTimeout).toBe(5_000);
    errWrite.mockRestore();
  });
});
