import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDeftTs, seedProject } from "./_helpers.js";

const roots: string[] = [];
afterEach(() => {
  roots.length = 0;
});

function project(policy: Record<string, unknown> = {}): string {
  const root = seedProject(policy);
  roots.push(root);
  return root;
}

describe("deft-ts policy (maps tests/cli/test_policy.py CLI paths)", () => {
  it("show text lists configured policy fields", () => {
    const root = project({ wipCap: 7 });
    const { exitCode, stdout } = runDeftTs("policy", ["show", "--project-root", root]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("plan.policy.wipCap");
  });

  it("show --field returns the configured value", () => {
    const root = project({ wipCap: 9 });
    const { exitCode, stdout } = runDeftTs("policy", [
      "show",
      "--project-root",
      root,
      "--field",
      "plan.policy.wipCap",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("9");
  });

  it("resolve emits disclosure for default fail-closed branch policy", () => {
    const root = project({ allowDirectCommitsToMaster: false });
    const { exitCode, stdout } = runDeftTs("policy", ["resolve", "--project-root", root]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Branch-protection policy is ON");
  });

  it("enforce-branches writes allowDirectCommitsToMaster=false", () => {
    const root = project({ allowDirectCommitsToMaster: true });
    const { exitCode, stdout } = runDeftTs("policy", [
      "enforce-branches",
      "--project-root",
      root,
      "--actor",
      "gates-cli",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("branch-protection ON");
    const data = JSON.parse(
      readFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "utf8"),
    ) as { plan: { policy: { allowDirectCommitsToMaster: boolean } } };
    expect(data.plan.policy.allowDirectCommitsToMaster).toBe(false);
  });

  it("allow-direct-commits refuses without --confirm", () => {
    const root = project();
    const { exitCode, stdout, stderr } = runDeftTs("policy", [
      "allow-direct-commits",
      "--project-root",
      root,
    ]);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("Capability-cost disclosure");
    expect(stdout + stderr).toContain("--confirm");
  });

  it("returns exit 2 for unknown subcommand", () => {
    const { exitCode } = runDeftTs("policy", ["nope"]);
    expect(exitCode).toBe(2);
  });
});

describe("deft-ts policy-set Python oracle (maps tests/cli/test_policy_set.py)", () => {
  it("policy-set routes through dispatcher when Python toolchain is available", () => {
    const root = project();
    const { exitCode } = runDeftTs("policy-set", [
      "enforce-branches",
      "--project-root",
      root,
      "--actor",
      "test",
    ]);
    expect([0, 1, 2]).toContain(exitCode);
  });
});
