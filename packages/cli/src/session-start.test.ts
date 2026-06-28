import { describe, expect, it } from "vitest";
import { parseArgs } from "./session-start.js";

describe("session-start parseArgs", () => {
  it("defaults project root to cwd", () => {
    expect(parseArgs([])).toEqual({
      projectRoot: ".",
      deferValues: [],
      emitJson: false,
      noHistory: false,
    });
  });

  it("parses --project-root, --defer, --json, and --no-history", () => {
    expect(
      parseArgs([
        "--project-root",
        "/tmp/proj",
        "--defer",
        "doctor=postponed",
        "--json",
        "--no-history",
      ]),
    ).toEqual({
      projectRoot: "/tmp/proj",
      deferValues: ["doctor=postponed"],
      emitJson: true,
      noHistory: true,
    });
  });

  it("accepts equals-form flags", () => {
    expect(parseArgs(["--project-root=/x", "--defer=cache_fresh=later"])).toEqual({
      projectRoot: "/x",
      deferValues: ["cache_fresh=later"],
      emitJson: false,
      noHistory: false,
    });
  });

  it("rejects unknown flags", () => {
    expect(parseArgs(["--nope"]).error).toContain("unrecognized argument");
  });
});
