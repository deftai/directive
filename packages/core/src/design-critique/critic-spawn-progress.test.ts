import { describe, expect, it } from "vitest";
import {
  CRITIC_SPAWN_PROGRESS_HALT,
  criticProgressIsSeparateFromLaunchProbe,
  evaluateCriticSpawnHygiene,
  evaluateCriticSpawnProgress,
  evaluateCriticTerminationBoundary,
  killCriticProcessTree,
} from "./critic-spawn-progress.js";
import { BENIGN_PONG_PROMPT, evaluateN3LaunchProbe } from "./panel-seat-families.js";

const hygieneOk = {
  outFdHeldUntilExit: true,
  detached: false,
  unref: false,
  stdin: "ignore" as const,
  parentWaitsOnChild: true,
  outFdKind: "integer" as const,
};

describe("evaluateCriticSpawnHygiene (#5478)", () => {
  it("accepts integer-fd ignore-stdin wait-on-child without detached+unref", () => {
    expect(evaluateCriticSpawnHygiene(hygieneOk)).toEqual({ ok: true });
    expect(
      evaluateCriticSpawnHygiene({ ...hygieneOk, stdin: "fd", detached: true, unref: false }),
    ).toEqual({ ok: true });
  });

  it("refuses detached+unref, null-fd WriteStream, open stdin, and fire-and-forget", () => {
    const bad = evaluateCriticSpawnHygiene({
      outFdHeldUntilExit: false,
      detached: true,
      unref: true,
      stdin: "pipe",
      parentWaitsOnChild: false,
      outFdKind: "write-stream-null-fd",
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe("hygiene-violation");
    expect(bad.reasons.join(" ")).toMatch(/detached\+unref/);
    expect(bad.reasons.join(" ")).toMatch(/integer fd/);
    expect(bad.reasons.join(" ")).toMatch(/stdin/);
    expect(bad.reasons.join(" ")).toMatch(/wait on child/);
    expect(bad.reasons.join(" ")).toMatch(/outFd must stay open/);
  });
});

describe("evaluateCriticSpawnProgress (#5478)", () => {
  const base = {
    tProgressMs: 60_000,
    tTimeoutMs: 300_000,
    startedAtMs: 1_000,
  };

  it("fails closed on no first log byte within T_progress and emits stderr", () => {
    const result = evaluateCriticSpawnProgress({
      ...base,
      nowMs: 1_000 + 60_000,
      samples: [{ atMs: 1_000 + 59_000, logByteLength: 0, stderrText: "oauth hung" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no-first-byte");
    expect(result.stderr).toBe("oauth hung");
    expect(result.haltToken).toBe(CRITIC_SPAWN_PROGRESS_HALT);
  });

  it("keeps hard T_timeout as an absolute backstop not renewed by log chatter", () => {
    const result = evaluateCriticSpawnProgress({
      ...base,
      nowMs: 1_000 + 300_000,
      samples: [
        { atMs: 1_000 + 10_000, logByteLength: 12 },
        { atMs: 1_000 + 290_000, logByteLength: 4_096, stderrText: "still writing" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("hard-timeout");
    expect(result.stderr).toBe("still writing");
    expect(result.haltToken).toBe(CRITIC_SPAWN_PROGRESS_HALT);
  });

  it("does not treat zero-stdout alone as the sole inactivity oracle when tool progress is observed", () => {
    const withTool = evaluateCriticSpawnProgress({
      ...base,
      nowMs: 1_000 + 60_000,
      samples: [
        {
          atMs: 1_000 + 30_000,
          logByteLength: 0,
          toolProgressObserved: true,
          stderrText: "",
        },
      ],
    });
    expect(withTool).toEqual({ ok: true, phase: "running" });

    const zeroOnly = evaluateCriticSpawnProgress({
      ...base,
      nowMs: 1_000 + 60_000,
      samples: [{ atMs: 1_000 + 30_000, logByteLength: 0 }],
    });
    expect(zeroOnly.ok).toBe(false);
    if (zeroOnly.ok) return;
    expect(zeroOnly.code).toBe("no-first-byte");
  });

  it("continues when first byte arrives before T_progress", () => {
    expect(
      evaluateCriticSpawnProgress({
        ...base,
        nowMs: 1_000 + 30_000,
        samples: [{ atMs: 1_000 + 5_000, logByteLength: 8 }],
      }),
    ).toEqual({ ok: true, phase: "running" });
  });

  it("fails closed when a nonempty log stalls with no further growth", () => {
    const result = evaluateCriticSpawnProgress({
      ...base,
      nowMs: 1_000 + 120_000,
      samples: [
        { atMs: 1_000 + 5_000, logByteLength: 8 },
        { atMs: 1_000 + 120_000, logByteLength: 8 },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no-log-growth");
    expect(result.haltToken).toBe(CRITIC_SPAWN_PROGRESS_HALT);
  });

  it("keeps running when log bytes grow inside T_progress of last activity", () => {
    expect(
      evaluateCriticSpawnProgress({
        ...base,
        nowMs: 1_000 + 120_000,
        samples: [
          { atMs: 1_000 + 5_000, logByteLength: 8 },
          { atMs: 1_000 + 90_000, logByteLength: 64 },
        ],
      }),
    ).toEqual({ ok: true, phase: "running" });
  });
});

describe("evaluateCriticTerminationBoundary (#5478)", () => {
  it("requires a named supervisor and termination before reseat", () => {
    const missing = evaluateCriticTerminationBoundary({
      supervisorName: "  ",
      childPid: 42,
      terminated: false,
      reseatRequested: false,
      commentAlreadyPosted: false,
      progressFailed: false,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe("missing-supervisor");

    const earlyReseat = evaluateCriticTerminationBoundary({
      supervisorName: "critic-spawn-supervisor",
      childPid: 42,
      terminated: false,
      reseatRequested: true,
      commentAlreadyPosted: false,
      progressFailed: true,
    });
    expect(earlyReseat.ok).toBe(false);
    if (earlyReseat.ok) return;
    expect(earlyReseat.code).toBe("reseat-before-terminate");
    expect(earlyReseat.haltToken).toBe(CRITIC_SPAWN_PROGRESS_HALT);
  });

  it("reconciles late post vs no-comment dispatch-fail", () => {
    expect(
      evaluateCriticTerminationBoundary({
        supervisorName: "critic-spawn-supervisor",
        childPid: 7,
        terminated: true,
        reseatRequested: false,
        commentAlreadyPosted: false,
        progressFailed: true,
      }),
    ).toEqual({ ok: true, disposition: "dispatch-fail-no-comment" });

    expect(
      evaluateCriticTerminationBoundary({
        supervisorName: "critic-spawn-supervisor",
        childPid: 7,
        terminated: true,
        reseatRequested: true,
        commentAlreadyPosted: true,
        progressFailed: true,
      }),
    ).toEqual({ ok: true, disposition: "late-post-reconciled" });
  });
});

describe("killCriticProcessTree (#5478)", () => {
  it("kills the owned process tree via seams and reports remaining", () => {
    const killed: number[] = [];
    const alive = new Set([10, 11, 12]);
    const result = killCriticProcessTree(10, {
      platform: "win32",
      listDescendants: (pid) => (pid === 10 ? [11, 12] : []),
      killTree: (pid) => {
        killed.push(pid);
        alive.delete(pid);
      },
      isPidAlive: (pid) => alive.has(pid),
    });
    expect(killed[0]).toBe(10);
    expect(result.remaining).toEqual([]);
    expect(result.discoveryOk).toBe(true);
    expect(alive.size).toBe(0);
  });

  it("discovers and kills descendants on the default Unix path", () => {
    const killed: number[] = [];
    const alive = new Set([20, 21, 22]);
    const listed: number[] = [];
    const result = killCriticProcessTree(20, {
      platform: "linux",
      listDescendants: (pid) => {
        listed.push(pid);
        return pid === 20 ? [21, 22] : [];
      },
      killTree: (pid) => {
        killed.push(pid);
        alive.delete(pid);
      },
      isPidAlive: (pid) => alive.has(pid),
    });
    expect(listed).toEqual([20]);
    expect(killed[0]).toBe(20);
    expect(killed).toEqual(expect.arrayContaining([20, 21, 22]));
    expect(result.remaining).toEqual([]);
    expect(result.discoveryOk).toBe(true);
    expect(alive.size).toBe(0);
  });

  it("fail-closes with nonempty remaining when descendant discovery fails", () => {
    const alive = new Set<number>();
    const result = killCriticProcessTree(30, {
      platform: "linux",
      listDescendants: () => ({ pids: [], ok: false }),
      killTree: (pid) => {
        alive.delete(pid);
      },
      isPidAlive: (pid) => alive.has(pid),
    });
    expect(result.discoveryOk).toBe(false);
    expect(result.remaining.length).toBeGreaterThan(0);
    expect(result.remaining).toContain(30);
  });
});

describe("probe≠progress keep (#5478 / #4432)", () => {
  it("keeps evaluateN3LaunchProbe as launchability only; progress lives elsewhere", () => {
    expect(criticProgressIsSeparateFromLaunchProbe()).toBe(true);
    const probe = evaluateN3LaunchProbe({
      spendN: 3,
      argvClass: "critic-bypass",
      prompt: BENIGN_PONG_PROMPT,
      envelopePath: null,
      threadAccess: false,
      launchableFamilies: ["grok", "claude", "codex"],
      onFail: "dispatch-fail",
    });
    expect(probe).toEqual({ ok: true });
    // Progress gate is not invoked by the probe fixture.
    expect(typeof evaluateCriticSpawnProgress).toBe("function");
  });
});
