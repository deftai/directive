import { describe, expect, it } from "vitest";
import { parseArgs, run } from "./migrate-xbrief.js";

describe("migrate-xbrief CLI", () => {
  it("parses --force and project/framework roots", () => {
    const args = parseArgs([
      "--project-root",
      "/tmp/project",
      "--framework-root",
      "/tmp/deft",
      "--force",
    ]);
    expect(args.error).toBeUndefined();
    expect(args.projectRoot).toBe("/tmp/project");
    expect(args.frameworkRoot).toBe("/tmp/deft");
    expect(args.force).toBe(true);
  });

  it("returns 2 for unknown flags", () => {
    expect(run(["--not-real"])).toBe(2);
  });
});
