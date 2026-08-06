import { describe, expect, it } from "vitest";
import * as deliveryAttempt from "./index.js";

describe("delivery-attempt public surface (#3143)", () => {
  it("exports evaluatePreDispatch and ledger helpers", () => {
    expect(typeof deliveryAttempt.evaluatePreDispatch).toBe("function");
    expect(typeof deliveryAttempt.emptyUnitLedger).toBe("function");
    expect(typeof deliveryAttempt.beginAttempt).toBe("function");
    expect(typeof deliveryAttempt.completeAttempt).toBe("function");
    expect(typeof deliveryAttempt.buildFailureInfo).toBe("function");
    expect(typeof deliveryAttempt.buildTerminalHandoff).toBe("function");
    expect(typeof deliveryAttempt.evaluateMaterialProgress).toBe("function");
    expect(deliveryAttempt.DEFAULT_DELIVERY_BUDGET_POLICY.maxActiveAttempts).toBe(1);
  });
});
