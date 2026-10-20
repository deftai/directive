import { describe, expect, it } from "vitest";
import { parseArgs, run } from "./verify-evaluator-surface.js";

describe("verify-evaluator-surface CLI (#4386)", () => {
  it("parses --path and --base-ref", () => {
    const parsed = parseArgs(["--project-root", ".", "--path", "README.md", "--base-ref", "HEAD"]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.paths).toEqual(["README.md"]);
    expect(parsed.baseRef).toBe("HEAD");
  });

  it("returns 2 on unrecognized arguments", () => {
    expect(run(["--nope"])).toBe(2);
  });

  it("skips when --path is not an evaluator surface", () => {
    expect(run(["--project-root", ".", "--path", "README.md", "--quiet"])).toBe(0);
  });
});
