import { describe, expect, it } from "vitest";
import {
  OPERATOR_SCOPE_CEILING_ARTIFACT_REL,
  OPERATOR_SCOPE_CEILING_PLAN_KEY,
  OPERATOR_SCOPE_CEILING_SCHEMA,
  UNTRACEABLE_SURFACE_REMEDIATION,
} from "./types.js";

describe("types (#4545)", () => {
  it("exports stable schema and remediation constants", () => {
    expect(OPERATOR_SCOPE_CEILING_SCHEMA).toBe("deft.operator-scope-ceiling.v1");
    expect(OPERATOR_SCOPE_CEILING_PLAN_KEY).toContain("operatorScopeCeiling");
    expect(OPERATOR_SCOPE_CEILING_ARTIFACT_REL).toContain("operator-scope-ceiling.json");
    expect(UNTRACEABLE_SURFACE_REMEDIATION).toContain("remove, or add to the brief");
  });
});
