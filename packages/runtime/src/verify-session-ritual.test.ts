import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyWorktreeOccupancy, type VerifyResult } from "@deftai/directive-core/session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCleanHostEnv } from "./__tests__/clean-host-env.js";
import { parseArgs, run } from "./verify-session-ritual.js";

useCleanHostEnv();

const cliTemps: string[] = [];
afterEach(() => {
  for (const t of cliTemps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function isolatedProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "verify-ritual-cli-"));
  cliTemps.push(root);
  return root;
}

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

describe("parseArgs --session-id (#7446)", () => {
  it("accepts equals-form as the presented session", () => {
    const parsed = parseArgs(["--tier=gated", "--session-id=host:agy:v1:dGVzdA"]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.sessionId).toBe("host:agy:v1:dGVzdA");
    expect(parsed.tier).toBe("gated");
  });

  it("accepts space-form as the presented session", () => {
    const parsed = parseArgs(["--tier=gated", "--session-id", "host:agy:v1:dGVzdA"]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.sessionId).toBe("host:agy:v1:dGVzdA");
  });

  it("leaves the session unset when the flag is absent", () => {
    expect(parseArgs(["--tier=gated"]).sessionId).toBeNull();
  });

  it("rejects an empty or missing value", () => {
    expect(parseArgs(["--session-id="]).error).toContain("--session-id");
    expect(parseArgs(["--session-id"]).error).toContain("--session-id");
  });

  it("keeps generic parse error for --bogus", () => {
    expect(parseArgs(["--bogus"]).error).toBe("unrecognized argument: --bogus");
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

describe("run --session-id and occupancy (#7446)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const owner = "host:agy:v1:b3duZXI";
  const doctorFailure = (): VerifyResult =>
    failedCacheFreshResult({
      message: "session ritual gated step 'doctor' failed: doctor exited 1",
    });

  it("exits 2 on an empty --session-id", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(run(["--tier=gated", "--session-id="])).toBe(2);
    expect(err.mock.calls.join("")).toContain("--session-id");
  });

  it("gives the lease owner recovery guidance, not a foreign-occupant refusal", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const root = isolatedProjectRoot();
    applyWorktreeOccupancy(root, { sessionId: owner });
    expect(
      run(["--tier=gated", "--project-root", root, `--session-id=${owner}`], {
        verifySessionRitual: doctorFailure,
      }),
    ).toBe(1);
    const stderr = err.mock.calls.join("");
    expect(stderr).toContain("gated step 'doctor' failed");
    expect(stderr).toContain("session:ready");
    expect(stderr).toContain(`--session-id=${owner}`);
    expect(stderr).not.toContain("Worktree occupied");
    expect(stderr).not.toContain("neither holds that lease");
    expect(stderr).not.toContain("Use another worktree");
  });

  it("still refuses a presenter that is not the lease owner", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const root = isolatedProjectRoot();
    applyWorktreeOccupancy(root, { sessionId: owner });
    expect(
      run(["--tier=gated", "--project-root", root, "--session-id", "host:agy:v1:c3RyYW5nZXI"], {
        verifySessionRitual: doctorFailure,
      }),
    ).toBe(1);
    expect(err.mock.calls.join("")).toContain("Worktree occupied");
  });

  it("names the missing identity and the flag when none is presented", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const root = isolatedProjectRoot();
    applyWorktreeOccupancy(root, { sessionId: owner });
    expect(
      run(["--tier=gated", "--project-root", root], { verifySessionRitual: doctorFailure }),
    ).toBe(1);
    const stderr = err.mock.calls.join("");
    expect(stderr).toContain("No session identity was presented");
    expect(stderr).toContain("--session-id=<your session id>");
    expect(stderr).not.toContain("Worktree occupied");
    expect(stderr).not.toContain("neither holds that lease");
  });
});

describe("run ritual failure (#3506)", () => {
  it("prints session:ready recovery and audited defer soft-path on code 1", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const result = failedCacheFreshResult();
    expect(
      run(["--tier=gated", "--project-root", isolatedProjectRoot()], {
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

  it("omits cache_fresh defer copy when the failed step is not cache_fresh", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(
      run(["--tier=gated", "--project-root", isolatedProjectRoot()], {
        verifySessionRitual: () =>
          failedCacheFreshResult({
            message: "session ritual gated step 'doctor' failed: doctor exited 1",
          }),
      }),
    ).toBe(1);
    const stderr = err.mock.calls.join("");
    expect(stderr).toContain("session:ready");
    expect(stderr).not.toContain("cache_fresh=<reason>");
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
