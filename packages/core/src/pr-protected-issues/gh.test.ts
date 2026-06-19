import { describe, expect, it } from "vitest";
import { defaultRunGh } from "./gh.js";

describe("defaultRunGh ENOENT", () => {
  it("returns not-found when gh binary missing", () => {
    const result = defaultRunGh(["gh", "version"]);
    if (result.returncode === -1 && result.stderr.includes("not found")) {
      expect(result.stderr).toContain("gh CLI not found");
    } else {
      expect(result.returncode).toBe(0);
    }
  });
});

describe("defaultRunGh failure path", () => {
  it("returns non-zero status with stderr on invalid subcommand", () => {
    const result = defaultRunGh(["gh", "this-subcommand-does-not-exist-xyz"]);
    expect(result.returncode).not.toBe(0);
  });
});
