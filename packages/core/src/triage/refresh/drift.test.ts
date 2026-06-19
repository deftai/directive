import { describe, expect, it } from "vitest";
import { isDrift } from "./index.js";

describe("refresh drift", () => {
  it("treats missing cache as drift", () => {
    expect(isDrift(null, "2026-05-05T00:00:00Z")).toBe(true);
  });

  it("compares ISO timestamps lexicographically", () => {
    expect(isDrift("2026-05-01T00:00:00Z", "2026-05-05T00:00:00Z")).toBe(true);
    expect(isDrift("2026-05-05T00:00:00Z", "2026-05-04T00:00:00Z")).toBe(false);
  });

  it("empty live is not drift", () => {
    expect(isDrift("2026-05-05T00:00:00Z", "")).toBe(false);
  });
});
