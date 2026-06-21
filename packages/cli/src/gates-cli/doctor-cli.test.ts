import { describe, expect, it } from "vitest";
import { repoRoot, runDeftTs } from "./_helpers.js";

describe("deft-ts doctor (maps tests/cli/test_doctor.py)", () => {
  it("completes without crash and emits check symbols", () => {
    const { exitCode, stdout } = runDeftTs("doctor", ["--full"], { cwd: repoRoot() });
    expect([0, 1]).toContain(exitCode);
    const hasMarker = /[\u2713\u26a0\u2717]/.test(stdout) || stdout.includes('"status"');
    expect(hasMarker).toBe(true);
  });

  it("accepts --json and returns structured output", () => {
    const { exitCode, stdout } = runDeftTs("doctor", ["--full", "--json"], { cwd: repoRoot() });
    expect([0, 1]).toContain(exitCode);
    const payload = JSON.parse(stdout.trim()) as { status: string };
    expect(["completed", "throttle-skipped"]).toContain(payload.status);
  });

  it("returns exit 2 for unknown flags", () => {
    const { exitCode, stderr } = runDeftTs("doctor", ["--not-a-flag"], { cwd: repoRoot() });
    expect(exitCode).toBe(2);
    expect(stderr.length + runDeftTs("doctor", ["--not-a-flag"]).stdout.length).toBeGreaterThan(0);
  });
});
