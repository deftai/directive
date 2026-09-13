import { describe, expect, it } from "vitest";
import {
  fieldPresent,
  fieldString,
  firstString,
  hookPayloadEnvironBag,
  hookPayloadTopLevelKeys,
  landProcessOnlyFlagOnToolInput,
  mergeHookDispatchEnviron,
  record,
  toolInputRecord,
} from "./payload.js";

describe("payload helpers (#2950)", () => {
  it("record rejects null/array", () => {
    expect(record(null)).toBeNull();
    expect(record([])).toBeNull();
    expect(record({ a: 1 })).toEqual({ a: 1 });
  });

  it("firstString and fieldString trim non-empty", () => {
    expect(firstString([null, "  x  ", "y"])).toBe("x");
    expect(fieldString({ k: "  v  " }, "k")).toBe("v");
    expect(fieldString({ k: "" }, "k")).toBeNull();
    expect(fieldPresent({ k: undefined }, "k")).toBe(true);
  });

  it("toolInputRecord prefers nested tool_input", () => {
    const input = {
      tool_input: { path: "a.ts" },
      arguments: { path: "b.ts" },
    };
    expect(toolInputRecord(input)?.path).toBe("a.ts");
  });

  it("hookPayloadTopLevelKeys sorts keys", () => {
    expect(hookPayloadTopLevelKeys({ b: 1, a: 2 })).toEqual(["a", "b"]);
    expect(hookPayloadTopLevelKeys(null)).toEqual([]);
  });
});

describe("spawn stdin env bag (#4393)", () => {
  it("threads stdin env bag over fallback and omits when absent", () => {
    expect(hookPayloadEnvironBag({ env: { DEFT_ACTIVE_SCOPE: "b-story.xbrief.json" } })).toEqual({
      DEFT_ACTIVE_SCOPE: "b-story.xbrief.json",
    });
    expect(hookPayloadEnvironBag(null)).toBeNull();
    expect(hookPayloadEnvironBag({ env: {} })).toBeNull();
    expect(hookPayloadEnvironBag({ env: { FOO: 1 } })).toBeNull();
    expect(hookPayloadEnvironBag({ tool_input: { cwd: "/wt" } })).toBeNull();
    expect(
      mergeHookDispatchEnviron(
        { environ: { DEFT_ACTIVE_SCOPE: "pinned.xbrief.json" } },
        { DEFT_SESSION_ID: "parent", DEFT_ACTIVE_SCOPE: "process-wide.xbrief.json" },
      ),
    ).toEqual({
      DEFT_SESSION_ID: "parent",
      DEFT_ACTIVE_SCOPE: "pinned.xbrief.json",
    });
    expect(mergeHookDispatchEnviron({ tool_name: "spawn_subagent" }, { A: "1" })).toBeUndefined();
  });
});

describe("landProcessOnlyFlagOnToolInput (#4315)", () => {
  it("lands process_only from Grok toolInput onto canonical tool_input", () => {
    const landed = landProcessOnlyFlagOnToolInput({
      hookEventName: "pre_tool_use",
      toolName: "spawn_subagent",
      toolInput: {
        subagent_type: "general-purpose",
        process_only: true,
        cwd: "/dest",
        prompt: "critic",
      },
    }) as { tool_input?: { process_only?: boolean; subagent_type?: string; cwd?: string } };
    expect(landed.tool_input?.process_only).toBe(true);
    expect(landed.tool_input?.subagent_type).toBe("general-purpose");
    expect(landed.tool_input?.cwd).toBe("/dest");
  });

  it("lands processOnly camelCase and top-level flag spellings", () => {
    const fromCamel = landProcessOnlyFlagOnToolInput({
      toolName: "spawn_subagent",
      toolInput: { subagent_type: "general-purpose", processOnly: "true" },
    }) as { tool_input?: { process_only?: boolean } };
    expect(fromCamel.tool_input?.process_only).toBe(true);
    const fromTop = landProcessOnlyFlagOnToolInput({
      tool_name: "spawn_subagent",
      process_only: true,
      toolInput: { subagent_type: "general-purpose", cwd: "/dest" },
    }) as { tool_input?: { process_only?: boolean; cwd?: string } };
    expect(fromTop.tool_input?.cwd).toBe("/dest");
    const fromOne = landProcessOnlyFlagOnToolInput({
      toolName: "spawn_subagent",
      toolInput: { process_only: 1, subagent_type: "general-purpose" },
    }) as { tool_input?: { process_only?: boolean } };
    expect(fromOne.tool_input?.process_only).toBe(true);
  });

  it("does not invent process_only from dest-path or prompt text", () => {
    const unmarked = landProcessOnlyFlagOnToolInput({
      toolName: "spawn_subagent",
      toolInput: {
        subagent_type: "general-purpose",
        cwd: "/dest/linked-worktree",
        prompt: "You are a process_only critic",
      },
    }) as { tool_input?: { process_only?: boolean } };
    expect(unmarked.tool_input?.process_only).toBeUndefined();
    expect(unmarked).toEqual({
      toolName: "spawn_subagent",
      toolInput: {
        subagent_type: "general-purpose",
        cwd: "/dest/linked-worktree",
        prompt: "You are a process_only critic",
      },
    });
  });

  it("is a no-op when tool_input.process_only is already true", () => {
    const payload = {
      tool_name: "spawn_subagent",
      tool_input: { subagent_type: "general-purpose", process_only: true, cwd: "/dest" },
    };
    expect(landProcessOnlyFlagOnToolInput(payload)).toBe(payload);
  });
});
