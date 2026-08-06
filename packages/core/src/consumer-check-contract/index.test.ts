import { describe, expect, it } from "vitest";
import * as ccc from "./index.js";

describe("consumer-check-contract index surface (#3145)", () => {
  it("re-exports evaluate API and required gates", () => {
    expect(typeof ccc.evaluateConsumerCheckContract).toBe("function");
    expect(ccc.REQUIRED_CONSUMER_ENFORCEMENT_GATES).toContain("verify:test-boundary");
    expect(typeof ccc.textReferencesGate).toBe("function");
  });
});
