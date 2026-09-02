import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listChildOccupancyLeases, recordChildOccupancyLease } from "./child-occupancy.js";
import { applyWorktreeOccupancy } from "./occupancy.js";
import {
  allocatedWorktreeMatches,
  evaluateImplementSpawnOccupancy,
  inspectSpawnDestination,
  persistSpawnReservation,
  releaseSpawnReservation,
} from "./spawn-occupancy.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function gitInit(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "T"], { cwd: root, encoding: "utf8" });
  writeFileSync(join(root, "README"), "x\n", "utf8");
  execFileSync("git", ["add", "README"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root, encoding: "utf8" });
}

function addLinkedWorktree(root: string, dest: string): void {
  execFileSync("git", ["worktree", "add", "--detach", dest, "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
}

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
      expect(decision.reservation.worktreePath).not.toBe(root);
      expect(decision.reservation.worktreePath).toContain("spawn-pending");
      expect(persistSpawnReservation(root, decision.reservation).ok).toBe(true);
      const second = evaluateImplementSpawnOccupancy({
        payload: { tool_name: "Task", tool_input: { isolation: "worktree", prompt: "build" } },
        payloadRoot: root,
        host: "claude",
      });
      expect(second.allow).toBe(true);
      if (second.allow) expect(persistSpawnReservation(root, second.reservation).ok).toBe(true);
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

  it("dest-locks across sibling parent worktrees of the same repo", () => {
    const main = mkdtempSync(join(tmpdir(), "spawn-occ-main-"));
    temps.push(main);
    gitInit(main);
    const parentA = join(main, "parent-a");
    const parentB = join(main, "parent-b");
    addLinkedWorktree(main, parentA);
    addLinkedWorktree(main, parentB);
    const dest = join(main, "child-dest");
    const first = persistSpawnReservation(parentA, {
      agentId: "leaf-a",
      parentId: "parent-a",
      occupancyOwner: "parent-a",
      worktreePath: dest,
      identitySourceKind: "host-env",
      incarnation: "inc-a",
      provenance: "dispatch",
    });
    expect(first.ok).toBe(true);
    const second = persistSpawnReservation(parentB, {
      agentId: "leaf-b",
      parentId: "parent-b",
      occupancyOwner: "parent-b",
      worktreePath: dest,
      identitySourceKind: "host-env",
      incarnation: "inc-b",
      provenance: "dispatch",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("conflict");
  });

  it("releases a dest lock from a sibling worktree of the same repo", () => {
    const main = mkdtempSync(join(tmpdir(), "spawn-occ-rel-"));
    temps.push(main);
    gitInit(main);
    const parentA = join(main, "parent-a");
    const child = join(main, "child");
    addLinkedWorktree(main, parentA);
    addLinkedWorktree(main, child);
    const dest = child;
    expect(
      persistSpawnReservation(parentA, {
        agentId: "leaf-a",
        parentId: "parent-a",
        occupancyOwner: "parent-a",
        worktreePath: dest,
        identitySourceKind: "host-env",
        incarnation: "inc-a",
        provenance: "dispatch",
      }).ok,
    ).toBe(true);
    releaseSpawnReservation(child, dest);
    const again = persistSpawnReservation(parentA, {
      agentId: "leaf-b",
      parentId: "parent-a",
      occupancyOwner: "parent-a",
      worktreePath: dest,
      identitySourceKind: "host-env",
      incarnation: "inc-b",
      provenance: "dispatch",
    });
    expect(again.ok).toBe(true);
  });

  it("dest-locks a missing destination so two first-creates conflict", () => {
    const root = mkdtempSync(join(tmpdir(), "spawn-occ-missing-"));
    temps.push(root);
    const dest = join(root, "wt-missing");
    const first = persistSpawnReservation(root, {
      agentId: "leaf-1",
      parentId: "parent",
      occupancyOwner: "parent",
      worktreePath: dest,
      identitySourceKind: "host-env",
      incarnation: "inc-a",
      provenance: "dispatch",
    });
    expect(first.ok).toBe(true);
    const second = persistSpawnReservation(root, {
      agentId: "leaf-2",
      parentId: "parent",
      occupancyOwner: "parent",
      worktreePath: dest,
      identitySourceKind: "host-env",
      incarnation: "inc-b",
      provenance: "dispatch",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("conflict");
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
    const first = persistSpawnReservation(root, decision.reservation);
    expect(first.ok).toBe(true);
    const listed = listChildOccupancyLeases(root);
    expect(listed.some((r) => r.incarnation === decision.incarnation)).toBe(true);
    expect(listed[0]?.provenance).toBe("dispatch");
    const second = persistSpawnReservation(root, {
      ...decision.reservation,
      incarnation: "inc-other",
      agentId: "leaf-2",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("conflict");
  });

  it("refuses spawn onto a git main clone even when the payload names an exception", () => {
    const root = mkdtempSync(join(tmpdir(), "spawn-occ-main-"));
    temps.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: root, encoding: "utf8" });
    execFileSync("git", ["config", "user.name", "T"], { cwd: root, encoding: "utf8" });
    writeFileSync(join(root, "README"), "x\n", "utf8");
    execFileSync("git", ["add", "README"], { cwd: root, encoding: "utf8" });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root, encoding: "utf8" });
    const decision = evaluateImplementSpawnOccupancy({
      payload: {
        tool_name: "spawn_subagent",
        tool_input: {
          cwd: root,
          primary_claim_exception: "operator-default-branch",
          prompt: "implement",
        },
      },
      payloadRoot: root,
      host: "grok",
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe("primary-path");
  });

  it("does not treat a destination-local reservation as bound to a different store", () => {
    const parent = mkdtempSync(join(tmpdir(), "spawn-occ-bind-p-"));
    const other = mkdtempSync(join(tmpdir(), "spawn-occ-bind-o-"));
    temps.push(parent, other);
    mkdirSync(join(other, ".deft"), { recursive: true });
    recordChildOccupancyLease(other, {
      agentId: "stranger",
      parentId: "other-parent",
      occupancyOwner: "other-parent",
      worktreePath: other,
      identitySourceKind: "host-env",
      incarnation: "inc-x",
      provenance: "dispatch",
    });
    expect(allocatedWorktreeMatches(parent, other, { parentId: "parent" })).toBe(false);
    expect(allocatedWorktreeMatches(other, other, { parentId: "other-parent" })).toBe(false);
  });

  it("binds allocation to same-repo linked worktree, incarnation, and owner", () => {
    const parent = mkdtempSync(join(tmpdir(), "spawn-occ-repo-p-"));
    temps.push(parent);
    gitInit(parent);
    const wt = join(parent, "wt");
    addLinkedWorktree(parent, wt);
    recordChildOccupancyLease(parent, {
      agentId: "leaf",
      parentId: "parent",
      occupancyOwner: "parent",
      worktreePath: wt,
      identitySourceKind: "host-env",
      incarnation: "inc-1",
      provenance: "dispatch",
    });
    expect(allocatedWorktreeMatches(parent, wt, { parentId: "parent" })).toBe(true);
    expect(allocatedWorktreeMatches(parent, wt, { parentId: "other-parent" })).toBe(false);
  });

  it("rejects a foreign-repository path even when a dispatch record names it", () => {
    const parent = mkdtempSync(join(tmpdir(), "spawn-occ-repo-f-"));
    const foreign = mkdtempSync(join(tmpdir(), "spawn-occ-repo-x-"));
    temps.push(parent, foreign);
    gitInit(parent);
    gitInit(foreign);
    const foreignWt = join(foreign, "wt");
    addLinkedWorktree(foreign, foreignWt);
    recordChildOccupancyLease(parent, {
      agentId: "stranger",
      parentId: "other-parent",
      occupancyOwner: "other-parent",
      worktreePath: foreignWt,
      identitySourceKind: "host-env",
      incarnation: "inc-x",
      provenance: "dispatch",
    });
    expect(allocatedWorktreeMatches(parent, foreignWt, { parentId: "other-parent" })).toBe(false);
  });

  it("rejects a same-repo tree occupied by a successor that is not the current parent", () => {
    const parent = mkdtempSync(join(tmpdir(), "spawn-occ-repo-s-"));
    temps.push(parent);
    gitInit(parent);
    const wt = join(parent, "wt");
    addLinkedWorktree(parent, wt);
    recordChildOccupancyLease(parent, {
      agentId: "leaf",
      parentId: "parent",
      occupancyOwner: "parent",
      worktreePath: wt,
      identitySourceKind: "host-env",
      incarnation: "inc-1",
      provenance: "dispatch",
    });
    applyWorktreeOccupancy(wt, { sessionId: "successor", now: new Date(), env: {} });
    expect(allocatedWorktreeMatches(parent, wt, { parentId: "parent" })).toBe(false);
  });
});
