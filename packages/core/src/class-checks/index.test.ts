import { describe, expect, it } from "vitest";
import * as classChecks from "./index.js";

describe("class-checks index surface (#4980)", () => {
  it("re-exports evaluate and policy APIs", () => {
    const policy = classChecks.defaultClassChecksPolicy();
    expect(policy.source).toBe("defaults");
    expect(policy.protectedGlobs).toContain("packages/core/src/authz/**");
    expect(classChecks.DEFAULT_TEST_MARKERS).toContain("smoke");
    const finding = classChecks.scanTestIdentityInInfra(
      "infra/main.bicep",
      "resource id 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = { name: 'smoke-test-identity' }\n",
      policy.testMarkers,
    );
    expect(finding?.kind).toBe("test-identity-in-infra");
  });
});
