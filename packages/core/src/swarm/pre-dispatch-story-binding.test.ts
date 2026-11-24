import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  completeAttempt,
  loadUnitLedger,
  markBlocked,
  recordOperatorOverride,
  saveUnitLedger,
} from "../delivery-attempt/index.js";
import { applyWorktreeOccupancy } from "../session/occupancy.js";
import {
  ensureBeginStoryBinding,
  formatPreDispatchReport,
  removeEndedStoryBindings,
  resolveStoryBindingScope,
  resolveStoryBindingTarget,
  swarmPreDispatch,
} from "./pre-dispatch.js";
import {
  readStoryBindingRecord,
  STORY_BINDING_LOCK_NAME,
  STORY_BINDING_STORE_DIR,
  storyBindingRecordName,
} from "./story-binding-record.js";
import { resolveWorkerAuthDestPath } from "./worker-auth-assignment.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

function writeBrief(
  root: string,
  name: string,
  planId: string,
  issue: number,
  swarm: Record<string, unknown> = {},
): void {
  const dir = join(root, "xbrief", "active");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: planId,
        status: "running",
        narratives: { Origin: `Ingested from https://github.com/o/r/issues/${issue}` },
        metadata: { swarm: { file_scope: ["packages/x/**"], ...swarm } },
      },
    }),
    "utf8",
  );
}

interface Fixture {
  readonly primary: string;
  readonly wtA: string;
  readonly wtB: string;
}

/** Two linked worktrees (branches story-a / story-b), each with two active briefs. */
function fixture(): Fixture {
  const primary = mkdtempSync(join(tmpdir(), "pre-dispatch-6379-"));
  temps.push(primary);
  git(primary, ["init", "-q"]);
  git(primary, ["config", "user.email", "t@t.local"]);
  git(primary, ["config", "user.name", "T"]);
  git(primary, ["commit", "--allow-empty", "-q", "-m", "init"]);
  const nest = join(primary, ".deft-scratch", "worktrees");
  mkdirSync(nest, { recursive: true });
  const wtA = join(nest, "wt-a");
  const wtB = join(nest, "wt-b");
  git(primary, ["worktree", "add", "-q", "-b", "story-a", wtA]);
  git(primary, ["worktree", "add", "-q", "-b", "story-b", wtB]);
  for (const root of [wtA, wtB]) {
    // A large story that swarm:launch readiness refuses (large forbids parallel_safe).
    writeBrief(root, "a-story.xbrief.json", "plan-a", 101, {
      size: "large",
      parallel_safe: true,
      readiness: "ready",
    });
    writeBrief(root, "b-story.xbrief.json", "plan-b", 102);
  }
  return { primary, wtA, wtB };
}

function storyOf(wt: string): string | null {
  const read = readStoryBindingRecord(wt);
  if (!read.ok) throw new Error(read.detail);
  return read.record?.story_id ?? null;
}

function idsOf(wt: string): readonly string[] | null {
  const read = readStoryBindingRecord(wt);
  if (!read.ok) throw new Error(read.detail);
  return read.record?.attempt_ids ?? null;
}

function begin(projectRoot: string, scopeId: string, targetId: string) {
  return swarmPreDispatch({ projectRoot, scopeId, targetId, sourceRevision: "rev" });
}

function complete(projectRoot: string, scopeId: string, targetId: string) {
  return swarmPreDispatch({ projectRoot, scopeId, targetId, action: "complete" });
}

function bindingLines(report: string): string[] {
  return report.split("\n").filter((line) => line.includes("story-binding:"));
}

describe("swarm:pre-dispatch begin writes the story-binding record (#6379)", {
  timeout: 120_000,
}, () => {
  it("writes the record for a large story that launch readiness refuses, with no new flag", () => {
    const { primary, wtA } = fixture();
    const result = begin(primary, "plan-a", wtA);
    expect(result.exitCode).toBe(0);
    expect(storyOf(wtA)).toBe("plan-a");
    expect(idsOf(wtA)).toEqual([result.attempt?.attemptId]);
    expect(bindingLines(formatPreDispatchReport(result))).toHaveLength(1);
  });

  it("writes the record for the one linked worktree that has a branch target checked out", () => {
    const { primary, wtA, wtB } = fixture();
    const result = begin(primary, "b-story.xbrief.json", "story-b");
    expect(result.exitCode).toBe(0);
    expect(storyOf(wtB)).toBe("plan-b");
    expect(storyOf(wtA)).toBeNull();
  });

  it("repair-admits an orphan active attempt with missing binding and no worker (#7274)", () => {
    const { primary, wtA } = fixture();
    const first = begin(primary, "plan-a", wtA);
    expect(first.exitCode).toBe(0);
    const common = join(primary, ".git");
    const name = storyBindingRecordName(resolveWorkerAuthDestPath(wtA));
    rmSync(join(common, STORY_BINDING_STORE_DIR, name));
    expect(storyOf(wtA)).toBeNull();
    const again = begin(primary, "plan-a", wtA);
    expect(again.exitCode).toBe(0);
    expect(again.decision).toBe("ALLOW_RESUME");
    expect(again.reason).toMatch(/repair-admit/);
    expect(storyOf(wtA)).toBe("plan-a");
    expect(idsOf(wtA)).toEqual([first.attempt?.attemptId]);
  });

  it("stamps begin-supplied identities onto a repair-admitted attempt (#7274)", () => {
    const { primary, wtA } = fixture();
    const first = begin(primary, "plan-a", wtA);
    expect(first.exitCode).toBe(0);
    const common = join(primary, ".git");
    const name = storyBindingRecordName(resolveWorkerAuthDestPath(wtA));
    rmSync(join(common, STORY_BINDING_STORE_DIR, name));
    const again = swarmPreDispatch({
      projectRoot: primary,
      scopeId: "plan-a",
      targetId: wtA,
      sourceRevision: "rev",
      workerId: "leaf-2",
      externalRunId: "run-2",
    });
    expect(again.exitCode).toBe(0);
    expect(again.decision).toBe("ALLOW_RESUME");
    expect(again.attempt?.attemptId).toBe(first.attempt?.attemptId);
    expect(again.attempt?.workerId).toBe("leaf-2");
    expect(again.attempt?.externalRunId).toBe("run-2");
    const ledger = loadUnitLedger(primary, again.scopeId, again.targetId, again.workflowId);
    const row = ledger?.attempts.find((a) => a.attemptId === first.attempt?.attemptId);
    expect(row?.workerId).toBe("leaf-2");
    expect(row?.externalRunId).toBe("run-2");
  });

  it("refuses repair-admit when dest occupancy is live despite null workerId (#7274)", () => {
    const { primary, wtA } = fixture();
    const first = begin(primary, "plan-a", wtA);
    expect(first.exitCode).toBe(0);
    expect(first.attempt?.workerId).toBeNull();
    const common = join(primary, ".git");
    const name = storyBindingRecordName(resolveWorkerAuthDestPath(wtA));
    rmSync(join(common, STORY_BINDING_STORE_DIR, name));
    expect(applyWorktreeOccupancy(wtA, { sessionId: "live-leaf", intent: "swarm" }).code).toBe(0);
    const again = begin(primary, "plan-a", wtA);
    expect(again.exitCode).toBe(1);
    expect(again.decision).toBe("DENY_DUPLICATE_ACTIVE");
    expect(again.duplicateActiveHint).toBe("pre-cancel");
    expect(formatPreDispatchReport(again)).toMatch(/Takeover:/);
  });

  it("refuses repair-admit when the attempt already has an externalRunId (#7274)", () => {
    const { primary, wtA } = fixture();
    const first = swarmPreDispatch({
      projectRoot: primary,
      scopeId: "plan-a",
      targetId: wtA,
      sourceRevision: "rev",
      externalRunId: "run-live",
    });
    expect(first.exitCode).toBe(0);
    expect(first.attempt?.workerId).toBeNull();
    expect(first.attempt?.externalRunId).toBe("run-live");
    const common = join(primary, ".git");
    const name = storyBindingRecordName(resolveWorkerAuthDestPath(wtA));
    rmSync(join(common, STORY_BINDING_STORE_DIR, name));
    const again = begin(primary, "plan-a", wtA);
    expect(again.exitCode).toBe(1);
    expect(again.decision).toBe("DENY_DUPLICATE_ACTIVE");
    expect(again.duplicateActiveHint).toBe("pre-cancel");
  });

  it("inspect hint names the delivery-attempts ledger path (#7274)", () => {
    const { primary, wtA } = fixture();
    expect(begin(primary, "plan-a", wtA).exitCode).toBe(0);
    const again = begin(primary, "plan-a", wtA);
    expect(again.exitCode).toBe(1);
    expect(again.decision).toBe("DENY_DUPLICATE_ACTIVE");
    expect(again.duplicateActiveHint).toBe("inspect");
    expect(formatPreDispatchReport(again)).toMatch(/\.deft\/delivery-attempts\//);
  });

  it("restores override quota when lock-wait rollback cancels before spawn (#7274)", () => {
    const { primary, wtA } = fixture();
    const first = begin(primary, "plan-a", wtA);
    expect(first.exitCode).toBe(0);
    let ledger = loadUnitLedger(primary, first.scopeId, first.targetId, first.workflowId);
    expect(ledger).not.toBeNull();
    ledger = completeAttempt(ledger!, {
      attemptId: first.attempt!.attemptId,
      status: "failed",
      failure: {
        stage: "validate",
        code: "CONFIG_INVALID",
        fingerprint: "fp-lock-wait-override",
        retryability: "deterministic",
        resourceClass: "config",
      },
    });
    ledger = markBlocked(ledger, "BLOCK_NO_MATERIAL_PROGRESS", {
      kind: "material-delta",
      description: "need fix",
      satisfied: false,
    });
    ledger = recordOperatorOverride(ledger, {
      actor: "scott",
      rationale: "one-shot override for lock-wait rollback",
      allowedAttempts: 1,
    });
    saveUnitLedger(primary, ledger);
    expect(ledger.override?.remainingAttempts).toBe(1);
    const store = join(primary, ".git", STORY_BINDING_STORE_DIR);
    mkdirSync(store, { recursive: true });
    writeFileSync(
      join(store, STORY_BINDING_LOCK_NAME),
      JSON.stringify({ pid: process.pid, token: "held" }),
      "utf8",
    );
    const locked = swarmPreDispatch({
      projectRoot: primary,
      scopeId: "plan-a",
      targetId: wtA,
      sourceRevision: "rev-2",
      storyBindingLockWait: { maxAttempts: 2, sleepMs: 1, maxWaitMs: 50, sleep: () => {} },
    });
    expect(locked.exitCode).toBe(1);
    expect(locked.decision).toBeNull();
    expect(locked.reason).toMatch(/rolled back/);
    const after = loadUnitLedger(primary, first.scopeId, first.targetId, first.workflowId);
    expect(after?.override?.remainingAttempts).toBe(1);
    rmSync(join(store, STORY_BINDING_LOCK_NAME));
    const retry = begin(primary, "plan-a", wtA);
    expect(retry.exitCode).toBe(0);
    expect(retry.decision).toBe("ALLOW_OVERRIDE");
    const spent = loadUnitLedger(primary, first.scopeId, first.targetId, first.workflowId);
    expect(spent?.override?.remainingAttempts).toBe(0);
  });

  it("keeps DENY_DUPLICATE_ACTIVE with pre-cancel hint when a worker is attached (#7274)", () => {
    const { primary, wtA } = fixture();
    const first = swarmPreDispatch({
      projectRoot: primary,
      scopeId: "plan-a",
      targetId: wtA,
      sourceRevision: "rev",
      workerId: "leaf-1",
    });
    expect(first.exitCode).toBe(0);
    const common = join(primary, ".git");
    const name = storyBindingRecordName(resolveWorkerAuthDestPath(wtA));
    rmSync(join(common, STORY_BINDING_STORE_DIR, name));
    const again = begin(primary, "plan-a", wtA);
    expect(again.exitCode).toBe(1);
    expect(again.decision).toBe("DENY_DUPLICATE_ACTIVE");
    expect(again.duplicateActiveHint).toBe("pre-cancel");
    expect(formatPreDispatchReport(again)).toMatch(/Takeover:/);
    expect(storyOf(wtA)).toBe("plan-a");
    expect(idsOf(wtA)).toEqual([first.attempt?.attemptId]);
  });

  it("refuses repair-admit when the store lock wait is exhausted (#7274)", () => {
    const { primary, wtA } = fixture();
    expect(begin(primary, "plan-a", wtA).exitCode).toBe(0);
    const common = join(primary, ".git");
    const name = storyBindingRecordName(resolveWorkerAuthDestPath(wtA));
    rmSync(join(common, STORY_BINDING_STORE_DIR, name));
    const store = join(common, STORY_BINDING_STORE_DIR);
    writeFileSync(
      join(store, STORY_BINDING_LOCK_NAME),
      JSON.stringify({ pid: process.pid, token: "held" }),
      "utf8",
    );
    const again = swarmPreDispatch({
      projectRoot: primary,
      scopeId: "plan-a",
      targetId: wtA,
      sourceRevision: "rev",
      storyBindingLockWait: { maxAttempts: 2, sleepMs: 1, maxWaitMs: 50, sleep: () => {} },
    });
    expect(again.exitCode).toBe(1);
    expect(again.decision).toBe("DENY_DUPLICATE_ACTIVE");
    expect(again.duplicateActiveHint).toBe("binding-repair");
    expect(again.reason).toMatch(/binding repair blocked by store lock/);
    expect(formatPreDispatchReport(again)).toMatch(/Binding-repair:/);
    expect(storyOf(wtA)).toBeNull();
  });

  it("rolls back a just-created attempt when begin store-lock wait is exhausted (#7274)", () => {
    const { primary, wtA } = fixture();
    const store = join(primary, ".git", STORY_BINDING_STORE_DIR);
    mkdirSync(store, { recursive: true });
    writeFileSync(
      join(store, STORY_BINDING_LOCK_NAME),
      JSON.stringify({ pid: process.pid, token: "held" }),
      "utf8",
    );
    const locked = swarmPreDispatch({
      projectRoot: primary,
      scopeId: "plan-a",
      targetId: wtA,
      sourceRevision: "rev",
      storyBindingLockWait: { maxAttempts: 2, sleepMs: 1, maxWaitMs: 50, sleep: () => {} },
    });
    expect(locked.exitCode).toBe(1);
    expect(locked.decision).toBeNull();
    expect(locked.reason).toMatch(/rolled back/);
    expect(locked.storyBinding).toContain("no record written (store)");
    expect(locked.activeAttemptIds).toEqual([]);
    expect(storyOf(wtA)).toBeNull();
    rmSync(join(store, STORY_BINDING_LOCK_NAME));
    const retry = begin(primary, "plan-a", wtA);
    expect(retry.exitCode).toBe(0);
    expect(storyOf(wtA)).toBe("plan-a");
  });

  it("writes no record and prints one line when the scope id or target does not resolve", () => {
    const { primary, wtA } = fixture();
    const noScope = begin(primary, "no-such-story", wtA);
    expect(noScope.exitCode).toBe(0);
    expect(storyOf(wtA)).toBeNull();
    const lines = bindingLines(formatPreDispatchReport(noScope));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("no record written (scope)");
    expect(lines[0]).toContain("matches 0 active briefs");

    const noTarget = begin(primary, "plan-a", "no-such-branch");
    expect(noTarget.exitCode).toBe(0);
    expect(noTarget.storyBinding).toContain("no record written (target)");

    // The main worktree is not a linked worktree.
    const main = begin(primary, "plan-b", primary);
    expect(main.exitCode).toBe(0);
    expect(main.storyBinding).toContain("is not a linked worktree");

    // A non-repository project root never reaches git worktree resolution.
    const plain = mkdtempSync(join(tmpdir(), "pre-dispatch-6379-plain-"));
    temps.push(plain);
    const outside = begin(plain, "plan-a", "story-a");
    expect(outside.exitCode).toBe(0);
    expect(outside.storyBinding).toContain("not inside a Git repository");
  });

  it("removes only the ended attempt's worktree record across two worktrees", () => {
    const { primary, wtA, wtB } = fixture();
    expect(begin(primary, "plan-a", wtA).exitCode).toBe(0);
    const b = begin(primary, "plan-b", wtB);
    expect(b.exitCode).toBe(0);
    const doneA = complete(primary, "plan-a", wtA);
    expect(doneA.exitCode).toBe(0);
    expect(doneA.storyBinding).toContain("records deleted 1");
    expect(storyOf(wtA)).toBeNull();
    expect(storyOf(wtB)).toBe("plan-b");
    const cancelB = swarmPreDispatch({
      projectRoot: primary,
      scopeId: "plan-b",
      targetId: wtB,
      action: "cancel",
      attemptId: b.attempt?.attemptId,
      agentId: "leaf",
      cancellerId: "parent",
      preCancelForce: true,
      preCancelReason: "test takeover",
    });
    expect(cancelB.exitCode).toBe(0);
    expect(storyOf(wtB)).toBeNull();
  });

  it("keeps the record until both a path-target and a branch-target attempt end", () => {
    const { primary, wtA } = fixture();
    const byPath = begin(primary, "plan-a", wtA);
    const byBranch = begin(primary, "plan-a", "story-a");
    expect(byPath.exitCode).toBe(0);
    expect(byBranch.exitCode).toBe(0);
    expect(idsOf(wtA)).toEqual([byPath.attempt?.attemptId, byBranch.attempt?.attemptId]);
    expect(complete(primary, "plan-a", "story-a").exitCode).toBe(0);
    expect(idsOf(wtA)).toEqual([byPath.attempt?.attemptId]);
    expect(complete(primary, "plan-a", wtA).exitCode).toBe(0);
    expect(storyOf(wtA)).toBeNull();
  });

  it("prunes an ended id whose removal found the store locked at the next begin", () => {
    const { primary, wtA } = fixture();
    const first = begin(primary, "plan-a", wtA);
    expect(first.exitCode).toBe(0);
    const lock = join(primary, ".git", STORY_BINDING_STORE_DIR, STORY_BINDING_LOCK_NAME);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "held" }), "utf8");
    const done = complete(primary, "plan-a", wtA);
    expect(done.exitCode).toBe(0);
    expect(done.storyBinding).toContain("not removed");
    expect(idsOf(wtA)).toEqual([first.attempt?.attemptId]);
    rmSync(lock);
    const next = begin(primary, "plan-a", wtA);
    expect(next.exitCode).toBe(0);
    expect(idsOf(wtA)).toEqual([next.attempt?.attemptId]);
  });

  it("keeps an id that only another checkout's ledger knows", () => {
    const { primary, wtA, wtB } = fixture();
    // Another checkout (wt-b as project root) begins first; its ledger is not primary's.
    const other = begin(wtB, "plan-a", wtA);
    expect(other.exitCode).toBe(0);
    const mine = begin(primary, "plan-a", wtA);
    expect(mine.exitCode).toBe(0);
    expect(idsOf(wtA)).toEqual([other.attempt?.attemptId, mine.attempt?.attemptId]);
    expect(complete(primary, "plan-a", wtA).exitCode).toBe(0);
    expect(idsOf(wtA)).toEqual([other.attempt?.attemptId]);
  });

  it("replaces a record for a different story with only the new attempt id", () => {
    const { primary, wtA } = fixture();
    expect(begin(primary, "plan-a", wtA).exitCode).toBe(0);
    const other = begin(primary, "#102", wtA);
    expect(other.exitCode).toBe(0);
    expect(storyOf(wtA)).toBe("plan-b");
    expect(idsOf(wtA)).toEqual([other.attempt?.attemptId]);
  });

  it("removes the id when the attempt ends from another checkout of the same repository", () => {
    const { primary, wtA, wtB } = fixture();
    const started = begin(primary, "plan-a", wtA);
    expect(started.exitCode).toBe(0);
    // The ledger travels with the parent; the record store is shared through the common dir.
    cpSync(join(primary, ".deft"), join(wtB, ".deft"), { recursive: true });
    const ended = complete(wtB, "plan-a", wtA);
    expect(ended.exitCode).toBe(0);
    expect(storyOf(wtA)).toBeNull();
  });
});

function repo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temps.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t.local"]);
  git(root, ["config", "user.name", "T"]);
  git(root, ["commit", "--allow-empty", "-q", "-m", "init"]);
  return root;
}

function activeDir(root: string): string {
  const dir = join(root, "xbrief", "active");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeScopeBrief(root: string, name: string, planId: string | null, issue: number): void {
  writeFileSync(
    join(activeDir(root), name),
    JSON.stringify({
      plan: {
        ...(planId === null ? {} : { id: planId }),
        status: "running",
        narratives: { Origin: `Ingested from https://github.com/o/r/issues/${issue}` },
      },
    }),
    "utf8",
  );
}

describe("story-binding target and scope resolution (#6379 item 2)", { timeout: 120_000 }, () => {
  it("resolves a linked worktree path and a branch, and refuses everything else", () => {
    const primary = repo("sb-target-");
    const wt = join(primary, "wt");
    git(primary, ["worktree", "add", "-q", "-b", "story-x", wt]);
    const canonical = resolveWorkerAuthDestPath(wt);
    for (const target of [wt, "wt", "story-x"]) {
      expect(resolveStoryBindingTarget(primary, target)).toMatchObject({
        ok: true,
        worktreePath: canonical,
      });
    }
    expect(resolveStoryBindingTarget(primary, "refs/heads/story-x")).toMatchObject({ ok: true });
    expect(resolveStoryBindingTarget(primary, "  ")).toEqual({
      ok: false,
      reason: "target is empty",
    });
    const mainBranch = git(primary, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    const onMain = resolveStoryBindingTarget(primary, mainBranch);
    if (onMain.ok) throw new Error("expected refusal");
    expect(onMain.reason).toContain("0 linked worktrees");

    // A plain directory inside the main worktree is not a linked worktree.
    mkdirSync(join(primary, "plain"));
    expect(resolveStoryBindingTarget(primary, "plain")).toMatchObject({ ok: false });

    // A directory outside any repository.
    const outside = mkdtempSync(join(tmpdir(), "sb-target-outside-"));
    temps.push(outside);
    expect(resolveStoryBindingTarget(primary, outside).ok).toBe(false);

    // A linked worktree of another repository.
    const other = repo("sb-target-other-");
    const otherWt = join(other, "wt");
    git(other, ["worktree", "add", "-q", "--detach", otherWt]);
    const foreign = resolveStoryBindingTarget(primary, otherWt);
    if (foreign.ok) throw new Error("expected refusal");
    expect(foreign.reason).toContain("not a worktree of this repository");

    // A project root outside any repository cannot list worktrees.
    expect(resolveStoryBindingTarget(outside, "story-x")).toEqual({
      ok: false,
      reason: "the project root is not inside a Git repository",
    });
  });

  it("resolves a scope id by brief path, story id or owned issue number, exactly once", () => {
    const root = mkdtempSync(join(tmpdir(), "sb-scope-"));
    temps.push(root);
    writeScopeBrief(root, "a-story.xbrief.json", "plan-a", 101);
    writeScopeBrief(root, "b-story.xbrief.json", null, 102);
    writeScopeBrief(root, "c-story.xbrief.json", "plan-c", 102);
    writeFileSync(join(activeDir(root), "d-story.xbrief.json"), "{ not json", "utf8");
    writeFileSync(join(activeDir(root), "e-story.xbrief.json"), "[]", "utf8");
    expect(resolveStoryBindingScope(root, "plan-a")).toMatchObject({ ok: true, storyId: "plan-a" });
    expect(resolveStoryBindingScope(root, "#101")).toMatchObject({ ok: true, storyId: "plan-a" });
    expect(resolveStoryBindingScope(root, "xbrief/active/a-story.xbrief.json")).toMatchObject({
      ok: true,
      storyId: "plan-a",
    });
    // Without plan.id the story id is the filename stem.
    expect(resolveStoryBindingScope(root, "b-story")).toMatchObject({
      ok: true,
      storyId: "b-story",
    });
    const ambiguous = resolveStoryBindingScope(root, "102");
    if (ambiguous.ok) throw new Error("expected refusal");
    expect(ambiguous.reason).toContain("matches 2 active briefs");
    expect(resolveStoryBindingScope(root, "")).toMatchObject({ ok: false });
    expect(resolveStoryBindingScope(root, "nope")).toMatchObject({ ok: false });
  });

  it("rolls back on locked begin wait and still covers non-waiting ensure/remove edges (#7274)", () => {
    const primary = repo("sb-store-");
    const wt = join(primary, "wt");
    git(primary, ["worktree", "add", "-q", "-b", "story-y", wt]);
    writeScopeBrief(wt, "a-story.xbrief.json", "plan-a", 101);
    const store = join(primary, ".git", STORY_BINDING_STORE_DIR);
    mkdirSync(store, { recursive: true });
    writeFileSync(
      join(store, STORY_BINDING_LOCK_NAME),
      JSON.stringify({ pid: process.pid, token: "held" }),
      "utf8",
    );
    const input = { projectRoot: primary, scopeId: "plan-a", targetId: wt };
    // Begin waits then rolls back the just-created attempt when the budget ends.
    const locked = swarmPreDispatch({
      ...input,
      sourceRevision: "rev",
      storyBindingLockWait: { maxAttempts: 2, sleepMs: 1, maxWaitMs: 50, sleep: () => {} },
    });
    expect(locked.exitCode).toBe(1);
    expect(locked.decision).toBeNull();
    expect(locked.reason).toMatch(/rolled back/);
    expect(locked.storyBinding).toContain("no record written (store)");
    expect(locked.activeAttemptIds).toEqual([]);
    const id = locked.attempt?.attemptId ?? "";
    // Complete/remove still do not wait on a live holder.
    expect(removeEndedStoryBindings(primary, [id])).toContain("not removed");
    rmSync(join(store, STORY_BINDING_LOCK_NAME));
    // Rolled-back attempt is ended: ensure refuses to write it alone.
    expect(ensureBeginStoryBinding(input, [id])).toContain(
      "no attempt of this unit is still running",
    );
    expect(ensureBeginStoryBinding(input, [id, "other-checkout-attempt"])).toContain("-> plan-a");
    expect(removeEndedStoryBindings(primary, ["other-checkout-attempt"])).toContain(
      "records deleted 1",
    );
    expect(removeEndedStoryBindings(primary, [id])).toBeNull();
    expect(removeEndedStoryBindings(primary, [])).toBeNull();
    const outside = mkdtempSync(join(tmpdir(), "sb-store-outside-"));
    temps.push(outside);
    expect(removeEndedStoryBindings(outside, ["att-1"])).toBeNull();
  });
});
