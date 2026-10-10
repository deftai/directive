import { afterEach, describe, expect, it, vi } from "vitest";
import { parseReleaseArgs, run } from "./review-monitor-release.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("review-monitor-release CLI", () => {
  it("parseReleaseArgs requires --pr", () => {
    expect(parseReleaseArgs([]).pr).toBeNull();
  });

  it("parses equals-form flags", () => {
    const parsed = parseReleaseArgs([
      "--pr=12",
      "--repo=deftai/directive",
      "--monitor-agent-id=rm-12",
      "--owner=alice",
      "--project-root=.",
    ]);
    expect(parsed.pr).toBe(12);
    expect(parsed.repo).toBe("deftai/directive");
    expect(parsed.monitorAgentId).toBe("rm-12");
    expect(parsed.owner).toBe("alice");
  });

  it("run exits 2 without --pr", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(run([])).toBe(2);
  });

  it("run prints help", () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(run(["--help"])).toBe(0);
    expect(out.mock.calls.join("")).toContain("review-monitor:release");
  });
});
