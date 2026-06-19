import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "./triage-scope.js";
import {
  buildFixtureRepo,
  diffCase,
  normalizeOutput,
  renderReport,
} from "./triage-scope-parity.js";

describe("triage-scope parity harness", () => {
  it("normalizes paths", () => {
    expect(normalizeOutput("path=/tmp/x/.deft-cache/github-issue/o/r/coverage.json")).toBe(
      "path=<ROOT>/coverage.json",
    );
  });

  it("diffCase detects mismatches", () => {
    const diff = diffCase(
      { exitCode: 0, stdout: "a", stderr: "" },
      { exitCode: 1, stdout: "b", stderr: "" },
      "x",
    );
    expect(diff.exitMismatch).toBe(true);
    expect(diff.stdoutMismatch).toBe(true);
  });

  it("renderReport clean and divergent", () => {
    expect(renderReport({ ok: true, diffs: [] })).toContain("CLEAN");
    expect(
      renderReport({
        ok: false,
        diffs: [
          {
            caseName: "x",
            exitMismatch: true,
            stdoutMismatch: true,
            stderrMismatch: true,
            pythonExit: 0,
            tsExit: 1,
          },
        ],
      }),
    ).toContain("DIVERGENCE");
    expect(
      renderReport({
        ok: false,
        diffs: [
          {
            caseName: "y",
            exitMismatch: false,
            stdoutMismatch: true,
            stderrMismatch: false,
            pythonExit: 0,
            tsExit: 0,
          },
        ],
      }),
    ).toContain("stdout mismatch");
  });

  it("buildFixtureRepo creates project definition", () => {
    const root = buildFixtureRepo({ policy: { triageScope: [{ rule: "all-open" }] } });
    expect(root.length).toBeGreaterThan(0);
  });
});

describe("triage-scope thin CLI", () => {
  it("run delegates to core cli", () => {
    const root = mkdtempSync(join(tmpdir(), "thin-cli-"));
    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "packages/cli/dist/triage-scope.js"), "--project-root", root, "--list"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("effective rules");
  });

  it("run function returns exit code for missing path", () => {
    const code = run(["--project-root", "/definitely-missing-deft-path", "--list"]);
    expect(code).toBe(2);
  });

  it("run function returns zero for successful list", () => {
    const root = mkdtempSync(join(tmpdir(), "thin-cli-ok-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      `${JSON.stringify({ plan: { title: "T", status: "running", items: [] } })}\n`,
      "utf8",
    );
    expect(run(["--project-root", root, "--list"])).toBe(0);
  });
});
