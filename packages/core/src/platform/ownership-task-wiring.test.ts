/**
 * Prefer-B (#1617 / PR #5217): ownership task verbs use house :engine:invoke
 * only — no bespoke ownership-ensure-cli / ownership-run shims.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../content-contracts/standards/_helpers.js";

describe("ownership task Prefer-B wiring (#1617)", () => {
  const root = repoRoot();
  const ownershipYml = readFileSync(join(root, "tasks", "ownership.yml"), "utf8");
  const verifyYml = readFileSync(join(root, "tasks", "verify.yml"), "utf8");
  const engineYml = readFileSync(join(root, "tasks", "engine.yml"), "utf8");

  it("routes ownership:doctor / ownership:fix through :engine:invoke", () => {
    expect(ownershipYml).toMatch(/task:\s*:engine:invoke/);
    expect(ownershipYml).toContain("ownership:doctor --project-root");
    expect(ownershipYml).toContain("ownership:fix --project-root");
    expect(ownershipYml).not.toMatch(/_ensure-cli|ownership-run\.cjs|ownership-ensure-cli/);
  });

  it("routes verify:ownership through :engine:invoke without build dep", () => {
    const block = verifyYml.match(/(?:^|\n) {2}ownership:\n[\s\S]*?(?=\n {2}[a-z]|\n[a-z]|$)/);
    const text = block?.[0] ?? "";
    const cmds = text.match(/\n {4}cmds:\n[\s\S]*/)?.[0] ?? text;
    expect(cmds).toMatch(/task:\s*:engine:invoke/);
    expect(cmds).toContain("verify:ownership --project-root");
    expect(cmds).not.toMatch(/deps:|ownership-run\.cjs|ownership-ensure-cli/);
  });

  it("keeps ownership verbs on the engine runtime-verb allowlist", () => {
    expect(engineYml).toMatch(/ownership:doctor/);
    expect(engineYml).toMatch(/ownership:fix/);
    expect(engineYml).toMatch(/verify:ownership/);
  });

  it("does not ship ownership-ensure-cli.cjs or ownership-run.cjs", () => {
    expect(existsSync(join(root, "tasks", "ownership-ensure-cli.cjs"))).toBe(false);
    expect(existsSync(join(root, "tasks", "ownership-run.cjs"))).toBe(false);
  });

  it("task ownership:doctor -- --help exits 0 when task + CLI are available", () => {
    const probe = spawnSync("task", ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      shell: process.platform === "win32",
    });
    if (probe.status !== 0) {
      // CI images without go-task skip the live smoke; wiring tests above still bind.
      return;
    }
    // Prefer-B: ownership verbs ride :engine:invoke and never build a CLI.
    // Live smoke requires this checkout's built CLI so an older global
    // `deft`/`directive` that only answers --version cannot false-fail.
    if (!existsSync(join(root, "packages", "cli", "dist", "bin.js"))) {
      return;
    }
    const result = spawnSync("task", ["ownership:doctor", "--", "--help"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      shell: process.platform === "win32",
      env: { ...process.env, DEFT_SKIP_TS_BUILD: "1" },
      timeout: 120_000,
    });
    expect(
      result.status,
      `stdout=${result.stdout?.slice(0, 500)}\nstderr=${result.stderr?.slice(0, 500)}`,
    ).toBe(0);
  });
});
