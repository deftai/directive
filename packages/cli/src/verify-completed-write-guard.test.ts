import { describe, expect, it } from "vitest";
import { parseArgs } from "./verify-completed-write-guard.js";

describe("verify-completed-write-guard CLI (#3679)", () => {
  it("parses defaults", () => {
    expect(parseArgs([])).toMatchObject({
      projectRoot: ".",
      baseRef: "",
      quiet: false,
    });
  });

  it("parses flags", () => {
    expect(
      parseArgs(["--project-root", "/root", "--base-ref", "origin/master", "--quiet"]),
    ).toMatchObject({
      projectRoot: "/root",
      baseRef: "origin/master",
      quiet: true,
    });
  });

  it("rejects unknown args", () => {
    expect(parseArgs(["--nope"])).toMatchObject({ error: "unrecognized argument: --nope" });
  });
});
