import { describe, expect, it } from "vitest";
import {
  FACT_KINDS,
  INTENT_CONSTRAINT_PLAN_KEY,
  INTENT_CONSTRAINT_RECORD_SCHEMA,
  INTENT_CONSTRAINT_REMEDIATION,
  REJECTION_SCOPES,
} from "./types.js";

describe("intent-constraint constants (#4541)", () => {
  it("keeps the namespaced plan key and closed fact kinds", () => {
    expect(INTENT_CONSTRAINT_PLAN_KEY).toBe("x-directive/intentConstraint");
    expect(INTENT_CONSTRAINT_RECORD_SCHEMA).toBe("deft.intent-constraint.v1");
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(
      /Tests and in-scope file paths are not authority/,
    );
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(/in-harness ask|parent chat/);
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(/rewrite or park/);
    expect(INTENT_CONSTRAINT_REMEDIATION).toContain("scope:record-intent-constraint");
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(/legacy repair only/);
    expect(FACT_KINDS).toEqual(["throw-site", "reject-site", "abort-site", "numeric-const"]);
    expect(REJECTION_SCOPES).toEqual(["item", "invocation", "operation"]);
  });
});
