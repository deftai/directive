import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decideHook } from "../hooks/dispatcher.js";
import { completeCohort } from "../swarm/complete-cohort.js";
import {
  persistLaunchOccupancyRecord,
  resolveLaunchOccupancySessionId,
  swarmLaunch,
} from "../swarm/launch.js";
import {
  applyWorktreeOccupancy,
  evaluateOccupancyWriteGate,
  formatOccupancyRemediation,
  heartbeatAgeSeconds,
  heartbeatOccupancy,
  isOccupancyExpired,
  liveOccupant,
  OCCUPANCY_MAX_LEASE_MS,
  OCCUPANCY_REFRESH_AFTER_MS,
  OCCUPANCY_STALE_WARN_MS,
  OCCUPANCY_TTL_MS,
  occupancyLiveness,
  occupancyPath,
  readOccupancy,
  releaseOccupancy,
  releaseSwarmOccupancy,
  resolveOccupancySessionId,
  stealOccupancy,
} from "./occupancy.js";
import {
  newRitualStatePayload,
  readRitualState,
  ritualStatePath,
  ritualStep,
  writeRitualState,
} from "./ritual-sentinel.js";
import { READ_ONLY_POSTURE, REARM_CEREMONY_TIER, runSessionStart } from "./session-start.js";
import { verifySessionRitual, writeGateRitualOptions } from "./verify-session-ritual.js";

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

/**
 * Beat an owner's lease every half TTL until its claim age crosses the absolute
 * cap, and return the moment of the crossing (#3599). The last beat before the
 * crossing succeeds, so heartbeat freshness can never be the reason a lease
 * built this way reads as dead — only the cap can.
 */
function beatUntilPastCap(root: string, sessionId: string, claimedAt: Date): Date {
  let at = claimedAt;
  const maxBeats = Math.ceil((OCCUPANCY_MAX_LEASE_MS / OCCUPANCY_TTL_MS) * 2) + 4;
  for (let beat = 0; beat <= maxBeats; beat += 1) {
    if (at.getTime() - claimedAt.getTime() > OCCUPANCY_MAX_LEASE_MS) return at;
    at = new Date(at.getTime() + OCCUPANCY_TTL_MS / 2);
    evaluateOccupancyWriteGate(root, { sessionId, now: at, refresh: true });
  }
  throw new Error("lease never crossed the absolute age cap");
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
    expect(denied.message).toContain("session:start --steal --confirm");
    expect(denied.message).not.toContain("or steal (`occupancy:steal --confirm`)");
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
    expect(stolen.message).toContain("claimed_at=2026-08-17T12:00:00Z");
    expect(stolen.message).toContain("heartbeat_at=2026-08-17T12:00:00Z");
    expect(stolen.message).toContain("lease only");
    expect(stolen.message).toContain("unless ritual state already names the same owner");
    expect(stolen.message).toContain("session:start --rearm --session-id=<same-session-id>");
    expect(stolen.message).toContain("session:start --session-id=<same-session-id>");
    expect(stolen.message).toContain("when re-arm is eligible");
    expect(stolen.message).not.toContain("--session-id=new");
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

  it("write-gate refresh keeps a working owner's lease alive past the TTL (#3599)", () => {
    const root = tempRoot();
    const claimedAt = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now: claimedAt });

    // Writes spaced under the TTL used to expire the lease anyway, because the
    // owner-allow path never re-stamped. Walk past the TTL one write at a time.
    let at = claimedAt;
    for (let step = 0; step < 4; step += 1) {
      at = new Date(at.getTime() + OCCUPANCY_TTL_MS / 2);
      const gate = evaluateOccupancyWriteGate(root, {
        sessionId: "owner",
        now: at,
        refresh: true,
      });
      expect(gate.allow).toBe(true);
      expect(gate.refreshed).toBe(true);
    }
    expect(at.getTime() - claimedAt.getTime()).toBeGreaterThan(OCCUPANCY_TTL_MS);

    const record = readOccupancy(root);
    expect(record?.heartbeatAt.toISOString()).toBe(at.toISOString());
    expect(record?.claimedAt.toISOString()).toBe(claimedAt.toISOString());
    expect(record?.lastWriteAt?.toISOString()).toBe(at.toISOString());
    expect(isOccupancyExpired(record as NonNullable<typeof record>, at)).toBe(false);
  });

  it("write-gate refresh is off by default and floored to avoid amplification (#3599)", () => {
    const root = tempRoot();
    const claimedAt = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now: claimedAt });
    const wellPastFloor = new Date(claimedAt.getTime() + OCCUPANCY_REFRESH_AFTER_MS + 1);

    const readOnly = evaluateOccupancyWriteGate(root, { sessionId: "owner", now: wellPastFloor });
    expect(readOnly.allow).toBe(true);
    expect(readOnly.refreshed).toBe(false);
    expect(readOccupancy(root)?.heartbeatAt.toISOString()).toBe(claimedAt.toISOString());

    const underFloor = new Date(claimedAt.getTime() + OCCUPANCY_REFRESH_AFTER_MS - 1);
    const skipped = evaluateOccupancyWriteGate(root, {
      sessionId: "owner",
      now: underFloor,
      refresh: true,
    });
    expect(skipped.allow).toBe(true);
    expect(skipped.refreshed).toBe(false);
    expect(readOccupancy(root)?.heartbeatAt.toISOString()).toBe(claimedAt.toISOString());
  });

  it("write-gate warns the holder inside its own staleness window (#3599)", () => {
    const root = tempRoot();
    const claimedAt = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now: claimedAt });

    const fresh = new Date(claimedAt.getTime() + OCCUPANCY_STALE_WARN_MS - 1);
    expect(evaluateOccupancyWriteGate(root, { sessionId: "owner", now: fresh }).warning).toBeNull();

    const stale = new Date(claimedAt.getTime() + OCCUPANCY_STALE_WARN_MS);
    const warned = evaluateOccupancyWriteGate(root, { sessionId: "owner", now: stale });
    expect(warned.allow).toBe(true);
    expect(warned.warning).toContain("has not beaten for 900s");
    expect(warned.warning).toContain("occupancy:heartbeat --session-id=owner");
  });

  it("write-gate refresh never resurrects a lease taken by another session (#3599)", () => {
    const root = tempRoot();
    const claimedAt = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now: claimedAt });
    const later = new Date(claimedAt.getTime() + OCCUPANCY_REFRESH_AFTER_MS + 1);
    stealOccupancy(root, {
      sessionId: "thief",
      occupant: "owner",
      confirm: true,
      now: later,
    });

    const gate = evaluateOccupancyWriteGate(root, {
      sessionId: "owner",
      now: later,
      refresh: true,
    });
    expect(gate.allow).toBe(false);
    expect(gate.refreshed).toBe(false);
    expect(readOccupancy(root)?.sessionId).toBe("thief");
  });

  it("the absolute age cap expires a lease that never stops refreshing (#3599)", () => {
    const root = tempRoot();
    const claimedAt = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now: claimedAt });

    const past = beatUntilPastCap(root, "owner", claimedAt);
    expect(past.getTime() - claimedAt.getTime()).toBeGreaterThan(OCCUPANCY_MAX_LEASE_MS);

    const record = readOccupancy(root) as NonNullable<ReturnType<typeof readOccupancy>>;
    expect(record.claimedAt.toISOString()).toBe(claimedAt.toISOString());
    // The lease is dead on claim age, not on neglect: it was beaten well inside
    // the heartbeat window right up to the crossing.
    expect(heartbeatAgeSeconds(record, past)).toBeLessThan(OCCUPANCY_TTL_MS / 1000);
    expect(occupancyLiveness(record, past)).toBe("age-capped");
    expect(isOccupancyExpired(record, past)).toBe(true);
    expect(liveOccupant(root, past)).toBeNull();

    // The holder's next write is refused, in the cap's own words rather than
    // the stale-heartbeat ones. Allowing it would hand a write to the very
    // bearer the cap exists to bound, on a tree a peer may already be claiming.
    const gate = evaluateOccupancyWriteGate(root, {
      sessionId: "owner",
      now: past,
      refresh: true,
    });
    expect(gate.allow).toBe(false);
    expect(gate.occupant).toBeNull();
    expect(gate.refreshed).toBe(false);
    expect(gate.message).toContain("absolute age cap");
    expect(gate.message).toContain("session:start --session-id=owner");
    expect(gate.message).not.toContain("has not beaten");

    // The refusal is aimed at the stale holder, not at the tree: a peer taking
    // over the abandoned worktree is the reclaim the cap exists to enable.
    const reclaimer = evaluateOccupancyWriteGate(root, { sessionId: "peer", now: past });
    expect(reclaimer.allow).toBe(true);
    expect(reclaimer.message).toBeNull();
  });

  it("a lease past the cap reads as capped even once its heartbeat also lapses (#3599)", () => {
    const root = tempRoot();
    const claimedAt = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now: claimedAt });
    // Both dead at once: past the cap, and silent for longer than the TTL.
    const past = new Date(claimedAt.getTime() + OCCUPANCY_MAX_LEASE_MS + OCCUPANCY_TTL_MS + 1000);

    const record = readOccupancy(root) as NonNullable<ReturnType<typeof readOccupancy>>;
    expect(heartbeatAgeSeconds(record, past)).toBeGreaterThan(OCCUPANCY_TTL_MS / 1000);
    expect(occupancyLiveness(record, past)).toBe("age-capped");

    // Reading this as merely stale would route the holder to the refresh
    // remediation, which a capped lease cannot accept, and would skip the
    // refusal — giving the deader lease the more permissive verdict.
    const gate = evaluateOccupancyWriteGate(root, {
      sessionId: "owner",
      now: past,
      refresh: true,
    });
    expect(gate.allow).toBe(false);
    expect(gate.message).toContain("absolute age cap");
    expect(gate.message).not.toContain("has not beaten");

    // Reclaim by anyone else is unaffected; both dead states free the tree.
    expect(evaluateOccupancyWriteGate(root, { sessionId: "peer", now: past }).allow).toBe(true);

    // The heartbeat verb tells the holder the same thing the gate did.
    const beat = heartbeatOccupancy(root, { sessionId: "owner", now: past, env: {} });
    expect(beat.code).toBe(1);
    expect(beat.message).toContain("absolute age cap");
  });

  it("a refresh that discovers the lease moved denies the former owner (#3599)", () => {
    const root = tempRoot();
    const claimedAt = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now: claimedAt });
    const wroteAt = new Date(claimedAt.getTime() + OCCUPANCY_REFRESH_AFTER_MS + 1000);

    // Hold the lock so the re-stamp has to wait, then hand the lease to another
    // session during that wait: the gate's unlocked read saw "owner", but the
    // locked read will see "thief". Allowing on the record we started from is
    // what would let a former owner write into someone else's worktree.
    const lockPath = `${occupancyPath(root)}.lock`;
    writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, "utf8");
    let handedOver = false;
    const gate = evaluateOccupancyWriteGate(root, {
      sessionId: "owner",
      now: wroteAt,
      refresh: true,
      lockDeps: {
        sleepMs: () => {
          if (handedOver) return;
          handedOver = true;
          rmSync(lockPath, { force: true });
          // Rewrite the record as the peer process would, rather than through
          // the lease API: the occupancy lock is not reentrant, and the point
          // of the test is an out-of-process handover mid-attempt.
          const occupancyFile = occupancyPath(root);
          writeFileSync(
            occupancyFile,
            readFileSync(occupancyFile, "utf8").replace(/"owner"/g, '"thief"'),
            "utf8",
          );
        },
      },
    });

    expect(handedOver).toBe(true);
    expect(readOccupancy(root)?.sessionId).toBe("thief");
    expect(gate.allow).toBe(false);
    expect(gate.refreshed).toBe(false);
    expect(gate.message).toContain("Worktree occupied by session thief");
  });

  it("a refresh blocked only by the lock keeps the owner writing (#3599)", () => {
    const root = tempRoot();
    const claimedAt = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now: claimedAt });
    const wroteAt = new Date(claimedAt.getTime() + OCCUPANCY_REFRESH_AFTER_MS + 1000);

    // Lock held for the whole attempt: contention says nothing about who owns
    // the lease, so it must not become a denial for the rightful owner.
    const lockPath = `${occupancyPath(root)}.lock`;
    writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, "utf8");
    let clock = 0;
    const gate = evaluateOccupancyWriteGate(root, {
      sessionId: "owner",
      now: wroteAt,
      refresh: true,
      lockDeps: {
        now: () => {
          clock += 31_000;
          return clock;
        },
        sleepMs: () => {
          /* no-op */
        },
      },
    });

    expect(gate.allow).toBe(true);
    expect(gate.refreshed).toBe(false);
    expect(gate.message).toBeNull();
    expect(gate.occupant?.sessionId).toBe("owner");
    expect(readOccupancy(root)?.heartbeatAt.toISOString()).toBe(claimedAt.toISOString());
  });

  it("a refresh that times out while a peer takes over denies the former owner (#3599)", () => {
    const root = tempRoot();
    const claimedAt = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now: claimedAt });
    const wroteAt = new Date(claimedAt.getTime() + OCCUPANCY_REFRESH_AFTER_MS + 1000);

    // The takeover completes while the lock stays held, so the re-stamp gives
    // up on the timeout and never observes an owner. A blocked lock is not
    // evidence that the lease is still ours — the peer holding it is one of the
    // reasons it blocks — so the gate must ask the file rather than fall back
    // on the snapshot it read before waiting.
    const lockPath = `${occupancyPath(root)}.lock`;
    writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, "utf8");
    let handedOver = false;
    let clock = 0;
    const gate = evaluateOccupancyWriteGate(root, {
      sessionId: "owner",
      now: wroteAt,
      refresh: true,
      lockDeps: {
        // The first clock read happens inside the lock wait, after the gate's
        // unlocked read of "owner" and before any locked read: exactly the
        // window a peer takeover lands in. Rewrite the record as the peer
        // process would, then let the clock run past the lock deadline.
        now: () => {
          if (!handedOver) {
            handedOver = true;
            const occupancyFile = occupancyPath(root);
            writeFileSync(
              occupancyFile,
              readFileSync(occupancyFile, "utf8").replace(/"owner"/g, '"thief"'),
              "utf8",
            );
          }
          clock += 31_000;
          return clock;
        },
        sleepMs: () => {
          /* no-op */
        },
      },
    });

    expect(handedOver).toBe(true);
    expect(readOccupancy(root)?.sessionId).toBe("thief");
    expect(gate.allow).toBe(false);
    expect(gate.refreshed).toBe(false);
    expect(gate.message).toContain("Worktree occupied by session thief");
  });

  it("a successful refresh drops the staleness warning it was about to print (#3599)", () => {
    const root = tempRoot();
    const claimedAt = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now: claimedAt });
    const staleButLive = new Date(claimedAt.getTime() + OCCUPANCY_STALE_WARN_MS);

    // Read-only evaluation of the same instant does warn: the lease really is
    // inside the staleness window until something re-stamps it.
    const probe = evaluateOccupancyWriteGate(root, { sessionId: "owner", now: staleButLive });
    expect(probe.refreshed).toBe(false);
    expect(probe.warning).toContain("has not beaten");

    // The refreshing call renews that same lease, so repeating the warning
    // would tell the owner to refresh what this write just refreshed.
    const gate = evaluateOccupancyWriteGate(root, {
      sessionId: "owner",
      now: staleButLive,
      refresh: true,
    });
    expect(gate.allow).toBe(true);
    expect(gate.refreshed).toBe(true);
    expect(gate.warning).toBeNull();
    expect(readOccupancy(root)?.heartbeatAt.toISOString()).toBe(staleButLive.toISOString());
  });

  it("a lease refreshed continuously under the cap stays live (#3599)", () => {
    const root = tempRoot();
    const claimedAt = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now: claimedAt });

    let at = claimedAt;
    while (at.getTime() + OCCUPANCY_TTL_MS / 2 - claimedAt.getTime() <= OCCUPANCY_MAX_LEASE_MS) {
      at = new Date(at.getTime() + OCCUPANCY_TTL_MS / 2);
      const gate = evaluateOccupancyWriteGate(root, {
        sessionId: "owner",
        now: at,
        refresh: true,
      });
      expect(gate.allow).toBe(true);
      expect(gate.refreshed).toBe(true);
      expect(gate.warning).toBeNull();
    }
    expect(at.getTime() - claimedAt.getTime()).toBeGreaterThan(OCCUPANCY_TTL_MS);

    const record = readOccupancy(root) as NonNullable<ReturnType<typeof readOccupancy>>;
    expect(occupancyLiveness(record, at)).toBe("live");
    expect(liveOccupant(root, at)?.sessionId).toBe("owner");
  });

  it("claimed_at survives every refresh path, or the cap is unenforceable (#3599)", () => {
    const root = tempRoot();
    const claimedAt = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now: claimedAt });
    const beatAt = new Date(claimedAt.getTime() + OCCUPANCY_REFRESH_AFTER_MS + 1000);

    applyWorktreeOccupancy(root, { sessionId: "owner", now: beatAt });
    expect(readOccupancy(root)?.claimedAt.toISOString()).toBe(claimedAt.toISOString());

    heartbeatOccupancy(root, { sessionId: "owner", now: beatAt, env: {} });
    expect(readOccupancy(root)?.claimedAt.toISOString()).toBe(claimedAt.toISOString());

    evaluateOccupancyWriteGate(root, { sessionId: "owner", now: beatAt, refresh: true });
    expect(readOccupancy(root)?.claimedAt.toISOString()).toBe(claimedAt.toISOString());

    // Guard the inverse too: the refresh really did land, so the assertions
    // above cannot pass by simply never writing the record.
    expect(readOccupancy(root)?.heartbeatAt.toISOString()).toBe(beatAt.toISOString());
  });

  it("the refresh verb tells a capped holder to re-claim, not to beat harder (#3599)", () => {
    const root = tempRoot();
    const claimedAt = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now: claimedAt });
    const past = beatUntilPastCap(root, "owner", claimedAt);

    const capped = heartbeatOccupancy(root, { sessionId: "owner", now: past, env: {} });
    expect(capped.code).toBe(1);
    expect(capped.message).toContain("absolute age cap");
    expect(capped.message).not.toContain("found no live lease");

    // An ordinary idle lease still reads as an ordinary idle lease.
    const idle = tempRoot();
    applyWorktreeOccupancy(idle, { sessionId: "owner", now: claimedAt });
    const stale = new Date(claimedAt.getTime() + OCCUPANCY_TTL_MS + 1000);
    const idleBeat = heartbeatOccupancy(idle, { sessionId: "owner", now: stale, env: {} });
    expect(idleBeat.code).toBe(1);
    expect(idleBeat.message).toContain("found no live lease");
  });

  it("heartbeatOccupancy refreshes the owner and refuses everything else (#3599)", () => {
    const root = tempRoot();
    const claimedAt = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now: claimedAt });
    const later = new Date(claimedAt.getTime() + 10 * 60 * 1000);

    const beat = heartbeatOccupancy(root, { sessionId: "owner", now: later, env: {} });
    expect(beat.code).toBe(0);
    expect(beat.action).toBe("heartbeat");
    expect(readOccupancy(root)?.heartbeatAt.toISOString()).toBe(later.toISOString());
    // A manual refresh is not a product write.
    expect(readOccupancy(root)?.lastWriteAt).toBeNull();

    const foreign = heartbeatOccupancy(root, { sessionId: "other", now: later, env: {} });
    expect(foreign.code).toBe(1);
    expect(foreign.message).toContain("Worktree occupied by session owner");

    const anonymous = heartbeatOccupancy(root, { now: later, env: {} });
    expect(anonymous.code).toBe(2);
    expect(anonymous.message).toContain("never mints an owner");
    expect(readOccupancy(root)?.sessionId).toBe("owner");
  });

  it("heartbeatOccupancy refuses to claim a free or expired worktree (#3599)", () => {
    const root = tempRoot();
    const now = new Date("2026-08-17T12:00:00Z");
    expect(heartbeatOccupancy(root, { sessionId: "owner", now, env: {} }).code).toBe(1);
    expect(readOccupancy(root)).toBeNull();

    applyWorktreeOccupancy(root, { sessionId: "owner", now });
    const expiredAt = new Date(now.getTime() + OCCUPANCY_TTL_MS + 1);
    expect(heartbeatOccupancy(root, { sessionId: "owner", now: expiredAt, env: {} }).code).toBe(1);
    expect(readOccupancy(root)?.heartbeatAt.toISOString()).toBe(now.toISOString());
  });

  it("the refresh verb separates a lost lease from an unavailable lock (#3599)", () => {
    const root = tempRoot();
    const now = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now });
    const lockPath = `${occupancyPath(root)}.lock`;
    writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, "utf8");
    let clock = 0;

    const blocked = heartbeatOccupancy(root, {
      sessionId: "owner",
      now,
      env: {},
      lockDeps: {
        now: () => {
          clock += 31_000;
          return clock;
        },
        sleepMs: () => {
          /* no-op */
        },
      },
    });

    expect(blocked.code).toBe(1);
    expect(blocked.message).toContain("still yours");
    expect(blocked.message).not.toContain("changed owner");
    expect(readOccupancy(root)?.sessionId).toBe("owner");
  });

  it("steal surfaces the occupant's last write, not only heartbeat age (#3599)", () => {
    const root = tempRoot();
    const claimedAt = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "busy", now: claimedAt });
    const wroteAt = new Date(claimedAt.getTime() + OCCUPANCY_REFRESH_AFTER_MS + 1_000);
    evaluateOccupancyWriteGate(root, { sessionId: "busy", now: wroteAt, refresh: true });

    const askedAt = new Date(wroteAt.getTime() + 30_000);
    const unconfirmed = stealOccupancy(root, {
      sessionId: "thief",
      occupant: "busy",
      now: askedAt,
    });
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.message).toContain("last write 30s ago");

    const stolen = stealOccupancy(root, {
      sessionId: "thief",
      occupant: "busy",
      confirm: true,
      now: askedAt,
    });
    expect(stolen.code).toBe(0);
    expect(stolen.message).toContain("last write 30s ago");
    expect(stolen.message).toContain("last_write_at=2026-08-17T12:05:01Z");
    // The new owner inherits no write history.
    expect(readOccupancy(root)?.lastWriteAt).toBeNull();
  });

  it("reads a pre-#3599 record that carries no last_write_at", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(
      occupancyPath(root),
      JSON.stringify({
        schemaVersion: 1,
        session_id: "legacy",
        worktree_path: root,
        intent: "mutation",
        claimed_at: "2026-08-17T12:00:00Z",
        heartbeat_at: "2026-08-17T12:00:00Z",
      }),
      "utf8",
    );
    const record = readOccupancy(root);
    expect(record?.sessionId).toBe("legacy");
    expect(record?.lastWriteAt).toBeNull();
    expect(
      formatOccupancyRemediation(
        record as NonNullable<typeof record>,
        new Date("2026-08-17T12:00:09Z"),
      ),
    ).toContain("no recorded write");
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

  it("owner releases a live lease and a non-owner is denied (#3604)", () => {
    const root = tempRoot();
    const now = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now });
    const denied = releaseOccupancy(root, { sessionId: "other", now });
    expect(denied.code).toBe(1);
    expect(denied.action).toBe("denied");
    expect(readOccupancy(root)?.sessionId).toBe("owner");
    const released = releaseOccupancy(root, { sessionId: "owner", now });
    expect(released.code).toBe(0);
    expect(released.action).toBe("released");
    expect(readOccupancy(root)).toBeNull();
  });

  it("clears expired residue without ownership (#3604)", () => {
    const root = tempRoot();
    const claimedAt = new Date("2026-08-17T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "stale", now: claimedAt });
    const expiredAt = new Date(claimedAt.getTime() + OCCUPANCY_TTL_MS + 1);
    const released = releaseOccupancy(root, { sessionId: "hygiene", now: expiredAt });
    expect(released.code).toBe(0);
    expect(released.action).toBe("released");
    expect(readOccupancy(root)).toBeNull();
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
    expect(
      formatOccupancyRemediation(
        record as NonNullable<typeof record>,
        new Date("2026-08-17T12:00:09Z"),
      ),
    ).toContain("claimed_at=2026-08-17T12:00:00Z");
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
      releaseSwarmOccupancy(root, {
        env: {},
        now: new Date("2026-08-17T12:00:00Z"),
      }).action,
    ).toBe("denied");
  });

  it("close-out reads its own cohort slot after another launch overwrites the manifest", () => {
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
    writeFileSync(
      join(root, ".deft", "swarm-launch-manifest.json"),
      JSON.stringify([{ occupancy_session_id: "other-launch" }], null, 2),
      "utf8",
    );
    persistLaunchOccupancyRecord(root, {
      allocation_plan_id: "other-plan",
      occupancy_session_id: "other-launch",
      story_ids: ["story-b"],
      cohort_key: "plan:other-plan",
    });
    expect(resolveLaunchOccupancySessionId(root, { storyIds: ["story-a"] }).sessionId).toBe(minted);
    expect(resolveLaunchOccupancySessionId(root).sessionId).toBe("");
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
  });

  it("close-out refuses a missing or foreign cohort occupancy record", () => {
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
    expect(readOccupancy(root)?.sessionId).toBeTruthy();
    rmSync(join(root, ".deft", "swarm-launch-occupancy"), { recursive: true, force: true });
    writeFileSync(
      join(root, ".deft", "swarm-launch-manifest.json"),
      JSON.stringify([{ occupancy_session_id: "other-launch" }], null, 2),
      "utf8",
    );
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
    expect(live.exitCode).toBe(1);
    expect(live.sweep?.errors.some((err) => err.includes("session:start --steal"))).toBe(true);
    expect(readOccupancy(root)?.sessionId).toBeTruthy();
  });
});

function git(root: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@t.local",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@t.local",
    },
  });
  if (result.status !== 0) throw new Error((result.stderr ?? result.stdout ?? "git failed").trim());
  return (result.stdout ?? "").trim();
}

/** Fresh, fully-green mutation ritual payload for `sessionId`. */
function ritualPayloadFor(root: string, sessionId: string, head: string, startedAt: Date) {
  return newRitualStatePayload({
    sessionId,
    gitHead: head,
    worktreePath: resolve(root),
    startedAt,
    quickSteps: {
      alignment: ritualStep({ ok: true, ts: startedAt }),
      branch_policy: ritualStep({ ok: true, ts: startedAt }),
      triage_welcome: ritualStep({ ok: true, ts: startedAt }),
      verify_tools: ritualStep({ ok: true, ts: startedAt }),
    },
    gatedSteps: {
      agent_hooks: ritualStep({ ok: true, ts: startedAt }),
      doctor: ritualStep({ ok: true, ts: startedAt }),
      cache_fresh: ritualStep({ ok: true, ts: startedAt }),
    },
  });
}

/** Real repo plus a fresh mutation ritual owned by `sessionId`. */
function ownedRitualRepo(sessionId: string, startedAt: Date): string {
  const root = mkdtempSync(join(tmpdir(), "occ-ritual-order-"));
  temps.push(root);
  mkdirSync(join(root, ".deft"), { recursive: true });
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(join(root, "README.md"), "x\n", "utf8");
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { policy: { sessionRitualStalenessHours: 4 } },
    }),
    "utf8",
  );
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t.local"]);
  git(root, ["config", "user.name", "T"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
  writeRitualState(
    root,
    ritualPayloadFor(root, sessionId, git(root, ["rev-parse", "HEAD"]), startedAt),
  );
  return root;
}

describe("occupancy decides before any ritual persist (#3769)", () => {
  // The ritual verifier is deliberately NOT stubbed in this suite: only the
  // gated entrypoint runner and the active-scope reader are. A persist by the
  // real verifier is therefore observable in the owner's state file, which is
  // what makes the ordering testable at all.
  const hookSeams = {
    ritualRunner: () => ({ code: 0, stdout: "hooks ready", stderr: "" }),
    inspectScope: () => ({
      ready: true,
      path: "xbrief/active/story.xbrief.json",
      message: "OK active scope",
    }),
  };

  it("leaves the owner's ritual state byte-identical when a foreign write is denied", () => {
    const root = ownedRitualRepo("owner", new Date());
    applyWorktreeOccupancy(root, { sessionId: "owner", intent: "mutation" });
    const before = readFileSync(ritualStatePath(root));

    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: { toolName: "Write", file_path: join(root, "src", "app.ts") },
        environ: { DEFT_SESSION_ID: "intruder" },
      },
      hookSeams,
    );

    expect(decision).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
    expect(readFileSync(ritualStatePath(root)).equals(before)).toBe(true);
    expect(readRitualState(root)[0]?.sessionId).toBe("owner");
  });

  it("pins the premise: the write-gate verifier does persist when it runs", () => {
    const root = ownedRitualRepo("owner", new Date());
    const before = readFileSync(ritualStatePath(root));

    // The same verifier the dispatcher reaches on the allow path. agent_hooks
    // is re-executed and recorded on every admitted write (#3738), which is
    // exactly why a denied session must never reach this call.
    const result = verifySessionRitual(
      root,
      writeGateRitualOptions({
        runner: hookSeams.ritualRunner,
        checkActiveCli: () => ({
          ok: true,
          code: 0,
          active: null,
          candidates: [],
          targetVersion: null,
          message: "ok",
          lines: [],
        }),
      }),
    );

    expect(result.code).toBe(0);
    expect(readFileSync(ritualStatePath(root)).equals(before)).toBe(false);
    expect(readRitualState(root)[0]?.sessionId).toBe("owner");
  });

  it("refuses an in-flight ritual write once the tree is re-armed under a new owner", () => {
    const startedAt = new Date();
    const root = ownedRitualRepo("owner", startedAt);
    const head = git(root, ["rev-parse", "HEAD"]);

    // The gated runner stands in for wall-clock: a rival session takes the
    // lease and re-arms the record while agent_hooks is still executing.
    const result = verifySessionRitual(
      root,
      writeGateRitualOptions({
        runner: () => {
          writeRitualState(root, ritualPayloadFor(root, "rival", head, new Date()));
          return { code: 0, stdout: "hooks ready", stderr: "" };
        },
        checkActiveCli: () => ({
          ok: true,
          code: 0,
          active: null,
          candidates: [],
          targetVersion: null,
          message: "ok",
          lines: [],
        }),
      }),
    );

    // The losing session is refused rather than silently overwriting the
    // record the new occupant depends on.
    expect(result.code).toBe(2);
    expect(result.message).toContain("re-armed by rival");
    expect(readRitualState(root)[0]?.sessionId).toBe("rival");
  });
});
