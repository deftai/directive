import { describe, expect, it } from "vitest";
import {
  bindClausesToDeclaredScope,
  commandCountFromFingerprint,
  deriveAcceptanceClauses,
  emitVerifyAcAttempts,
  evaluateProductOracleIntegrity,
  flagPassAfterFailFromJsonl,
  mergeOracleVerdict,
  methodFingerprintForWalk,
  stampDerivedClausesOnAcceptance,
  VERIFY_AC_CHECK_ID_PREFIX,
  verifyAcCheckId,
  walkAcceptanceClauses,
} from "./index.js";

describe("verify-ac public exports (#3322 / #3323 / #3337)", () => {
  it("re-exports the detector, evaluate, and clause helpers", () => {
    expect(typeof flagPassAfterFailFromJsonl).toBe("function");
    expect(typeof evaluateProductOracleIntegrity).toBe("function");
    expect(typeof mergeOracleVerdict).toBe("function");
    expect(typeof emitVerifyAcAttempts).toBe("function");
    expect(typeof methodFingerprintForWalk).toBe("function");
    expect(typeof commandCountFromFingerprint).toBe("function");
    expect(typeof deriveAcceptanceClauses).toBe("function");
    expect(typeof bindClausesToDeclaredScope).toBe("function");
    expect(typeof walkAcceptanceClauses).toBe("function");
    expect(typeof stampDerivedClausesOnAcceptance).toBe("function");
    expect(typeof verifyAcCheckId).toBe("function");
    expect(VERIFY_AC_CHECK_ID_PREFIX).toBe("verify:ac");
  });
});
