import { describe, expect, it } from "vitest";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import { EXIT_CONFIG_ERROR, EXIT_TIMEOUT_OR_ESCALATION } from "./constants.js";
import { evaluateSemanticGreen } from "./semantic-green.js";

const PR = 2379;
const REPO = "deftai/directive";
const SPINE_HEAD = "d".repeat(40);
const PRE_SPINE_BASE = "a".repeat(40);
const CURRENT_HEAD = "b".repeat(40);

function makeRunGh(handlers: Record<string, RunGhFn>): RunGhFn {
  return (cmd) => {
    const joined = cmd.join(" ");
    for (const [needle, handler] of Object.entries(handlers)) {
      if (joined.includes(needle)) {
        return handler(cmd);
      }
    }
    return { returncode: 1, stdout: "", stderr: `unexpected gh call: ${joined}` };
  };
}

function pullsHandler(baseSha: string, baseRef = "master"): RunGhFn {
  return () => ({
    returncode: 0,
    stdout: JSON.stringify({
      base: { ref: baseRef, sha: baseSha },
      head: { sha: "c".repeat(40) },
    }),
    stderr: "",
  });
}

function branchRefHandler(headSha: string): RunGhFn {
  return () => ({
    returncode: 0,
    stdout: JSON.stringify({ object: { sha: headSha } }),
    stderr: "",
  });
}

function greenCheckRunsHandler(): RunGhFn {
  return () => ({
    returncode: 0,
    stdout: JSON.stringify({
      check_runs: [{ name: "CI", status: "completed", conclusion: "success" }],
    }),
    stderr: "",
  });
}

describe("evaluateSemanticGreen", () => {
  it("no-ops when cascade mode is off", () => {
    const result = evaluateSemanticGreen(PR, REPO, { cascadeMode: false });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBeNull();
  });

  it("rejects merge-tree-clean PR whose base is behind target HEAD (#2385)", () => {
    const runGh = makeRunGh({
      "/pulls/": pullsHandler(PRE_SPINE_BASE),
      "/git/ref/heads/": branchRefHandler(SPINE_HEAD),
    });
    const result = evaluateSemanticGreen(PR, REPO, { cascadeMode: true, runGh });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("semantic-stale-base");
    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(result.error).toContain("semantically stale");
    expect(result.payload.pr_base_sha).toBe(PRE_SPINE_BASE);
    expect(result.payload.target_head_sha).toBe(SPINE_HEAD);
  });

  it("passes when PR base matches target HEAD", () => {
    const runGh = makeRunGh({
      "/pulls/": pullsHandler(CURRENT_HEAD),
      "/git/ref/heads/": branchRefHandler(CURRENT_HEAD),
    });
    const result = evaluateSemanticGreen(PR, REPO, { cascadeMode: true, runGh });
    expect(result.ok).toBe(true);
  });

  it("blocks when require-master-ci-green and target branch CI is red", () => {
    const runGh = makeRunGh({
      "/pulls/": pullsHandler(CURRENT_HEAD),
      "/git/ref/heads/": branchRefHandler(CURRENT_HEAD),
      "/check-runs": () => ({
        returncode: 0,
        stdout: JSON.stringify({
          check_runs: [{ name: "CI", status: "completed", conclusion: "failure" }],
        }),
        stderr: "",
      }),
    });
    const result = evaluateSemanticGreen(PR, REPO, {
      cascadeMode: true,
      requireMasterCiGreen: true,
      runGh,
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("master-ci-not-green");
    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(result.error).toContain("Target branch CI is not green");
  });

  it("passes require-master-ci-green when target branch CI is ready", () => {
    const runGh = makeRunGh({
      "/pulls/": pullsHandler(CURRENT_HEAD),
      "/git/ref/heads/": branchRefHandler(CURRENT_HEAD),
      "/check-runs": greenCheckRunsHandler(),
    });
    const result = evaluateSemanticGreen(PR, REPO, {
      cascadeMode: true,
      requireMasterCiGreen: true,
      runGh,
    });
    expect(result.ok).toBe(true);
    expect(result.payload.master_ci.ready_state).toBe("ready");
  });

  it("surfaces gh failures as config-error", () => {
    const runGh = makeRunGh({
      "/pulls/": () => ({ returncode: 1, stdout: "", stderr: "rate limit" }),
    });
    const result = evaluateSemanticGreen(PR, REPO, { cascadeMode: true, runGh });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("config-error");
    expect(result.exitCode).toBe(EXIT_CONFIG_ERROR);
  });

  it("surfaces branch ref failures as config-error", () => {
    const runGh = makeRunGh({
      "/pulls/": pullsHandler(CURRENT_HEAD),
      "/git/ref/heads/": () => ({ returncode: 1, stdout: "", stderr: "not found" }),
    });
    const result = evaluateSemanticGreen(PR, REPO, { cascadeMode: true, runGh });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("config-error");
    expect(result.error).toContain("/git/ref/heads/");
  });

  it("surfaces check-runs fetch failures for master CI gate", () => {
    const runGh = makeRunGh({
      "/pulls/": pullsHandler(CURRENT_HEAD),
      "/git/ref/heads/": branchRefHandler(CURRENT_HEAD),
      "/check-runs": () => ({ returncode: 1, stdout: "", stderr: "api down" }),
    });
    const result = evaluateSemanticGreen(PR, REPO, {
      cascadeMode: true,
      requireMasterCiGreen: true,
      runGh,
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("master-ci-not-green");
    expect(result.error).toContain("could not be fetched");
  });

  it("honors explicit --base-branch override", () => {
    const runGh = makeRunGh({
      "/pulls/": pullsHandler(PRE_SPINE_BASE, "develop"),
      "/git/ref/heads/master": branchRefHandler(CURRENT_HEAD),
    });
    const result = evaluateSemanticGreen(PR, REPO, {
      cascadeMode: true,
      baseBranch: "master",
      runGh,
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("semantic-stale-base");
    expect(result.payload.target_branch).toBe("master");
  });

  it("covers malformed PR and branch ref payloads", () => {
    const cases: Array<{ label: string; runGh: RunGhFn; expectSub: string }> = [
      {
        label: "empty pulls body",
        runGh: makeRunGh({ "/pulls/": () => ({ returncode: 0, stdout: "", stderr: "" }) }),
        expectSub: "empty body",
      },
      {
        label: "invalid pulls json",
        runGh: makeRunGh({ "/pulls/": () => ({ returncode: 0, stdout: "{", stderr: "" }) }),
        expectSub: "could not parse PR JSON",
      },
      {
        label: "pulls array shape",
        runGh: makeRunGh({ "/pulls/": () => ({ returncode: 0, stdout: "[]", stderr: "" }) }),
        expectSub: "unexpected PR JSON shape",
      },
      {
        label: "missing base object",
        runGh: makeRunGh({ "/pulls/": () => ({ returncode: 0, stdout: "{}", stderr: "" }) }),
        expectSub: "missing base object",
      },
      {
        label: "empty branch ref body",
        runGh: makeRunGh({
          "/pulls/": pullsHandler(CURRENT_HEAD),
          "/git/ref/heads/": () => ({ returncode: 0, stdout: "", stderr: "" }),
        }),
        expectSub: "empty body from gh api /git/ref/heads/",
      },
      {
        label: "invalid branch ref json",
        runGh: makeRunGh({
          "/pulls/": pullsHandler(CURRENT_HEAD),
          "/git/ref/heads/": () => ({ returncode: 0, stdout: "{", stderr: "" }),
        }),
        expectSub: "could not parse branch ref JSON",
      },
      {
        label: "branch ref array shape",
        runGh: makeRunGh({
          "/pulls/": pullsHandler(CURRENT_HEAD),
          "/git/ref/heads/": () => ({ returncode: 0, stdout: "[]", stderr: "" }),
        }),
        expectSub: "unexpected branch ref JSON shape",
      },
      {
        label: "branch ref object without sha string",
        runGh: makeRunGh({
          "/pulls/": pullsHandler(CURRENT_HEAD),
          "/git/ref/heads/": () => ({
            returncode: 0,
            stdout: JSON.stringify({ object: { sha: 123 } }),
            stderr: "",
          }),
        }),
        expectSub: "branch ref JSON missing object.sha",
      },
      {
        label: "branch ref missing object",
        runGh: makeRunGh({
          "/pulls/": pullsHandler(CURRENT_HEAD),
          "/git/ref/heads/": () => ({
            returncode: 0,
            stdout: JSON.stringify({ object: null }),
            stderr: "",
          }),
        }),
        expectSub: "branch ref JSON missing object.sha",
      },
    ];
    for (const testCase of cases) {
      const result = evaluateSemanticGreen(PR, REPO, { cascadeMode: true, runGh: testCase.runGh });
      expect(result.ok, testCase.label).toBe(false);
      expect(result.error ?? "", testCase.label).toContain(testCase.expectSub);
    }
  });

  it("blocks master CI gate when required checks are still pending", () => {
    const runGh = makeRunGh({
      "/pulls/": pullsHandler(CURRENT_HEAD),
      "/git/ref/heads/": branchRefHandler(CURRENT_HEAD),
      "/check-runs": () => ({
        returncode: 0,
        stdout: JSON.stringify({
          check_runs: [{ name: "CI", status: "queued", conclusion: "none" }],
        }),
        stderr: "",
      }),
    });
    const result = evaluateSemanticGreen(PR, REPO, {
      cascadeMode: true,
      requireMasterCiGreen: true,
      runGh,
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("master-ci-not-green");
    expect(result.error).toContain("not-ready-yet");
  });

  it("covers missing base ref or sha and explicit empty base branch", () => {
    const missingRef = evaluateSemanticGreen(PR, REPO, {
      cascadeMode: true,
      runGh: makeRunGh({
        "/pulls/": () => ({
          returncode: 0,
          stdout: JSON.stringify({ base: { sha: CURRENT_HEAD } }),
          stderr: "",
        }),
      }),
    });
    expect(missingRef.outcome).toBe("config-error");
    expect(missingRef.error).toContain("base.ref or base.sha");

    const missingSha = evaluateSemanticGreen(PR, REPO, {
      cascadeMode: true,
      runGh: makeRunGh({
        "/pulls/": () => ({
          returncode: 0,
          stdout: JSON.stringify({ base: { ref: "master" } }),
          stderr: "",
        }),
      }),
    });
    expect(missingSha.outcome).toBe("config-error");

    const emptyBranch = evaluateSemanticGreen(PR, REPO, {
      cascadeMode: true,
      baseBranch: "",
      runGh: makeRunGh({ "/pulls/": pullsHandler(CURRENT_HEAD) }),
    });
    expect(emptyBranch.outcome).toBe("config-error");
    expect(emptyBranch.error).toContain("Could not resolve target branch");
  });
});
