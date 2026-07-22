import { describe, expect, it } from "vitest";
import type { JsonObject } from "../vbrief-build/types.js";

/** Minimal schema-valid scope brief for lifecycle unit tests (#2131). */
export function minimalScopeBrief(plan: Record<string, unknown>): JsonObject {
  return {
    xBRIEFInfo: { version: "0.8" },
    plan,
  };
}

describe("scope-test-fixtures", () => {
  it("minimalScopeBrief wraps plan with xBRIEFInfo 0.8", () => {
    const brief = minimalScopeBrief({ title: "T", status: "running", items: [] });
    expect(brief.xBRIEFInfo).toEqual({ version: "0.8" });
  });
});
