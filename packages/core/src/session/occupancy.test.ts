import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { completeCohort } from "../swarm/complete-cohort.js";
import { swarmLaunch } from "../swarm/launch.js";
import {
  applyWorktreeOccupancy,
  evaluateOccupancyWriteGate,
  formatOccupancyRemediation,
  heartbeatAgeSeconds,
  isOccupancyExpired,
  OCCUPANCY_TTL_MS,
  occupancyPath,
  readOccupancy,
  releaseOccupancy,
  releaseSwarmOccupancy,
  resolveOccupancySessionId,
  stealOccupancy,
} from "./occupancy.js";
import { newRitualStatePayload, ritualStep, writeRitualState } from "./ritual-sentinel.js";
import { READ_ONLY_POSTURE, REARM_CEREMONY_TIER, runSessionStart } from "./session-start.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "occupancy-"));
  temps.push(root);
  return root;
}

describe("worktree occupancy lease (#3433)", () => {
  it("claims a free worktree", () => {
    const root = tempRoot();
    const now = new Date("2026-08-17T12:00:00Z");
    const result = applyWorktreeOccupancy(root, {
      sessionId: "sess-a",
      now,
      intent: "mutation",
    });
    expect(result.code).toBe(0);
    expect(result.action).toBe("claimed");
    expect(result.sessionId).toBe("sess-a");
    const record = readOccupancy(root);
    expect(record?.sessionId).toBe("sess-a");
    expect(record?.intent).toBe("mutation");
    expect(existsSync(occupancyPath(root))).toBe(true);
    expect(readFileSync(occupancyPath(root), "utf8")).toContain("sess-a");
  });

  it("denies a different live session and prints remediation", () => {
    const root = tempRoot();
    const claimedAt = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now: claimedAt, intent: "swarm" });
    const later = new Date("2026-08-17T12:05:00Z");
    const denied = applyWorktreeOccupancy(root, { sessionId: "other", now: later });
    expect(denied.code).toBe(1);
    expect(denied.action).toBe("denied");
    expect(denied.message).toContain("Worktree occupied by session owner");
    expect(denied.message).toContain("intent=swarm");
    expect(denied.message).toContain("heartbeat 300s ago");
    expect(denied.message).toContain("occupancy:request");
    expect(denied.message).toContain("occupancy:steal --confirm");
    expect(readOccupancy(root)?.sessionId).toBe("owner");
  });

  it("read-only callers never write occupancy", () => {
    const root = tempRoot();
    applyWorktreeOccupancy(root, { sessionId: "owner", now: new Date("2026-08-17T12:00:00Z") });
    const before = readFileSync(occupancyPath(root), "utf8");
    expect(existsSync(occupancyPath(root))).toBe(true);
    expect(before).toContain("owner");
    expect(readOccupancy(root)?.sessionId).toBe("owner");
  });

  it("same-session heartbeat keeps the occupant id", () => {
    const root = tempRoot();
    const first = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "same", now: first });
    const later = new Date("2026-08-17T12:10:00Z");
    const beat = applyWorktreeOccupancy(root, {
      env: { DEFT_SESSION_ID: "same" },
      now: later,
      newSessionId: () => "must-not-mint",
    });
    expect(beat.code).toBe(0);
    expect(beat.action).toBe("heartbeat");
    expect(beat.sessionId).toBe("same");
    const record = readOccupancy(root);
    expect(record?.sessionId).toBe("same");
    expect(record?.heartbeatAt.toISOString()).toBe(later.toISOString());
    expect(record?.claimedAt.toISOString()).toBe(first.toISOString());
  });

  it("resolveOccupancySessionId prefers DEFT_SESSION_ID over a mint", () => {
    expect(
      resolveOccupancySessionId({
        env: { DEFT_SESSION_ID: "env-id" },
        newSessionId: () => "minted",
      }),
    ).toBe("env-id");
  });

  it("steals after naming the occupant with --confirm", () => {
    const root = tempRoot();
    applyWorktreeOccupancy(root, {
      sessionId: "old",
      now: new Date("2026-08-17T12:00:00Z"),
      intent: "mutation",
    });
    const stolen = stealOccupancy(root, {
      sessionId: "new",
      occupant: "old",
      confirm: true,
      now: new Date("2026-08-17T12:01:00Z"),
    });
    expect(stolen.code).toBe(0);
    expect(stolen.action).toBe("stolen");
    expect(readOccupancy(root)?.sessionId).toBe("new");
  });

  it("refuses steal without confirm or a matching occupant name", () => {
    const root = tempRoot();
    const now = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "old", now });
    expect(stealOccupancy(root, { sessionId: "new", occupant: "old", now }).code).toBe(2);
    expect(
      stealOccupancy(root, { sessionId: "new", occupant: "wrong", confirm: true, now }).code,
    ).toBe(1);
    expect(readOccupancy(root)?.sessionId).toBe("old");
  });

  it("treats an expired heartbeat as free", () => {
    const root = tempRoot();
    const claimedAt = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "stale", now: claimedAt });
    const expiredAt = new Date(claimedAt.getTime() + OCCUPANCY_TTL_MS + 1);
    expect(
      isOccupancyExpired(
        readOccupancy(root) as NonNullable<ReturnType<typeof readOccupancy>>,
        expiredAt,
      ),
    ).toBe(true);
    const claimed = applyWorktreeOccupancy(root, { sessionId: "fresh", now: expiredAt });
    expect(claimed.code).toBe(0);
    expect(claimed.action).toBe("claimed");
    expect(readOccupancy(root)?.sessionId).toBe("fresh");
  });

  it("write-gate denies a different live session and allows the occupant", () => {
    const root = tempRoot();
    const now = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now });
    expect(evaluateOccupancyWriteGate(root, { sessionId: "other", now }).allow).toBe(false);
    expect(evaluateOccupancyWriteGate(root, { env: { DEFT_SESSION_ID: "owner" }, now }).allow).toBe(
      true,
    );
    expect(evaluateOccupancyWriteGate(root, { now }).allow).toBe(false);
  });

  it("release of an expired lease does not delete a replacement claim", () => {
    const root = tempRoot();
    const claimedAt = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "stale", now: claimedAt });
    const expiredAt = new Date(claimedAt.getTime() + OCCUPANCY_TTL_MS + 1);
    applyWorktreeOccupancy(root, { sessionId: "fresh", now: expiredAt });
    const released = releaseOccupancy(root, { sessionId: "stale", now: expiredAt });
    expect(released.code).toBe(1);
    expect(released.action).toBe("denied");
    expect(readOccupancy(root)?.sessionId).toBe("fresh");
  });

  it("lock-wait timeout does not unlink a live owner lock", () => {
    const root = tempRoot();
    const now = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now });
    const lockPath = `${occupancyPath(root)}.lock`;
    writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, "utf8");
    let clock = 0;
    expect(() =>
      applyWorktreeOccupancy(root, {
        sessionId: "owner",
        now,
        lockDeps: {
          now: () => {
            clock += 31_000;
            return clock;
          },
          sleepMs: () => {
            /* no-op */
          },
        },
      }),
    ).toThrow(/timed out acquiring lock/);
    expect(existsSync(lockPath)).toBe(true);
    expect(readOccupancy(root)?.sessionId).toBe("owner");
  });

  it("releases a swarm close-out and refuses a foreign live mutation lease", () => {
    const root = tempRoot();
    const now = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, {
      sessionId: "swarm-parent",
      now,
      intent: "swarm",
    });
    const released = releaseOccupancy(root, { sessionId: "swarm-parent", now });
    expect(released.code).toBe(0);
    expect(released.action).toBe("released");
    expect(readOccupancy(root)).toBeNull();

    applyWorktreeOccupancy(root, {
      sessionId: "mut",
      now,
      intent: "mutation",
    });
    const refused = releaseOccupancy(root, { swarmCloseout: true, sessionId: "other", now });
    expect(refused.code).toBe(1);
    expect(readOccupancy(root)?.sessionId).toBe("mut");
  });

  it("formats heartbeat age in whole seconds", () => {
    const root = tempRoot();
    const now = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "a", now });
    const record = readOccupancy(root);
    expect(record).not.toBeNull();
    expect(
      heartbeatAgeSeconds(record as NonNullable<typeof record>, new Date("2026-08-17T12:00:09Z")),
    ).toBe(9);
    expect(
      formatOccupancyRemediation(
        record as NonNullable<typeof record>,
        new Date("2026-08-17T12:00:09Z"),
      ),
    ).toContain("heartbeat 9s ago");
  });

  it("mutation session:start claims and a second session is denied", () => {
    const root = tempRoot();
    const now = new Date("2026-08-17T12:00:00Z");
    const first = runSessionStart(root, {
      writeHistory: false,
      now,
      newSessionId: () => "first-sess",
      runGit: () => ({ code: 0, stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", stderr: "" }),
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: () => ({ exitCode: 0 }),
    });
    expect(first.code).toBe(0);
    expect(readOccupancy(root)?.sessionId).toBe("first-sess");
    const second = runSessionStart(root, {
      writeHistory: false,
      now: new Date("2026-08-17T12:01:00Z"),
      newSessionId: () => "second-sess",
      runGit: () => ({ code: 0, stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", stderr: "" }),
      verifyTools: () => ({ exitCode: 0 }),
    });
    expect(second.code).toBe(1);
    expect(second.lines.join("\n")).toContain("Worktree occupied by session first-sess");
    expect(readOccupancy(root)?.sessionId).toBe("first-sess");
  });

  it("read-only session:start does not claim occupancy", () => {
    const root = tempRoot();
    applyWorktreeOccupancy(root, {
      sessionId: "owner",
      now: new Date("2026-08-17T12:00:00Z"),
    });
    const result = runSessionStart(root, {
      posture: READ_ONLY_POSTURE,
      writeHistory: false,
      newSessionId: () => "reader",
    });
    expect(result.code).toBe(0);
    expect(readOccupancy(root)?.sessionId).toBe("owner");
  });

  it("re-arm with DEFT_SESSION_ID keeps the occupant id and does not mint", () => {
    const root = tempRoot();
    const head = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const started = new Date("2026-08-17T10:00:00Z");
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "seed-session",
        gitHead: head,
        worktreePath: root,
        startedAt: started,
        quickSteps: {
          alignment: ritualStep({ ok: true, ts: started }),
          branch_policy: ritualStep({ ok: true, ts: started }),
          verify_tools: ritualStep({ ok: true, ts: started, exitCode: 0 }),
          triage_welcome: ritualStep({ ok: true, ts: started }),
        },
        gatedSteps: {
          agent_hooks: ritualStep({ ok: true, ts: started }),
          doctor: ritualStep({ ok: true, ts: started }),
          cache_fresh: ritualStep({ ok: true, ts: started }),
        },
      }),
    );
    applyWorktreeOccupancy(root, { sessionId: "seed-session", now: started });
    const rearm = runSessionStart(root, {
      ceremonyTier: REARM_CEREMONY_TIER,
      writeHistory: false,
      now: new Date("2026-08-17T11:00:00Z"),
      env: { DEFT_SESSION_ID: "seed-session" },
      newSessionId: () => "must-not-mint",
      runGit: (_r, args) => {
        if (args.includes("HEAD")) return { code: 0, stdout: head, stderr: "" };
        if (args.includes("--show-toplevel")) return { code: 0, stdout: root, stderr: "" };
        if (args.includes("--is-ancestor")) return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(rearm.code).toBe(0);
    expect(readOccupancy(root)?.sessionId).toBe("seed-session");
    expect(rearm.payload.occupancy).toEqual(
      expect.objectContaining({ session_id: "seed-session" }),
    );
  });

  it("swarm:launch claims intent swarm and complete-cohort releases", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: {} }),
      "utf8",
    );
    writeFileSync(
      join(root, "xbrief", "active", "story-a.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          id: "story-a",
          title: "story-a",
          status: "running",
          metadata: { kind: "story", swarm: { readiness: "ready" } },
        },
      }),
      "utf8",
    );
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "routing.local.json"),
      JSON.stringify({
        grok: { "leaf-implementation": { model: "grok-4", mode: "pinned" } },
      }),
      "utf8",
    );
    const launched = swarmLaunch({
      stories: ["story-a"],
      projectRoot: root,
      autonomous: true,
      environ: {
        DEFT_SESSION_ID: "swarm-parent",
        DEFT_ROUTING_PATH: join(root, ".deft", "routing.local.json"),
      },
      preflightGate: () => ({ exitCode: 0, message: "" }),
      readinessGate: () => ({ exitCode: 0, report: "" }),
      runtimeAuthProbe: () => ["local-unsandboxed", "host-gh"],
    });
    expect(launched.exitCode).toBe(0);
    expect(readOccupancy(root)?.intent).toBe("swarm");
    expect(readOccupancy(root)?.sessionId).toBe("swarm-parent");
    const preview = completeCohort({
      stories: [join(root, "xbrief", "active", "story-a.xbrief.json")],
      projectRoot: root,
      dryRun: true,
    });
    expect(readOccupancy(root)?.intent).toBe("swarm");
    void preview;
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    const donePath = join(root, "xbrief", "completed", "story-a.xbrief.json");
    writeFileSync(
      donePath,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { id: "story-a", title: "story-a", status: "completed" },
      }),
      "utf8",
    );
    vi.stubEnv("DEFT_SESSION_ID", "swarm-parent");
    const live = completeCohort({
      stories: [donePath],
      projectRoot: root,
      dryRun: false,
    });
    vi.unstubAllEnvs();
    expect(live.exitCode).toBe(0);
    expect(readOccupancy(root)).toBeNull();
  });

  it("close-out releases a minted swarm lease without DEFT_SESSION_ID", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: {} }),
      "utf8",
    );
    writeFileSync(
      join(root, "xbrief", "active", "story-a.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          id: "story-a",
          title: "story-a",
          status: "running",
          metadata: { kind: "story", swarm: { readiness: "ready" } },
        },
      }),
      "utf8",
    );
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "routing.local.json"),
      JSON.stringify({
        grok: { "leaf-implementation": { model: "grok-4", mode: "pinned" } },
      }),
      "utf8",
    );
    const launched = swarmLaunch({
      stories: ["story-a"],
      projectRoot: root,
      autonomous: true,
      environ: {
        DEFT_ROUTING_PATH: join(root, ".deft", "routing.local.json"),
      },
      preflightGate: () => ({ exitCode: 0, message: "" }),
      readinessGate: () => ({ exitCode: 0, report: "" }),
      runtimeAuthProbe: () => ["local-unsandboxed", "host-gh"],
    });
    expect(launched.exitCode).toBe(0);
    const minted = readOccupancy(root)?.sessionId;
    expect(minted).toBeTruthy();
    expect(minted).not.toBe("");
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    const donePath = join(root, "xbrief", "completed", "story-a.xbrief.json");
    writeFileSync(
      donePath,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { id: "story-a", title: "story-a", status: "completed" },
      }),
      "utf8",
    );
    vi.stubEnv("DEFT_SESSION_ID", "");
    const live = completeCohort({
      stories: [donePath],
      projectRoot: root,
      dryRun: false,
    });
    vi.unstubAllEnvs();
    expect(live.exitCode).toBe(0);
    expect(readOccupancy(root)).toBeNull();
    expect(
      releaseSwarmOccupancy(root, { env: {}, now: new Date("2026-08-17T12:00:00Z") }).action,
    ).toBe("released");
  });
});
