import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ABANDONED_OCCUPANCY_LEASE_RECOVERY, occupancyLeaseDoctorTip } from "./main.js";

describe("occupancyLeaseDoctorTip (#4667)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when no lease file exists", () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-lease-tip-"));
    roots.push(root);
    expect(occupancyLeaseDoctorTip(root)).toBeNull();
  });

  it("does not call a live lease abandoned", () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-lease-tip-"));
    roots.push(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    const now = new Date("2026-09-29T17:00:00Z");
    writeFileSync(
      join(root, ".deft", "occupancy.json"),
      JSON.stringify({
        schemaVersion: 1,
        session_id: "host:test:live",
        intent: "mutation",
        claimed_at: "2026-09-29T16:55:00Z",
        heartbeat_at: "2026-09-29T16:59:00Z",
        worktree_path: root,
        host: "none",
        address: "none",
        identity_provenance: "explicit",
        join_protocol: "none",
        retain_capable: false,
      }),
      "utf8",
    );
    const tip = occupancyLeaseDoctorTip(root, now);
    expect(tip).toContain("live");
    expect(tip).not.toMatch(/^Abandoned/);
    expect(tip).toContain(ABANDONED_OCCUPANCY_LEASE_RECOVERY.slice(0, 40));
  });

  it("labels heartbeat-stale leases abandoned-or-expired", () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-lease-tip-"));
    roots.push(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    const now = new Date("2026-09-29T17:00:00Z");
    writeFileSync(
      join(root, ".deft", "occupancy.json"),
      JSON.stringify({
        schemaVersion: 1,
        session_id: "host:test:stale",
        intent: "mutation",
        claimed_at: "2026-09-29T15:00:00Z",
        heartbeat_at: "2026-09-29T15:30:00Z",
        worktree_path: root,
        host: "none",
        address: "none",
        identity_provenance: "explicit",
        join_protocol: "none",
        retain_capable: false,
      }),
      "utf8",
    );
    const tip = occupancyLeaseDoctorTip(root, now);
    expect(tip).toMatch(/Abandoned or expired/);
    expect(tip).toContain("heartbeat-stale");
  });

  it("help recovery recipe no longer leads with Abandoned live", () => {
    expect(ABANDONED_OCCUPANCY_LEASE_RECOVERY.startsWith("Occupancy lease recovery:")).toBe(true);
    expect(ABANDONED_OCCUPANCY_LEASE_RECOVERY).toContain(
      "occupancy:release --session-id=<id from .deft/occupancy.json>",
    );
  });
});
