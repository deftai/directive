import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listChildOccupancyLeases, recordChildOccupancyLease } from "./child-occupancy.js";
import { applyWorktreeOccupancy } from "./occupancy.js";
import {
  evaluateImplementSpawnOccupancy,
  inspectSpawnDestination,
  persistSpawnReservation,
} from "./spawn-occupancy.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("inspectSpawnDestination (#4066)", () => {
  it("reads isolation=worktree from tool_input and ignores parent payload cwd", () => {
    expect(
      inspectSpawnDestination({
        tool_name: "Task",
        cwd: "/parent",
        tool_input: { isolation: "worktree", prompt: "implement" },
      }),
    ).toEqual({ kind: "host-isolation", path: null, isolation: "worktree" });
  });

  it("reads an explicit worktree path from tool_input cwd", () => {
    expect(
      inspectSpawnDestination({
        tool_name: "spawn_subagent",
        cwd: "/parent",
        tool_input: { cwd: "/tmp/worker-tree", prompt: "implement" },
      }),
    ).toEqual({ kind: "path", path: "/tmp/worker-tree", isolation: null });
  });

  it("does not treat parent payload cwd as a destination", () => {
    expect(
      inspectSpawnDestination({
        tool_name: "Task",
        cwd: "/parent",
        tool_input: { subagent_type: "generalPurpose", prompt: "implement" },
      }),
    ).toBeNull();
    expect(
      inspectSpawnDestination({
        toolName: "spawn_subagent",
        cwd: "/parent",
        prompt: "implement",
      }),
    ).toBeNull();
  });
});

describe("evaluateImplementSpawnOccupancy (#4066)", () => {
  it("fails closed when implement-class spawn has no destination field", () => {
    const root = mkdtempSync(join(tmpdir(), "spawn-occ-"));
    temps.push(root);
    const decision = evaluateImplementSpawnOccupancy({
      payload: { tool_name: "spawn_subagent", tool_input: { prompt: "implement" } },
      payloadRoot: root,
      host: "grok",
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toBe("destination-missing");
      expect(decision.message).toContain("own worktree");
      expect(decision.message).not.toContain("steal");
    }
  });

  it("allows Claude isolation=worktree without a concrete path", () => {
    const root = mkdtempSync(join(tmpdir(), "spawn-occ-iso-"));
    temps.push(root);
    const decision = evaluateImplementSpawnOccupancy({
      payload: { tool_name: "Task", tool_input: { isolation: "worktree", prompt: "build" } },
      payloadRoot: root,
      host: "claude",
    });
    expect(decision.allow).toBe(true);
    if (decision.allow) {
      expect(decision.hostCanReroot).toBe(true);
      expect(decision.incarnation.length).toBeGreaterThan(0);
      expect(decision.reservation.provenance).toBe("dispatch");
    }
  });

  it("refuses a destination that already has a live occupant", () => {
    const root = mkdtempSync(join(tmpdir(), "spawn-occ-live-"));
    temps.push(root);
    const dest = join(root, "wt");
    mkdirSync(dest, { recursive: true });
    const now = new Date("2026-09-02T12:00:00Z");
    applyWorktreeOccupancy(dest, { sessionId: "foreign", now, env: {} });
    const decision = evaluateImplementSpawnOccupancy({
      payload: {
        tool_name: "spawn_subagent",
        tool_input: { cwd: dest, prompt: "implement" },
      },
      payloadRoot: root,
      host: "grok",
      now,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toBe("destination-occupied");
      expect(decision.message).toContain("Use another worktree");
      expect(decision.message).not.toContain("steal");
    }
  });

  it("refuses a second reservation of the same destination path", () => {
    const root = mkdtempSync(join(tmpdir(), "spawn-occ-rsv-"));
    temps.push(root);
    const dest = join(root, "wt");
    mkdirSync(dest, { recursive: true });
    recordChildOccupancyLease(root, {
      agentId: "first",
      parentId: "parent",
      occupancyOwner: "parent",
      worktreePath: dest,
      identitySourceKind: "host-env",
      incarnation: "inc-1",
      provenance: "dispatch",
    });
    const decision = evaluateImplementSpawnOccupancy({
      payload: { tool_name: "spawn_subagent", tool_input: { cwd: dest } },
      payloadRoot: root,
      host: "grok",
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe("reservation-conflict");
  });

  it("persists a dispatch reservation with incarnation", () => {
    const root = mkdtempSync(join(tmpdir(), "spawn-occ-persist-"));
    temps.push(root);
    const dest = join(root, "wt");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, ".git"), "gitdir: /repo/.git/worktrees/wt\n", "utf8");
    const decision = evaluateImplementSpawnOccupancy({
      payload: { tool_name: "spawn_subagent", tool_input: { cwd: dest, name: "leaf-1" } },
      payloadRoot: root,
      host: "grok",
      parentId: "parent-1",
    });
    expect(decision.allow).toBe(true);
    if (!decision.allow) return;
    persistSpawnReservation(root, decision.reservation);
    const listed = listChildOccupancyLeases(root);
    expect(listed.some((r) => r.incarnation === decision.incarnation)).toBe(true);
    expect(listed[0]?.provenance).toBe("dispatch");
  });
});
