import { describe, expect, it } from "vitest";
import { evaluateAndPrepareBlock, evaluateInFlight, evaluatePreDispatch } from "./evaluate.js";
import { buildFailureInfo } from "./fingerprint.js";
import {
  beginAttempt,
  completeAttempt,
  emptyUnitLedger,
  MemoryLedgerStore,
  markBlocked,
  recordOperatorOverride,
} from "./ledger.js";
import type { DeliveryUnitLedger, FailureInfo, MaterialDeltaClaim } from "./types.js";

const unit = { scopeId: "scope-1", targetId: "target-1", workflowId: "wf-delivery" };

function baseInput(
  overrides: Partial<Parameters<typeof evaluatePreDispatch>[1]> = {},
): Parameters<typeof evaluatePreDispatch>[1] {
  return {
    ...unit,
    sourceRevision: "rev-1",
    trigger: "automatic",
    ...overrides,
  };
}

function failDeterministic(resourceClass = "config"): FailureInfo {
  return buildFailureInfo({
    stage: "validate",
    code: "CONFIG_INVALID",
    retryability: "deterministic",
    resourceClass,
    message: "schema field missing",
  });
}

function failTransient(): FailureInfo {
  return buildFailureInfo({
    stage: "fetch",
    code: "ETIMEDOUT",
    retryability: "transient",
    resourceClass: "network",
  });
}

function failUnknown(n = 1): FailureInfo {
  return buildFailureInfo({
    stage: "review",
    code: `WEIRD_${n}`,
    retryability: "unknown",
    resourceClass: "review",
    message: "unexpected outcome",
  });
}

function withFailed(
  ledger: DeliveryUnitLedger,
  failure: FailureInfo,
  rev = "rev-1",
  attemptId = "a1",
): DeliveryUnitLedger {
  let L = ledger;
  ({ ledger: L } = beginAttempt(L, {
    sourceRevision: rev,
    trigger: "automatic",
    attemptId,
  }));
  return completeAttempt(L, {
    attemptId,
    status: "failed",
    failure,
    elapsedSeconds: 5,
    toolCallCount: 2,
  });
}

describe("evaluatePreDispatch regression suite (#3143)", () => {
  // 1. Duplicate active run
  it("1. denies manual dispatch while automatic run is queued/running", () => {
    let ledger = emptyUnitLedger(unit);
    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "rev-1",
      trigger: "automatic",
      status: "queued",
      attemptId: "auto-1",
    }));
    const r = evaluatePreDispatch(
      ledger,
      baseInput({ trigger: "manual", sourceRevision: "rev-1" }),
    );
    expect(r.decision).toBe("DENY_DUPLICATE_ACTIVE");
    expect(r.allowed).toBe(false);
  });

  // 2. Same revision, same deterministic failure
  it("2. blocks second automatic attempt without material delta", () => {
    const failure = failDeterministic();
    let ledger = emptyUnitLedger(unit);
    ledger = withFailed(ledger, failure, "rev-1", "a1");
    const r = evaluatePreDispatch(
      ledger,
      baseInput({
        sourceRevision: "rev-1",
        anticipatedFailure: failure,
      }),
    );
    expect(r.allowed).toBe(false);
    expect(["BLOCK_NO_MATERIAL_PROGRESS", "BLOCK_NON_RETRYABLE"]).toContain(r.decision);
    expect(r.handoff).not.toBeNull();
  });

  // 3. New revision, same failure — counter carries forward
  it("3. carries sameFailureCount across revisions and still exhausts", () => {
    const failure = failDeterministic("config");
    let ledger = emptyUnitLedger(unit);
    ledger = withFailed(ledger, failure, "rev-1", "a1");
    expect(ledger.sameFailureCounts[failure.fingerprint]).toBe(1);

    // Second failure on new revision (same fingerprint) — no leftover override quota
    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "rev-2",
      trigger: "automatic",
      attemptId: "a2",
    }));
    ledger = completeAttempt(ledger, {
      attemptId: "a2",
      status: "failed",
      failure,
      elapsedSeconds: 5,
      toolCallCount: 1,
    });
    expect(ledger.sameFailureCounts[failure.fingerprint]).toBe(2);
    expect(ledger.override).toBeNull();

    const r = evaluatePreDispatch(
      ledger,
      baseInput({
        sourceRevision: "rev-3",
        anticipatedFailure: failure,
        materialDelta: [
          {
            kind: "unrelated",
            addresses: ["docs"],
            sourceRevision: "rev-3",
          },
        ],
      }),
    );
    expect(r.allowed).toBe(false);
    expect(r.event.sameFailureCount).toBe(2);
  });

  // 4. Relevant corrective delta
  it("4. allows one new attempt when delta addresses failing invariant", () => {
    const failure = failDeterministic("config");
    let ledger = emptyUnitLedger(unit);
    ledger = withFailed(ledger, failure, "rev-1", "a1");
    const delta: MaterialDeltaClaim[] = [
      {
        kind: "configuration",
        addresses: ["config"],
        sourceRevision: "rev-2",
        note: "fixed schema field",
      },
    ];
    const r = evaluatePreDispatch(
      ledger,
      baseInput({
        sourceRevision: "rev-2",
        anticipatedFailure: failure,
        materialDelta: delta,
      }),
    );
    expect(r.decision).toBe("ALLOW_MATERIAL_PROGRESS");
    expect(r.allowed).toBe(true);
  });

  // 5. Unrelated revision churn
  it("5. unrelated change does not reset failure budget", () => {
    const failure = failDeterministic("config");
    let ledger = emptyUnitLedger(unit);
    ledger = withFailed(ledger, failure, "rev-1", "a1");
    const r = evaluatePreDispatch(
      ledger,
      baseInput({
        sourceRevision: "rev-2",
        anticipatedFailure: failure,
        materialDelta: [
          {
            kind: "unrelated",
            addresses: ["readme"],
            sourceRevision: "rev-2",
          },
        ],
      }),
    );
    expect(r.allowed).toBe(false);
    expect(r.event.materialDeltaClassification).toBe("unrelated");
  });

  // 6. Transient recovery
  it("6. allows one bounded transient retry then succeeds and closes", () => {
    const failure = failTransient();
    let ledger = emptyUnitLedger(unit);
    ledger = withFailed(ledger, failure, "rev-1", "a1");

    const r1 = evaluatePreDispatch(
      ledger,
      baseInput({ anticipatedFailure: failure, trigger: "retry" }),
    );
    expect(r1.decision).toBe("ALLOW_TRANSIENT_RETRY");
    expect(r1.allowed).toBe(true);

    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "rev-1",
      trigger: "retry",
      attemptId: "a2",
    }));
    ledger = completeAttempt(ledger, {
      attemptId: "a2",
      status: "succeeded",
      elapsedSeconds: 2,
      toolCallCount: 1,
    });
    expect(ledger.failedAttemptCount).toBe(1);
    expect(ledger.lastFailure).toBeNull();
    // Success closes the failure identity — next dispatch is a fresh first path
    const r2 = evaluatePreDispatch(ledger, baseInput({ trigger: "automatic" }));
    expect(r2.decision).toBe("ALLOW_FIRST_ATTEMPT");
    expect(r2.allowed).toBe(true);

    // Exhaustion path: two transient failures (initial + retry) then block
    let exhausted = emptyUnitLedger(unit);
    exhausted = withFailed(exhausted, failure, "rev-1", "t1");
    ({ ledger: exhausted } = beginAttempt(exhausted, {
      sourceRevision: "rev-1",
      trigger: "retry",
      attemptId: "t2",
    }));
    exhausted = completeAttempt(exhausted, {
      attemptId: "t2",
      status: "failed",
      failure,
    });
    const r3 = evaluatePreDispatch(
      exhausted,
      baseInput({ anticipatedFailure: failure, trigger: "retry" }),
    );
    expect(r3.allowed).toBe(false);
  });

  // 7. Repeated unknown
  it("7. blocks at configured identical-unknown threshold", () => {
    // Same fingerprint for both unknowns
    const failure = failUnknown(1);
    let ledger = emptyUnitLedger(unit);
    ledger = withFailed(ledger, failure, "rev-1", "a1");
    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "rev-1",
      trigger: "retry",
      attemptId: "a2",
    }));
    ledger = completeAttempt(ledger, {
      attemptId: "a2",
      status: "failed",
      failure,
      elapsedSeconds: 1,
      toolCallCount: 1,
    });
    expect(ledger.sameFailureCounts[failure.fingerprint]).toBe(2);

    const r = evaluatePreDispatch(ledger, baseInput({ anticipatedFailure: failure }));
    expect(r.decision).toBe("BLOCK_REPEATED_UNKNOWN");
    expect(r.handoff).not.toBeNull();
    expect(r.handoff?.sameFailureCount).toBe(2);
  });

  // 8. Adjacent downstream failure / stage advancement
  it("8. stage advancement is material progress without erasing aggregate phase budget", () => {
    const failure = failDeterministic("config");
    let ledger = emptyUnitLedger(unit);
    ledger = withFailed(ledger, failure, "rev-1", "a1");
    expect(ledger.failedAttemptCount).toBe(1);

    const r = evaluatePreDispatch(
      ledger,
      baseInput({
        sourceRevision: "rev-2",
        anticipatedFailure: failure,
        materialDelta: [
          {
            kind: "stage",
            addresses: ["validate"],
            sourceRevision: "rev-2",
            note: "advanced past validate to deploy",
          },
        ],
      }),
    );
    expect(r.decision).toBe("ALLOW_MATERIAL_PROGRESS");
    // Aggregate counter still 1 on ledger
    expect(ledger.failedAttemptCount).toBe(1);
  });

  // 9. Worker takeover
  it("9. successor cannot restart an exhausted loop", () => {
    const failure = failDeterministic();
    const store = new MemoryLedgerStore();
    let ledger = store.getOrCreate(unit);
    // Exhaust with 3 failures via overrides/begins
    for (let i = 1; i <= 3; i++) {
      ({ ledger } = beginAttempt(ledger, {
        sourceRevision: `rev-${i}`,
        trigger: i === 1 ? "automatic" : "override",
        attemptId: `a${i}`,
        workerId: "worker-a",
        // Override-authorized dispatches must set consumeOverride so quota is spent.
        consumeOverride: i > 1,
      }));
      ledger = completeAttempt(ledger, {
        attemptId: `a${i}`,
        status: "failed",
        failure,
      });
      if (i < 3) {
        ledger = recordOperatorOverride(ledger, {
          actor: "op",
          rationale: "force next",
          allowedAttempts: 1,
        });
      }
    }
    store.set(ledger);
    expect(ledger.failedAttemptCount).toBe(3);

    // Successor
    const successor = store.get(unit.scopeId, unit.targetId, unit.workflowId);
    expect(successor).not.toBeNull();
    if (successor === null) throw new Error("expected successor ledger");
    const r = evaluatePreDispatch(
      successor,
      baseInput({
        sourceRevision: "rev-99",
        anticipatedFailure: failure,
        materialDelta: [],
      }),
    );
    expect(r.allowed).toBe(false);
    expect(r.decision).toBe("BLOCK_ATTEMPT_BUDGET");
  });

  // 10. Session compaction/restart — counters intact (covered in ledger.test + here)
  it("10. blocked resume condition remains after simulated reload", () => {
    const failure = failDeterministic();
    let ledger = emptyUnitLedger(unit);
    ledger = withFailed(ledger, failure);
    const { evaluation, ledger: blocked } = evaluateAndPrepareBlock(
      ledger,
      baseInput({ anticipatedFailure: failure }),
    );
    expect(evaluation.allowed).toBe(false);
    expect(blocked.blockedDecision).not.toBeNull();
    expect(blocked.resumeCondition?.satisfied).toBe(false);

    // Simulated JSON round-trip
    const reloaded = JSON.parse(JSON.stringify(blocked)) as DeliveryUnitLedger;
    const r2 = evaluatePreDispatch(reloaded, baseInput({ anticipatedFailure: failure }));
    expect(r2.allowed).toBe(false);
  });

  // 11. Interrupted external run — see ledger.test; gate still sees single failure
  it("11. single terminal state after interrupted-run reconciliation", () => {
    const failure = failUnknown();
    let ledger = emptyUnitLedger(unit);
    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "rev-1",
      trigger: "automatic",
      attemptId: "a1",
      externalRunId: "ext-1",
    }));
    ledger = completeAttempt(ledger, {
      externalRunId: "ext-1",
      status: "failed",
      failure,
    });
    ledger = completeAttempt(ledger, {
      externalRunId: "ext-1",
      status: "failed",
      failure,
    });
    expect(ledger.failedAttemptCount).toBe(1);
    expect(ledger.attempts.length).toBe(1);
  });

  // 12. Source-bound evidence
  it("12. evidence for intermediate revision is not valid for later revision", () => {
    const failure = buildFailureInfo({
      stage: "accept",
      code: "EVIDENCE",
      retryability: "deterministic",
      resourceClass: "evidence",
    });
    let ledger = emptyUnitLedger(unit);
    ledger = withFailed(ledger, failure, "rev-1", "a1");
    const r = evaluatePreDispatch(
      ledger,
      baseInput({
        sourceRevision: "rev-3",
        anticipatedFailure: failure,
        materialDelta: [
          {
            kind: "evidence",
            addresses: ["evidence"],
            sourceRevision: "rev-2", // intermediate — not evaluated rev
            note: "stale evidence",
          },
        ],
      }),
    );
    expect(r.allowed).toBe(false);
  });

  // 13. Telemetry unavailable — still enforce elapsed/tool budgets
  it("13. missing host token counts still trigger elapsed/tool-call limits", () => {
    const failure = failTransient();
    let ledger = emptyUnitLedger(unit);
    // Manually inflate elapsed without tokens
    ledger = {
      ...ledger,
      totalElapsedSeconds: 4000,
      totalToolCallCount: 10,
      totalHostTokenCount: null,
      lastFailure: failure,
      failedAttemptCount: 0,
    };
    const r = evaluatePreDispatch(
      ledger,
      baseInput({
        anticipatedFailure: failure,
        usage: { hostTokenCount: null },
        policy: { maxElapsedSeconds: 3600, maxHostTokens: 100 },
      }),
    );
    expect(r.decision).toBe("BLOCK_ELAPSED_BUDGET");
    expect(r.allowed).toBe(false);

    let ledger2 = emptyUnitLedger(unit);
    ledger2 = {
      ...ledger2,
      totalElapsedSeconds: 10,
      totalToolCallCount: 600,
      totalHostTokenCount: null,
    };
    const r2 = evaluatePreDispatch(
      ledger2,
      baseInput({
        policy: { maxToolCalls: 500, maxHostTokens: 50 },
      }),
    );
    expect(r2.decision).toBe("BLOCK_TOOL_OR_TOKEN_BUDGET");
  });

  it("override cannot bypass DENY_DUPLICATE_ACTIVE even when a budget would block", () => {
    const failure = failDeterministic();
    let ledger = emptyUnitLedger(unit);
    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "rev-1",
      trigger: "automatic",
      attemptId: "a1",
    }));
    // Active attempt still running + elapsed budget exhausted + usable override
    ledger = {
      ...ledger,
      totalElapsedSeconds: 10_000,
      lastFailure: failure,
    };
    ledger = recordOperatorOverride(ledger, {
      actor: "scott",
      rationale: "should not open a second active",
      allowedAttempts: 1,
    });
    const r = evaluatePreDispatch(
      ledger,
      baseInput({
        trigger: "override",
        anticipatedFailure: failure,
        policy: { maxElapsedSeconds: 100 },
      }),
    );
    expect(r.decision).toBe("DENY_DUPLICATE_ACTIVE");
    expect(r.allowed).toBe(false);
  });

  // 14. Override audit
  it("14. bounded operator override permits only declared next attempts and preserves history", () => {
    const failure = failDeterministic();
    let ledger = emptyUnitLedger(unit);
    ledger = withFailed(ledger, failure, "rev-1", "a1");
    ledger = markBlocked(ledger, "BLOCK_NO_MATERIAL_PROGRESS", {
      kind: "material-delta",
      description: "need fix",
      satisfied: false,
    });
    ledger = recordOperatorOverride(ledger, {
      actor: "scott",
      rationale: "temporary env waiver",
      allowedAttempts: 1,
    });
    expect(ledger.attempts.length).toBe(1);

    const r = evaluatePreDispatch(
      ledger,
      baseInput({
        trigger: "override",
        anticipatedFailure: failure,
      }),
    );
    expect(r.decision).toBe("ALLOW_OVERRIDE");
    expect(r.allowed).toBe(true);

    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "rev-2",
      trigger: "override",
      attemptId: "a2",
      consumeOverride: true,
    }));
    expect(ledger.override?.remainingAttempts).toBe(0);
    expect(ledger.attempts.length).toBe(2);

    ledger = completeAttempt(ledger, {
      attemptId: "a2",
      status: "failed",
      failure,
    });
    // No remaining override
    const r2 = evaluatePreDispatch(
      ledger,
      baseInput({
        trigger: "automatic",
        anticipatedFailure: failure,
      }),
    );
    expect(r2.allowed).toBe(false);
    // History preserved
    expect(ledger.attempts.length).toBe(2);
  });

  it("allows first attempt on empty ledger", () => {
    const ledger = emptyUnitLedger(unit);
    const r = evaluatePreDispatch(ledger, baseInput());
    expect(r.decision).toBe("ALLOW_FIRST_ATTEMPT");
    expect(r.allowed).toBe(true);
    expect(r.nextAttemptId).not.toBeNull();
  });

  it("emits structured decision events for observability", () => {
    const ledger = emptyUnitLedger(unit);
    const r = evaluatePreDispatch(ledger, baseInput());
    expect(r.event.decision).toBe("allow");
    expect(r.event.reasonCode).toBe("ALLOW_FIRST_ATTEMPT");
    expect(r.event.scopeId).toBe(unit.scopeId);
  });
});

describe("evaluateInFlight (#3983)", () => {
  it("allows a running attempt under maxElapsedSeconds", () => {
    let ledger = emptyUnitLedger(unit);
    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "rev-1",
      trigger: "automatic",
      attemptId: "live-1",
      now: "2026-08-30T00:00:00.000Z",
    }));
    const r = evaluateInFlight(ledger, {
      now: "2026-08-30T00:10:00.000Z",
      policy: { maxElapsedSeconds: 3600 },
    });
    expect(r.allowed).toBe(true);
    expect(r.decision).toBe("ALLOW_RESUME");
  });
  it("blocks a running attempt that has exhausted maxElapsedSeconds", () => {
    let ledger = emptyUnitLedger(unit);
    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "rev-1",
      trigger: "automatic",
      attemptId: "live-2",
      now: "2026-08-30T00:00:00.000Z",
    }));
    const r = evaluateInFlight(ledger, {
      now: "2026-08-30T02:00:00.000Z",
      policy: { maxElapsedSeconds: 3600 },
    });
    expect(r.allowed).toBe(false);
    expect(r.decision).toBe("BLOCK_ELAPSED_BUDGET");
    expect(r.handoff).not.toBeNull();
  });
  it("allows when no attempt is in flight", () => {
    const ledger = emptyUnitLedger(unit);
    const r = evaluateInFlight(ledger, { now: "2026-08-30T00:00:00.000Z" });
    expect(r.allowed).toBe(true);
    expect(r.decision).toBe("ALLOW_FIRST_ATTEMPT");
  });
});
