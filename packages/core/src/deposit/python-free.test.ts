import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWithMutationLedger, snapshotMutationSummary } from "../fs/mutation-ledger.js";
import {
  collectPythonArtifacts,
  isPythonHelperPath,
  isRepoRootPythonRunShim,
  prunePythonArtifactsFromDeposit,
} from "./python-free.js";

describe("python-free deposit hygiene (#2022 Phase 3)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    created.push(root);
    return root;
  }

  it("collectPythonArtifacts reports scripts/, .py files, and run shims", () => {
    const deposit = join(freshRoot("py-artifacts-"), "core");
    mkdirSync(join(deposit, "scripts"), { recursive: true });
    writeFileSync(join(deposit, "scripts", "probe.py"), "# probe\n", "utf8");
    writeFileSync(join(deposit, "run"), "#!/usr/bin/env python3\n", "utf8");
    writeFileSync(join(deposit, "legacy.pyc"), "\x00\n", "utf8");
    mkdirSync(join(deposit, "__pycache__"), { recursive: true });

    const artifacts = collectPythonArtifacts(deposit);
    expect(artifacts.some((a) => a.kind === "scripts-tree")).toBe(true);
    expect(artifacts.some((a) => a.path.endsWith("probe.py"))).toBe(true);
    expect(artifacts.some((a) => a.kind === "run-shim")).toBe(true);
    expect(artifacts.some((a) => a.path.includes("__pycache__"))).toBe(true);
  });

  it("isPythonHelperPath identifies pruned .py helpers (#3602 C3)", () => {
    expect(isPythonHelperPath("scripts/ip_risk.py")).toBe(true);
    expect(isPythonHelperPath("legacy.pyc")).toBe(true);
    expect(isPythonHelperPath("tasks/verify.yml")).toBe(false);
  });

  it("collectPythonArtifacts ignores non-python run shims and absent trees", () => {
    const deposit = join(freshRoot("py-clean-"), "core");
    mkdirSync(deposit, { recursive: true });
    writeFileSync(join(deposit, "run"), "#!/usr/bin/env node\nconsole.log('ok')\n", "utf8");
    expect(collectPythonArtifacts(deposit)).toEqual([]);
    expect(isRepoRootPythonRunShim(join(freshRoot("py-no-run-")))).toBe(false);
  });

  it("prunePythonArtifactsFromDeposit removes scripts/, .py files, and run shims", async () => {
    const project = freshRoot("py-prune-");
    const deposit = join(project, ".deft", "core");
    mkdirSync(join(deposit, "scripts"), { recursive: true });
    writeFileSync(join(deposit, "scripts", "probe.py"), "# probe\n", "utf8");
    writeFileSync(join(deposit, "run"), "#!/usr/bin/env python3\n", "utf8");
    writeFileSync(join(deposit, "main.md"), "# Deft\n", "utf8");
    writeFileSync(join(project, "run"), "#!/usr/bin/env python3\n", "utf8");

    const lines: string[] = [];
    const removed = await prunePythonArtifactsFromDeposit(deposit, project, {
      printf: (text) => {
        lines.push(text);
      },
    });
    expect(removed).toBeGreaterThan(0);
    expect(lines.length).toBeGreaterThan(0);
    expect(existsSync(join(deposit, "scripts"))).toBe(false);
    expect(existsSync(join(deposit, "run"))).toBe(false);
    expect(existsSync(join(deposit, "main.md"))).toBe(true);
    expect(existsSync(join(project, "run"))).toBe(false);
    expect(collectPythonArtifacts(deposit)).toEqual([]);
    expect(isRepoRootPythonRunShim(project)).toBe(false);
  });

  it("collectPythonArtifacts treats unreadable run files as shims", () => {
    const deposit = join(freshRoot("py-unreadable-run-"), "core");
    mkdirSync(deposit, { recursive: true });
    const runPath = join(deposit, "run");
    writeFileSync(runPath, "#!/usr/bin/env python3\n", "utf8");
    chmodSync(runPath, 0o000);
    try {
      expect(collectPythonArtifacts(deposit).some((a) => a.kind === "run-shim")).toBe(true);
    } finally {
      chmodSync(runPath, 0o644);
    }
  });

  it("isRepoRootPythonRunShim treats unreadable run files as shims", () => {
    const project = freshRoot("py-unreadable-project-run-");
    const runPath = join(project, "run");
    writeFileSync(runPath, "#!/usr/bin/env python3\n", "utf8");
    chmodSync(runPath, 0o000);
    try {
      expect(isRepoRootPythonRunShim(project)).toBe(true);
    } finally {
      chmodSync(runPath, 0o644);
    }
  });

  it("collectPythonArtifacts ignores a scripts file that is not a directory", () => {
    const deposit = join(freshRoot("py-scripts-file-"), "core");
    mkdirSync(join(deposit, "nested"), { recursive: true });
    writeFileSync(join(deposit, "scripts"), "not-a-directory\n", "utf8");
    writeFileSync(join(deposit, "nested", "tool.py"), "# x\n", "utf8");
    expect(collectPythonArtifacts(deposit).some((a) => a.path.endsWith("tool.py"))).toBe(true);
    expect(collectPythonArtifacts(deposit).some((a) => a.kind === "scripts-tree")).toBe(false);
  });

  it("isRepoRootPythonRunShim returns false for non-shebang run files", () => {
    const project = freshRoot("py-plain-run-");
    writeFileSync(join(project, "run"), "echo hi\n", "utf8");
    expect(isRepoRootPythonRunShim(project)).toBe(false);
  });

  it("prunePythonArtifactsFromDeposit removes nested .py files", async () => {
    const project = freshRoot("py-prune-extra-");
    const deposit = join(project, ".deft", "core");
    mkdirSync(join(deposit, "pkg", "__pycache__"), { recursive: true });
    writeFileSync(join(deposit, "pkg", "mod.pyc"), "\x00\n", "utf8");
    const runPath = join(deposit, "run");
    writeFileSync(runPath, "#!/usr/bin/env python3\n", "utf8");
    chmodSync(runPath, 0o000);

    try {
      const removed = await prunePythonArtifactsFromDeposit(deposit, project);
      expect(removed).toBeGreaterThan(0);
      expect(existsSync(join(deposit, "pkg", "__pycache__"))).toBe(false);
      expect(existsSync(runPath)).toBe(false);
    } finally {
      if (existsSync(runPath)) chmodSync(runPath, 0o644);
    }
  });

  it("prunePythonArtifactsFromDeposit keeps non-python deposit run shims", async () => {
    const project = freshRoot("py-keep-node-run-");
    const deposit = join(project, ".deft", "core");
    mkdirSync(deposit, { recursive: true });
    writeFileSync(join(deposit, "run"), "#!/usr/bin/env node\n", "utf8");
    expect(await prunePythonArtifactsFromDeposit(deposit, project)).toBe(0);
    expect(existsSync(join(deposit, "run"))).toBe(true);
  });

  it("collectPythonArtifacts returns empty for a clean deposit tree", () => {
    const deposit = join(freshRoot("py-empty-deposit-"), "core");
    mkdirSync(deposit, { recursive: true });
    writeFileSync(join(deposit, "Taskfile.yml"), "version: '3'\n", "utf8");
    expect(collectPythonArtifacts(deposit)).toEqual([]);
  });

  it("ledgers prune deletes when a ledger is bound (#3392)", async () => {
    const project = freshRoot("py-prune-ledger-");
    const deposit = join(project, ".deft", "core");
    mkdirSync(join(deposit, "scripts"), { recursive: true });
    writeFileSync(join(deposit, "scripts", "probe.py"), "# probe\n", "utf8");
    writeFileSync(join(deposit, "legacy.pyc"), "\x00\n", "utf8");
    writeFileSync(join(deposit, "run"), "#!/usr/bin/env python3\n", "utf8");
    writeFileSync(join(project, "run"), "#!/usr/bin/env python3\n", "utf8");

    const summary = await runWithMutationLedger(project, async () => {
      await prunePythonArtifactsFromDeposit(deposit, project);
      return snapshotMutationSummary();
    });

    expect(summary.deleted).toEqual(
      expect.arrayContaining([
        ".deft/core/scripts",
        ".deft/core/legacy.pyc",
        ".deft/core/run",
        "run",
      ]),
    );
    expect(summary.deleted).not.toEqual([]);
  });

  it("prunePythonArtifactsFromDeposit is a no-op on an already-clean deposit", async () => {
    const project = freshRoot("py-clean-deposit-");
    const deposit = join(project, ".deft", "core");
    mkdirSync(deposit, { recursive: true });
    writeFileSync(join(deposit, "Taskfile.yml"), "version: '3'\n", "utf8");
    expect(await prunePythonArtifactsFromDeposit(deposit, project)).toBe(0);
  });
});
