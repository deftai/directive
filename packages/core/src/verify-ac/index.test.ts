import { describe, expect, it } from "vitest";
import {
  emitVerifyAcAttempts,
  evaluateProductOracleIntegrity,
  flagPassAfterFailFromJsonl,
  mergeOracleVerdict,
} from "./index.js";

describe("verify-ac public exports (#3322)", () => {
  it("re-exports the detector and evaluate helpers", () => {
    expect(typeof flagPassAfterFailFromJsonl).toBe("function");
    expect(typeof evaluateProductOracleIntegrity).toBe("function");
    expect(typeof mergeOracleVerdict).toBe("function");
    expect(typeof emitVerifyAcAttempts).toBe("function");
  });
});
