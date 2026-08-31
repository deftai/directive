import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyWorktreeOccupancy,
  evaluateOccupancyWriteGate,
  OCCUPANCY_MAX_LEASE_MS,
  OCCUPANCY_REFRESH_AFTER_MS,
  OCCUPANCY_TTL_MS,
  occupancyPath,
  readOccupancy,
} from "../session/occupancy.js";
import { restampOwnerLivenessOnHookEvent } from "./owner-liveness.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const CLAIMED_AT = new Date("2026-08-31T12:00:00Z");
const PAST_FLOOR = new Date(CLAIMED_AT.getTime() + OCCUPANCY_REFRESH_AFTER_MS + 1_000);

function leasedRoot(sessionId = "owner"): string {
  const root = mkdtempSync(join(tmpdir(), "owner-liveness-"));
  temps.push(root);
  applyWorktreeOccupancy(root, { sessionId, intent: "mutation", now: CLAIMED_AT });
  return root;
}

describe("owner liveness on non-write hook activity (#3987)", () => {
  it("renews the owner's lease from a hook event with no write in it", () => {
    const root = leasedRoot();
    const before = readOccupancy(root);
    const outcome = restampOwnerLivenessOnHookEvent({
      projectRoot: root,
      ownerSessionId: "owner",
      hostAuthoritative: true,
      now: PAST_FLOOR,
    });
    expect(outcome).toMatchObject({ restamped: true, sessionId: "owner" });
    const after = readOccupancy(root);
    expect(after?.heartbeatAt.toISOString()).toBe(PAST_FLOOR.toISOString());
    expect(before?.heartbeatAt.toISOString()).toBe(CLAIMED_AT.toISOString());
  });

  it("leaves last_write_at alone so `no recorded write` stays honest", () => {
    const root = leasedRoot();
    restampOwnerLivenessOnHookEvent({
      projectRoot: root,
      ownerSessionId: "owner",
      hostAuthoritative: true,
      now: PAST_FLOOR,
    });
    expect(readOccupancy(root)?.lastWriteAt).toBeNull();
  });

  it("does not advance claimed_at, so the absolute lease cap is unmoved", () => {
    const root = leasedRoot();
    let at = PAST_FLOOR;
    // Renew repeatedly across more than the whole cap window; every renewal is
    // a fresh heartbeat, so only the cap can end this lease.
    for (let step = 0; step < 40; step += 1) {
      restampOwnerLivenessOnHookEvent({
        projectRoot: root,
        ownerSessionId: "owner",
        hostAuthoritative: true,
        now: at,
      });
      at = new Date(at.getTime() + OCCUPANCY_TTL_MS / 2);
    }
    expect(readOccupancy(root)?.claimedAt.toISOString()).toBe(CLAIMED_AT.toISOString());
    const pastCap = new Date(CLAIMED_AT.getTime() + OCCUPANCY_MAX_LEASE_MS + 1_000);
    expect(
      restampOwnerLivenessOnHookEvent({
        projectRoot: root,
        ownerSessionId: "owner",
        hostAuthoritative: true,
        now: pastCap,
      }),
    ).toEqual({ restamped: false, reason: "no-live-lease" });
  });

  it("refuses an ambient identity even when the id matches the occupant", () => {
    const root = leasedRoot();
    expect(
      restampOwnerLivenessOnHookEvent({
        projectRoot: root,
        ownerSessionId: "owner",
        hostAuthoritative: false,
        now: PAST_FLOOR,
      }),
    ).toEqual({ restamped: false, reason: "no-host-authoritative-owner" });
    expect(readOccupancy(root)?.heartbeatAt.toISOString()).toBe(CLAIMED_AT.toISOString());
  });

  it("refuses an unresolved owner id", () => {
    const root = leasedRoot();
    for (const ownerSessionId of [undefined, "", "   "]) {
      expect(
        restampOwnerLivenessOnHookEvent({
          projectRoot: root,
          ownerSessionId,
          hostAuthoritative: true,
          now: PAST_FLOOR,
        }),
      ).toEqual({ restamped: false, reason: "no-host-authoritative-owner" });
    }
  });

  it("refuses a foreign session and a granted member — renewal is owner-only", () => {
    const root = leasedRoot();
    expect(
      restampOwnerLivenessOnHookEvent({
        projectRoot: root,
        ownerSessionId: "someone-else",
        hostAuthoritative: true,
        now: PAST_FLOOR,
      }),
    ).toEqual({ restamped: false, reason: "not-owner" });
    expect(readOccupancy(root)?.heartbeatAt.toISOString()).toBe(CLAIMED_AT.toISOString());
  });

  it("refuses to mint a lease on an unheld or expired tree", () => {
    const free = mkdtempSync(join(tmpdir(), "owner-liveness-free-"));
    temps.push(free);
    expect(
      restampOwnerLivenessOnHookEvent({
        projectRoot: free,
        ownerSessionId: "owner",
        hostAuthoritative: true,
        now: PAST_FLOOR,
      }),
    ).toEqual({ restamped: false, reason: "no-live-lease" });
    expect(readOccupancy(free)).toBeNull();

    const stale = leasedRoot();
    const pastTtl = new Date(CLAIMED_AT.getTime() + OCCUPANCY_TTL_MS + 1_000);
    expect(
      restampOwnerLivenessOnHookEvent({
        projectRoot: stale,
        ownerSessionId: "owner",
        hostAuthoritative: true,
        now: pastTtl,
      }),
    ).toEqual({ restamped: false, reason: "no-live-lease" });
    expect(readOccupancy(stale)?.heartbeatAt.toISOString()).toBe(CLAIMED_AT.toISOString());
  });

  it("skips inside the shared refresh floor rather than rewriting per tool call", () => {
    const root = leasedRoot();
    const inside = new Date(CLAIMED_AT.getTime() + OCCUPANCY_REFRESH_AFTER_MS - 1_000);
    expect(
      restampOwnerLivenessOnHookEvent({
        projectRoot: root,
        ownerSessionId: "owner",
        hostAuthoritative: true,
        now: inside,
      }),
    ).toEqual({ restamped: false, reason: "within-refresh-floor" });
    expect(readOccupancy(root)?.heartbeatAt.toISOString()).toBe(CLAIMED_AT.toISOString());
  });

  it("refuses a record that names a different worktree", () => {
    const root = leasedRoot();
    const other = mkdtempSync(join(tmpdir(), "owner-liveness-other-"));
    temps.push(other);
    // A lease record describing another tree must not be renewed from this one
    // — the mismatch is written directly because the claim path always records
    // the root it was given.
    const path = occupancyPath(root);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw.worktree_path = other;
    writeFileSync(path, JSON.stringify(raw), "utf8");
    expect(
      restampOwnerLivenessOnHookEvent({
        projectRoot: root,
        ownerSessionId: "owner",
        hostAuthoritative: true,
        now: PAST_FLOOR,
      }),
    ).toEqual({ restamped: false, reason: "foreign-worktree" });
  });

  it("does not suppress the write gate's own product-write stamp", () => {
    // Ordering guarantee: liveness renewal resets the shared age floor, so a
    // renewal placed before the mutation gates would stop them recording
    // `last_write_at` at all. Renewal after a gated write leaves that stamp.
    const root = leasedRoot();
    const wroteAt = PAST_FLOOR;
    evaluateOccupancyWriteGate(root, { sessionId: "owner", now: wroteAt, refresh: true });
    expect(readOccupancy(root)?.lastWriteAt?.toISOString()).toBe(wroteAt.toISOString());
    const later = new Date(wroteAt.getTime() + OCCUPANCY_REFRESH_AFTER_MS + 1_000);
    restampOwnerLivenessOnHookEvent({
      projectRoot: root,
      ownerSessionId: "owner",
      hostAuthoritative: true,
      now: later,
    });
    const after = readOccupancy(root);
    expect(after?.heartbeatAt.toISOString()).toBe(later.toISOString());
    expect(after?.lastWriteAt?.toISOString()).toBe(wroteAt.toISOString());
  });
});
