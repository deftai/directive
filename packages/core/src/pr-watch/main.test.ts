import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_WAIT_MINUTES,
  DEFAULT_POLL_SECONDS,
  EXIT_CLEAN,
  EXIT_NEW_P0_P1,
  EXIT_TERMINAL_ERROR,
  WATCH_HELP,
} from "./constants.js";
import {
  emitWatchJson,
  formatWatchHelp,
  parseWatchArgs,
  printWatchHuman,
  runWatch,
  watchResultToJson,
} from "./main.js";
import type { WatchProbe, WatchResult } from "./types.js";

const HEAD = "abcdef1234567890abcdef1234567890abcdef12";

function makeProbe(overrides: Partial<WatchProbe> = {}): WatchProbe {
  return {
    found: true,
    headSha: HEAD,
    lastReviewedSha: HEAD,
    shaMatch: true,
    confidence: 5,
    p0Count: 0,
    p1Count: 0,
    hasBlocking: false,
    errored: false,
    ciFailures: 0,
    ciFailedChecks: [],
    ciReadyState: "ready",
    ciCapacityStalledChecks: [],
    terminalCheckRun: true,
    isClean: false,
    cleanGateHoldout: null,
    error: null,
    ...overrides,
  };
}

describe("parseWatchArgs", () => {
  it("requires a PR number", () => {
    expect(parseWatchArgs([]).error).toContain("required");
  });

  it("rejects a non-positive PR number", () => {
    expect(parseWatchArgs(["0"]).error).toContain("invalid PR number");
    expect(parseWatchArgs(["-3"]).error).toContain("unrecognized");
  });

  it("defaults max-wait/poll and parses the PR number", () => {
    const a = parseWatchArgs(["1056"]);
    expect(a.error).toBeUndefined();
    expect(a.prNumber).toBe(1056);
    expect(a.maxWaitMinutes).toBe(DEFAULT_MAX_WAIT_MINUTES);
    expect(a.pollSeconds).toBe(DEFAULT_POLL_SECONDS);
    expect(a.oneShot).toBe(false);
    expect(a.emitJson).toBe(false);
  });

  it("parses all flags (space and = forms)", () => {
    const a = parseWatchArgs([
      "42",
      "--one-shot",
      "--json",
      "--max-wait-minutes",
      "10",
      "--poll-seconds=15",
      "--repo",
      "deftai/directive",
      "--project-root=/tmp/x",
    ]);
    expect(a.error).toBeUndefined();
    expect(a.oneShot).toBe(true);
    expect(a.emitJson).toBe(true);
    expect(a.maxWaitMinutes).toBe(10);
    expect(a.pollSeconds).toBe(15);
    expect(a.repo).toBe("deftai/directive");
    expect(a.projectRoot).toBe("/tmp/x");
  });

  it("rejects invalid numeric flag values", () => {
    expect(parseWatchArgs(["1", "--poll-seconds", "abc"]).error).toContain("--poll-seconds");
    expect(parseWatchArgs(["1", "--max-wait-minutes", "-1"]).error).toContain("--max-wait-minutes");
  });

  it("rejects unknown flags", () => {
    expect(parseWatchArgs(["1", "--nope"]).error).toContain("unrecognized");
  });

  it("accepts --help / -h without a PR number (#2652)", () => {
    expect(parseWatchArgs(["--help"]).help).toBe(true);
    expect(parseWatchArgs(["--help"]).error).toBeUndefined();
    expect(parseWatchArgs(["-h"]).help).toBe(true);
    expect(parseWatchArgs(["1056", "--help"]).help).toBe(true);
  });
});

describe("formatWatchHelp (#2652)", () => {
  it("names task pr:watch as canonical and documents exits 0/1/2", () => {
    const help = formatWatchHelp();
    expect(help).toBe(WATCH_HELP);
    expect(help).toContain("task pr:watch -- <pr_number>");
    expect(help).toContain("--one-shot");
    expect(help).toContain("--json");
    expect(help).toContain("--max-wait-minutes");
    expect(help).toContain("--poll-seconds");
    expect(help).toContain("--repo");
    expect(help).toContain("--project-root");
    expect(help).toContain("0  CLEAN");
    expect(help).toContain("1  NEW_P0_P1");
    expect(help).toContain("2  ERRORED");
  });
});

describe("watchResultToJson (AC-4 shape)", () => {
  const result: WatchResult = {
    verdict: "CLEAN",
    exitCode: EXIT_CLEAN,
    prNumber: 1056,
    probe: makeProbe({ isClean: true }),
    elapsedSeconds: 180,
    pollCount: 3,
  };

  it("pins the exact field set and order", () => {
    expect(Object.keys(watchResultToJson(result))).toEqual([
      "verdict",
      "pr_number",
      "head_sha",
      "last_reviewed_sha",
      "sha_match",
      "confidence",
      "p0_count",
      "p1_count",
      "errored",
      "ci_failures",
      "ci_failed_checks",
      "ci_ready_state",
      "ci_capacity_stalled_checks",
      "is_clean",
      "clean_gate_holdout",
      "elapsed_seconds",
      "poll_count",
    ]);
  });

  it("maps probe values into snake_case JSON", () => {
    const json = watchResultToJson(result) as Record<string, unknown>;
    expect(json.verdict).toBe("CLEAN");
    expect(json.pr_number).toBe(1056);
    expect(json.head_sha).toBe(HEAD);
    expect(json.sha_match).toBe(true);
    expect(json.is_clean).toBe(true);
    expect(json.ci_ready_state).toBe("ready");
    expect(json.ci_capacity_stalled_checks).toEqual([]);
    expect(json.elapsed_seconds).toBe(180);
    expect(json.poll_count).toBe(3);
    // Non-weather ready_state must not include platform status URLs (#3180).
    expect(json.platform_status_github).toBeUndefined();
    expect(json.platform_status_blacksmith).toBeUndefined();
  });

  it("surfaces static platform status URLs on weather-class ci_ready_state (#3180)", () => {
    const weather: WatchResult = {
      ...result,
      verdict: "CI_NEVER_SCHEDULED",
      exitCode: EXIT_TERMINAL_ERROR,
      probe: makeProbe({
        isClean: false,
        ciReadyState: "ci_never_scheduled",
        cleanGateHoldout: "ci_never_scheduled",
      }),
    };
    const json = watchResultToJson(weather) as Record<string, unknown>;
    expect(json.ci_ready_state).toBe("ci_never_scheduled");
    expect(json.platform_status_github).toBe("https://www.githubstatus.com/");
    expect(json.platform_status_blacksmith).toBe("https://status.blacksmith.sh/");
    const human = printWatchHuman(weather);
    expect(human).toContain("https://www.githubstatus.com/");
    expect(human).toContain("https://status.blacksmith.sh/");
    expect(human).toContain("Probe status pages before workflow edits (#3180)");
  });

  it("emits ASCII-escaped JSON with a trailing newline", () => {
    const out = emitWatchJson(result);
    expect(out.endsWith("\n")).toBe(true);
    expect(JSON.parse(out).verdict).toBe("CLEAN");
  });
});

describe("runWatch (exit-code passthrough + JSON)", () => {
  let stdout = "";
  afterEach(() => {
    stdout = "";
    vi.restoreAllMocks();
  });

  const spyStdout = () => {
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  };

  it("returns exit 0 and emits AC-4 JSON on a CLEAN verdict", () => {
    spyStdout();
    const probeFn = () => makeProbe({ isClean: true });
    const code = runWatch(["1056", "--json", "--one-shot", "--repo", "deftai/directive"], {
      probeFn,
    });
    expect(code).toBe(EXIT_CLEAN);
    const payload = JSON.parse(stdout) as Record<string, unknown>;
    expect(payload.verdict).toBe("CLEAN");
    expect(payload.pr_number).toBe(1056);
  });

  it("returns exit 1 on a NEW_P0_P1 verdict", () => {
    spyStdout();
    const probeFn = () =>
      makeProbe({
        hasBlocking: true,
        p0Count: 1,
        shaMatch: true,
        cleanGateHoldout: "has_blocking",
      });
    const code = runWatch(["1056", "--one-shot", "--repo", "deftai/directive"], { probeFn });
    expect(code).toBe(EXIT_NEW_P0_P1);
    expect(stdout).toContain("NEW_P0_P1");
  });

  it("returns exit 0 and prints usage for --help (#2652)", () => {
    spyStdout();
    const code = runWatch(["--help"], {});
    expect(code).toBe(EXIT_CLEAN);
    expect(stdout).toContain("task pr:watch -- <pr_number>");
    expect(stdout).toContain("exit codes:");
  });

  it("returns exit 0 for -h (#2652)", () => {
    spyStdout();
    expect(runWatch(["-h"], {})).toBe(EXIT_CLEAN);
    expect(stdout).toContain("task pr:watch");
  });

  it("returns exit 2 on a parse error", () => {
    spyStdout();
    const code = runWatch(["--bogus"], {});
    expect(code).toBe(EXIT_TERMINAL_ERROR);
  });

  it("returns exit 2 when --project-root does not exist", () => {
    spyStdout();
    const code = runWatch(["1056", "--project-root", "/nonexistent/path/xyz-1056"], {
      probeFn: () => makeProbe({ isClean: true }),
    });
    expect(code).toBe(EXIT_TERMINAL_ERROR);
  });
});
