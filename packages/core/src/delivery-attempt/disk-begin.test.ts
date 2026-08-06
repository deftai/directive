import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { beginAttemptOnDisk } from "./disk-begin.js";
import { buildFailureInfo } from "./fingerprint.js";
import { beginAttempt, completeAttempt, emptyUnitLedger, saveUnitLedger } from "./ledger.js";

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

describe("beginAttemptOnDisk (#3143)", () => {
  it("re-evaluates under lock and refuses blocked unit", () => {
    const root = mkdtempSync(join(tmpdir(), "da-disk-"));
    temps.push(root);
    const failure = buildFailureInfo({
      stage: "v",
      code: "CONFIG",
      retryability: "deterministic",
      resourceClass: "config",
    });
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
      failure,
    });
    saveUnitLedger(root, ledger);

    expect(() =>
      beginAttemptOnDisk(root, {
        scopeId: "s",
        targetId: "t",
        workflowId: "w",
        sourceRevision: "r2",
        trigger: "automatic",
        anticipatedFailure: failure,
      }),
    ).toThrow(/BLOCK_/);
  });
});
