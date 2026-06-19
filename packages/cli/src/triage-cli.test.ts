import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFixtureRepo,
  diffCase,
  normalizeOutput,
  PARITY_CASES,
  renderReport,
  resolveDeftRoot,
  runParity,
} from "./triage-aux-a-parity.js";
import { parseArgs as parseReconcile, run as runReconcile } from "./triage-reconcile.js";
import { parseArgs as parseRefresh, run as runRefresh } from "./triage-refresh.js";
import { parseArgs as parseScopeDrift, run as runScopeDrift } from "./triage-scope-drift.js";
import { parseArgs as parseWelcome, run as runWelcome } from "./triage-welcome.js";

describe("triage CLI parsers", () => {
  it("parses welcome flags", () => {
    expect(parseWelcome(["--no-history"]).noHistory).toBe(true);
    expect(parseWelcome(["--onboard"]).onboard).toBe(true);
    expect(parseWelcome(["--project-root=/tmp"]).projectRoot).toBe("/tmp");
    expect(parseWelcome(["--task-prefix", "task"]).taskPrefix).toBe("task");
    expect(parseWelcome(["--skip-bootstrap"]).error).toBeUndefined();
  });

  it("parses reconcile json", () => {
    expect(parseReconcile(["--dry-run", "--json"]).emitJson).toBe(true);
    expect(parseReconcile(["--repo=deftai/directive"]).repo).toBe("deftai/directive");
  });

  it("parses refresh root", () => {
    expect(parseRefresh(["--project-root", "/tmp"]).projectRoot).toBe("/tmp");
    expect(parseRefresh(["--project-root=/x"]).projectRoot).toBe("/x");
  });

  it("parses scope-drift ignore", () => {
    expect(parseScopeDrift(["--ignore-label", "x"]).ignoreLabel).toBe("x");
    expect(parseScopeDrift(["--threshold=5"]).threshold).toBe(5);
    expect(parseScopeDrift(["--cache-root=/c"]).cacheRoot).toBe("/c");
  });

  it("rejects unknown welcome flag", () => {
    expect(parseWelcome(["--bogus"]).error).toBeDefined();
  });

  it("rejects missing project-root value", () => {
    expect(parseWelcome(["--project-root"]).error).toBeDefined();
    expect(parseRefresh(["--project-root"]).error).toBeDefined();
    expect(parseReconcile(["--repo"]).error).toBeDefined();
  });
});

describe("triage CLI runners", () => {
  it("runs welcome default on temp dir", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-welcome-"));
    expect(runWelcome(["--no-history", "--project-root", root])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("runs reconcile dry-run json", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-reconcile-"));
    expect(runReconcile(["--dry-run", "--json", "--project-root", root])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("runs refresh on empty active", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-refresh-"));
    expect(runRefresh(["--project-root", root])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects mutual exclusive ignore flags at CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-drift2-"));
    expect(
      runScopeDrift(["--ignore-label", "a", "--ignore-milestone", "b", "--project-root", root]),
    ).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });

  it("handles ignore-label no-op path", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-drift3-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ plan: { policy: { triageScopeIgnores: [{ label: "x" }] } } }),
      "utf8",
    );
    expect(runScopeDrift(["--ignore-label", "x", "--project-root", root])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects bad project root for reconcile", () => {
    expect(runReconcile(["--project-root", join(tmpdir(), "missing-reconcile-dir-xyz")])).toBe(2);
  });

  it("runs welcome onboard exit 2", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-welcome-onb-"));
    expect(runWelcome(["--onboard", "--project-root", root])).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });

  it("runs welcome bad root", () => {
    expect(runWelcome(["--project-root", join(tmpdir(), "missing-welcome-xyz")])).toBe(2);
  });

  it("runs reconcile text summary", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-reconcile-text-"));
    expect(runReconcile(["--project-root", root])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("runs scope-drift report with threshold", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-drift-th-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "{}", "utf8");
    expect(runScopeDrift(["--threshold", "2", "--project-root", root])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("runs scope-drift ignore-milestone changed", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-drift-ms-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ plan: { policy: {} } }),
      "utf8",
    );
    expect(runScopeDrift(["--ignore-milestone", "m1", "--project-root", root])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("runs scope-drift bad root", () => {
    expect(runScopeDrift(["--project-root", join(tmpdir(), "missing-drift-xyz")])).toBe(2);
  });

  it("runs welcome with task prefix", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-welcome-tp-"));
    expect(runWelcome(["--no-history", "--task-prefix", "deft", "--project-root", root])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("runs reconcile with repo filter", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-reconcile-repo-"));
    expect(runReconcile(["--dry-run", "--repo=deftai/directive", "--project-root", root])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects unknown refresh flag", () => {
    expect(runRefresh(["--nope"])).toBe(2);
  });
});

describe("triage-aux-a parity helpers", () => {
  it("normalizes project_root paths", () => {
    expect(normalizeOutput('root /tmp/foo "project_root": "/tmp/foo"')).toContain("<ROOT>");
  });

  it("diffCase detects exit mismatch", () => {
    const diff = diffCase(
      { exitCode: 0, stdout: "a", stderr: "" },
      { exitCode: 1, stdout: "a", stderr: "" },
      "x",
    );
    expect(diff.exitMismatch).toBe(true);
  });

  it("runParity matches python oracle", () => {
    const result = runParity();
    expect(result.ok).toBe(true);
    expect(renderReport(result)).toContain("CLEAN");
  });

  it("diffCase detects stdout and stderr mismatch", () => {
    const exitOnly = diffCase(
      { exitCode: 0, stdout: "a", stderr: "" },
      { exitCode: 0, stdout: "b", stderr: "" },
      "x",
    );
    expect(exitOnly.stdoutMismatch).toBe(true);
    const errOnly = diffCase(
      { exitCode: 0, stdout: "a", stderr: "e1" },
      { exitCode: 0, stdout: "a", stderr: "e2" },
      "y",
    );
    expect(errOnly.stderrMismatch).toBe(true);
  });

  it("renderReport lists stdout/stderr mismatch", () => {
    const report = renderReport({
      ok: false,
      diffs: [
        {
          caseName: "z",
          exitMismatch: false,
          stdoutMismatch: true,
          stderrMismatch: true,
          pythonExit: 0,
          tsExit: 0,
        },
      ],
    });
    expect(report).toContain("stdout mismatch");
    expect(report).toContain("stderr mismatch");
  });

  it("resolveDeftRoot honors DEFT_ROOT", () => {
    const prev = process.env.DEFT_ROOT;
    process.env.DEFT_ROOT = "/custom/deft";
    expect(resolveDeftRoot()).toBe("/custom/deft");
    delete process.env.DEFT_ROOT;
    if (prev !== undefined) process.env.DEFT_ROOT = prev;
  });

  it("buildFixtureRepo applies setup", () => {
    const root = buildFixtureRepo((r) =>
      mkdirSync(join(r, "vbrief", "active"), { recursive: true }),
    );
    expect(root.length).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });
});
