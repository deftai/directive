import type { VerifyResult } from "@deftai/directive-core/session";
import { describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-session-ritual.js";

function failedCacheFreshResult(overrides: Partial<VerifyResult> = {}): VerifyResult {
  return {
    code: 1,
    message: [
      "session ritual gated step 'cache_fresh' failed: ❌ deft cache-fresh: cache is 9.0h old (max-age=4h).",
      "  Recovery: run `deft cache fetch-all --source github-issue --repo OWNER/NAME --force` to refresh and reconcile upstream state.",
    ].join("\n"),
    tier: "gated",
    statePath: "/tmp/ritual-state.json",
    bypassed: false,
    wouldFailCode: null,
    posture: "mutation",
    ritualStateRequired: true,
    recoveryTier: "cold",
    ...overrides,
  };
}

describe("parseArgs", () => {
  it("defaults to quick tier with project root .", () => {
    expect(parseArgs([])).toMatchObject({
      projectRoot: ".",
      tier: "quick",
      posture: null,
      emitJson: false,
    });
    expect(parseArgs([]).error).toBeUndefined();
  });

  it("parses --tier=gated", () => {
    expect(parseArgs(["--tier=gated"])).toMatchObject({ tier: "gated" });
    expect(parseArgs(["--tier=gated"]).error).toBeUndefined();
  });

  it("accepts a lone -- separator before flags (#2680)", () => {
    expect(parseArgs(["--", "--tier=gated"])).toMatchObject({ tier: "gated" });
    expect(parseArgs(["--", "--tier=gated"]).error).toBeUndefined();
    expect(parseArgs(["--", "--tier=gated"])).toEqual(parseArgs(["--tier=gated"]));
  });

  it("errors on missing values and unknown flags", () => {
    expect(parseArgs(["--tier"]).error).toBeDefined();
    expect(parseArgs(["--bogus"]).error).toBeDefined();
    expect(parseArgs(["--project-root"]).error).toMatch(/project-root/);
    expect(parseArgs(["--posture"]).error).toMatch(/posture/);
  });

  it("parses equals-form project root and posture aliases (#2666)", () => {
    expect(parseArgs(["--project-root=/tmp/work"]).projectRoot).toBe("/tmp/work");
    expect(parseArgs(["--posture=mutating"]).posture).toBe("mutation");
    expect(parseArgs(["--posture", "mutation"]).posture).toBe("mutation");
    expect(parseArgs(["--posture=read-only"]).posture).toBe("read-only");
    expect(parseArgs(["--json"]).emitJson).toBe(true);
  });

  it("rejects invalid tier and posture choices", () => {
    expect(parseArgs(["--tier=invalid"]).error).toMatch(/invalid choice/);
    expect(parseArgs(["--tier", "invalid"]).error).toMatch(/invalid choice/);
    expect(parseArgs(["--posture=nope"]).error).toMatch(/invalid choice/);
  });
});

describe("run (#2666)", () => {
  it("exits 2 and prints parse errors", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(run(["--bogus"])).toBe(2);
    const stderr = err.mock.calls.join("");
    expect(stderr).toContain("unrecognized argument");
    expect(stderr).not.toContain("session:ready");
    expect(stderr).not.toContain("cache_fresh=<reason>");
    err.mockRestore();
  });
});

describe("run ritual failure (#3506)", () => {
  it("prints session:ready recovery and audited defer soft-path on code 1", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const result = failedCacheFreshResult();
    expect(
      run(["--tier=gated"], {
        verifySessionRitual: () => result,
      }),
    ).toBe(1);
    const stderr = err.mock.calls.join("");
    expect(stderr).toContain("session:ready");
    expect(stderr).toContain("one-shot");
    expect(stderr).toContain("--defer cache_fresh=<reason>");
    expect(stderr).toContain("audited");
    expect(stderr).toContain("cache fetch-all");
    err.mockRestore();
  });

  it("emits recovery_tier on --json without changing parse-error exit 2", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(
      run(["--tier=gated", "--json"], {
        verifySessionRitual: () => failedCacheFreshResult({ recoveryTier: "cold" }),
      }),
    ).toBe(1);
    const payload = JSON.parse(out.mock.calls.join("")) as { recovery_tier: string | null };
    expect(payload.recovery_tier).toBe("cold");
    expect(run(["--bogus"])).toBe(2);
    err.mockRestore();
    out.mockRestore();
  });
});
