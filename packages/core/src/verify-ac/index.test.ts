import { describe, expect, it } from "vitest";
import {
  bindClausesToDeclaredScope,
  collectBriefLandInventoryAsPrDiffPaths,
  commandCountFromFingerprint,
  deriveAcceptanceClauses,
  emitVerifyAcAttempts,
  evaluatePathBActivationAcDisposition,
  evaluateProductOracleIntegrity,
  flagPassAfterFailFromJsonl,
  isPathBActivationAcDispositionText,
  mergeOracleVerdict,
  methodFingerprintForWalk,
  PATH_B_ACTIVATION_AC_DISPOSITION,
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

  it("re-exports Path B activation disposition helpers (#5792)", () => {
    expect(typeof collectBriefLandInventoryAsPrDiffPaths).toBe("function");
    expect(typeof evaluatePathBActivationAcDisposition).toBe("function");
    expect(typeof isPathBActivationAcDispositionText).toBe("function");
    expect(PATH_B_ACTIVATION_AC_DISPOSITION).toBe("path_b_activation_deferred");
  });
});
