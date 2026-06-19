import { describe, expect, it } from "vitest";
import { run } from "./doctor.js";

describe("doctor CLI", () => {
  it("returns 0 for full json with tools present", () => {
    expect(run(["--full", "--json"])).toBe(0);
  });
});
