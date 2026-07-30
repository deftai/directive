import { afterEach, describe, expect, it, vi } from "vitest";
import { IssueState } from "../intake/reconcile-issues.js";
import type { CompletedProcess } from "../scm/call.js";
import {
  computeRateLimitSleepSeconds,
  fetchIssueStatesForRelease,
  formatRateLimitFailureDetails,
  MAX_RATE_LIMIT_RETRY_SLEEP_S,
  probeGithubRateLimit,
} from "./issue-state-fetch.js";

function completed(stdout = "", stderr = "", returncode = 0): CompletedProcess {
  return { args: [], returncode, stdout, stderr };
}

const RATE_LIMIT_STDERR =
  "gh: API rate limit exceeded for user (HTTP 403)\nX-RateLimit-Reset: 2000000300\n";

describe("issue-state-fetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("probeGithubRateLimit parses core and graphql remaining", () => {
    const scmCall = vi.fn().mockReturnValue(
      completed(
        JSON.stringify({
          resources: {
            core: { remaining: 0, reset: 2000000300 },
            graphql: { remaining: 4933, reset: 2000000300 },
          },
        }),
      ),
    );
    const probe = probeGithubRateLimit(scmCall);
    expect(probe).toEqual({
      coreRemaining: 0,
      coreResetUnix: 2000000300,
      graphqlRemaining: 4933,
    });
    expect(scmCall).toHaveBeenCalledWith("github-issue", "api", ["rate_limit"], {
      timeout: 30,
      cwd: undefined,
    });
  });

  it("computeRateLimitSleepSeconds caps at MAX_RATE_LIMIT_RETRY_SLEEP_S", () => {
    const nowSec = 2_000_000_000;
    const probe = { coreRemaining: 0, coreResetUnix: nowSec + 900, graphqlRemaining: 100 };
    const sleepS = computeRateLimitSleepSeconds(RATE_LIMIT_STDERR, probe, nowSec);
    expect(sleepS).toBe(MAX_RATE_LIMIT_RETRY_SLEEP_S);
  });

  it("computeRateLimitSleepSeconds returns 0 when not rate-limited", () => {
    expect(computeRateLimitSleepSeconds("404 Not Found", null, 1_700_000_000)).toBe(0);
  });

  it("formatRateLimitFailureDetails includes vbrief:validate and allow-vbrief-drift guidance", () => {
    const details = formatRateLimitFailureDetails(
      { coreRemaining: 0, coreResetUnix: 2_000_000_300, graphqlRemaining: 4933 },
      true,
    );
    expect(details).toContain("core.remaining=0");
    expect(details).toContain("task vbrief:validate");
    expect(details).toContain("--allow-vbrief-drift");
  });

  it("fetchIssueStatesForRelease retries once after rate-limit sleep", () => {
    const sleep = vi.fn();
    const now = vi.fn().mockReturnValue(2_000_000_000);
    let issueCalls = 0;
    const scmCall = vi.fn((_source: string, _verb: string, args: readonly string[] | null) => {
      if (args?.[0] === "rate_limit") {
        return completed(
          JSON.stringify({
            resources: {
              core: { remaining: 0, reset: 2_000_000_060 },
              graphql: { remaining: 4933, reset: 2_000_000_060 },
            },
          }),
        );
      }
      issueCalls += 1;
      if (issueCalls === 1) {
        return completed("", RATE_LIMIT_STDERR, 1);
      }
      return completed(JSON.stringify({ state: "open", state_reason: null }));
    });

    const result = fetchIssueStatesForRelease("deftai/directive", new Set([206]), {
      scmCall,
      sleep,
      now,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.states.get(206)?.value).toBe("OPEN");
    }
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(issueCalls).toBe(2);
  });

  it("fetchIssueStatesForRelease emits actionable failure after retry still rate-limited", () => {
    const sleep = vi.fn();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const scmCall = vi.fn((_source: string, _verb: string, args: readonly string[] | null) => {
      if (args?.[0] === "rate_limit") {
        return completed(
          JSON.stringify({
            resources: {
              core: { remaining: 0, reset: 2_000_000_300 },
              graphql: { remaining: 4933, reset: 2_000_000_300 },
            },
          }),
        );
      }
      return completed("", RATE_LIMIT_STDERR, 1);
    });

    const result = fetchIssueStatesForRelease("deftai/directive", new Set([206]), {
      scmCall,
      sleep,
      now: () => 2_000_000_000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("rate limit exhausted");
    }
    expect(sleep).toHaveBeenCalledTimes(1);
    const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrText).toContain("core.remaining=0");
    expect(stderrText).toContain("--allow-vbrief-drift");
    stderrSpy.mockRestore();
  });

  it("fetchIssueStatesForRelease does not probe rate_limit on non-rate-limit failures", () => {
    const sleep = vi.fn();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const scmCall = vi.fn().mockReturnValue(completed("", "auth failed", 1));
    const result = fetchIssueStatesForRelease("deftai/directive", new Set([1]), {
      scmCall,
      sleep,
    });
    expect(result.ok).toBe(false);
    expect(scmCall).toHaveBeenCalledTimes(1);
    const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrText).not.toContain("rate limit probe");
    expect(stderrText).not.toContain("--allow-vbrief-drift");
    stderrSpy.mockRestore();
  });

  it("fetchIssueStatesForRelease does not retry on non-rate-limit failures", () => {
    const sleep = vi.fn();
    const scmCall = vi.fn().mockReturnValue(completed("", "auth failed", 1));
    const result = fetchIssueStatesForRelease("deftai/directive", new Set([1]), {
      scmCall,
      sleep,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("failed to fetch issue states from gh");
    }
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fetchIssueStatesForRelease succeeds without retry when first fetch works", () => {
    const sleep = vi.fn();
    const scmCall = vi
      .fn()
      .mockReturnValue(completed(JSON.stringify({ state: "closed", state_reason: "completed" })));
    const result = fetchIssueStatesForRelease("deftai/directive", new Set([11]), {
      scmCall,
      sleep,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.states.get(11)).toEqual(new IssueState("CLOSED", "COMPLETED"));
    }
    expect(sleep).not.toHaveBeenCalled();
  });

  it("probeGithubRateLimit fails open on throw, non-zero, empty, and bad JSON (#2952)", () => {
    expect(
      probeGithubRateLimit(
        vi.fn().mockImplementation(() => {
          throw new Error("boom");
        }),
      ),
    ).toBeNull();
    expect(probeGithubRateLimit(vi.fn().mockReturnValue(completed("", "err", 1)))).toBeNull();
    expect(probeGithubRateLimit(vi.fn().mockReturnValue(completed("   ", "", 0)))).toBeNull();
    expect(probeGithubRateLimit(vi.fn().mockReturnValue(completed("not-json", "", 0)))).toBeNull();
    expect(probeGithubRateLimit(vi.fn().mockReturnValue(completed("null", "", 0)))).toBeNull();
    expect(probeGithubRateLimit(vi.fn().mockReturnValue(completed("[]", "", 0)))).toBeNull();
    expect(
      probeGithubRateLimit(
        vi.fn().mockReturnValue(completed(JSON.stringify({ resources: null }), "", 0)),
      ),
    ).toBeNull();
    expect(
      probeGithubRateLimit(
        vi
          .fn()
          .mockReturnValue(
            completed(JSON.stringify({ resources: { core: null, graphql: {} } }), "", 0),
          ),
      ),
    ).toBeNull();
    expect(
      probeGithubRateLimit(
        vi.fn().mockReturnValue(
          completed(
            JSON.stringify({
              resources: { core: { remaining: "nope" }, graphql: { remaining: 1 } },
            }),
            "",
            0,
          ),
        ),
      ),
    ).toBeNull();
    // Missing remaining fields yield nulls (not NaN).
    expect(
      probeGithubRateLimit(
        vi
          .fn()
          .mockReturnValue(
            completed(JSON.stringify({ resources: { core: { reset: 100 }, graphql: {} } }), "", 0),
          ),
      ),
    ).toEqual({ coreRemaining: null, coreResetUnix: 100, graphqlRemaining: null });
  });

  it("computeRateLimitSleepSeconds uses probe reset when header absent (#2952)", () => {
    const nowSec = 1_000;
    const probe = { coreRemaining: 0, coreResetUnix: nowSec + 30, graphqlRemaining: 1 };
    // detectRateLimit must see a rate-limit stderr shape without X-RateLimit-Reset.
    const sleepS = computeRateLimitSleepSeconds(
      "gh: API rate limit exceeded for user (HTTP 403)",
      probe,
      nowSec,
    );
    expect(sleepS).toBeGreaterThanOrEqual(1);
    expect(sleepS).toBeLessThanOrEqual(MAX_RATE_LIMIT_RETRY_SLEEP_S);
  });

  it("formatRateLimitFailureDetails covers probe-null and non-rate-limit paths (#2952)", () => {
    const noProbe = formatRateLimitFailureDetails(null, false);
    expect(noProbe).toContain("Probe `gh api rate_limit`");
    expect(noProbe).not.toContain("Recovery:");
    const noReset = formatRateLimitFailureDetails(
      { coreRemaining: null, coreResetUnix: null, graphqlRemaining: null },
      true,
    );
    expect(noReset).toContain("core.remaining=?");
    expect(noReset).toContain("gh api rate_limit");
    expect(noReset).toContain("Recovery:");
  });
});
