import { describe, expect, it } from "vitest";
import {
  CRITIQUE_RECOMMEND_FIELD,
  DEFAULT_CONCURRENCY,
  ORIGIN_MASTER,
  RESERVED_CLEARANCE_RE,
  SHA12_LENGTH,
  VALIDITY_STATES,
} from "./types.js";

describe("issue-eval types", () => {
  it("pins Stage A binds", () => {
    expect(DEFAULT_CONCURRENCY).toBe(4);
    expect(ORIGIN_MASTER).toBe("origin/master");
    expect(SHA12_LENGTH).toBe(12);
    expect(CRITIQUE_RECOMMEND_FIELD).toBe("critique-recommend");
    expect(VALIDITY_STATES).toContain("still-open");
    expect(RESERVED_CLEARANCE_RE.test("design-critique: not warranted, because no")).toBe(true);
  });
});
