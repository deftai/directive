import { describe, expect, it } from "vitest";
import { parseArgs, run } from "./verify-durable-effect-acquisition.js";

describe("verify-durable-effect-acquisition CLI (#5080)", () => {
  it("parses --origin-ref and refuses --base-ref", () => {
    const parsed = parseArgs(["--project-root", ".", "--origin-ref", "origin/master"]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.originRef).toBe("origin/master");
    expect(parseArgs(["--base-ref", "HEAD"]).error).toMatch(/merge base/);
  });

  it("returns 2 on unrecognized arguments", () => {
    expect(run(["--nope"])).toBe(2);
  });
});
