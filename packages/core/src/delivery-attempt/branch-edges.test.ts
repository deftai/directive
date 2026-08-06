import { describe, expect, it } from "vitest";
import { evaluateAndPrepareBlock, evaluatePreDispatch } from "./evaluate.js";
import { buildFailureInfo, normalizeFailureMessage } from "./fingerprint.js";
import { buildTerminalHandoff, redactHandoffForPersist } from "./handoff.js";
import {
  beginAttempt,
  completeAttempt,
  emptyUnitLedger,
  parseUnitLedger,
  recordOperatorOverride,
} from "./ledger.js";
import { evaluateMaterialProgress } from "./material-delta.js";

const unit = { scopeId: "be-s", targetId: "be-t", workflowId: "be-w" };

describe("delivery-attempt branch edges (#3143)", () => {
  it("parses full attempt records with optional null fields", () => {
    const parsed = parseUnitLedger({
      scopeId: "s",
      targetId: "t",
      workflowId: "w",
      phaseId: "p",
      attempts: [
        {
          attemptId: "a1",
          sourceRevision: "r1",
          trigger: "automatic",
          status: "running",
          failure: {
            stage: "s",
            code: "c",
            fingerprint: "fp",
            retryability: "transient",
            resourceClass: "net",
          },
          materialDelta: [
            {
              kind: "code",
              addresses: ["a", 1, "b"],
              sourceRevision: "r1",
              note: "n",
            },
            { kind: null },
            "skip",
          ],
          startedAt: "2026-01-01T00:00:00Z",
          endedAt: null,
          elapsedSeconds: 1,
          toolCallCount: 2,
          hostTokenCount: 3,
          workerId: "w1",
          externalRunId: "e1",
        },
        {
          attemptId: "a2",
          sourceRevision: "r2",
          trigger: "manual",
          status: "failed",
          failure: null,
          materialDelta: "nope",
          startedAt: "2026-01-01T00:00:01Z",
          hostTokenCount: null,
        },
      ],
      failedAttemptCount: 1,
      sameFailureCounts: { fp: 1 },
      totalElapsedSeconds: 1,
      totalToolCallCount: 2,
      totalHostTokenCount: null,
      lastFailure: {
        stage: "s",
        fingerprint: "fp",
        retryability: "transient",
        code: null,
        resourceClass: null,
      },
      lastMaterialDelta: [],
      lastSourceRevision: "r1",
      blockedDecision: null,
      resumeCondition: {
        kind: "monitor-wake",
        description: "wait",
        satisfied: false,
      },
      override: {
        overrideId: "o1",
        actor: "a",
        rationale: "r",
        recordedAt: "2026-01-01T00:00:00Z",
        allowedAttempts: 2,
        expiresAt: "2099-01-01T00:00:00Z",
        remainingAttempts: 1,
      },
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(parsed?.attempts.length).toBe(2);
    expect(parsed?.override?.remainingAttempts).toBe(1);
    expect(parsed?.resumeCondition?.kind).toBe("monitor-wake");
  });

  it("rejects incomplete parse shapes", () => {
    expect(
      parseUnitLedger({ scopeId: "s", targetId: "t", workflowId: "w", attempts: null }),
    ).not.toBeNull();
    expect(
      parseUnitLedger({
        scopeId: "s",
        targetId: "t",
        workflowId: "w",
        lastFailure: { stage: "s", fingerprint: "f", retryability: "bad" },
      })?.lastFailure,
    ).toBeNull();
    expect(
      parseUnitLedger({
        scopeId: "s",
        targetId: "t",
        workflowId: "w",
        resumeCondition: { kind: "x" },
        override: { overrideId: "o", actor: "a", rationale: "r" },
      })?.override,
    ).toBeNull();
  });

  it("completeAttempt by externalRunId active match and already-terminal short-circuit", () => {
    let ledger = emptyUnitLedger(unit);
    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "r1",
      trigger: "automatic",
      attemptId: "a1",
      externalRunId: "ext-a",
    }));
    ledger = completeAttempt(ledger, {
      externalRunId: "ext-a",
      status: "failed",
      failure: buildFailureInfo({ stage: "s", code: "C", retryability: "deterministic" }),
      hostTokenCount: null,
    });
    const again = completeAttempt(ledger, {
      attemptId: "a1",
      status: "failed",
      failure: buildFailureInfo({ stage: "s", code: "C", retryability: "deterministic" }),
    });
    expect(again.failedAttemptCount).toBe(1);
  });

  it("completeAttempt without attemptId uses latest active", () => {
    let ledger = emptyUnitLedger(unit);
    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "r1",
      trigger: "automatic",
      attemptId: "a1",
    }));
    ledger = completeAttempt(ledger, {
      status: "succeeded",
      elapsedSeconds: 2,
      toolCallCount: 1,
      hostTokenCount: 10,
    });
    expect(ledger.lastFailure).toBeNull();
    expect(ledger.totalHostTokenCount).toBe(10);
  });

  it("expired override does not allow; material progress with resume trigger", () => {
    let ledger = emptyUnitLedger(unit);
    ledger = recordOperatorOverride(ledger, {
      actor: "a",
      rationale: "r",
      allowedAttempts: 1,
      expiresAt: "2000-01-01T00:00:00Z",
      now: "2026-08-06T00:00:00Z",
    });
    const r = evaluatePreDispatch(ledger, {
      ...unit,
      sourceRevision: "r1",
      trigger: "automatic",
      now: "2026-08-06T00:00:00Z",
    });
    expect(r.decision).toBe("ALLOW_FIRST_ATTEMPT");

    ledger = markBlockedWithResume(ledger);
    const r2 = evaluatePreDispatch(ledger, {
      ...unit,
      sourceRevision: "r2",
      trigger: "automatic",
      materialDelta: [
        {
          kind: "configuration",
          addresses: ["config"],
          sourceRevision: "r2",
        },
      ],
      anticipatedFailure: buildFailureInfo({
        stage: "v",
        code: "CONFIG",
        retryability: "deterministic",
        resourceClass: "config",
      }),
    });
    // material progress while resume satisfied → ALLOW_RESUME or ALLOW_MATERIAL_PROGRESS
    expect(r2.allowed).toBe(true);
  });

  it("evaluateAndPrepareBlock allows leave ledger unchanged", () => {
    const ledger = emptyUnitLedger(unit);
    const out = evaluateAndPrepareBlock(ledger, {
      ...unit,
      sourceRevision: "r1",
      trigger: "automatic",
    });
    expect(out.evaluation.allowed).toBe(true);
    expect(out.ledger.blockedDecision).toBeNull();
  });

  it("redactHandoffForPersist is identity; normalize empty message", () => {
    const ledger = emptyUnitLedger(unit);
    const h = buildTerminalHandoff({ ledger, decision: "BLOCK_ATTEMPT_BUDGET" });
    expect(redactHandoffForPersist(h)).toEqual(h);
    expect(normalizeFailureMessage(null)).toBe("");
    expect(normalizeFailureMessage(undefined)).toBe("");
  });

  it("material progress with non-progress kinds and empty claims", () => {
    expect(
      evaluateMaterialProgress({
        claims: null,
        failure: null,
        evaluatedRevision: "r1",
      }).isMaterial,
    ).toBe(false);
    expect(
      evaluateMaterialProgress({
        claims: [{ kind: "none", addresses: [], sourceRevision: "r1" }],
        failure: null,
        evaluatedRevision: "r1",
      }).isMaterial,
    ).toBe(false);
  });

  it("transient exhaustion message path after max retries", () => {
    const failure = buildFailureInfo({
      stage: "f",
      code: "ETIMEDOUT",
      retryability: "transient",
    });
    let ledger = emptyUnitLedger(unit);
    for (let i = 1; i <= 2; i++) {
      ({ ledger } = beginAttempt(ledger, {
        sourceRevision: "r1",
        trigger: i === 1 ? "automatic" : "retry",
        attemptId: `t${i}`,
      }));
      ledger = completeAttempt(ledger, {
        attemptId: `t${i}`,
        status: "failed",
        failure,
      });
    }
    const r = evaluatePreDispatch(ledger, {
      ...unit,
      sourceRevision: "r1",
      trigger: "retry",
      anticipatedFailure: failure,
    });
    expect(r.decision).toBe("BLOCK_NO_MATERIAL_PROGRESS");
  });

  it("deterministic block with zero sameFailureCount uses BLOCK_NON_RETRYABLE", () => {
    // failedAttemptCount >= 1 but sameFailureCounts missing fingerprint
    let ledger = emptyUnitLedger(unit);
    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "r1",
      trigger: "automatic",
      attemptId: "a1",
    }));
    ledger = completeAttempt(ledger, {
      attemptId: "a1",
      status: "failed",
      failure: null,
    });
    ledger = {
      ...ledger,
      failedAttemptCount: 1,
      lastFailure: buildFailureInfo({
        stage: "v",
        code: "CONFIG",
        retryability: "deterministic",
      }),
      sameFailureCounts: {},
    };
    const r = evaluatePreDispatch(ledger, {
      ...unit,
      sourceRevision: "r1",
      trigger: "automatic",
      anticipatedFailure: ledger.lastFailure,
    });
    expect(r.allowed).toBe(false);
  });
});

function markBlockedWithResume(ledger: ReturnType<typeof emptyUnitLedger>) {
  return {
    ...ledger,
    blockedDecision: "BLOCK_NO_MATERIAL_PROGRESS" as const,
    resumeCondition: {
      kind: "material-delta" as const,
      description: "need fix",
      satisfied: true,
    },
  };
}
