import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_WAIT_MINUTES,
  DEFAULT_POLL_SECONDS,
  EXIT_CLEAN,
  EXIT_NEW_P0_P1,
  EXIT_TERMINAL_ERROR,
} from "./constants.js";
import { emitWatchJson, parseWatchArgs, runWatch, watchResultToJson } from "./main.js";
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
    expect(json.elapsed_seconds).toBe(180);
    expect(json.poll_count).toBe(3);
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
