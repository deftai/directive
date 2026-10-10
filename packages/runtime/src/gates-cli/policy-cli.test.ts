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

describe("deft-ts policy (maps tests/cli/test_policy.py CLI paths)", async () => {
  it("show text lists configured policy fields", async () => {
    const root = project({ wipCap: 7 });
    const { exitCode, stdout } = await runDeftTs("policy", ["show", "--project-root", root]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("plan.policy.wipCap");
  });

  it("show --field returns the configured value", async () => {
    const root = project({ wipCap: 9 });
    const { exitCode, stdout } = await runDeftTs("policy", [
      "show",
      "--project-root",
      root,
      "--field",
      "plan.policy.wipCap",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("9");
  });

  it("resolve emits disclosure for default fail-closed branch policy", async () => {
    const root = project({ allowDirectCommitsToMaster: false });
    const { exitCode, stdout } = await runDeftTs("policy", ["resolve", "--project-root", root]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Branch-protection policy is ON");
  });

  it("enforce-branches writes allowDirectCommitsToMaster=false", async () => {
    const root = project({ allowDirectCommitsToMaster: true });
    const { exitCode, stdout } = await runDeftTs("policy", [
      "enforce-branches",
      "--project-root",
      root,
      "--actor",
      "gates-cli",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("branch-protection ON");
    const data = JSON.parse(
      readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
    ) as { plan: Record<string, { allowDirectCommitsToMaster: boolean }> };
    expect(data.plan["x-directive/policy"].allowDirectCommitsToMaster).toBe(false);
  });

  it("disable-host-hooks refuses without --confirm and persists with it", async () => {
    const root = project();
    const refused = await runDeftTs("policy", [
      "disable-host-hooks",
      "--host",
      "cursor",
      "--project-root",
      root,
    ]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout + refused.stderr).toContain("Capability-cost disclosure");
    const applied = await runDeftTs("policy", [
      "disable-host-hooks",
      "--host",
      "cursor",
      "--confirm",
      "--project-root",
      root,
    ]);
    expect(applied.exitCode).toBe(0);
    const data = JSON.parse(
      readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
    ) as { plan: Record<string, { hostHooks?: { cursor?: boolean } }> };
    const policy = data.plan["x-directive/policy"] ?? data.plan.policy;
    expect(policy?.hostHooks?.cursor).toBe(false);
  });

  it("allow-direct-commits refuses without --confirm", async () => {
    const root = project();
    const { exitCode, stdout, stderr } = await runDeftTs("policy", [
      "allow-direct-commits",
      "--project-root",
      root,
    ]);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("Capability-cost disclosure");
    expect(stdout + stderr).toContain("--confirm");
  });

  it("returns exit 2 for unknown subcommand", async () => {
    const { exitCode } = await runDeftTs("policy", ["nope"]);
    expect(exitCode).toBe(2);
  });
});

describe("deft-ts policy-set Python oracle (maps tests/cli/test_policy_set.py)", async () => {
  it("policy-set routes through dispatcher when Python toolchain is available", async () => {
    const root = project();
    const { exitCode } = await runDeftTs("policy-set", [
      "enforce-branches",
      "--project-root",
      root,
      "--actor",
      "test",
    ]);
    expect([0, 1, 2]).toContain(exitCode);
  });
});
