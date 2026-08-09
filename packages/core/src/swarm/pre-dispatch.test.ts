import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeAttempts,
  type DeliveryUnitLedger,
  loadUnitLedger,
} from "../delivery-attempt/index.js";
import {
  formatPreDispatchReport,
  IMPLEMENT_LEAF_WORKFLOW_ID,
  swarmPreDispatch,
} from "./pre-dispatch.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) {
    try {
      rmSync(t, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "swarm-pre-dispatch-"));
  temps.push(root);
  return root;
}

const unit = {
  scopeId: "3228",
  targetId: ".deft-scratch/worktrees/3228-swarm-pre-dispatch-deny",
  workflowId: IMPLEMENT_LEAF_WORKFLOW_ID,
};

function requireLedger(
  root: string,
  scopeId: string,
  targetId: string,
  workflowId: string,
): DeliveryUnitLedger {
  const ledger = loadUnitLedger(root, scopeId, targetId, workflowId);
  expect(ledger).not.toBeNull();
  if (ledger === null) {
    throw new Error("expected unit ledger");
  }
  return ledger;
}

describe("swarmPreDispatch (#3228)", () => {
  it("begin allows first attempt and records it (exit 0)", () => {
    const root = tempRoot();
    const r = swarmPreDispatch({
      projectRoot: root,
      ...unit,
      action: "begin",
      sourceRevision: "rev-a",
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toMatch(/^ALLOW_/);
    expect(r.attempt).not.toBeNull();
    expect(r.attempt?.status).toBe("running");
    expect(r.activeAttemptIds).toHaveLength(1);

    const ledger = requireLedger(root, r.scopeId, r.targetId, r.workflowId);
    expect(activeAttempts(ledger)).toHaveLength(1);
  });

  it("second begin with active attempt is DENY_DUPLICATE_ACTIVE (exit 1)", () => {
    const root = tempRoot();
    const first = swarmPreDispatch({
      projectRoot: root,
      ...unit,
      action: "begin",
      sourceRevision: "rev-a",
    });
    expect(first.exitCode).toBe(0);

    const second = swarmPreDispatch({
      projectRoot: root,
      ...unit,
      action: "begin",
      sourceRevision: "rev-b",
    });
    expect(second.exitCode).toBe(1);
    expect(second.decision).toBe("DENY_DUPLICATE_ACTIVE");
    expect(second.attempt).toBeNull();
    expect(second.activeAttemptIds).toEqual(first.activeAttemptIds);

    const ledger = requireLedger(root, first.scopeId, first.targetId, first.workflowId);
    expect(activeAttempts(ledger)).toHaveLength(1);
  });

  it("post-terminal begin allows a new attempt (exit 0)", () => {
    const root = tempRoot();
    const first = swarmPreDispatch({
      projectRoot: root,
      ...unit,
      action: "begin",
      sourceRevision: "rev-a",
    });
    expect(first.exitCode).toBe(0);

    const closed = swarmPreDispatch({
      projectRoot: root,
      ...unit,
      action: "complete",
      status: "succeeded",
      attemptId: first.attempt?.attemptId,
    });
    expect(closed.exitCode).toBe(0);
    expect(closed.activeAttemptIds).toHaveLength(0);

    const second = swarmPreDispatch({
      projectRoot: root,
      ...unit,
      action: "begin",
      sourceRevision: "rev-b",
    });
    expect(second.exitCode).toBe(0);
    expect(second.decision).toMatch(/^ALLOW_/);
    expect(second.attempt?.attemptId).not.toBe(first.attempt?.attemptId);
  });

  it("takeover = cancel prior then begin (not concurrent dual active)", () => {
    const root = tempRoot();
    const first = swarmPreDispatch({
      projectRoot: root,
      ...unit,
      action: "begin",
      sourceRevision: "rev-a",
    });
    expect(first.exitCode).toBe(0);

    const denied = swarmPreDispatch({
      projectRoot: root,
      ...unit,
      action: "begin",
      sourceRevision: "rev-b",
    });
    expect(denied.exitCode).toBe(1);
    expect(denied.decision).toBe("DENY_DUPLICATE_ACTIVE");

    const cancelled = swarmPreDispatch({
      projectRoot: root,
      ...unit,
      action: "cancel",
      attemptId: first.attempt?.attemptId,
    });
    expect(cancelled.exitCode).toBe(0);
    expect(cancelled.attempt?.status).toBe("cancelled");
    expect(cancelled.activeAttemptIds).toHaveLength(0);

    const takeover = swarmPreDispatch({
      projectRoot: root,
      ...unit,
      action: "begin",
      sourceRevision: "rev-c",
      workerId: "replacement-leaf",
    });
    expect(takeover.exitCode).toBe(0);
    expect(takeover.attempt?.workerId).toBe("replacement-leaf");

    const ledger = requireLedger(root, takeover.scopeId, takeover.targetId, takeover.workflowId);
    expect(activeAttempts(ledger)).toHaveLength(1);
  });

  it("resume of same unit does not open a second active attempt", () => {
    const root = tempRoot();
    const first = swarmPreDispatch({
      projectRoot: root,
      ...unit,
      action: "begin",
      sourceRevision: "rev-a",
      externalRunId: "run-1",
    });
    expect(first.exitCode).toBe(0);

    // "Resume" wrongly implemented as peer begin must fail closed.
    const peer = swarmPreDispatch({
      projectRoot: root,
      ...unit,
      action: "begin",
      sourceRevision: "rev-a",
      externalRunId: "run-1-resume",
    });
    expect(peer.exitCode).toBe(1);
    expect(peer.decision).toBe("DENY_DUPLICATE_ACTIVE");
    expect(
      activeAttempts(requireLedger(root, first.scopeId, first.targetId, first.workflowId)),
    ).toHaveLength(1);
  });

  it("missing scope/target is config error (exit 2)", () => {
    const root = tempRoot();
    expect(
      swarmPreDispatch({
        projectRoot: root,
        scopeId: "",
        targetId: unit.targetId,
      }).exitCode,
    ).toBe(2);
    expect(
      swarmPreDispatch({
        projectRoot: root,
        scopeId: unit.scopeId,
        targetId: "",
      }).exitCode,
    ).toBe(2);
  });

  it("formatPreDispatchReport mentions DENY hint", () => {
    const root = tempRoot();
    swarmPreDispatch({
      projectRoot: root,
      ...unit,
      action: "begin",
      sourceRevision: "r1",
    });
    const denied = swarmPreDispatch({
      projectRoot: root,
      ...unit,
      action: "begin",
      sourceRevision: "r2",
    });
    const report = formatPreDispatchReport(denied);
    expect(report).toContain("DENY_DUPLICATE_ACTIVE");
    expect(report).toContain("do not spawn");
  });

  it("equivalent worktree path forms share one unit key (deny peer)", () => {
    const root = tempRoot();
    const rel = ".deft-scratch/worktrees/3228-peer";
    const first = swarmPreDispatch({
      projectRoot: root,
      scopeId: "s-path",
      targetId: rel,
      action: "begin",
      sourceRevision: "r1",
    });
    expect(first.exitCode).toBe(0);

    const abs = join(root, rel);
    const peer = swarmPreDispatch({
      projectRoot: root,
      scopeId: "s-path",
      targetId: abs,
      action: "begin",
      sourceRevision: "r2",
    });
    expect(peer.exitCode).toBe(1);
    expect(peer.decision).toBe("DENY_DUPLICATE_ACTIVE");
    expect(peer.targetId).toBe(first.targetId);
  });

  it("branch-like targets stay opaque (not path-normalized)", () => {
    const root = tempRoot();
    const r = swarmPreDispatch({
      projectRoot: root,
      scopeId: "s-branch",
      targetId: "feat/my-story",
      action: "begin",
      sourceRevision: "r1",
    });
    expect(r.exitCode).toBe(0);
    expect(r.targetId).toBe("feat/my-story");
  });

  it("bare relative dir that exists under project is path-normalized", () => {
    const root = tempRoot();
    const bare = "wt-bare";
    mkdirSync(join(root, bare));
    const first = swarmPreDispatch({
      projectRoot: root,
      scopeId: "s-bare",
      targetId: bare,
      action: "begin",
      sourceRevision: "r1",
    });
    expect(first.exitCode).toBe(0);
    expect(first.targetId).not.toBe(bare);
    expect(first.targetId.toLowerCase()).toContain("wt-bare");

    const peer = swarmPreDispatch({
      projectRoot: root,
      scopeId: "s-bare",
      targetId: join(root, bare),
      action: "begin",
      sourceRevision: "r2",
    });
    expect(peer.exitCode).toBe(1);
    expect(peer.decision).toBe("DENY_DUPLICATE_ACTIVE");
  });
});
