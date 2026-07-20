import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseVerifyReviewMonitorArgs, run } from "./verify-review-monitor.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("verify-review-monitor CLI", () => {
  it("parseVerifyReviewMonitorArgs requires --pr", () => {
    const parsed = parseVerifyReviewMonitorArgs([]);
    expect(parsed.pr).toBeNull();
  });

  it("parses equals-form flags and call-site", () => {
    const parsed = parseVerifyReviewMonitorArgs([
      "--pr=12",
      "--repo=deftai/directive",
      "--head-sha=abc",
      "--project-root=.",
      "--call-site=swarm-phase5-6",
      "--approach3",
      "--approach3-warned",
      "--json",
    ]);
    expect(parsed.pr).toBe(12);
    expect(parsed.repo).toBe("deftai/directive");
    expect(parsed.headSha).toBe("abc");
    expect(parsed.callSite).toBe("swarm-phase5-6");
    expect(parsed.approach3).toBe(true);
    expect(parsed.approach3Warned).toBe(true);
    expect(parsed.emitJson).toBe(true);
  });

  it("rejects invalid call-site and pr", () => {
    expect(parseVerifyReviewMonitorArgs(["--pr", "x"]).error).toMatch(/invalid --pr/);
    expect(parseVerifyReviewMonitorArgs(["--pr=0"]).error).toMatch(/invalid --pr/);
    expect(parseVerifyReviewMonitorArgs(["--call-site", "nope"]).error).toMatch(
      /invalid --call-site/,
    );
    expect(parseVerifyReviewMonitorArgs(["--call-site"]).error).toMatch(/expected one argument/);
    expect(parseVerifyReviewMonitorArgs(["--repo"]).error).toMatch(/expected one argument/);
    expect(parseVerifyReviewMonitorArgs(["--head-sha"]).error).toMatch(/expected one argument/);
    expect(parseVerifyReviewMonitorArgs(["--project-root"]).error).toMatch(/expected one argument/);
    expect(parseVerifyReviewMonitorArgs(["--unknown"]).error).toMatch(/unrecognized/);
  });

  it("parses space-separated flag forms", () => {
    const parsed = parseVerifyReviewMonitorArgs([
      "--pr",
      "4",
      "--repo",
      "o/r",
      "--head-sha",
      "sha",
      "--project-root",
      ".",
      "--call-site",
      "solo",
    ]);
    expect(parsed.pr).toBe(4);
    expect(parsed.repo).toBe("o/r");
    expect(parsed.headSha).toBe("sha");
    expect(parsed.callSite).toBe("solo");
  });

  it("run exits 2 without --pr", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(run([])).toBe(2);
  });

  it("run prints help and exits 0", () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(run(["--help"])).toBe(0);
    expect(out.mock.calls.join("")).toContain("verify:review-monitor");
  });

  it("run exits 0 on Tier 3 with no monitor required", () => {
    vi.stubEnv("CURSOR_COMPOSER", "");
    vi.stubEnv("CURSOR_AGENT", "");
    vi.stubEnv("GROK_BUILD", "");
    vi.stubEnv("DEFT_MONITOR_TIER", "3");
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(run(["--pr", "9", "--project-root", "."])).toBe(0);
  });

  it("run emits json and fails closed on Tier 1 without monitor", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-cli-"));
    vi.stubEnv("DEFT_MONITOR_TIER", "1");
    vi.stubEnv("DEFT_MONITOR_TIER1_PRIMITIVE", "cursor-task");
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(
      run(["--pr", "55", "--project-root", root, "--call-site", "swarm-phase6-cascade", "--json"]),
    ).toBe(1);
    expect(out.mock.calls.join("")).toContain('"ready": false');
  });

  it("run exits 2 for parse error", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(run(["--pr"])).toBe(2);
  });
});
