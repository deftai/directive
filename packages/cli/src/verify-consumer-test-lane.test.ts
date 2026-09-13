import { describe, expect, it } from "vitest";
import { parseArgs, run } from "./verify-consumer-test-lane.js";

describe("verify-consumer-test-lane CLI (#4386)", () => {
  it("parses --project-root", () => {
    const parsed = parseArgs(["--project-root", "."]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.projectRoot).toBe(".");
  });

  it("returns 2 on unrecognized arguments", () => {
    expect(run(["--nope"])).toBe(2);
  });
});
