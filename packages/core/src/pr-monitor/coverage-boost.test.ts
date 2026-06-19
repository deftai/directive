import { describe, expect, it, vi } from "vitest";
import * as computeMod from "../pr-merge-readiness/compute.js";
import { EXIT_CAP_REACHED, EXIT_CLEAN, EXIT_CONFIG_ERROR, EXIT_PR_TERMINAL } from "./constants.js";
import { parseMonitorArgs, runMonitor } from "./main.js";
import { formatPollStatus, monitor, summaryLabelForExit } from "./monitor.js";
import { callReadiness, readinessExitToPoll } from "./readiness.js";
import type { PollResult } from "./types.js";

describe("coverage boost", () => {
  it("formatPollStatus handles non-string via and non-array failures", () => {
    const line = formatPollStatus(1, {
      exitCode: 1,
      payload: { via: 42, merge_ready: false, failures: "nope" },
      rawStdout: "",
      rawStderr: "",
    });
    expect(line).toContain("via=?");
    expect(line).toContain("(0 failures)");
  });

  it("forwards readiness stderr after poll status", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    monitor(1, "deftai/directive", {
      capMinutes: 10,
      sleepFn: () => undefined,
      clockFn: { now: () => 0 },
      callReadinessFn: (): PollResult => ({
        exitCode: 1,
        payload: { via: "error", merge_ready: false, failures: ["x"] },
        rawStdout: "",
        rawStderr: "captured gh noise",
      }),
    });
    const written = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(written.indexOf("captured gh noise")).toBeGreaterThan(
      written.indexOf("[monitor_pr] poll #1"),
    );
    stderr.mockRestore();
  });

  it("returns CAP_REACHED when remaining budget is zero after poll", () => {
    let reads = 0;
    const clockFn = {
      now(): number {
        reads += 1;
        if (reads <= 2) return 0;
        return 1000;
      },
    };
    const result = monitor(1, "deftai/directive", {
      capMinutes: 0.001,
      cadence: [[1, 3]],
      sleepFn: () => undefined,
      clockFn,
      callReadinessFn: (): PollResult => ({
        exitCode: 1,
        payload: { via: "error", merge_ready: false, failures: ["blocked"] },
        rawStdout: "",
        rawStderr: "",
      }),
    });
    expect(result.exitCode).toBe(EXIT_CAP_REACHED);
    expect(result.pollCount).toBe(1);
  });

  it("returns CONFIG_ERROR when loop exhausts with config exit", () => {
    const result = monitor(1, "deftai/directive", {
      capMinutes: 120,
      cadence: [[1, 1]],
      sleepFn: () => undefined,
      clockFn: { now: () => 0 },
      callReadinessFn: (): PollResult => ({
        exitCode: EXIT_CONFIG_ERROR,
        payload: { via: "error", merge_ready: false },
        rawStdout: "",
        rawStderr: "",
      }),
    });
    expect(result.exitCode).toBe(EXIT_CONFIG_ERROR);
  });

  it("summaryLabelForExit covers all labels", () => {
    expect(summaryLabelForExit(EXIT_CLEAN)).toBe("CLEAN");
    expect(summaryLabelForExit(EXIT_CAP_REACHED)).toBe("CAP-REACHED");
    expect(summaryLabelForExit(EXIT_PR_TERMINAL)).toBe("PR-TERMINAL");
    expect(summaryLabelForExit(EXIT_CONFIG_ERROR)).toBe("CONFIG-ERROR");
    expect(summaryLabelForExit(99)).toBe("UNKNOWN");
  });

  it("parseMonitorArgs covers remaining branches", () => {
    expect(parseMonitorArgs(["1", "--repo"]).error).toContain("--repo");
    expect(parseMonitorArgs(["1", "--cap-minutes"]).error).toContain("--cap-minutes");
    expect(parseMonitorArgs(["1", "--cap-minutes=bad"]).error).toContain("invalid");
    expect(parseMonitorArgs(["1", "--repo=org/r", "--cap-minutes=5"]).capMinutes).toBe(5);
    expect(parseMonitorArgs(["1", "2"]).error).toContain("unrecognized");
    expect(parseMonitorArgs(["0"]).error).toContain("invalid");
    expect(parseMonitorArgs([]).error).toContain("required");
  });

  it("runMonitor returns config error on parse failure", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(runMonitor(["--json"])).toBe(EXIT_CONFIG_ERROR);
    stderr.mockRestore();
  });

  it("runMonitor uses GH_REPO when --repo omitted", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const prev = process.env.GH_REPO;
    process.env.GH_REPO = "deftai/directive";
    expect(
      runMonitor(["1363", "--json"], {
        monitorFn: () => ({
          exitCode: EXIT_PR_TERMINAL,
          payload: { via: "fallback2", merge_ready: false },
          pollCount: 1,
        }),
      }),
    ).toBe(EXIT_PR_TERMINAL);
    if (prev === undefined) {
      delete process.env.GH_REPO;
    } else {
      process.env.GH_REPO = prev;
    }
    stderr.mockRestore();
    stdout.mockRestore();
  });

  it("callReadiness captures buffer stderr chunks", () => {
    const result = callReadiness(1, "deftai/directive", {
      runGh: () => {
        process.stderr.write(Buffer.from("buf-err"));
        return { returncode: 1, stdout: "", stderr: "head fail" };
      },
    });
    expect(result.rawStderr).toContain("buf-err");
  });

  it("callReadiness handles thrown non-Error values", () => {
    vi.spyOn(computeMod, "computeGateResult").mockImplementationOnce(() => {
      throw "boom";
    });
    const result = callReadiness(1, "deftai/directive");
    expect(result.exitCode).toBe(EXIT_CONFIG_ERROR);
    expect(result.payload.error).toContain("boom");
    vi.restoreAllMocks();
  });

  it("readinessExitToPoll maps external error", () => {
    expect(readinessExitToPoll(2)).toBe(1);
    expect(readinessExitToPoll(0)).toBe(0);
  });
});
