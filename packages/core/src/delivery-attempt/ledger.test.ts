import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFailureInfo } from "./fingerprint.js";
import {
  beginAttempt,
  completeAttempt,
  emptyUnitLedger,
  loadUnitLedger,
  MemoryLedgerStore,
  markBlocked,
  recordOperatorOverride,
  saveUnitLedger,
} from "./ledger.js";

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

function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "da-ledger-"));
  temps.push(d);
  return d;
}

describe("delivery-attempt ledger durability (#3143)", () => {
  it("persists and reloads counters across session restart (compaction/restart)", () => {
    const root = tmpRoot();
    let ledger = emptyUnitLedger({
      scopeId: "s1",
      targetId: "t1",
      workflowId: "w1",
    });
    const fail = buildFailureInfo({
      stage: "accept",
      code: "SCHEMA",
      retryability: "deterministic",
      resourceClass: "schema",
    });
    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "rev1",
      trigger: "automatic",
      attemptId: "a1",
    }));
    ledger = completeAttempt(ledger, {
      attemptId: "a1",
      status: "failed",
      failure: fail,
      elapsedSeconds: 10,
      toolCallCount: 5,
    });
    expect(ledger.failedAttemptCount).toBe(1);
    expect(ledger.sameFailureCounts[fail.fingerprint]).toBe(1);

    saveUnitLedger(root, ledger);
    const reloaded = loadUnitLedger(root, "s1", "t1", "w1");
    expect(reloaded).not.toBeNull();
    expect(reloaded?.failedAttemptCount).toBe(1);
    expect(reloaded?.sameFailureCounts[fail.fingerprint]).toBe(1);
    expect(reloaded?.totalElapsedSeconds).toBe(10);
    expect(reloaded?.totalToolCallCount).toBe(5);
  });

  it("MemoryLedgerStore survives worker takeover (successor reads prior)", () => {
    const store = new MemoryLedgerStore();
    let ledger = store.getOrCreate({ scopeId: "s", targetId: "t", workflowId: "w" });
    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "r1",
      trigger: "automatic",
      attemptId: "a1",
      workerId: "worker-a",
    }));
    ledger = completeAttempt(ledger, {
      attemptId: "a1",
      status: "failed",
      failure: buildFailureInfo({ stage: "x", code: "Y", retryability: "unknown" }),
    });
    store.set(ledger);

    // Successor worker
    const successor = store.get("s", "t", "w");
    expect(successor?.failedAttemptCount).toBe(1);
    expect(successor?.attempts[0]?.workerId).toBe("worker-a");
  });

  it("interrupted external run reconciles once without duplicate attempt", () => {
    let ledger = emptyUnitLedger({
      scopeId: "s",
      targetId: "t",
      workflowId: "w",
    });
    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "r1",
      trigger: "automatic",
      attemptId: "a1",
      externalRunId: "run-99",
    }));
    ledger = completeAttempt(ledger, {
      attemptId: "a1",
      externalRunId: "run-99",
      status: "failed",
      failure: buildFailureInfo({ stage: "ci", code: "FAIL", retryability: "unknown" }),
      elapsedSeconds: 3,
    });
    const afterFirst = ledger.failedAttemptCount;
    const attemptLen = ledger.attempts.length;

    // Reconcile again with same externalRunId
    ledger = completeAttempt(ledger, {
      externalRunId: "run-99",
      status: "failed",
      failure: buildFailureInfo({ stage: "ci", code: "FAIL", retryability: "unknown" }),
      elapsedSeconds: 3,
    });
    expect(ledger.failedAttemptCount).toBe(afterFirst);
    expect(ledger.attempts.length).toBe(attemptLen);
  });

  it("operator override preserves history and bounds remaining attempts", () => {
    let ledger = emptyUnitLedger({
      scopeId: "s",
      targetId: "t",
      workflowId: "w",
    });
    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "r1",
      trigger: "automatic",
      attemptId: "a1",
    }));
    ledger = completeAttempt(ledger, {
      attemptId: "a1",
      status: "failed",
      failure: buildFailureInfo({ stage: "z", code: "C", retryability: "deterministic" }),
    });
    ledger = markBlocked(ledger, "BLOCK_NO_MATERIAL_PROGRESS", {
      kind: "material-delta",
      description: "need fix",
      satisfied: false,
    });
    ledger = recordOperatorOverride(ledger, {
      actor: "scott",
      rationale: "known flake in upstream gate",
      allowedAttempts: 1,
    });
    expect(ledger.attempts.length).toBe(1);
    expect(ledger.override?.remainingAttempts).toBe(1);
    expect(ledger.blockedDecision).toBeNull();

    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "r2",
      trigger: "override",
      attemptId: "a2",
    }));
    expect(ledger.override?.remainingAttempts).toBe(0);
    expect(ledger.attempts.length).toBe(2);
  });
});
