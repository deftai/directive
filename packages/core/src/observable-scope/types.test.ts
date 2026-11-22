import { describe, expect, it } from "vitest";
import {
  OBSERVABLE_CHANGE_PLAN_KEY,
  OBSERVABLE_SCOPE_RECORD_SCHEMA,
  OBSERVABLE_SCOPE_REMEDIATION,
  OBSERVABLE_UI_ARTIFACT_SCHEMA,
  OBSERVABLE_UI_POLICY_REL,
  OBSERVABLE_UI_POLICY_SCHEMA,
  OBSERVABLE_UI_PROVIDER,
  STRUCTURE_KINDS,
} from "./types.js";

describe("observable-scope constants (#4495)", () => {
  it("keeps the namespaced plan key and parse5+typescript provider", () => {
    expect(OBSERVABLE_CHANGE_PLAN_KEY).toBe("x-directive/observableChange");
    expect(OBSERVABLE_UI_PROVIDER).toBe("parse5+typescript");
    expect(OBSERVABLE_UI_ARTIFACT_SCHEMA).toBe("deft.observable-ui.v1");
    expect(OBSERVABLE_SCOPE_RECORD_SCHEMA).toBe("deft.observable-scope.v1");
    expect(OBSERVABLE_UI_POLICY_SCHEMA).toBe("deft.observable-ui.policy.v1");
    expect(OBSERVABLE_UI_POLICY_REL).toBe(".deft/observable-ui.policy.json");
    // #7031: write the declaration and land it before the UI-change PR.
    expect(OBSERVABLE_SCOPE_REMEDIATION).toMatch(/write the declaration/);
    expect(OBSERVABLE_SCOPE_REMEDIATION).toMatch(/before the UI-change PR/);
    expect(OBSERVABLE_SCOPE_REMEDIATION).toMatch(/A declaration is not consent/);
    expect(OBSERVABLE_SCOPE_REMEDIATION).not.toMatch(/real TTY|agent\/CI shells still refuse/);
    expect(OBSERVABLE_SCOPE_REMEDIATION).toMatch(
      /delivery-branch merge base|rebase the implementation branch/,
    );
    expect(OBSERVABLE_SCOPE_REMEDIATION).toContain("scope:record-observable-scope");
    expect(STRUCTURE_KINDS).toEqual([
      "tab",
      "tab-selected",
      "heading",
      "control",
      "table-column",
      "landmark",
      "container",
    ]);
  });
});
