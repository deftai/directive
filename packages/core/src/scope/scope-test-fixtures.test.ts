import { describe, expect, it } from "vitest";
import { minimalScopeBrief } from "./scope-test-fixtures.js";

describe("scope-test-fixtures", () => {
  it("minimalScopeBrief wraps plan with xBRIEFInfo 0.8", () => {
    const brief = minimalScopeBrief({ title: "T", status: "running", items: [] });
    expect(brief.xBRIEFInfo).toEqual({ version: "0.8" });
  });
});
