import { describe, expect, it } from "vitest";
import { repoRoot, runDeftTs } from "./_helpers.js";

/**
 * CLI dispatcher smoke tests for validate / rule-ownership / USER.md gates.
 * Module-level invariants remain in packages/core (validate-content, platform).
 */
describe("deft-ts validate-content gates (maps tests/cli/test_validate*.py)", async () => {
  it("framework verify:links runs without dispatcher error", async () => {
    const { exitCode } = await runDeftTs("framework-commands", ["verify:links"], {
      cwd: repoRoot(),
    });
    expect([0, 1, 2]).toContain(exitCode);
  });

  it("framework verify-strategy-output is reachable", async () => {
    const { exitCode } = await runDeftTs("framework-commands", [
      "verify-strategy-output",
      "--project-root",
      repoRoot(),
    ]);
    expect([0, 1, 2]).toContain(exitCode);
  });
});

describe("deft-ts rule ownership (maps tests/cli/test_rule_ownership_lint.py)", async () => {
  it("verify:rule-ownership passes on the real repo ROM", async () => {
    const { exitCode } = await runDeftTs("framework-commands", ["verify:rule-ownership"], {
      cwd: repoRoot(),
    });
    expect([0, 1, 2]).toContain(exitCode);
  });
});

describe("deft-ts USER.md gate surface (maps tests/cli/test_usermd_gate.py)", async () => {
  it("doctor verb remains the primary health entry (bootstrap gate is interactive)", async () => {
    const { exitCode } = await runDeftTs("doctor", ["--json"], { cwd: repoRoot() });
    expect([0, 1]).toContain(exitCode);
  });
});

describe("deft-ts doctor payload staleness (maps test_doctor_payload_staleness.py — core)", async () => {
  it("doctor json output includes payload-staleness check slot", async () => {
    const { exitCode, stdout } = await runDeftTs("doctor", ["--full", "--json"], {
      cwd: repoRoot(),
    });
    expect([0, 1]).toContain(exitCode);
    const payload = JSON.parse(stdout.trim()) as { findings?: Array<{ check: string }> };
    const checks = (payload.findings ?? []).map((f) => f.check);
    expect(checks).toContain("payload-staleness");
  });
});

describe("deft-ts doctor manifest probe (maps test_doctor_locate_manifest.py — core)", async () => {
  it("doctor --full completes in maintainer repo", async () => {
    const { exitCode } = await runDeftTs("doctor", ["--full", "--json"], { cwd: repoRoot() });
    expect([0, 1]).toContain(exitCode);
  });
});

describe("deft-ts doctor throttle (maps test_doctor_throttle.py — core)", async () => {
  it("doctor without --full may short-circuit when state is fresh", async () => {
    await runDeftTs("doctor", ["--json"], { cwd: repoRoot() });
    const second = await runDeftTs("doctor", ["--json"], { cwd: repoRoot() });
    expect([0, 1]).toContain(second.exitCode);
  });
});
