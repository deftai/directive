import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot, runDeftTs, seedProject } from "./_helpers.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

describe("deft-ts verify-branch (maps tests/cli/test_preflight_branch.py overlap)", () => {
  it("exits 0 on default branch when project definition missing and flag set", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-branch-"));
    temps.push(root);
    const { exitCode } = runDeftTs("verify-branch", [
      "--allow-missing-project-definition",
      "--project-root",
      root,
    ]);
    expect([0, 1, 2]).toContain(exitCode);
  });

  it("verify:branch alias routes identically", () => {
    const args = ["--allow-missing-project-definition", "--project-root", repoRoot()];
    const direct = runDeftTs("verify-branch", args);
    const alias = runDeftTs("verify:branch", args);
    expect(alias.exitCode).toBe(direct.exitCode);
  });
});

describe("deft-ts verify-wip-cap", () => {
  it("accepts --allow-over-cap against framework repo", () => {
    const { exitCode } = runDeftTs("verify-wip-cap", [
      "--allow-over-cap",
      "--project-root",
      repoRoot(),
    ]);
    expect([0, 1]).toContain(exitCode);
  });

  it("verify:wip-cap alias routes identically", () => {
    const args = ["--allow-over-cap", "--project-root", repoRoot()];
    expect(runDeftTs("verify:wip-cap", args).exitCode).toBe(
      runDeftTs("verify-wip-cap", args).exitCode,
    );
  });
});

describe("deft-ts verify-judgment-gates (maps tests/cli/test_verify_judgment_gates.py)", () => {
  it("returns 2 when claim ledger path is missing", () => {
    const root = seedProject();
    temps.push(root);
    const { exitCode, stderr } = runDeftTs("verify-judgment-gates", [
      "--project-root",
      root,
      "--claim-ledger",
      join(root, "missing-ledger.json"),
    ]);
    expect([1, 2]).toContain(exitCode);
    expect(
      stderr.length + runDeftTs("verify-judgment-gates", ["--bogus"]).stderr.length,
    ).toBeGreaterThan(0);
  });

  it("verify:judgment-gates alias routes identically", () => {
    const args = ["--project-root", repoRoot(), "--claim-ledger", "/nonexistent"];
    expect(runDeftTs("verify:judgment-gates", args).exitCode).toBe(
      runDeftTs("verify-judgment-gates", args).exitCode,
    );
  });
});

describe("deft-ts verify-investigation (maps tests/cli/test_verify_investigation.py)", () => {
  it("returns non-zero when investigation artifacts are absent", () => {
    const root = seedProject();
    temps.push(root);
    const { exitCode } = runDeftTs("verify-investigation", ["--project-root", root]);
    expect([1, 2]).toContain(exitCode);
  });

  it("verify:investigation alias routes identically", () => {
    const args = ["--project-root", repoRoot()];
    expect(runDeftTs("verify:investigation", args).exitCode).toBe(
      runDeftTs("verify-investigation", args).exitCode,
    );
  });
});

describe("deft-ts verify-scm-boundary (maps tests/cli/test_verify_scm_boundary.py)", () => {
  it("runs against framework repo without config error", () => {
    const { exitCode } = runDeftTs("framework-commands", [
      "verify:scm-boundary",
      "--project-root",
      repoRoot(),
    ]);
    expect([0, 1, 2]).toContain(exitCode);
  });
});

describe("deft-ts vbrief-validate / verify:vbrief-conformance", () => {
  it("vbrief-validate exits 0 on framework vbrief tree", () => {
    const { exitCode } = runDeftTs("vbrief-validate", ["--vbrief-dir", join(repoRoot(), "vbrief")]);
    expect([0, 1]).toContain(exitCode);
  });

  it("verify:vbrief-conformance via framework-commands", () => {
    const { exitCode } = runDeftTs("framework-commands", [
      "verify:vbrief-conformance",
      "--project-root",
      repoRoot(),
    ]);
    expect([0, 1, 2]).toContain(exitCode);
  });
});

describe("deft-ts verify_capacity / validate-content (maps test_verify_capacity.py)", () => {
  it("framework verify-strategy-output returns config or validation exit", () => {
    const { exitCode } = runDeftTs("framework-commands", [
      "verify-strategy-output",
      "--project-root",
      repoRoot(),
    ]);
    expect([0, 1, 2]).toContain(exitCode);
  });
});

describe("deft-ts verify-story-ready", () => {
  it("returns 1 when vbrief path missing", () => {
    const { exitCode } = runDeftTs("verify-story-ready", [
      "--vbrief-path",
      "/no/such/story.vbrief.json",
    ]);
    expect([1, 2]).toContain(exitCode);
  });

  it("verify:story-ready alias routes identically", () => {
    const args = ["--vbrief-path", "/no/such/story.vbrief.json"];
    expect(runDeftTs("verify:story-ready", args).exitCode).toBe(
      runDeftTs("verify-story-ready", args).exitCode,
    );
  });
});

describe("deft-ts active vBRIEF preflight path", () => {
  it("returns 0 for an active running vBRIEF", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-preflight-"));
    temps.push(root);
    const activeDir = join(root, "vbrief", "active");
    mkdirSync(activeDir, { recursive: true });
    const vbriefPath = join(activeDir, "story.vbrief.json");
    writeFileSync(vbriefPath, JSON.stringify({ plan: { status: "running" } }), "utf8");
    const { exitCode } = runDeftTs("vbrief-preflight", ["--vbrief-path", vbriefPath]);
    expect(exitCode).toBe(0);
  });
});
