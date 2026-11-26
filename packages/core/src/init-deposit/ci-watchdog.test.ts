import { describe, expect, it, vi } from "vitest";
import {
  cancelMatchingPrimaries,
  isCancelableUnclaimed,
} from "../../../../.github/scripts/cancel-queued-ci-primary.mjs";
import {
  classifyJob,
  classifyJobsPayload,
  runnerClaimed as classifyRunnerClaimed,
} from "../../../../.github/scripts/classify-ci-job-state.mjs";
import {
  isCapacityDeath,
  isTransientApiError,
  resolveAuthoritativeLane,
  runnerClaimed,
  selectPrimaryJob,
} from "../../../../.github/scripts/resolve-ci-authoritative-lane.mjs";

describe("classify-ci-job-state (#2672 / #3168 / #3340)", () => {
  it("missing", () => {
    expect(classifyJob(null)).toBe("missing");
    expect(classifyJobsPayload("typescript (blacksmith primary)", { jobs: [] })).toBe("missing");
  });

  it("queued", () => {
    expect(
      classifyJob({
        name: "TypeScript (Blacksmith primary) / run",
        status: "queued",
        started_at: null,
        runner_name: null,
      }),
    ).toBe("queued");
  });

  it("waiting unclaimed is queued", () => {
    expect(
      classifyJob({
        name: "Go (Blacksmith primary) / run",
        status: "waiting",
        started_at: null,
        runner_name: null,
      }),
    ).toBe("queued");
  });

  it("started in_progress with runner (#2652)", () => {
    expect(
      classifyJob({
        name: "TypeScript (Blacksmith primary) / run",
        status: "in_progress",
        started_at: "2026-08-06T12:00:00Z",
        runner_name: "blacksmith-abc",
      }),
    ).toBe("started");
  });

  it("started_at alone is unclaimed (#3340)", () => {
    expect(
      classifyJob({
        name: "TypeScript (Blacksmith primary) / run",
        status: "in_progress",
        started_at: "2026-08-06T12:00:00Z",
        runner_name: null,
      }),
    ).toBe("queued");
  });

  it("queued with started_at and no runner is unclaimed", () => {
    expect(
      classifyJob({
        name: "Merge gate (Blacksmith primary)",
        status: "queued",
        started_at: "2026-08-13T15:20:00Z",
        runner_name: null,
      }),
    ).toBe("queued");
  });

  it("empty runner_name is unclaimed", () => {
    const job = {
      name: "Go (Blacksmith primary) / run",
      status: "in_progress",
      started_at: "2026-08-13T15:20:00Z",
      runner_name: "  ",
    };
    expect(classifyJob(job)).toBe("queued");
    expect(classifyRunnerClaimed(job)).toBe(false);
  });

  it("reusable caller in_progress without inner runner is unclaimed", () => {
    const payload = {
      jobs: [
        {
          name: "TypeScript (Blacksmith primary)",
          status: "in_progress",
          started_at: "2026-08-13T15:20:00Z",
          runner_name: null,
        },
        {
          name: "TypeScript (Blacksmith primary) / run",
          status: "queued",
          started_at: null,
          runner_name: null,
        },
      ],
    };
    expect(classifyJobsPayload("typescript (blacksmith primary)", payload)).toBe("queued");
  });

  it("reusable inner runner is claimed", () => {
    const payload = {
      jobs: [
        {
          name: "TypeScript (Blacksmith primary)",
          status: "in_progress",
          started_at: "2026-08-13T15:20:00Z",
          runner_name: null,
        },
        {
          name: "TypeScript (Blacksmith primary) / run",
          status: "in_progress",
          started_at: "2026-08-13T15:21:00Z",
          runner_name: "blacksmith-abc",
        },
      ],
    };
    expect(classifyJobsPayload("typescript (blacksmith primary)", payload)).toBe("started");
  });

  it("cancelled with started_at and no runner is capacity death", () => {
    expect(
      classifyJob({
        name: "Merge gate (Blacksmith primary)",
        status: "completed",
        conclusion: "cancelled",
        started_at: "2026-08-13T15:20:00Z",
        runner_name: null,
      }),
    ).toBe("cancelled_unclaimed");
  });

  it("done success", () => {
    expect(
      classifyJob({
        name: "TypeScript (Blacksmith primary) / run",
        status: "completed",
        conclusion: "success",
        started_at: "2026-08-06T12:00:00Z",
        runner_name: "blacksmith-abc",
      }),
    ).toBe("done");
  });

  it("done failure after claim", () => {
    expect(
      classifyJob({
        name: "TypeScript (Blacksmith primary) / run",
        status: "completed",
        conclusion: "failure",
        started_at: "2026-08-06T12:00:00Z",
        runner_name: "blacksmith-abc",
      }),
    ).toBe("done");
  });

  it("cancelled unclaimed arms failover (#3168)", () => {
    expect(
      classifyJob({
        name: "TypeScript (Blacksmith primary) / run",
        status: "completed",
        conclusion: "cancelled",
        started_at: null,
        runner_name: null,
      }),
    ).toBe("cancelled_unclaimed");
  });

  it("skipped unclaimed arms failover", () => {
    expect(
      classifyJob({
        name: "Go (Blacksmith primary) / run",
        status: "completed",
        conclusion: "skipped",
        started_at: null,
        runner_name: null,
      }),
    ).toBe("cancelled_unclaimed");
  });

  it("cancelled after runner claim is done", () => {
    expect(
      classifyJob({
        name: "TypeScript (Blacksmith primary) / run",
        status: "completed",
        conclusion: "cancelled",
        started_at: "2026-08-06T12:00:00Z",
        runner_name: "blacksmith-abc",
      }),
    ).toBe("done");
  });

  it("needle match is case-insensitive", () => {
    expect(
      classifyJobsPayload("typescript (blacksmith primary)", {
        jobs: [
          {
            name: "TypeScript (Blacksmith primary) / run",
            status: "queued",
            started_at: null,
            runner_name: null,
          },
        ],
      }),
    ).toBe("queued");
  });
});

describe("cancel-queued-ci-primary (#2672 / #3168 / #3340)", () => {
  it("queued unclaimed is cancelable", () => {
    expect(isCancelableUnclaimed({ status: "queued", started_at: null, runner_name: null })).toBe(
      true,
    );
  });

  it("waiting unclaimed is cancelable", () => {
    expect(isCancelableUnclaimed({ status: "waiting", started_at: null, runner_name: null })).toBe(
      true,
    );
  });

  it("in_progress with runner is not cancelable (#2652)", () => {
    expect(
      isCancelableUnclaimed({
        status: "in_progress",
        started_at: "2026-08-06T12:00:00Z",
        runner_name: "blacksmith-abc",
      }),
    ).toBe(false);
  });

  it("in_progress without runner is cancelable (#3340)", () => {
    expect(
      isCancelableUnclaimed({
        status: "in_progress",
        started_at: "2026-08-13T15:20:00Z",
        runner_name: null,
      }),
    ).toBe(true);
  });

  it("queued with started_at and no runner is cancelable", () => {
    expect(
      isCancelableUnclaimed({
        status: "queued",
        started_at: "2026-08-13T15:20:00Z",
        runner_name: null,
      }),
    ).toBe(true);
  });

  it("claimed queued with runner is not cancelable", () => {
    expect(
      isCancelableUnclaimed({
        status: "queued",
        started_at: null,
        runner_name: "blacksmith-abc",
      }),
    ).toBe(false);
  });

  it("completed cancelled is not cancelable", () => {
    expect(
      isCancelableUnclaimed({
        status: "completed",
        conclusion: "cancelled",
        started_at: null,
        runner_name: null,
      }),
    ).toBe(false);
  });

  it("cancels only matching queued jobs", () => {
    const calls: string[][] = [];
    const payload = {
      jobs: [
        {
          id: 101,
          name: "TypeScript (Blacksmith primary) / run",
          status: "queued",
          started_at: null,
          runner_name: null,
        },
        {
          id: 102,
          name: "Go (Blacksmith primary) / run",
          status: "queued",
          started_at: null,
          runner_name: null,
        },
        {
          id: 103,
          name: "TypeScript (Blacksmith primary) / run",
          status: "in_progress",
          started_at: "2026-08-06T12:00:00Z",
          runner_name: "bs-1",
        },
        {
          id: 104,
          name: "TypeScript (Blacksmith primary) / run",
          status: "completed",
          conclusion: "cancelled",
          started_at: null,
          runner_name: null,
        },
      ],
    };
    const cancelled = cancelMatchingPrimaries("typescript (blacksmith primary)", payload, {
      repo: "deftai/directive",
      runner: (argv) => {
        calls.push([...argv]);
        return null;
      },
    });
    expect(cancelled).toEqual([101]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.at(-1)).toContain("repos/deftai/directive/actions/jobs/101/cancel");
  });

  it("cancels started_at-only in_progress", () => {
    const calls: string[][] = [];
    const payload = {
      jobs: [
        {
          id: 201,
          name: "Merge gate (Blacksmith primary)",
          status: "in_progress",
          started_at: "2026-08-13T15:20:00Z",
          runner_name: null,
        },
        {
          id: 202,
          name: "Merge gate (Blacksmith primary)",
          status: "in_progress",
          started_at: "2026-08-13T15:21:00Z",
          runner_name: "blacksmith-abc",
        },
      ],
    };
    const cancelled = cancelMatchingPrimaries("merge gate (blacksmith primary)", payload, {
      repo: "deftai/directive",
      runner: (argv) => {
        calls.push([...argv]);
        return null;
      },
    });
    expect(cancelled).toEqual([201]);
    expect(calls).toHaveLength(1);
  });
});

describe("resolve-ci-authoritative-lane helpers (#3340)", () => {
  it("started_at alone is not claimed", () => {
    expect(
      runnerClaimed({
        status: "in_progress",
        started_at: "2026-08-13T15:20:00Z",
        runner_name: null,
      }),
    ).toBe(false);
  });

  it("runner_name is claimed", () => {
    expect(
      runnerClaimed({
        status: "in_progress",
        started_at: "2026-08-13T15:20:00Z",
        runner_name: "blacksmith-abc",
      }),
    ).toBe(true);
  });

  it("cancelled with started_at and no runner is capacity death", () => {
    expect(
      isCapacityDeath({
        status: "completed",
        conclusion: "cancelled",
        started_at: "2026-08-13T15:20:00Z",
        runner_name: null,
      }),
    ).toBe(true);
  });

  it("cancelled after claim is not capacity death", () => {
    expect(
      isCapacityDeath({
        status: "completed",
        conclusion: "cancelled",
        started_at: "2026-08-13T15:20:00Z",
        runner_name: "blacksmith-abc",
      }),
    ).toBe(false);
  });

  it("prefers inner /run job", () => {
    const match = selectPrimaryJob("merge gate (blacksmith primary)", {
      jobs: [
        {
          name: "Merge gate (Blacksmith primary)",
          status: "in_progress",
          started_at: "2026-08-13T15:20:00Z",
          runner_name: null,
        },
        {
          name: "Merge gate (Blacksmith primary) / run",
          status: "queued",
          started_at: null,
          runner_name: null,
        },
      ],
    });
    expect(match).not.toBeNull();
    expect(String(match?.name)).toContain(" / run");
    expect(runnerClaimed(match)).toBe(false);
  });

  it("prefers claimed inner", () => {
    const match = selectPrimaryJob("go (blacksmith primary)", {
      jobs: [
        {
          name: "Go (Blacksmith primary)",
          status: "in_progress",
          runner_name: null,
        },
        {
          name: "Go (Blacksmith primary) / run",
          status: "in_progress",
          runner_name: "blacksmith-abc",
        },
      ],
    });
    expect(match?.runner_name).toBe("blacksmith-abc");
  });

  it("failover success is authoritative", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = resolveAuthoritativeLane({
      REPO: "deftai/directive",
      RUN_ID: "1",
      WANT_FAILOVER: "true",
      FAILOVER_RESULT: "success",
      PRIMARY_NEEDLE: "typescript (blacksmith primary)",
      SUITE_LABEL: "TypeScript",
    });
    expect(code).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toContain("GH-hosted failover");
    log.mockRestore();
  });

  it("failover non-success fails closed", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = resolveAuthoritativeLane({
      REPO: "deftai/directive",
      RUN_ID: "1",
      WANT_FAILOVER: "true",
      FAILOVER_RESULT: "failure",
      PRIMARY_NEEDLE: "typescript (blacksmith primary)",
      SUITE_LABEL: "TypeScript",
    });
    expect(code).toBe(1);
    err.mockRestore();
  });

  it("primary success is green", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = resolveAuthoritativeLane(
      {
        REPO: "deftai/directive",
        RUN_ID: "9",
        WANT_FAILOVER: "false",
        PRIMARY_NEEDLE: "typescript (blacksmith primary)",
        SUITE_LABEL: "TypeScript",
      },
      {
        ghApi: () => ({
          jobs: [
            {
              name: "TypeScript (Blacksmith primary) / run",
              status: "completed",
              conclusion: "success",
              runner_name: "blacksmith-abc",
            },
          ],
        }),
      },
    );
    expect(code).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toContain("Blacksmith primary");
    log.mockRestore();
  });

  it("capacity death without failover fails loud", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = resolveAuthoritativeLane(
      {
        REPO: "deftai/directive",
        RUN_ID: "9",
        WANT_FAILOVER: "false",
        PRIMARY_NEEDLE: "go (blacksmith primary)",
        SUITE_LABEL: "Go",
      },
      {
        ghApi: () => ({
          jobs: [
            {
              name: "Go (Blacksmith primary) / run",
              status: "completed",
              conclusion: "cancelled",
              runner_name: null,
            },
          ],
        }),
      },
    );
    expect(code).toBe(1);
    expect(String(err.mock.calls.at(-1)?.[0])).toContain("WANT_FAILOVER");
    err.mockRestore();
    vi.restoreAllMocks();
  });
});

describe("resolve-ci-authoritative-lane observation budget and retry (#7014)", () => {
  const BASE = {
    REPO: "deftai/directive",
    RUN_ID: "9",
    WANT_FAILOVER: "false",
    PRIMARY_NEEDLE: "merge gate (blacksmith primary)",
    SUITE_LABEL: "Merge-gate",
  };
  const MIN = 60_000;

  function primary(status: string, conclusion: string | null) {
    return {
      jobs: [
        {
          name: "Merge gate (Blacksmith primary)",
          status,
          conclusion,
          runner_name: "blacksmith-abc",
        },
      ],
    };
  }

  /** Fake clock: `sleep` advances `now`. */
  function clock() {
    let t = 0;
    return {
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
      },
      at: () => t,
    };
  }

  function quiet() {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    return err;
  }

  function lastError(err: ReturnType<typeof quiet>): string {
    return String(err.mock.calls.at(-1)?.[0]);
  }

  it.each(["cancelled", "failure"])("primary concluded %s after a timeout fails", (conclusion) => {
    const err = quiet();
    const c = clock();
    const code = resolveAuthoritativeLane(
      { ...BASE, OBSERVATION_BUDGET_MINUTES: "35" },
      { ghApi: () => primary("completed", conclusion), now: c.now, sleep: c.sleep },
    );
    expect(code).toBe(1);
    expect(lastError(err)).toContain(`concluded ${conclusion}`);
    vi.restoreAllMocks();
  });

  it.each([
    ["missing", { jobs: [] }],
    ["nonterminal", primary("in_progress", null)],
  ])("%s primary past the budget fails within the budget", (_label, payload) => {
    const err = quiet();
    const c = clock();
    const code = resolveAuthoritativeLane(
      { ...BASE, OBSERVATION_BUDGET_MINUTES: "35" },
      { ghApi: () => payload, now: c.now, sleep: c.sleep },
    );
    expect(code).toBe(1);
    expect(lastError(err)).toContain("Observation budget of 35 minutes exhausted");
    expect(c.at()).toBeGreaterThanOrEqual(35 * MIN);
    expect(c.at()).toBeLessThan(36 * MIN);
    vi.restoreAllMocks();
  });

  it("no budget set keeps the 6-hour deadline", () => {
    const err = quiet();
    const c = clock();
    const code = resolveAuthoritativeLane(BASE, {
      ghApi: () => primary("in_progress", null),
      now: c.now,
      sleep: c.sleep,
    });
    expect(code).toBe(1);
    expect(lastError(err)).toContain("Timed out waiting for Blacksmith Merge-gate primary");
    expect(c.at()).toBeGreaterThanOrEqual(6 * 60 * MIN);
    vi.restoreAllMocks();
  });

  it.each(["0", "-5", "abc"])("invalid budget %s is a config error", (bad) => {
    const err = quiet();
    const api = vi.fn();
    const code = resolveAuthoritativeLane(
      { ...BASE, OBSERVATION_BUDGET_MINUTES: bad },
      { ghApi: api },
    );
    expect(code).toBe(2);
    expect(api).not.toHaveBeenCalled();
    expect(lastError(err)).toContain("OBSERVATION_BUDGET_MINUTES");
    vi.restoreAllMocks();
  });

  it("one 502 then success passes", () => {
    quiet();
    const c = clock();
    let calls = 0;
    const code = resolveAuthoritativeLane(
      { ...BASE, OBSERVATION_BUDGET_MINUTES: "35" },
      {
        ghApi: () => {
          calls += 1;
          if (calls === 1) throw Object.assign(new Error("gh: HTTP 502"), { stderr: "HTTP 502" });
          return primary("completed", "success");
        },
        now: c.now,
        sleep: c.sleep,
      },
    );
    expect(code).toBe(0);
    expect(calls).toBe(2);
    expect(c.at()).toBe(2_000);
    vi.restoreAllMocks();
  });

  it("one call timeout then success passes", () => {
    quiet();
    const c = clock();
    let calls = 0;
    const code = resolveAuthoritativeLane(BASE, {
      ghApi: () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" });
        return primary("completed", "success");
      },
      now: c.now,
      sleep: c.sleep,
    });
    expect(code).toBe(0);
    vi.restoreAllMocks();
  });

  it("retries exhausted fails with an error naming the API failure", () => {
    const err = quiet();
    const c = clock();
    let calls = 0;
    const code = resolveAuthoritativeLane(
      { ...BASE, OBSERVATION_BUDGET_MINUTES: "35" },
      {
        ghApi: () => {
          calls += 1;
          throw Object.assign(new Error("gh: HTTP 503"), { stderr: "HTTP 503" });
        },
        now: c.now,
        sleep: c.sleep,
      },
    );
    expect(code).toBe(1);
    expect(calls).toBe(5);
    expect(lastError(err)).toContain("jobs API call failed after 5 attempt(s)");
    expect(lastError(err)).toContain("HTTP 503");
    vi.restoreAllMocks();
  });

  it("a non-transient API failure is not retried", () => {
    const err = quiet();
    let calls = 0;
    const code = resolveAuthoritativeLane(BASE, {
      ghApi: () => {
        calls += 1;
        throw Object.assign(new Error("gh: HTTP 404"), { stderr: "HTTP 404" });
      },
    });
    expect(code).toBe(1);
    expect(calls).toBe(1);
    expect(lastError(err)).toContain("not retryable");
    vi.restoreAllMocks();
  });

  it("retries stop at the deadline in force", () => {
    const err = quiet();
    const c = clock();
    let calls = 0;
    const code = resolveAuthoritativeLane(
      { ...BASE, OBSERVATION_BUDGET_MINUTES: "0.05" },
      {
        ghApi: () => {
          calls += 1;
          throw Object.assign(new Error("gh: HTTP 500"), { stderr: "HTTP 500" });
        },
        now: c.now,
        sleep: c.sleep,
      },
    );
    expect(code).toBe(1);
    expect(calls).toBeLessThan(5);
    expect(c.at()).toBeLessThan(3_000);
    expect(lastError(err)).toContain("jobs API call failed");
    vi.restoreAllMocks();
  });

  it("queue-reuse and failover short circuits make no API read and ignore the budget", () => {
    quiet();
    const api = vi.fn();
    const budget = { OBSERVATION_BUDGET_MINUTES: "35" };
    expect(
      resolveAuthoritativeLane(
        { ...BASE, ...budget, QUEUE_PASSED: "true", QUEUE_RUN_ID: "5", QUEUE_RUN_ATTEMPT: "1" },
        { ghApi: api },
      ),
    ).toBe(0);
    expect(
      resolveAuthoritativeLane(
        { ...BASE, ...budget, WANT_FAILOVER: "true", FAILOVER_RESULT: "success" },
        { ghApi: api },
      ),
    ).toBe(0);
    expect(
      resolveAuthoritativeLane(
        { ...BASE, ...budget, WANT_FAILOVER: "true", FAILOVER_RESULT: "failure" },
        { ghApi: api },
      ),
    ).toBe(1);
    expect(api).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("isTransientApiError recognises 5xx and timeouts only", () => {
    expect(isTransientApiError(Object.assign(new Error("x"), { stderr: "gh: HTTP 504" }))).toBe(true);
    expect(isTransientApiError(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe(true);
    expect(isTransientApiError(Object.assign(new Error("x"), { killed: true }))).toBe(true);
    expect(isTransientApiError(new Error("gh: HTTP 403"))).toBe(false);
    expect(isTransientApiError(new Error("boom"))).toBe(false);
  });
});
