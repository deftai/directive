import { describe, expect, it } from "vitest";
import {
  fieldPresent,
  fieldString,
  firstString,
  hookPayloadEnvironBag,
  hookPayloadTopLevelKeys,
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
