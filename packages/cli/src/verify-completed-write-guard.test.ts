import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, run } from "./verify-completed-write-guard.js";

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

  it("parses equals-form flags and missing values", () => {
    expect(parseArgs(["--project-root=/root", "--base-ref=origin/master"])).toMatchObject({
      projectRoot: "/root",
      baseRef: "origin/master",
    });
    expect(parseArgs(["--project-root"])).toMatchObject({
      error: "argument --project-root: expected one argument",
    });
    expect(parseArgs(["--base-ref"])).toMatchObject({
      error: "argument --base-ref: expected one argument",
    });
  });

  it("run exits 2 on parse error and 0 on a non-git root skip", () => {
    expect(run(["--nope"])).toBe(2);
    const root = mkdtempSync(join(tmpdir(), "verify-cwg-nongit-"));
    try {
      expect(run(["--project-root", root, "--quiet"])).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
