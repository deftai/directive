import { describe, expect, it } from "vitest";
import {
  canClaimPass,
  detectRemoteClaims,
  type HandoffEvidence,
  validateHandoffEvidence,
} from "./index.js";

describe("handoff-evidence barrel (#3120)", () => {
  it("re-exports validateHandoffEvidence and rejects invented-done", () => {
    const evidence: HandoffEvidence = {
      status: "pass",
      pr_number: 1,
      work: { state: "done" },
      ship: { state: "done" },
    };
    const result = validateHandoffEvidence(evidence);
    expect(result.ok).toBe(false);
    expect(result.failClass).toBe("invented-done");
    expect(detectRemoteClaims(evidence)).toContain("pr_number");
    expect(canClaimPass(evidence)).toBe(false);
  });

  it("re-exports accept path for legal partial", () => {
    expect(
      validateHandoffEvidence({
        status: "partial",
        proof_status: "n/a-no-remote-claim",
        work: { state: "done" },
        ship: { state: "not_started" },
      }).ok,
    ).toBe(true);
  });
});
