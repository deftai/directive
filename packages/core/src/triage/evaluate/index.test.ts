import { describe, expect, it } from "vitest";
import { CRITIQUE_RECOMMEND_FIELD, DEFAULT_CONCURRENCY, RESERVED_CLEARANCE_RE } from "./index.js";

describe("evaluate barrel", () => {
  it("re-exports Stage A constants", () => {
    expect(DEFAULT_CONCURRENCY).toBe(4);
    expect(CRITIQUE_RECOMMEND_FIELD).toBe("critique-recommend");
    expect(RESERVED_CLEARANCE_RE.test("design-critique: warranted, because x")).toBe(true);
  });
});
