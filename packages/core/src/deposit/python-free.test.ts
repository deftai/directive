import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectPythonArtifacts,
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

  it("collectPythonArtifacts reports scripts/, .py files, and run shims", async () => {
    const deposit = join(freshRoot("py-artifacts-"), "core");
    mkdirSync(join(deposit, "scripts"), { recursive: true });
    writeFileSync(join(deposit, "scripts", "probe.py"), "# probe\n", "utf8");
    writeFileSync(join(deposit, "run"), "#!/usr/bin/env python3\n", "utf8");
    writeFileSync(join(deposit, "legacy.pyc"), "\x00\n", "utf8");

    const artifacts = await collectPythonArtifacts(deposit);
    expect(artifacts.some((a) => a.kind === "scripts-tree")).toBe(true);
    expect(artifacts.some((a) => a.path.endsWith("probe.py"))).toBe(true);
    expect(artifacts.some((a) => a.kind === "run-shim")).toBe(true);
  });

  it("prunePythonArtifactsFromDeposit removes scripts/, .py files, and run shims", async () => {
    const project = freshRoot("py-prune-");
    const deposit = join(project, ".deft", "core");
    mkdirSync(join(deposit, "scripts"), { recursive: true });
    writeFileSync(join(deposit, "scripts", "probe.py"), "# probe\n", "utf8");
    writeFileSync(join(deposit, "run"), "#!/usr/bin/env python3\n", "utf8");
    writeFileSync(join(deposit, "main.md"), "# Deft\n", "utf8");
    writeFileSync(join(project, "run"), "#!/usr/bin/env python3\n", "utf8");

    const removed = await prunePythonArtifactsFromDeposit(deposit, project);
    expect(removed).toBeGreaterThan(0);
    expect(existsSync(join(deposit, "scripts"))).toBe(false);
    expect(existsSync(join(deposit, "run"))).toBe(false);
    expect(existsSync(join(deposit, "main.md"))).toBe(true);
    expect(existsSync(join(project, "run"))).toBe(false);
    expect(collectPythonArtifacts(deposit)).toEqual([]);
    expect(isRepoRootPythonRunShim(project)).toBe(false);
  });
});
