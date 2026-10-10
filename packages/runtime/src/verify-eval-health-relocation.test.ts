import { describe, expect, it } from "vitest";
import { parseArgs, run } from "./verify-eval-health-relocation.js";

describe("verify-eval-health-relocation CLI", () => {
  it("parses base-ref and seed-baseline flags", () => {
    const args = parseArgs([
      "--project-root",
      "/tmp/proj",
      "--base-ref",
      "origin/master",
      "--seed-baseline",
      "--quiet",
    ]);
    expect(args.error).toBeUndefined();
    expect(args.projectRoot).toBe("/tmp/proj");
    expect(args.baseRef).toBe("origin/master");
    expect(args.seedBaseline).toBe(true);
    expect(args.quiet).toBe(true);
  });

  it("rejects unknown flags", () => {
    const args = parseArgs(["--nope"]);
    expect(args.error).toContain("unrecognized argument");
  });

  it("run exits 0 when no diff context is supplied", () => {
    expect(run([])).toBe(0);
  });
});
