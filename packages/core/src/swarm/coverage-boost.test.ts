import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { completeCohort, resolveCohortPaths, sweepCohort } from "./complete-cohort.js";
import { defaultRuntimeAuthProbe, enforceGates, resolveStories, swarmLaunch } from "./launch.js";
import { launchMain } from "./launch-cli.js";
import { expandReadinessPaths } from "./readiness.js";
import { readinessMain } from "./readiness-cli.js";
import { resolveSwarmSubagentBackend } from "./subagent-backend.js";
import { runText } from "./subprocess.js";
import { evaluatePr, renderReviewCleanText, verifyReviewClean } from "./verify-review-clean.js";
import { compareKey, loadWorktreeMapFile, WorktreeMapConfigError } from "./worktrees.js";
import { worktreesMain } from "./worktrees-cli.js";

describe("swarm coverage boost", () => {
  it("covers subprocess and compareKey helpers", () => {
    expect(compareKey("/Foo/Bar")).toBe("/foo/bar");
    const bad = runText(["nonexistent-binary-xyz"]);
    expect(bad.returncode).not.toBe(0);
  });

  it("covers resolve cohort paths and empty sweep", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-cov-"));
    mkdirSync(join(project, "vbrief", "active"), { recursive: true });
    const story = join(project, "vbrief", "active", "x.vbrief.json");
    writeFileSync(story, JSON.stringify({ plan: { status: "running", items: [] } }), "utf8");
    const { paths } = resolveCohortPaths([story], [], project);
    expect(paths.length).toBe(1);
    const sweep = sweepCohort(paths, project, true);
    expect(sweep.stories.length).toBe(1);
    rmSync(project, { recursive: true, force: true });
  });

  it("covers launch gate seams and resolve errors", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-lch-"));
    mkdirSync(join(project, "vbrief", "active"), { recursive: true });
    const { errors } = resolveStories(project, ["missing-id"]);
    expect(errors.length).toBe(1);
    const [runtimeMode, authMode] = defaultRuntimeAuthProbe();
    expect(runtimeMode.length).toBeGreaterThan(0);
    expect(authMode.length).toBeGreaterThan(0);
    rmSync(project, { recursive: true, force: true });
  });

  it("covers launch config errors", () => {
    const result = swarmLaunch({ stories: [], projectRoot: "/tmp" });
    expect(result.exitCode).toBe(2);
  });

  it("covers verify review clean render and evaluate null", () => {
    const text = renderReviewCleanText({
      repo: "deftai/directive",
      pr_results: [],
      resolution_errors: [],
      all_clean: false,
    });
    expect(text).toContain("0 PR");
    const per = evaluatePr(1, "deftai/directive", () => ({
      returncode: 1,
      stdout: "",
      stderr: "fail",
    }));
    expect(per).toBeNull();
  });

  it("covers cli main usage paths", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "sw-cli-"));
    expect(worktreesMain([])).toBe(2);
    expect(readinessMain(["--project-root", emptyRoot])).toBe(1);
    expect(typeof launchMain(["--stories", ""])).toBe("number");
  });

  it("covers expandReadinessPaths default glob", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-exp-"));
    mkdirSync(join(project, "vbrief", "active"), { recursive: true });
    writeFileSync(
      join(project, "vbrief", "active", "z.vbrief.json"),
      JSON.stringify({ plan: { id: "z", status: "running", items: [] } }),
      "utf8",
    );
    const paths = expandReadinessPaths(project, []);
    expect(paths.some((p) => p.endsWith("z.vbrief.json"))).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("covers loadWorktreeMapFile invalid json", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-map-"));
    const bad = join(project, "bad.json");
    writeFileSync(bad, "not-json", "utf8");
    expect(() => loadWorktreeMapFile(bad)).toThrow(WorktreeMapConfigError);
    rmSync(project, { recursive: true, force: true });
  });

  it("covers resolveSwarmSubagentBackend missing file", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-pol2-"));
    const result = resolveSwarmSubagentBackend(project);
    expect(result.backend_id).toBeNull();
    rmSync(project, { recursive: true, force: true });
  });

  it("covers completeCohort json empty path", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-cc-"));
    mkdirSync(join(project, "vbrief"), { recursive: true });
    const result = completeCohort({ projectRoot: project, stories: [], emitJson: true });
    expect(result.exitCode).toBe(2);
    rmSync(project, { recursive: true, force: true });
  });

  it("covers enforceGates with stub gates", () => {
    const story = {
      token: "1",
      story_id: "s",
      path: "/x",
      relpath: "vbrief/active/x.vbrief.json",
    };
    const fail = enforceGates(
      [story],
      "/tmp",
      () => ({ exitCode: 1, message: "nope" }),
      () => ({ exitCode: 0, report: "ok" }),
    );
    expect(fail?.reason).toContain("preflight");
    const ok = enforceGates(
      [story],
      "/tmp",
      () => ({ exitCode: 0, message: "ok" }),
      () => ({ exitCode: 0, report: "ok" }),
    );
    expect(ok).toBeNull();
  });

  it("covers verifyReviewClean json empty", () => {
    const result = verifyReviewClean({ prNumbers: [], emitJson: true });
    expect(result.exitCode).toBe(2);
  });
});
