import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateAndPrepareBlock, evaluatePreDispatch } from "./evaluate.js";
import { buildFailureInfo, inferRetryability } from "./fingerprint.js";
import {
  buildTerminalHandoff,
  defaultResumeFor,
  formatHandoffReport,
  nextSafeActionFor,
} from "./handoff.js";
import {
  beginAttempt,
  clearBlockIfResumed,
  completeAttempt,
  emptyUnitLedger,
  hasActiveAttempt,
  listUnitLedgers,
  loadOrCreateUnitLedger,
  loadUnitLedger,
  markBlocked,
  parseUnitLedger,
  recordOperatorOverride,
  saveUnitLedger,
  unitLedgerPath,
} from "./ledger.js";
import { evaluateMaterialProgress } from "./material-delta.js";
import { utcIso } from "./types.js";

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
  const d = mkdtempSync(join(tmpdir(), "da-cov-"));
  temps.push(d);
  return d;
}

const unit = { scopeId: "cov-s", targetId: "cov-t", workflowId: "cov-w" };

describe("delivery-attempt coverage boost (#3143)", () => {
  it("blocks token budget when telemetry and policy maxHostTokens are set", () => {
    let ledger = emptyUnitLedger(unit);
    ledger = {
      ...ledger,
      totalHostTokenCount: 90,
      totalElapsedSeconds: 1,
      totalToolCallCount: 1,
    };
    const r = evaluatePreDispatch(ledger, {
      ...unit,
      sourceRevision: "r1",
      trigger: "automatic",
      usage: { hostTokenCount: 20 },
      policy: { maxHostTokens: 100 },
    });
    expect(r.decision).toBe("BLOCK_TOOL_OR_TOKEN_BUDGET");
  });

  it("allows resume when resumeCondition is satisfied", () => {
    let ledger = emptyUnitLedger(unit);
    ledger = markBlocked(ledger, "BLOCK_NO_MATERIAL_PROGRESS", {
      kind: "material-delta",
      description: "need fix",
      satisfied: true,
    });
    const r = evaluatePreDispatch(ledger, {
      ...unit,
      sourceRevision: "r2",
      trigger: "resume",
    });
    expect(r.decision).toBe("ALLOW_RESUME");
  });

  it("returns prior blocked decision when still blocked without progress", () => {
    let ledger = emptyUnitLedger(unit);
    const failure = buildFailureInfo({
      stage: "x",
      code: "CONFIG",
      retryability: "deterministic",
      resourceClass: "config",
    });
    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "r1",
      trigger: "automatic",
      attemptId: "a1",
    }));
    ledger = completeAttempt(ledger, {
      attemptId: "a1",
      status: "failed",
      failure,
    });
    const prepared = evaluateAndPrepareBlock(ledger, {
      ...unit,
      sourceRevision: "r1",
      trigger: "automatic",
      anticipatedFailure: failure,
    });
    expect(prepared.evaluation.allowed).toBe(false);
    const again = evaluatePreDispatch(prepared.ledger, {
      ...unit,
      sourceRevision: "r1",
      trigger: "automatic",
      anticipatedFailure: failure,
    });
    expect(again.allowed).toBe(false);
  });

  it("allows material progress under attempt budget but blocks when exhausted", () => {
    const failure = buildFailureInfo({
      stage: "v",
      code: "CONFIG",
      retryability: "deterministic",
      resourceClass: "config",
    });
    let ledger = emptyUnitLedger(unit);
    for (let i = 1; i <= 3; i++) {
      ({ ledger } = beginAttempt(ledger, {
        sourceRevision: `r${i}`,
        trigger: "automatic",
        attemptId: `a${i}`,
      }));
      ledger = completeAttempt(ledger, {
        attemptId: `a${i}`,
        status: "failed",
        failure,
      });
    }
    const r = evaluatePreDispatch(ledger, {
      ...unit,
      sourceRevision: "r4",
      trigger: "automatic",
      anticipatedFailure: failure,
      materialDelta: [
        {
          kind: "stage",
          addresses: ["v"],
          sourceRevision: "r4",
        },
      ],
    });
    expect(r.decision).toBe("BLOCK_ATTEMPT_BUDGET");
  });

  it("covers handoff decision branches and default resume kinds", () => {
    const codes = [
      "DENY_DUPLICATE_ACTIVE",
      "BLOCK_NON_RETRYABLE",
      "BLOCK_NO_MATERIAL_PROGRESS",
      "BLOCK_REPEATED_UNKNOWN",
      "BLOCK_ATTEMPT_BUDGET",
      "BLOCK_ELAPSED_BUDGET",
      "BLOCK_TOOL_OR_TOKEN_BUDGET",
      "ALLOW_FIRST_ATTEMPT",
    ] as const;
    for (const c of codes) {
      expect(nextSafeActionFor(c).length).toBeGreaterThan(5);
      expect(defaultResumeFor(c).description.length).toBeGreaterThan(3);
    }
    const ledger = emptyUnitLedger(unit);
    const handoff = buildTerminalHandoff({
      ledger,
      decision: "BLOCK_ELAPSED_BUDGET",
    });
    expect(formatHandoffReport(handoff)).toContain("BLOCK_ELAPSED_BUDGET");
  });

  it("covers parseUnitLedger edge paths and list/load helpers", () => {
    expect(parseUnitLedger(null)).toBeNull();
    expect(parseUnitLedger({ scopeId: "s" })).toBeNull();
    expect(
      parseUnitLedger({
        scopeId: "s",
        targetId: "t",
        workflowId: "w",
        attempts: [{ bad: true }],
        sameFailureCounts: { fp: 2, bad: "x" },
        lastFailure: { stage: "a", fingerprint: "f", retryability: "nope" },
        lastMaterialDelta: [{ kind: "code" }],
        resumeCondition: { kind: "material-delta" },
        override: { overrideId: "o" },
      }),
    ).not.toBeNull();

    const root = tmpRoot();
    expect(listUnitLedgers(root)).toEqual([]);
    let ledger = loadOrCreateUnitLedger(root, unit);
    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "r1",
      trigger: "manual",
      status: "queued",
      attemptId: "q1",
    }));
    expect(hasActiveAttempt(ledger)).toBe(true);
    saveUnitLedger(root, ledger);
    expect(loadUnitLedger(root, unit.scopeId, unit.targetId, unit.workflowId)).not.toBeNull();
    expect(listUnitLedgers(root).length).toBe(1);
    expect(unitLedgerPath(root, unit.scopeId, unit.targetId, unit.workflowId)).toContain(".deft");

    // corrupt file skipped
    mkdirSync(join(root, ".deft", "delivery-attempts"), { recursive: true });
    writeFileSync(join(root, ".deft", "delivery-attempts", "junk.json"), "{not-json", "utf8");
    expect(listUnitLedgers(root).length).toBeGreaterThanOrEqual(1);
  });

  it("completeAttempt synthetic and cancelled paths; clearBlockIfResumed", () => {
    let ledger = emptyUnitLedger(unit);
    ledger = completeAttempt(ledger, {
      externalRunId: "orphan-run",
      status: "cancelled",
      elapsedSeconds: 1,
      toolCallCount: 1,
      hostTokenCount: 5,
    });
    expect(ledger.attempts.length).toBe(1);
    expect(ledger.totalHostTokenCount).toBe(5);

    ledger = markBlocked(ledger, "BLOCK_ATTEMPT_BUDGET", {
      kind: "operator-override",
      description: "x",
      satisfied: false,
    });
    expect(clearBlockIfResumed(ledger).blockedDecision).toBe("BLOCK_ATTEMPT_BUDGET");
    ledger = {
      ...ledger,
      resumeCondition: {
        kind: "operator-override",
        description: "x",
        satisfied: true,
      },
    };
    const cleared = clearBlockIfResumed(ledger);
    expect(cleared.blockedDecision).toBeNull();
  });

  it("material delta empty addresses and failure-null paths", () => {
    const noFail = evaluateMaterialProgress({
      claims: [{ kind: "code", addresses: ["mod"], sourceRevision: "r1" }],
      failure: null,
      evaluatedRevision: "r1",
    });
    expect(noFail.isMaterial).toBe(true);

    const emptyAddr = evaluateMaterialProgress({
      claims: [{ kind: "code", addresses: [], sourceRevision: "r1" }],
      failure: buildFailureInfo({ stage: "s", code: "c", retryability: "deterministic" }),
      evaluatedRevision: "r1",
    });
    expect(emptyAddr.isMaterial).toBe(false);

    const substring = evaluateMaterialProgress({
      claims: [
        {
          kind: "code",
          addresses: ["auth"],
          sourceRevision: "r1",
        },
      ],
      failure: buildFailureInfo({
        stage: "gate",
        code: "X",
        retryability: "deterministic",
        resourceClass: "auth.permission",
      }),
      evaluatedRevision: "r1",
    });
    expect(substring.isMaterial).toBe(true);
  });

  it("override trigger without remaining quota falls through", () => {
    let ledger = emptyUnitLedger(unit);
    ledger = recordOperatorOverride(ledger, {
      actor: "a",
      rationale: "r",
      allowedAttempts: 1,
    });
    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "r1",
      trigger: "override",
      attemptId: "a1",
    }));
    // remainingAttempts now 0
    expect(ledger.override?.remainingAttempts).toBe(0);
    const r = evaluatePreDispatch(ledger, {
      ...unit,
      sourceRevision: "r2",
      trigger: "override",
    });
    // active attempt exists → deny duplicate
    expect(r.decision).toBe("DENY_DUPLICATE_ACTIVE");
  });

  it("utcIso and inferRetryability edge cases", () => {
    expect(utcIso("2026-08-06T00:00:00Z")).toBe("2026-08-06T00:00:00Z");
    expect(inferRetryability("403_FORBIDDEN")).toBe("deterministic");
    expect(inferRetryability("503")).toBe("transient");
  });

  it("unknown path under threshold and attempt budget on unknown thrash", () => {
    const failure = buildFailureInfo({
      stage: "u",
      code: "WEIRD",
      retryability: "unknown",
    });
    let ledger = emptyUnitLedger(unit);
    ({ ledger } = beginAttempt(ledger, {
      sourceRevision: "r1",
      trigger: "automatic",
      attemptId: "a1",
    }));
    ledger = completeAttempt(ledger, {
      attemptId: "a1",
      status: "failed",
      failure,
    });
    const mid = evaluatePreDispatch(ledger, {
      ...unit,
      sourceRevision: "r1",
      trigger: "retry",
      anticipatedFailure: failure,
    });
    expect(mid.allowed).toBe(true);

    // Exhaust phase attempt budget with different fingerprints but unknown class
    for (let i = 2; i <= 3; i++) {
      const f = buildFailureInfo({
        stage: "u",
        code: `WEIRD_${i}`,
        retryability: "unknown",
      });
      ({ ledger } = beginAttempt(ledger, {
        sourceRevision: `r${i}`,
        trigger: "automatic",
        attemptId: `a${i}`,
      }));
      ledger = completeAttempt(ledger, {
        attemptId: `a${i}`,
        status: "failed",
        failure: f,
      });
    }
    const blocked = evaluatePreDispatch(ledger, {
      ...unit,
      sourceRevision: "r9",
      trigger: "automatic",
      anticipatedFailure: failure,
    });
    expect(blocked.allowed).toBe(false);
  });
});
