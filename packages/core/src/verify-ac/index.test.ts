import { describe, expect, it } from "vitest";
import {
  deriveAcceptanceClauses,
  emitVerifyAcAttempts,
  evaluateProductOracleIntegrity,
  flagPassAfterFailFromJsonl,
  mergeOracleVerdict,
  stampDerivedClausesOnAcceptance,
  walkAcceptanceClauses,
} from "./index.js";

describe("verify-ac public exports (#3322 / #3323)", () => {
  it("re-exports the detector, evaluate, and clause helpers", () => {
    expect(typeof flagPassAfterFailFromJsonl).toBe("function");
    expect(typeof evaluateProductOracleIntegrity).toBe("function");
    expect(typeof mergeOracleVerdict).toBe("function");
    expect(typeof emitVerifyAcAttempts).toBe("function");
    expect(typeof deriveAcceptanceClauses).toBe("function");
    expect(typeof walkAcceptanceClauses).toBe("function");
    expect(typeof stampDerivedClausesOnAcceptance).toBe("function");
  });
});
