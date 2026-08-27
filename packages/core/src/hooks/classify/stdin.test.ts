import { describe, expect, it } from "vitest";
import { applyPatchMutationPaths, parseHookStdin, stripUtf8Bom } from "./stdin.js";

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

describe("applyPatchMutationPaths (#3794)", () => {
  it("collects mutation headers and `Move to` destinations", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/from.ts",
      "*** Move to: /other/tree/to.ts",
      "+x",
      "*** End Patch",
    ].join("\n");
    expect(applyPatchMutationPaths(patch)).toEqual(["src/from.ts", "/other/tree/to.ts"]);
  });

  it("drops duplicates across both header kinds", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: same.ts",
      "*** Move to: same.ts",
      "*** End Patch",
    ].join("\n");
    expect(applyPatchMutationPaths(patch)).toEqual(["same.ts"]);
  });

  it("leaves the #2738 single-mutation synthesis contract unchanged", () => {
    // `Move to` is not a mutation header, so a canonical rename still presents
    // exactly one mutation and still synthesizes.
    const freeForm = [
      "*** Begin Patch",
      "*** Update File: from.txt",
      "*** Move to: to.txt",
      "+x",
      "*** End Patch",
    ].join("\n");
    expect(parseHookStdin(freeForm)).toEqual({
      payload: {
        tool_name: "ApplyPatch",
        tool_input: { path: "from.txt", patch: freeForm },
      },
      context: {},
    });
  });
});
