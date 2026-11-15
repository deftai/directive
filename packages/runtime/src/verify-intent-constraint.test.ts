import { describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-intent-constraint.js";

describe("verify-intent-constraint CLI (#4541)", () => {
  it("parses --origin-ref and refuses --base-ref", () => {
    const parsed = parseArgs(["--project-root", ".", "--origin-ref", "origin/master"]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.originRef).toBe("origin/master");
    expect(parseArgs(["--base-ref", "HEAD"]).error).toMatch(/merge base/);
  });

  it("parses quiet, staged, plan-id, and equals-form flags", () => {
    const parsed = parseArgs([
      "--quiet",
      "--staged",
      "--plan-id",
      "story-1",
      "--project-root=.",
      "--origin-ref=origin/master",
    ]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.quiet).toBe(true);
    expect(parsed.staged).toBe(true);
    expect(parsed.planId).toBe("story-1");
    expect(parsed.projectRoot).toBe(".");
    expect(parsed.originRef).toBe("origin/master");
  });
  it("returns 2 on unrecognized arguments", () => {
    expect(run(["--nope"], {})).toBe(2);
  });
});

describe("verify:intent-constraint on merge_group (#6295)", () => {
  it("skips with exit 0 and never parses arguments", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(run(["--nope"], { GITHUB_EVENT_NAME: "merge_group" })).toBe(0);
    expect(stdout.mock.calls.join("")).toContain(
      "verify:intent-constraint: skipped on merge_group",
    );
    stdout.mockRestore();
  });

  it("still runs on pull_request", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run(["--nope"], { GITHUB_EVENT_NAME: "pull_request" })).toBe(2);
    stderr.mockRestore();
  });
});
