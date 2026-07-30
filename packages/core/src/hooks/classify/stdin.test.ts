import { describe, expect, it } from "vitest";
import { parseHookStdin, stripUtf8Bom } from "./stdin.js";

describe("parseHookStdin (#2734 / #2738 / #2950)", () => {
  it("strips BOM and parses JSON", () => {
    expect(stripUtf8Bom("\uFEFFhi")).toBe("hi");
    const payload = { tool_name: "Write", tool_input: { path: "a.txt" } };
    expect(parseHookStdin(`\uFEFF${JSON.stringify(payload)}`)).toEqual({
      payload,
      context: {},
    });
  });

  it("tags empty and parse failures", () => {
    expect(parseHookStdin("")).toEqual({ payload: {}, context: { stdinEmpty: true } });
    expect(parseHookStdin("\uFEFF")).toEqual({ payload: {}, context: { stdinEmpty: true } });
    expect(parseHookStdin("{bad")).toEqual({ payload: {}, context: { parseFailed: true } });
  });

  it("synthesizes single-file free-form ApplyPatch", () => {
    const freeForm = ["*** Begin Patch", "*** Add File: only.txt", "+x", "*** End Patch"].join(
      "\n",
    );
    expect(parseHookStdin(freeForm)).toEqual({
      payload: {
        tool_name: "ApplyPatch",
        tool_input: { path: "only.txt", patch: freeForm },
      },
      context: {},
    });
  });
});
