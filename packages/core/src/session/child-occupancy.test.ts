import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  childOccupancyFileSegment,
  childOccupancyIdentitySourceKind,
  childOccupancyPath,
  readChildOccupancyLease,
  recordChildOccupancyLease,
  releaseChildOccupancyOnTerminal,
  worktreeCandidatesForHeartbeat,
} from "./child-occupancy.js";
import {
  applyWorktreeOccupancy,
  evaluateOccupancyWriteGate,
  OCCUPANCY_TTL_MS,
  readOccupancy,
} from "./occupancy.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "child-occupancy-"));
  temps.push(root);
  return root;
}

describe("child occupancy dispatch record (#3999)", () => {
  const now = new Date("2026-08-31T12:00:00Z");
  const agentId = "child-agent";
  const parentId = "parent-agent";
  const childOwner = "host:grok:v1:child-owner";

  it("claim under a host-env id records the child so terminal can release without a parent write", () => {
    const root = tempRoot();
    const grokRaw = "01a054b9-4042-72e1-929c-b6a1074b31e3";
    const env = { GROK_SESSION_ID: grokRaw };
    applyWorktreeOccupancy(root, { now, env });
    const owner = readOccupancy(root)?.sessionId;
    expect(owner).toBeTruthy();
    expect(readChildOccupancyLease(root, grokRaw)?.occupancyOwner).toBe(owner);

    const released = releaseChildOccupancyOnTerminal(root, { agentId: grokRaw, now });
    expect(released.reason).toBe("released");
    expect(readOccupancy(root)).toBeNull();
    expect(evaluateOccupancyWriteGate(root, { sessionId: "parent", now, env: {} }).allow).toBe(
      true,
    );
  });

  it("dispatch-claim-exit clears the child owner lease without waiting for TTL", () => {
    const root = tempRoot();
    recordChildOccupancyLease(root, {
      agentId,
      parentId,
      occupancyOwner: childOwner,
      worktreePath: root,
      identitySourceKind: "host-env",
    });
    expect(existsSync(childOccupancyPath(root, agentId))).toBe(true);
    applyWorktreeOccupancy(root, { sessionId: childOwner, now, env: {} });
    expect(readOccupancy(root)?.sessionId).toBe(childOwner);

    const released = releaseChildOccupancyOnTerminal(root, { agentId, now });

    expect(released.reason).toBe("released");
    expect(readOccupancy(root)).toBeNull();
    expect(existsSync(childOccupancyPath(root, agentId))).toBe(false);
    const parentGate = evaluateOccupancyWriteGate(root, { sessionId: "parent", now, env: {} });
    expect(parentGate.allow).toBe(true);
    expect(parentGate.occupant).toBeNull();
  });

  it("leaves a successor owner in place", () => {
    const root = tempRoot();
    recordChildOccupancyLease(root, {
      agentId,
      parentId,
      occupancyOwner: childOwner,
      worktreePath: root,
      identitySourceKind: "host-env",
    });
    applyWorktreeOccupancy(root, { sessionId: childOwner, now, env: {} });
    applyWorktreeOccupancy(root, {
      sessionId: "successor",
      now: new Date(now.getTime() + OCCUPANCY_TTL_MS + 1),
      env: {},
    });

    const released = releaseChildOccupancyOnTerminal(root, {
      agentId,
      now: new Date(now.getTime() + OCCUPANCY_TTL_MS + 1),
    });

    expect(released.reason).toBe("owner-changed");
    expect(readOccupancy(root)?.sessionId).toBe("successor");
  });

  it("does not auto-release a shared payload identity mid-flight", () => {
    const root = tempRoot();
    const shared = "host:claude:v1:shared";
    recordChildOccupancyLease(root, {
      agentId,
      parentId,
      occupancyOwner: shared,
      worktreePath: root,
      identitySourceKind: "payload",
    });
    applyWorktreeOccupancy(root, { sessionId: shared, now, env: {} });

    const released = releaseChildOccupancyOnTerminal(root, { agentId, now });

    expect(released.reason).toBe("payload-skip");
    expect(readOccupancy(root)?.sessionId).toBe(shared);
    expect(readChildOccupancyLease(root, agentId)?.occupancyOwner).toBe(shared);
  });

  it("ignores a worker-authored heartbeat occupancy_owner and needs a dispatch record", () => {
    const root = tempRoot();
    const peer = "live-peer";
    applyWorktreeOccupancy(root, { sessionId: peer, now, env: {} });
    const scratch = join(root, ".deft-scratch", "subagent-status");
    mkdirSync(scratch, { recursive: true });
    writeFileSync(
      join(scratch, `${agentId}.json`),
      JSON.stringify({
        agent_id: agentId,
        parent_id: parentId,
        last_heartbeat_at: "2026-08-31T12:00:00Z",
        last_message: "done",
        phase: "terminal",
        terminal_state: "CLEAN",
        occupancy_owner: peer,
      }),
      "utf8",
    );

    const released = releaseChildOccupancyOnTerminal(root, { agentId, now });

    expect(released.reason).toBe("missing-record");
    expect(readOccupancy(root)?.sessionId).toBe(peer);
  });

  it("names identity-source kind from the host contract", () => {
    expect(childOccupancyIdentitySourceKind("grok")).toBe("host-env");
    expect(childOccupancyIdentitySourceKind("claude")).toBe("payload");
    expect(childOccupancyIdentitySourceKind("codex")).toBe("payload");
    expect(childOccupancyIdentitySourceKind("cursor")).toBe("payload");
    expect(childOccupancyIdentitySourceKind("unknown")).toBeNull();
  });

  it("guesses the worktree from a canonical heartbeat path", () => {
    const root = tempRoot();
    const heartbeat = join(root, ".deft-scratch", "subagent-status", "agent.json");
    expect(worktreeCandidatesForHeartbeat(heartbeat, root)).toEqual([root]);
  });

  it("refuses empty dispatch fields", () => {
    const root = tempRoot();
    expect(() =>
      recordChildOccupancyLease(root, {
        agentId: "  ",
        parentId,
        occupancyOwner: childOwner,
        worktreePath: root,
        identitySourceKind: "host-env",
      }),
    ).toThrow(/agentId/);
    expect(() =>
      recordChildOccupancyLease(root, {
        agentId,
        parentId: "",
        occupancyOwner: childOwner,
        worktreePath: root,
        identitySourceKind: "host-env",
      }),
    ).toThrow(/parentId/);
    expect(() =>
      recordChildOccupancyLease(root, {
        agentId,
        parentId,
        occupancyOwner: "  ",
        worktreePath: root,
        identitySourceKind: "host-env",
      }),
    ).toThrow(/occupancyOwner/);
    expect(() =>
      recordChildOccupancyLease(root, {
        agentId,
        parentId,
        occupancyOwner: childOwner,
        worktreePath: "  ",
        identitySourceKind: "host-env",
      }),
    ).toThrow(/worktreePath/);
  });

  it("treats an already-free recorded tree as released", () => {
    const root = tempRoot();
    recordChildOccupancyLease(root, {
      agentId,
      parentId,
      occupancyOwner: childOwner,
      worktreePath: root,
      identitySourceKind: "host-env",
    });
    const released = releaseChildOccupancyOnTerminal(root, { agentId, now });
    expect(released.reason).toBe("already-free");
    expect(existsSync(childOccupancyPath(root, agentId))).toBe(false);
  });

  it("no-ops without a dispatch record or agent id", () => {
    const root = tempRoot();
    expect(releaseChildOccupancyOnTerminal(root, { agentId, now }).reason).toBe("missing-record");
    expect(releaseChildOccupancyOnTerminal(root, { agentId: "  ", now }).reason).toBe(
      "missing-record",
    );
  });

  it("drops a malformed dispatch record", () => {
    const root = tempRoot();
    const path = childOccupancyPath(root, agentId);
    mkdirSync(join(root, ".deft", "child-occupancy"), { recursive: true });
    writeFileSync(path, "{not-json", "utf8");
    expect(readChildOccupancyLease(root, agentId)).toBeNull();
    writeFileSync(path, JSON.stringify({ agent_id: agentId }), "utf8");
    expect(readChildOccupancyLease(root, agentId)).toBeNull();
  });

  it("lists cwd when the heartbeat path is not under the worktree", () => {
    const root = tempRoot();
    const other = tempRoot();
    const heartbeat = join(other, "custom", "agent.json");
    const guessed = worktreeCandidatesForHeartbeat(heartbeat, root);
    expect(guessed).toContain(root);
    expect(guessed.length).toBe(2);
  });

  it("sanitizes agent ids for the store filename", () => {
    expect(childOccupancyFileSegment("host:grok:v1:abc")).toBe("host-grok-v1-abc");
    expect(childOccupancyFileSegment("...")).toBe("agent");
    expect(childOccupancyFileSegment("-x-")).toBe("x");
  });

  it("releases the recorded tree even when the store lives elsewhere", () => {
    const store = tempRoot();
    const tree = tempRoot();
    recordChildOccupancyLease(store, {
      agentId,
      parentId,
      occupancyOwner: childOwner,
      worktreePath: tree,
      identitySourceKind: "host-env",
    });
    applyWorktreeOccupancy(tree, { sessionId: childOwner, now, env: {} });
    const released = releaseChildOccupancyOnTerminal(store, { agentId, now });
    expect(released.reason).toBe("released");
    expect(readOccupancy(tree)).toBeNull();
  });
});
