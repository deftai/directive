import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isDeclaredLiveProcedureExclusion } from "./live-procedure-exclusions.js";
import {
  evaluateLiveProcedureTargets,
  formatLiveProcedureFailure,
  LIVE_PROCEDURE_METRIC,
  normalizePythonHelperTarget,
} from "./live-procedure-targets.js";
import { isPythonHelperPath } from "./python-free.js";

describe("C3 live-procedure target validation (#3602)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function staged(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    created.push(root);
    return root;
  }

  it("states the metric as unique targets, not occurrences or matching lines", () => {
    expect(LIVE_PROCEDURE_METRIC).toBe("unique-targets");
    const root = staged("c3-metric-");
    mkdirSync(join(root, "skills", "demo"), { recursive: true });
    writeFileSync(
      join(root, "skills", "demo", "SKILL.md"),
      "! run `scripts/missing.py`\n! also `scripts/missing.py` again\n",
      "utf8",
    );
    const result = evaluateLiveProcedureTargets({ stagedRoot: root });
    expect(result.metric).toBe("unique-targets");
    expect(result.hits.length).toBe(2);
    expect(result.uniqueTargets).toEqual(["scripts/missing.py"]);
  });

  it("fails on a deliberately mutated staged tree (non-vacuous)", () => {
    const root = staged("c3-mut-");
    mkdirSync(join(root, "skills", "demo"), { recursive: true });
    writeFileSync(
      join(root, "skills", "demo", "SKILL.md"),
      [
        "# Demo",
        "",
        "! Agents MUST run `scripts/missing.py` before preflight.",
        "Also see [helper](../../scripts/missing.py).",
        "Skip http://example.com/scripts/missing.py and [scripts/missing.py]({templated}).",
      ].join("\n"),
      "utf8",
    );
    const result = evaluateLiveProcedureTargets({ stagedRoot: root });
    expect(result.uniqueTargets).toEqual(["scripts/missing.py"]);
    expect(formatLiveProcedureFailure(result)).toContain("scripts/missing.py");
  });

  it("skips a declared prohibition file rather than pattern-matching Python mentions", () => {
    expect(isDeclaredLiveProcedureExclusion("scm/github.md")).toBe(true);
    const root = staged("c3-prohibit-");
    mkdirSync(join(root, "scm"), { recursive: true });
    writeFileSync(
      join(root, "scm", "github.md"),
      [
        "# GitHub",
        "",
        "- ⊗ Reference `scripts/_safe_subprocess.py` as a live implementation path.",
      ].join("\n"),
      "utf8",
    );
    const result = evaluateLiveProcedureTargets({ stagedRoot: root });
    expect(result.uniqueTargets).toEqual([]);
    expect(result.hits).toEqual([]);
  });

  it("normalizes deposit and link-shaped Python helper paths", () => {
    expect(normalizePythonHelperTarget("../../scripts/ip_risk.py")).toBe("scripts/ip_risk.py");
    expect(normalizePythonHelperTarget(".deft/core/scripts/validate_strategy_output.py")).toBe(
      "scripts/validate_strategy_output.py",
    );
    expect(normalizePythonHelperTarget("https://example.com/scripts/ip_risk.py")).toBeNull();
    expect(normalizePythonHelperTarget("scripts/../secrets.py")).toBeNull();
    expect(normalizePythonHelperTarget("[path]")).toBeNull();
    expect(isPythonHelperPath("scripts/ip_risk.py")).toBe(true);
    expect(isPythonHelperPath("tasks/verify.yml")).toBe(false);
  });

  it("detects pruned .py helpers outside scripts/ (compose python-free)", () => {
    expect(normalizePythonHelperTarget("tools/missing.py")).toBe("tools/missing.py");
    expect(normalizePythonHelperTarget("../../packages/core/legacy.pyc")).toBe(
      "packages/core/legacy.pyc",
    );
    expect(normalizePythonHelperTarget("app.py")).toBeNull();
    const root = staged("c3-nonscripts-");
    mkdirSync(join(root, "skills", "demo"), { recursive: true });
    writeFileSync(
      join(root, "skills", "demo", "SKILL.md"),
      "! run `tools/missing.py` then `packages/core/legacy.pyc`\n",
      "utf8",
    );
    const result = evaluateLiveProcedureTargets({ stagedRoot: root });
    expect(result.uniqueTargets).toEqual(["packages/core/legacy.pyc", "tools/missing.py"]);
  });

  it("skips planning, history/archive, missing roots, and excluded extra files", () => {
    const root = staged("c3-skip-");
    mkdirSync(join(root, ".planning"), { recursive: true });
    writeFileSync(join(root, ".planning", "MAP.md"), "`scripts/hidden.py`\n", "utf8");
    mkdirSync(join(root, "history", "archive"), { recursive: true });
    writeFileSync(join(root, "history", "archive", "old.md"), "`scripts/hidden.py`\n", "utf8");
    mkdirSync(join(root, "scm"), { recursive: true });
    writeFileSync(join(root, "scm", "github.md"), "`scripts/hidden.py`\n", "utf8");
    writeFileSync(
      join(root, "note.md"),
      [
        "[abs](http://example.com/docs)",
        "[mail](mailto:dev@example.com)",
        "[hash](#anchor)",
        "[skip]({templated})",
        "bare scripts/notpy",
      ].join("\n"),
      "utf8",
    );
    const result = evaluateLiveProcedureTargets({
      stagedRoot: root,
      extraFiles: [{ relativePath: "scm/github.md", absolutePath: join(root, "scm", "github.md") }],
    });
    expect(result.uniqueTargets).toEqual([]);
    expect(evaluateLiveProcedureTargets({ stagedRoot: join(root, "no-such") }).hits).toEqual([]);
    const notDir = join(root, "not-a-dir");
    writeFileSync(notDir, "x\n", "utf8");
    expect(evaluateLiveProcedureTargets({ stagedRoot: notDir }).hits).toEqual([]);
    expect(normalizePythonHelperTarget("scripts/foo")).toBeNull();
    expect(isDeclaredLiveProcedureExclusion("scm\\github.md")).toBe(true);
  });

  it("truncates the failure listing and skips unreadable extra files", () => {
    const root = staged("c3-trunc-");
    mkdirSync(join(root, "skills", "demo"), { recursive: true });
    const lines = Array.from({ length: 45 }, (_, i) => `! run \`scripts/missing${i}.py\``);
    writeFileSync(join(root, "skills", "demo", "SKILL.md"), `${lines.join("\n")}\n`, "utf8");
    const result = evaluateLiveProcedureTargets({
      stagedRoot: root,
      extraFiles: [{ relativePath: "gone.md", absolutePath: join(root, "no-such.md") }],
    });
    expect(result.hits.length).toBe(45);
    expect(formatLiveProcedureFailure(result)).toContain("more occurrence(s)");
  });

  it("source checkout has zero unique live-invalid helper targets after exclusions", () => {
    const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
    const result = evaluateLiveProcedureTargets({
      stagedRoot: join(repoRoot, "content"),
      extraFiles: [
        { relativePath: "main.md", absolutePath: join(repoRoot, "main.md") },
        { relativePath: "SKILL.md", absolutePath: join(repoRoot, "SKILL.md") },
      ],
    });
    expect(result.metric).toBe("unique-targets");
    expect(result.uniqueTargets, formatLiveProcedureFailure(result)).toEqual([]);
  });
});
