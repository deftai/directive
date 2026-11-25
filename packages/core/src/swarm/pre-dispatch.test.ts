import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeAttempts,
  type DeliveryUnitLedger,
  loadUnitLedger,
} from "../delivery-attempt/index.js";
import { gitCommonDir } from "../session/git.js";
import {
  formatPreDispatchReport,
  IMPLEMENT_LEAF_WORKFLOW_ID,
  isDirectiveProjectRoot,
  resolveStoryBindingTarget,
  swarmPreDispatch,
} from "./pre-dispatch.js";
import { readStoryBindingRecord } from "./story-binding-record.js";

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
      agentId: "leaf-prior",
      cancellerId: "parent-test",
      preCancelForce: true,
      preCancelReason: "unit-test takeover",
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
      workerId: "leaf-hint",
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
    expect(report).toContain("--action cancel");
    expect(report).toContain("subagent:pre-cancel");
  });

  it("bare ledger cancel without green pre-cancel is refused (#5278)", () => {
    const root = tempRoot();
    const first = swarmPreDispatch({
      projectRoot: root,
      ...unit,
      action: "begin",
      sourceRevision: "rev-a",
      workerId: "leaf-live",
    });
    expect(first.exitCode).toBe(0);

    const refused = swarmPreDispatch({
      projectRoot: root,
      ...unit,
      action: "cancel",
      attemptId: first.attempt?.attemptId,
      agentId: "leaf-live",
      cancellerId: "parent-1",
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.reason).toContain("pre-cancel refused");
    expect(
      activeAttempts(requireLedger(root, refused.scopeId, refused.targetId, refused.workflowId)),
    ).toHaveLength(1);
  });

  it("begin on an existing worktree path mkdirs subagent-status (#3730)", () => {
    const root = tempRoot();
    const rel = ".deft-scratch/worktrees/3730-arm";
    mkdirSync(join(root, rel), { recursive: true });
    const begun = swarmPreDispatch({
      projectRoot: root,
      scopeId: "3730",
      targetId: rel,
      action: "begin",
      sourceRevision: "r1",
    });
    expect(begun.exitCode).toBe(0);
    expect(existsSync(join(root, rel, ".deft-scratch", "subagent-status"))).toBe(true);
  });

  it("begin on a bare relative worktree name mkdirs subagent-status (#3730)", () => {
    const root = tempRoot();
    // `wt-bare` carries no separator and no `.deft-scratch/` segment, so the
    // branch-vs-path heuristic reads it as opaque; the `.git` marker is what
    // proves it is a worktree and arms heartbeats.
    mkdirSync(join(root, "wt-bare"), { recursive: true });
    writeFileSync(join(root, "wt-bare", ".git"), "gitdir: /repo/.git/worktrees/wt-bare\n", "utf8");
    const begun = swarmPreDispatch({
      projectRoot: root,
      scopeId: "3730",
      targetId: "wt-bare",
      action: "begin",
      sourceRevision: "r1",
    });
    expect(begun.exitCode).toBe(0);
    expect(existsSync(join(root, "wt-bare", ".deft-scratch", "subagent-status"))).toBe(true);
  });

  it("begin on a branch name colliding with a source dir does not mkdir there (#3730)", () => {
    const root = tempRoot();
    mkdirSync(join(root, "docs"), { recursive: true });
    const begun = swarmPreDispatch({
      projectRoot: root,
      scopeId: "3730",
      targetId: "docs",
      action: "begin",
      sourceRevision: "r1",
    });
    expect(begun.exitCode).toBe(0);
    expect(existsSync(join(root, "docs", ".deft-scratch"))).toBe(false);
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

  it("slash-containing target key is stable before and after mkdir", () => {
    const root = tempRoot();
    const slashy = "feat/my-story";
    const first = swarmPreDispatch({
      projectRoot: root,
      scopeId: "s-branch",
      targetId: slashy,
      action: "begin",
      sourceRevision: "r1",
    });
    expect(first.exitCode).toBe(0);
    expect(first.targetId).toContain("feat/my-story");
    mkdirSync(join(root, "feat", "my-story"), { recursive: true });
    const peer = swarmPreDispatch({
      projectRoot: root,
      scopeId: "s-branch",
      targetId: slashy,
      action: "begin",
      sourceRevision: "r2",
    });
    expect(peer.exitCode).toBe(1);
    expect(peer.decision).toBe("DENY_DUPLICATE_ACTIVE");
    expect(peer.targetId).toBe(first.targetId);
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

  it("bare target key is stable before and after mkdir (no dual ledger)", () => {
    const root = tempRoot();
    const bare = "wt-precreate";
    const first = swarmPreDispatch({
      projectRoot: root,
      scopeId: "s-pre",
      targetId: bare,
      action: "begin",
      sourceRevision: "r1",
    });
    expect(first.exitCode).toBe(0);
    mkdirSync(join(root, bare));
    const peer = swarmPreDispatch({
      projectRoot: root,
      scopeId: "s-pre",
      targetId: bare,
      action: "begin",
      sourceRevision: "r2",
    });
    expect(peer.exitCode).toBe(1);
    expect(peer.decision).toBe("DENY_DUPLICATE_ACTIVE");
    expect(peer.targetId).toBe(first.targetId);
  });

  it("hasActiveAliasPeer is false for unrelated targets", () => {
    const root = tempRoot();
    mkdirSync(join(root, "a"));
    mkdirSync(join(root, "b"));
    const first = swarmPreDispatch({
      projectRoot: root,
      scopeId: "s-unrelated",
      targetId: join(root, "a"),
      action: "begin",
      sourceRevision: "r1",
    });
    expect(first.exitCode).toBe(0);
    const second = swarmPreDispatch({
      projectRoot: root,
      scopeId: "s-unrelated",
      targetId: join(root, "b"),
      action: "begin",
      sourceRevision: "r2",
    });
    // Distinct physical dirs may each have an active attempt.
    expect(second.exitCode).toBe(0);
  });
});

describe("foreign Directive story-binding write (#7270)", () => {
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

  it("writes begun-from checkout root under a foreign Directive dest common-dir", () => {
    const parent = tempRoot();
    const foreign = tempRoot();
    gitInit(parent);
    gitInit(foreign);
    const foreignWt = join(foreign, "wt");
    addLinkedWorktree(foreign, foreignWt);
    mkdirSync(join(foreignWt, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(foreignWt, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: {} }),
      "utf8",
    );
    writeFileSync(
      join(foreignWt, "xbrief", "active", "story-7270.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { id: "github.issue.7270", status: "running", narratives: {} },
      }),
      "utf8",
    );
    expect(isDirectiveProjectRoot(foreignWt)).toBe(true);
    expect(resolveStoryBindingTarget(parent, foreignWt).ok).toBe(true);
    const begun = swarmPreDispatch({
      projectRoot: parent,
      scopeId: "github.issue.7270",
      targetId: foreignWt,
      action: "begin",
      sourceRevision: "rev",
    });
    expect(begun.exitCode).toBe(0);
    expect(begun.storyBinding).toContain("-> github.issue.7270");
    const binding = readStoryBindingRecord(foreignWt);
    expect(binding.ok).toBe(true);
    if (!binding.ok || binding.record === null) return;
    expect(binding.record.begun_from).toBe(resolve(parent));
    expect(binding.commonDir).toBe(gitCommonDir(foreignWt));
    const cancelled = swarmPreDispatch({
      projectRoot: parent,
      scopeId: "github.issue.7270",
      targetId: foreignWt,
      action: "cancel",
      attemptId: begun.attempt?.attemptId,
      preCancelForce: true,
      preCancelReason: "t",
      agentId: "a",
      cancellerId: "p",
    });
    expect(cancelled.exitCode).toBe(0);
    expect(cancelled.storyBinding).toContain("removed");
    const after = readStoryBindingRecord(foreignWt);
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.record).toBeNull();
  });

  it("still refuses a foreign non-Directive linked worktree", () => {
    const parent = tempRoot();
    const foreign = tempRoot();
    gitInit(parent);
    gitInit(foreign);
    const foreignWt = join(foreign, "wt");
    addLinkedWorktree(foreign, foreignWt);
    const target = resolveStoryBindingTarget(parent, foreignWt);
    expect(target.ok).toBe(false);
    if (!target.ok) expect(target.reason).toContain("not a worktree of this repository");
  });
});
