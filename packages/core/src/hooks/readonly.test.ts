import { describe, expect, it } from "vitest";
import { hookReadOnlyFromPayload, isExploreSpawn, isReadOnlyHookContext } from "./readonly.js";
import { READ_ONLY_HOOK_ENV } from "./tools.js";

describe("read-only hook context (#1185)", () => {
  it("honors DEFT_HOOK_READ_ONLY env override", () => {
    expect(isReadOnlyHookContext({}, { [READ_ONLY_HOOK_ENV]: "1" })).toBe(true);
    expect(isReadOnlyHookContext({ tool_name: "Write" }, {})).toBe(false);
  });

  it("detects Grok-style capability_mode in payload", () => {
    expect(hookReadOnlyFromPayload({ capability_mode: "read-only" })).toBe(true);
    expect(hookReadOnlyFromPayload({ default_capability_mode: "read_only" })).toBe(true);
    expect(hookReadOnlyFromPayload({ tool_input: { capabilityMode: "read-only" } })).toBe(true);
    expect(hookReadOnlyFromPayload({ posture: "read-only" })).toBe(true);
    expect(hookReadOnlyFromPayload({ readOnly: true })).toBe(true);
  });

  it("does not treat mutation posture as read-only", () => {
    expect(hookReadOnlyFromPayload({ posture: "mutation" })).toBe(false);
    expect(hookReadOnlyFromPayload({ capability_mode: "read-write" })).toBe(false);
  });
});

describe("explore spawn detection (#1185)", () => {
  it("recognizes explore subagent_type", () => {
    expect(isExploreSpawn({ tool_input: { subagent_type: "explore" } })).toBe(true);
    expect(isExploreSpawn({ subagentType: "explore" })).toBe(true);
    expect(isExploreSpawn({ tool_input: { subagent_type: "generalPurpose" } })).toBe(false);
  });

  it("recognizes explore worker_role", () => {
    expect(isExploreSpawn({ tool_input: { worker_role: "explore" } })).toBe(true);
    expect(isExploreSpawn({ workerRole: "leaf-implementation" })).toBe(false);
  });
});
