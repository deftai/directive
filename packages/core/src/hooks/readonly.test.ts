import { describe, expect, it } from "vitest";
import {
  hookReadOnlyFromPayload,
  isEphemeralSpawn,
  isExploreSpawn,
  isReadOnlyHookContext,
} from "./readonly.js";
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

describe("ephemeral spawn detection (#3080)", () => {
  it("recognizes worker_role ephemeral and aliases docs/assist", () => {
    expect(isEphemeralSpawn({ tool_input: { worker_role: "ephemeral" } })).toBe(true);
    expect(isEphemeralSpawn({ tool_input: { worker_role: "docs" } })).toBe(true);
    expect(isEphemeralSpawn({ workerRole: "assist" })).toBe(true);
    expect(isEphemeralSpawn({ tool_input: { workerRole: "EPHEMERAL" } })).toBe(true);
  });

  it("recognizes subagent_type ephemeral aliases", () => {
    expect(isEphemeralSpawn({ tool_input: { subagent_type: "ephemeral" } })).toBe(true);
    expect(isEphemeralSpawn({ subagentType: "docs" })).toBe(true);
    expect(isEphemeralSpawn({ tool_input: { subagent_type: "assist" } })).toBe(true);
  });

  it("fails closed on unmarked / generalPurpose (ambiguous → implement)", () => {
    expect(isEphemeralSpawn({ tool_input: { subagent_type: "generalPurpose" } })).toBe(false);
    expect(isEphemeralSpawn({ tool_input: { prompt: "write a brochure" } })).toBe(false);
    expect(isEphemeralSpawn(null)).toBe(false);
    expect(isEphemeralSpawn({ tool_input: { worker_role: "leaf-implementation" } })).toBe(false);
  });

  it("implement signals win over ephemeral markers (fail closed)", () => {
    expect(
      isEphemeralSpawn({
        tool_input: {
          worker_role: "ephemeral",
          drive_to: "merge-ready",
        },
      }),
    ).toBe(false);
    expect(
      isEphemeralSpawn({
        tool_input: {
          subagent_type: "docs",
          worker_role: "leaf-implementation",
        },
      }),
    ).toBe(false);
    expect(
      isEphemeralSpawn({
        tool_input: {
          worker_role: "assist",
          dispatch_kind: "swarm-cohort",
        },
      }),
    ).toBe(false);
    expect(
      isEphemeralSpawn({
        tool_input: { worker_role: "ephemeral", driveTo: "merge" },
      }),
    ).toBe(false);
  });
});

describe("read-only payload shape edges (#2986)", () => {
  it("reads capability from tool_call.arguments and nested booleans", () => {
    expect(hookReadOnlyFromPayload(null)).toBe(false);
    expect(hookReadOnlyFromPayload("string")).toBe(false);
    expect(
      hookReadOnlyFromPayload({
        tool_call: { arguments: { capability_mode: "read only" } },
      }),
    ).toBe(true);
    expect(
      hookReadOnlyFromPayload({
        toolCall: { arguments: { defaultCapabilityMode: "read-only" } },
      }),
    ).toBe(true);
    expect(
      hookReadOnlyFromPayload({
        tool_input: { posture: "read_only" },
      }),
    ).toBe(true);
    expect(
      hookReadOnlyFromPayload({
        session_posture: "read-only",
      }),
    ).toBe(true);
    expect(
      hookReadOnlyFromPayload({
        sessionPosture: "read-only",
      }),
    ).toBe(true);
    expect(hookReadOnlyFromPayload({ tool_input: { read_only: true } })).toBe(true);
    expect(hookReadOnlyFromPayload({ toolInput: { readOnly: true } })).toBe(true);
    expect(hookReadOnlyFromPayload({ read_only: true })).toBe(true);
    // Empty / non-readonly capability strings stay false.
    expect(hookReadOnlyFromPayload({ capability_mode: "  " })).toBe(false);
    expect(hookReadOnlyFromPayload({ capabilityMode: "readonly" })).toBe(true);
    // Env truthy variants.
    expect(isReadOnlyHookContext({}, { [READ_ONLY_HOOK_ENV]: "true" })).toBe(true);
    expect(isReadOnlyHookContext({}, { [READ_ONLY_HOOK_ENV]: "yes" })).toBe(true);
    expect(isReadOnlyHookContext({}, { [READ_ONLY_HOOK_ENV]: "on" })).toBe(true);
    expect(isReadOnlyHookContext({}, { [READ_ONLY_HOOK_ENV]: "0" })).toBe(false);
    // explore via workerRole camelCase and non-object payload.
    expect(isExploreSpawn({ workerRole: "explore" })).toBe(true);
    expect(isExploreSpawn(null)).toBe(false);
    expect(isExploreSpawn({ tool_input: { workerRole: "explore" } })).toBe(true);
  });
});
