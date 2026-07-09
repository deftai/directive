import { describe, expect, it } from "vitest";
import { policyColonInvocation, policySetInvocation } from "./policy-invocation.js";

describe("policy-invocation", () => {
  it("formats colon policy verbs for consumer disclosures", () => {
    expect(policyColonInvocation("show")).toBe("deft policy:show");
    expect(policyColonInvocation("enable-value-feedback", " -- --confirm")).toBe(
      "deft policy:enable-value-feedback -- --confirm",
    );
  });

  it("formats policy-set verbs for consumer disclosures", () => {
    expect(policySetInvocation("wip-cap", " -- --set 5 --confirm")).toBe(
      "deft policy set wip-cap -- --set 5 --confirm",
    );
  });
});
