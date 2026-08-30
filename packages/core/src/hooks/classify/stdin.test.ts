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

  it("does not synthesize a Move-to dual-target patch (#3614)", () => {
    // A rename is one header and two targets. Synthesis must refuse rather
    // than authorize the source while the write lands at the destination.
    const freeForm = [
      "*** Begin Patch",
      "*** Update File: from.txt",
      "*** Move to: to.txt",
      "+x",
      "*** End Patch",
    ].join("\n");
    expect(parseHookStdin(freeForm)).toEqual({ payload: {}, context: { parseFailed: true } });
  });

  it("fills tool_input.path on valid JSON ApplyPatch with no declared path (#3614)", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: xbrief/proposed/2026-08-21-story.xbrief.json",
      "+{}",
      "*** End Patch",
    ].join("\n");
    const stdin = JSON.stringify({
      tool_name: "apply_patch",
      tool_input: { patch },
    });
    const parsed = parseHookStdin(stdin);
    const payload = parsed.payload as { tool_input?: { path?: string; patch?: string } };
    expect(payload.tool_input?.path).toBe("xbrief/proposed/2026-08-21-story.xbrief.json");
    expect(payload.tool_input?.patch).toBe(patch);
    expect(parsed.context).toEqual({});
  });

  it("does not fill path on valid JSON Move-to dual-target ApplyPatch (#3614)", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: xbrief/proposed/2026-08-21-story.xbrief.json",
      "*** Move to: src/index.ts",
      "+x",
      "*** End Patch",
    ].join("\n");
    const stdin = JSON.stringify({
      tool_name: "apply_patch",
      tool_input: { patch },
    });
    const parsed = parseHookStdin(stdin);
    const payload = parsed.payload as { tool_input?: { path?: string } };
    expect(payload.tool_input?.path).toBeUndefined();
  });
});
