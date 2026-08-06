import { describe, expect, it } from "vitest";
import { buildFailureInfo } from "./fingerprint.js";
import { buildTerminalHandoff, formatHandoffReport, redactHandoffForPersist } from "./handoff.js";
import { beginAttempt, completeAttempt, emptyUnitLedger, markBlocked } from "./ledger.js";

describe("delivery-attempt terminal handoff (#3143)", () => {
  it("includes all contract fields and excludes secret-bearing free text", () => {
    let ledger = emptyUnitLedger({
      scopeId: "scope-a",
      targetId: "target-b",
      workflowId: "wf-c",
    });
    const failure = buildFailureInfo({
      stage: "acceptance",
      code: "EVIDENCE_MISSING",
      retryability: "deterministic",
      resourceClass: "evidence",
      message: "missing proof token=sk-should-not-appear-in-fingerprint-only",
    });
    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "sha-aaa",
      trigger: "automatic",
      attemptId: "a1",
    }));
    ledger = completeAttempt(ledger, {
      attemptId: "a1",
      status: "failed",
      failure,
      elapsedSeconds: 42,
      toolCallCount: 7,
      hostTokenCount: 1000,
    });
    ledger = markBlocked(ledger, "BLOCK_NO_MATERIAL_PROGRESS", {
      kind: "material-delta",
      description: "need evidence for sha-aaa",
      satisfied: false,
    });

    const handoff = buildTerminalHandoff({
      ledger,
      decision: "BLOCK_NO_MATERIAL_PROGRESS",
      now: "2026-08-06T12:00:00Z",
    });

    expect(handoff.schemaVersion).toBe(1);
    expect(handoff.scopeId).toBe("scope-a");
    expect(handoff.targetId).toBe("target-b");
    expect(handoff.workflowId).toBe("wf-c");
    expect(handoff.lastSourceRevision).toBe("sha-aaa");
    expect(handoff.failure?.fingerprint).toBe(failure.fingerprint);
    expect(handoff.failure?.retryability).toBe("deterministic");
    expect(handoff.totalAttempts).toBe(1);
    expect(handoff.failedAttemptCount).toBe(1);
    expect(handoff.sameFailureCount).toBe(1);
    expect(handoff.elapsedSeconds).toBe(42);
    expect(handoff.toolCallCount).toBe(7);
    expect(handoff.hostTokenCount).toBe(1000);
    expect(handoff.denyReason).toBe("BLOCK_NO_MATERIAL_PROGRESS");
    expect(handoff.nextSafeAction.length).toBeGreaterThan(10);
    expect(handoff.resumeCondition.kind).toBe("material-delta");
    expect(handoff.overridePermitted).toBe(true);
    expect(handoff.recordedAt).toBe("2026-08-06T12:00:00Z");

    const report = formatHandoffReport(handoff);
    expect(report).toContain("BLOCKED:");
    expect(report).toContain("BLOCK_NO_MATERIAL_PROGRESS");
    expect(report).not.toMatch(/sk-[a-z]/i);

    const redacted = redactHandoffForPersist(handoff);
    expect(redacted.failure?.fingerprint).toBe(failure.fingerprint);
  });
});
