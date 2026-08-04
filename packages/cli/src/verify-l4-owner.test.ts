import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseVerifyL4OwnerArgs, run } from "./verify-l4-owner.js";

describe("verify-l4-owner CLI (#3090)", () => {
  it("parses --pr and --review-cycle", () => {
    const args = parseVerifyL4OwnerArgs(["--pr", "42", "--review-cycle", "done", "--json"]);
    expect(args.pr).toBe(42);
    expect(args.reviewCycle).toBe("done");
    expect(args.emitJson).toBe(true);
    expect(args.error).toBeUndefined();
  });

  it("covers equals-form flags and missing-value errors (#3103)", () => {
    const ok = parseVerifyL4OwnerArgs([
      "--pr=7",
      "--repo=acme/widgets",
      "--head-sha=deadbeef",
      "--project-root=/tmp/p",
      "--review-cycle=skipped:no-pr",
      "--json",
    ]);
    expect(ok).toMatchObject({
      pr: 7,
      repo: "acme/widgets",
      headSha: "deadbeef",
      projectRoot: "/tmp/p",
      reviewCycle: "skipped:no-pr",
      emitJson: true,
    });

    expect(parseVerifyL4OwnerArgs(["--pr"]).error).toMatch(/--pr: expected one argument/);
    expect(parseVerifyL4OwnerArgs(["--pr", "0"]).error).toMatch(/invalid --pr/);
    expect(parseVerifyL4OwnerArgs(["--pr=abc"]).error).toMatch(/invalid --pr/);
    expect(parseVerifyL4OwnerArgs(["--repo"]).error).toMatch(/--repo: expected one argument/);
    expect(parseVerifyL4OwnerArgs(["--head-sha"]).error).toMatch(
      /--head-sha: expected one argument/,
    );
    expect(parseVerifyL4OwnerArgs(["--project-root"]).error).toMatch(
      /--project-root: expected one argument/,
    );
    expect(parseVerifyL4OwnerArgs(["--review-cycle"]).error).toMatch(
      /--review-cycle: expected one argument/,
    );
    expect(parseVerifyL4OwnerArgs(["--nope"]).error).toMatch(/unrecognized argument/);
    expect(parseVerifyL4OwnerArgs(["positional"]).error).toMatch(/unrecognized argument/);
    expect(parseVerifyL4OwnerArgs(["-h"]).help).toBe(true);
  });

  it("help exits 0", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(run(["--help"])).toBe(0);
    expect(out.mock.calls.join("")).toContain("verify:l4-owner");
    out.mockRestore();
  });

  it("missing --pr exits 2", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run([])).toBe(2);
    expect(err.mock.calls.join("")).toContain("--pr is required");
    err.mockRestore();
  });

  it("parse error path exits 2 with usage hint (#3103)", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run(["--pr"])).toBe(2);
    expect(err.mock.calls.join("")).toMatch(/expected one argument|--help/);
    err.mockRestore();
  });

  it("emits JSON for done and stderr for illegal freeform (#3103)", () => {
    const root = mkdtempSync(join(tmpdir(), "l4-cli-json-"));
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(
      run([
        "--pr",
        "12",
        "--repo",
        "acme/widgets",
        "--project-root",
        root,
        "--review-cycle",
        "done",
        "--json",
      ]),
    ).toBe(0);
    expect(out.mock.calls.join("")).toMatch(/"path": "done"/);

    out.mockClear();
    err.mockClear();
    // Freeform is rejected before any GitHub fetch (no network seam needed).
    expect(
      run([
        "--pr",
        "12",
        "--repo",
        "acme/widgets",
        "--project-root",
        root,
        "--review-cycle",
        "started",
      ]),
    ).toBe(1);
    expect(err.mock.calls.join("")).toMatch(/illegal freeform|review_cycle/);
    expect(out).not.toHaveBeenCalled();

    out.mockRestore();
    err.mockRestore();
  });
});
