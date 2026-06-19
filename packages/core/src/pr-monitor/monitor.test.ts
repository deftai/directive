import { describe, expect, it } from "vitest";
import { cadenceIntervals } from "./cadence.js";
import { DEFAULT_CADENCE, EXIT_CAP_REACHED, EXIT_CLEAN, EXIT_PR_TERMINAL } from "./constants.js";
import { formatPollStatus, isTerminalPrState, monitor } from "./monitor.js";
import type { PollResult } from "./types.js";

const HEAD_SHA = "abc1234567890def1234567890abcdef12345678";

class FakeClock {
  value = 0;

  now(): number {
    return this.value;
  }
}

function makeCallLog(...payloads: Array<Record<string, unknown>>) {
  const seq = [...payloads];
  return (_prNumber: number, _repo: string): PollResult => {
    const payload = seq.shift() ?? { via: "error", merge_ready: false, error: "no more" };
    return {
      exitCode: payload.merge_ready === true ? 0 : 1,
      payload,
      rawStdout: JSON.stringify(payload),
      rawStderr: "",
    };
  };
}

describe("cadenceIntervals", () => {
  it("expands tier repeats", () => {
    expect(
      cadenceIntervals([
        [60, 3],
        [180, 3],
        [300, 5],
      ]),
    ).toEqual([60, 60, 60, 180, 180, 180, 300, 300, 300, 300, 300]);
  });

  it("default cadence includes 1/3/5 minute tiers", () => {
    const intervals = new Set(DEFAULT_CADENCE.map(([interval]) => interval));
    expect(intervals.has(60)).toBe(true);
    expect(intervals.has(180)).toBe(true);
    expect(intervals.has(300)).toBe(true);
  });
});

describe("formatPollStatus", () => {
  it("formats clean poll line", () => {
    const line = formatPollStatus(1, {
      exitCode: 0,
      payload: { via: "primary", merge_ready: true, head_sha: HEAD_SHA, failures: [] },
      rawStdout: "",
      rawStderr: "",
    });
    expect(line).toContain("via=primary");
    expect(line).toContain("CLEAN");
    expect(line).toContain("head=abc123456789");
  });

  it("includes first failure excerpt", () => {
    const line = formatPollStatus(2, {
      exitCode: 1,
      payload: {
        via: "error",
        merge_ready: false,
        head_sha: null,
        failures: ["something went wrong badly enough to truncate here for test"],
      },
      rawStdout: "",
      rawStderr: "",
    });
    expect(line).toContain("BLOCKED");
    expect(line).toContain("something went wrong");
  });
});

describe("isTerminalPrState", () => {
  it("detects merged PR", () => {
    expect(
      isTerminalPrState({
        partial_data: { merged: true, pr_state: "closed" },
      }),
    ).toBe(true);
  });

  it("detects closed unmerged PR", () => {
    expect(isTerminalPrState({ partial_data: { pr_state: "closed", merged: false } })).toBe(true);
  });

  it("returns false without partial_data", () => {
    expect(isTerminalPrState({ via: "primary" })).toBe(false);
  });
});

describe("monitor loop", () => {
  it("exits CLEAN on first poll without sleeping", () => {
    const clock = new FakeClock();
    const sleeps: number[] = [];
    const result = monitor(1363, "deftai/directive", {
      capMinutes: 10,
      sleepFn: (s) => {
        sleeps.push(s);
      },
      clockFn: clock,
      callReadinessFn: makeCallLog({
        via: "primary",
        merge_ready: true,
        head_sha: HEAD_SHA,
        failures: [],
      }),
    });
    expect(result.exitCode).toBe(EXIT_CLEAN);
    expect(result.pollCount).toBe(1);
    expect(result.payload.via).toBe("primary");
    expect(sleeps).toEqual([]);
  });

  it("becomes ready after transient fallback2 polls", () => {
    const clock = new FakeClock();
    const advancingSleep = (s: number) => {
      clock.value += s;
    };
    const result = monitor(1363, "deftai/directive", {
      capMinutes: 120,
      cadence: [[1, 5]],
      sleepFn: advancingSleep,
      clockFn: clock,
      callReadinessFn: makeCallLog(
        { via: "fallback2", merge_ready: false, failures: ["a"] },
        { via: "fallback2", merge_ready: false, failures: ["a"] },
        { via: "primary", merge_ready: true, failures: [] },
      ),
    });
    expect(result.exitCode).toBe(EXIT_CLEAN);
    expect(result.payload.via).toBe("primary");
    expect(result.pollCount).toBe(3);
  });

  it("does not treat fallback2 merge_ready true as CLEAN", () => {
    const clock = new FakeClock();
    const advancingSleep = (s: number) => {
      clock.value += s;
    };
    const result = monitor(1363, "deftai/directive", {
      capMinutes: 120,
      cadence: [[1, 3]],
      sleepFn: advancingSleep,
      clockFn: clock,
      callReadinessFn: makeCallLog(
        { via: "fallback2", merge_ready: true, failures: [] },
        { via: "fallback2", merge_ready: true, failures: [] },
        { via: "fallback2", merge_ready: true, failures: [] },
      ),
    });
    expect(result.exitCode).toBe(EXIT_CAP_REACHED);
    expect(result.payload.via).toBe("fallback2");
    expect(result.pollCount).toBe(3);
  });

  it("short-circuits on terminal PR state", () => {
    const clock = new FakeClock();
    const result = monitor(1363, "deftai/directive", {
      capMinutes: 10,
      sleepFn: () => undefined,
      clockFn: clock,
      callReadinessFn: makeCallLog({
        via: "fallback2",
        merge_ready: false,
        failures: ["fallback2 is a coarse signal..."],
        partial_data: { pr_state: "closed", merged: true, mergeable: null },
      }),
    });
    expect(result.exitCode).toBe(EXIT_PR_TERMINAL);
    expect(result.pollCount).toBe(1);
  });

  it("returns CAP_REACHED when cap expires", () => {
    const clock = new FakeClock();
    const advancingSleep = (s: number) => {
      clock.value += s * 1000;
    };
    const result = monitor(1363, "deftai/directive", {
      capMinutes: 1,
      cadence: [[1, 5]],
      sleepFn: advancingSleep,
      clockFn: clock,
      callReadinessFn: makeCallLog(
        ...Array.from({ length: 10 }, () => ({
          via: "error",
          merge_ready: false,
          failures: ["x"],
        })),
      ),
    });
    expect(result.exitCode).toBe(EXIT_CAP_REACHED);
  });

  it("returns early when elapsed exceeds cap before poll", () => {
    let reads = 0;
    const clockFn = {
      now(): number {
        reads += 1;
        return reads === 1 ? 0 : 1000;
      },
    };
    const result = monitor(1363, "deftai/directive", {
      capMinutes: 0,
      cadence: [[1, 5]],
      sleepFn: () => undefined,
      clockFn,
      callReadinessFn: makeCallLog({
        via: "error",
        merge_ready: false,
        failures: ["x"],
      }),
    });
    expect(result.exitCode).toBe(EXIT_CAP_REACHED);
    expect(result.pollCount).toBe(0);
  });

  it("survives transient error payloads and resolves on fallback1 CLEAN", () => {
    const clock = new FakeClock();
    const advancingSleep = (s: number) => {
      clock.value += s;
    };
    const result = monitor(1363, "deftai/directive", {
      capMinutes: 120,
      cadence: [[1, 4]],
      sleepFn: advancingSleep,
      clockFn: clock,
      callReadinessFn: makeCallLog(
        { via: "error", merge_ready: false, error: "gh timeout", failures: ["external"] },
        { via: "error", merge_ready: false, error: "decode crash", failures: ["external"] },
        { via: "fallback1", merge_ready: true, head_sha: HEAD_SHA, failures: [] },
      ),
    });
    expect(result.exitCode).toBe(EXIT_CLEAN);
    expect(result.payload.via).toBe("fallback1");
    expect(result.pollCount).toBe(3);
  });
});
