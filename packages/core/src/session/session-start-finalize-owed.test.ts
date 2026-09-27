import { describe, expect, it } from "vitest";
import { evaluateFinalizeOwedSessionGate } from "./session-start.js";

describe("evaluateFinalizeOwedSessionGate (#4919)", () => {
  it("prints inventory and blocks when probe reports blocking owed", () => {
    const result = evaluateFinalizeOwedSessionGate("/tmp/proj", {
      probeFinalizeOwed: () => ({
        lines: ["finalize owed inventory:", "  #4919 owed [blocks] pr=#5100 xbrief/active/a.json"],
        blocks: true,
        unknown: false,
      }),
    });
    expect(result.blocks).toBe(true);
    expect(result.lines.join("\n")).toContain("4919");
  });

  it("does not block when --defer-owed reason is recorded", () => {
    const result = evaluateFinalizeOwedSessionGate("/tmp/proj", {
      deferOwedReason: "finishing unrelated hotfix",
      probeFinalizeOwed: () => ({
        lines: ["finalize owed inventory:", "  #4919 owed [blocks]"],
        blocks: true,
        unknown: false,
      }),
    });
    expect(result.blocks).toBe(false);
    expect(result.deferred).toBe(true);
    expect(result.lines.join("\n")).toContain("deferred");
  });

  it("records unknown without blocking on failed fetch probe", () => {
    const result = evaluateFinalizeOwedSessionGate("/tmp/proj", {
      probeFinalizeOwed: () => ({
        lines: ["finalize owed: unknown"],
        blocks: false,
        unknown: true,
      }),
    });
    expect(result.unknown).toBe(true);
    expect(result.blocks).toBe(false);
  });
});
