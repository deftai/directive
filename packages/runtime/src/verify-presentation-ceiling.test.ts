import { describe, expect, it } from "vitest";
import { parseArgs, run } from "./verify-presentation-ceiling.js";

describe("verify-presentation-ceiling CLI (#5056)", () => {
  it("parses project-root and base-ref flags", () => {
    const a = parseArgs(["--project-root", ".", "--base-ref", "origin/master", "--quiet"]);
    expect(a.error).toBeUndefined();
    expect(a.projectRoot).toBe(".");
    expect(a.baseRef).toBe("origin/master");
    expect(a.quiet).toBe(true);
  });

  it("parses equals-form flags without accepting prefix lookalikes", () => {
    expect(parseArgs(["--project-root=.", "--base-ref=topic(foo"])).toMatchObject({
      projectRoot: ".",
      baseRef: "topic(foo",
    });
    expect(parseArgs(["--base-reference=main"]).error).toMatch(/unrecognized/);
    expect(parseArgs(["--base-ref"]).error).toMatch(/expected one argument/);
    expect(parseArgs(["--project-root"]).error).toMatch(/expected one argument/);
  });

  it("rejects unknown args", () => {
    const a = parseArgs(["--nope"]);
    expect(a.error).toMatch(/unrecognized/);
  });

  it("runs against framework HEAD without requiring remote refs", () => {
    const code = run(["--project-root", ".", "--base-ref", "HEAD", "--quiet"]);
    expect(code).toBe(0);
  }, 30_000);
});
