import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import {
  EXIT_CONFIG_ERROR,
  EXIT_TIMEOUT_OR_ESCALATION,
  MERGE_GATE_TASK_CHECK_NAME,
  OUTCOME_FIRST_HOTFIX_BOOTSTRAP,
  OUTCOME_HOTFIX_SHAPE_INVALID,
  OUTCOME_MASTER_MERGE_GATE_RED,
} from "./constants.js";
import {
  ALLOWED_CANDIDATE_VALIDATION_COMMANDS,
  buildCandidateValidationAttestationFromProbe,
  CANDIDATE_VALIDATION_PRODUCER,
  CANDIDATE_VALIDATION_SCHEMA,
  type CandidateValidationAttestation,
  evaluateAlwaysOnNamedMergeGate,
  evaluateHotfixAdmission,
  evaluateNamedMergeGateFromRuns,
  evaluateNonCascadeCandidateGreen,
  evaluateSemanticGreen,
  parseHotfixShape,
  validateCandidateAttestation,
} from "./semantic-green.js";

const PR = 2379;
const REPO = "deftai/directive";
const SPINE_HEAD = "d".repeat(40);
const PRE_SPINE_BASE = "a".repeat(40);
const CURRENT_HEAD = "b".repeat(40);
const PR_HEAD = "c".repeat(40);

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

function pullsHandler(baseSha: string, baseRef = "master", headSha = PR_HEAD): RunGhFn {
  return () => ({
    returncode: 0,
    stdout: JSON.stringify({
      base: { ref: baseRef, sha: baseSha },
      head: { sha: headSha },
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

function validAttestation(
  prHeadSha = PR_HEAD,
  targetHeadSha = CURRENT_HEAD,
): CandidateValidationAttestation {
  return {
    schema: CANDIDATE_VALIDATION_SCHEMA,
    pr_head_sha: prHeadSha,
    target_head_sha: targetHeadSha,
    command: "task check",
    exit_code: 0,
    attested_at: "2026-10-08T12:00:00Z",
    producer: CANDIDATE_VALIDATION_PRODUCER,
  };
}

describe("evaluateSemanticGreen", () => {
  it("no-ops when cascade mode is off", () => {
    const result = evaluateSemanticGreen(PR, REPO, {
      skipNamedMergeGate: true,
      cascadeMode: false,
    });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBeNull();
  });

  it("rejects merge-tree-clean PR whose base is behind target HEAD (#2385)", () => {
    const runGh = makeRunGh({
      "/pulls/": pullsHandler(PRE_SPINE_BASE),
      "/git/ref/heads/": branchRefHandler(SPINE_HEAD),
    });
    const result = evaluateSemanticGreen(PR, REPO, {
      skipNamedMergeGate: true,
      cascadeMode: true,
      runGh,
    });
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
    const result = evaluateSemanticGreen(PR, REPO, {
      skipNamedMergeGate: true,
      cascadeMode: true,
      runGh,
    });
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
      skipNamedMergeGate: true,
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
      skipNamedMergeGate: true,
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
    const result = evaluateSemanticGreen(PR, REPO, {
      skipNamedMergeGate: true,
      cascadeMode: true,
      runGh,
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("config-error");
    expect(result.exitCode).toBe(EXIT_CONFIG_ERROR);
  });

  it("surfaces branch ref failures as config-error", () => {
    const runGh = makeRunGh({
      "/pulls/": pullsHandler(CURRENT_HEAD),
      "/git/ref/heads/": () => ({ returncode: 1, stdout: "", stderr: "not found" }),
    });
    const result = evaluateSemanticGreen(PR, REPO, {
      skipNamedMergeGate: true,
      cascadeMode: true,
      runGh,
    });
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
      skipNamedMergeGate: true,
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
      skipNamedMergeGate: true,
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
      const result = evaluateSemanticGreen(PR, REPO, {
        skipNamedMergeGate: true,
        cascadeMode: true,
        runGh: testCase.runGh,
      });
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
      skipNamedMergeGate: true,
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
      skipNamedMergeGate: true,
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
      skipNamedMergeGate: true,
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
      skipNamedMergeGate: true,
      cascadeMode: true,
      baseBranch: "",
      runGh: makeRunGh({ "/pulls/": pullsHandler(CURRENT_HEAD) }),
    });
    expect(emptyBranch.outcome).toBe("config-error");
    expect(emptyBranch.error).toContain("Could not resolve target branch");
  });
});

describe("evaluateSemanticGreen candidate validation (#4888)", () => {
  it("fails closed when attestation is missing", () => {
    const runGh = makeRunGh({
      "/pulls/": pullsHandler(CURRENT_HEAD),
      "/git/ref/heads/": branchRefHandler(CURRENT_HEAD),
    });
    const result = evaluateSemanticGreen(PR, REPO, {
      skipNamedMergeGate: true,
      requireCandidateValidation: true,
      checkLifecycleDirty: false,
      localHeadSha: PR_HEAD,
      runGh,
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("candidate-validation-missing-or-stale");
    expect(result.exitCode).toBe(EXIT_TIMEOUT_OR_ESCALATION);
    expect(result.error).toContain("evaluateSemanticGreen");
    expect(result.error).toContain("Missing candidate-validation attestation");
    expect(result.payload.pr_head_sha).toBe(PR_HEAD);
    expect(result.payload.target_head_sha).toBe(CURRENT_HEAD);
  });

  it("fails closed when attestation SHA pair is stale", () => {
    const runGh = makeRunGh({
      "/pulls/": pullsHandler(CURRENT_HEAD),
      "/git/ref/heads/": branchRefHandler(CURRENT_HEAD),
    });
    const result = evaluateSemanticGreen(PR, REPO, {
      skipNamedMergeGate: true,
      requireCandidateValidation: true,
      checkLifecycleDirty: false,
      localHeadSha: PR_HEAD,
      candidateValidationAttestation: validAttestation(PR_HEAD, SPINE_HEAD),
      runGh,
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("candidate-validation-missing-or-stale");
    expect(result.error).toContain("Stale candidate-validation attestation");
    expect(result.error).toContain("target_head");
  });

  it("passes when attestation matches the live SHA pair", () => {
    const runGh = makeRunGh({
      "/pulls/": pullsHandler(CURRENT_HEAD),
      "/git/ref/heads/": branchRefHandler(CURRENT_HEAD),
    });
    const attestation = validAttestation();
    const result = evaluateSemanticGreen(PR, REPO, {
      skipNamedMergeGate: true,
      requireCandidateValidation: true,
      checkLifecycleDirty: false,
      localHeadSha: PR_HEAD,
      candidateValidationAttestation: attestation,
      runGh,
    });
    expect(result.ok).toBe(true);
    expect(result.payload.candidate_validation).toMatchObject({
      required: true,
      schema: CANDIDATE_VALIDATION_SCHEMA,
      command: "task check",
      exit_code: 0,
      pr_head_sha: PR_HEAD,
      target_head_sha: CURRENT_HEAD,
    });
  });

  it("does not weaken cascade absolute refusal when both limbs are requested", () => {
    const runGh = makeRunGh({
      "/pulls/": pullsHandler(PRE_SPINE_BASE),
      "/git/ref/heads/": branchRefHandler(SPINE_HEAD),
    });
    const result = evaluateSemanticGreen(PR, REPO, {
      skipNamedMergeGate: true,
      cascadeMode: true,
      requireCandidateValidation: true,
      candidateValidationAttestation: validAttestation(PR_HEAD, SPINE_HEAD),
      runGh,
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("semantic-stale-base");
  });

  it("runs candidate validation after cascade passes when both limbs are requested", () => {
    const runGh = makeRunGh({
      "/pulls/": pullsHandler(CURRENT_HEAD),
      "/git/ref/heads/": branchRefHandler(CURRENT_HEAD),
    });
    const missing = evaluateSemanticGreen(PR, REPO, {
      skipNamedMergeGate: true,
      cascadeMode: true,
      requireCandidateValidation: true,
      checkLifecycleDirty: false,
      localHeadSha: PR_HEAD,
      runGh,
    });
    expect(missing.ok).toBe(false);
    expect(missing.outcome).toBe("candidate-validation-missing-or-stale");

    const attestation = validAttestation();
    const ok = evaluateSemanticGreen(PR, REPO, {
      skipNamedMergeGate: true,
      cascadeMode: true,
      requireCandidateValidation: true,
      checkLifecycleDirty: false,
      localHeadSha: PR_HEAD,
      candidateValidationAttestation: attestation,
      runGh,
    });
    expect(ok.ok).toBe(true);
    expect(ok.payload.candidate_validation).toMatchObject({
      required: true,
      schema: CANDIDATE_VALIDATION_SCHEMA,
      pr_head_sha: PR_HEAD,
      target_head_sha: CURRENT_HEAD,
    });
  });

  it("refuses tree-identity mismatch via pr-head-assert pattern", () => {
    const runGh = makeRunGh({
      "/pulls/": pullsHandler(CURRENT_HEAD),
      "/git/ref/heads/": branchRefHandler(CURRENT_HEAD),
    });
    const result = evaluateSemanticGreen(PR, REPO, {
      skipNamedMergeGate: true,
      requireCandidateValidation: true,
      checkLifecycleDirty: false,
      localHeadSha: SPINE_HEAD,
      candidateValidationAttestation: validAttestation(),
      runGh,
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("candidate-validation-tree-mismatch");
    expect(result.error).toContain("Local HEAD does not match PR head");
  });

  it("refuses dirty lifecycle paths when probe reports dirty", () => {
    const runGh = makeRunGh({
      "/pulls/": pullsHandler(CURRENT_HEAD),
      "/git/ref/heads/": branchRefHandler(CURRENT_HEAD),
    });
    const result = evaluateSemanticGreen(PR, REPO, {
      skipNamedMergeGate: true,
      requireCandidateValidation: true,
      localHeadSha: PR_HEAD,
      candidateValidationAttestation: validAttestation(),
      resolveLifecycleDirty: () => "xbrief/active/foo.xbrief.json",
      runGh,
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("candidate-validation-dirty-tree");
    expect(result.error).toContain("Lifecycle paths are dirty");
  });

  it("validateCandidateAttestation rejects forged non-zero exit stamps", () => {
    const forged = {
      ...validAttestation(),
      exit_code: 1 as unknown as 0,
    };
    const err = validateCandidateAttestation(forged, PR_HEAD, CURRENT_HEAD);
    expect(err).toContain("exit_code must be 0");
  });

  it("validateCandidateAttestation rejects schema and empty-command forgeries", () => {
    const badSchema = {
      ...validAttestation(),
      schema: "forged.schema" as typeof CANDIDATE_VALIDATION_SCHEMA,
    };
    expect(validateCandidateAttestation(badSchema, PR_HEAD, CURRENT_HEAD)).toContain(
      "schema mismatch",
    );
    const emptyCommand = { ...validAttestation(), command: "   " };
    expect(validateCandidateAttestation(emptyCommand, PR_HEAD, CURRENT_HEAD)).toContain(
      "missing named command",
    );
    expect(validateCandidateAttestation(validAttestation("ffff"), PR_HEAD, CURRENT_HEAD)).toContain(
      "pr_head_sha",
    );
  });

  it("surfaces candidate-validation config errors for pulls/branch/head", () => {
    const pullsFail = evaluateSemanticGreen(PR, REPO, {
      skipNamedMergeGate: true,
      requireCandidateValidation: true,
      checkLifecycleDirty: false,
      runGh: makeRunGh({ "/pulls/": () => ({ returncode: 1, stdout: "", stderr: "boom" }) }),
    });
    expect(pullsFail.outcome).toBe("config-error");

    const emptyBase = evaluateSemanticGreen(PR, REPO, {
      skipNamedMergeGate: true,
      requireCandidateValidation: true,
      checkLifecycleDirty: false,
      baseBranch: "",
      runGh: makeRunGh({ "/pulls/": pullsHandler(CURRENT_HEAD) }),
    });
    expect(emptyBase.outcome).toBe("config-error");
    expect(emptyBase.error).toContain("candidate validation");

    const branchFail = evaluateSemanticGreen(PR, REPO, {
      skipNamedMergeGate: true,
      requireCandidateValidation: true,
      checkLifecycleDirty: false,
      runGh: makeRunGh({
        "/pulls/": pullsHandler(CURRENT_HEAD),
        "/git/ref/heads/": () => ({ returncode: 1, stdout: "", stderr: "missing" }),
      }),
    });
    expect(branchFail.outcome).toBe("config-error");

    const noHead = evaluateSemanticGreen(PR, REPO, {
      skipNamedMergeGate: true,
      requireCandidateValidation: true,
      checkLifecycleDirty: false,
      runGh: makeRunGh({
        "/pulls/": () => ({
          returncode: 0,
          stdout: JSON.stringify({ base: { ref: "master", sha: CURRENT_HEAD } }),
          stderr: "",
        }),
        "/git/ref/heads/": branchRefHandler(CURRENT_HEAD),
      }),
    });
    expect(noHead.outcome).toBe("config-error");
    expect(noHead.error).toContain("PR head SHA");
  });

  it("rejects supplied prHeadSha that differs from live fetched head", () => {
    const injectedHead = "e".repeat(40);
    const runGh = makeRunGh({
      "/pulls/": pullsHandler(CURRENT_HEAD),
      "/git/ref/heads/": branchRefHandler(CURRENT_HEAD),
    });
    const result = evaluateSemanticGreen(PR, REPO, {
      skipNamedMergeGate: true,
      requireCandidateValidation: true,
      checkLifecycleDirty: false,
      prHeadSha: injectedHead,
      localHeadSha: injectedHead,
      candidateValidationAttestation: validAttestation(injectedHead, CURRENT_HEAD),
      resolveLifecycleDirty: () => null,
      runGh,
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("candidate-validation-head-mismatch");
    expect(result.error).toContain("does not match live fetched PR head");
  });

  it("accepts matching localHeadSha when prHeadSha matches live head", () => {
    const runGh = makeRunGh({
      "/pulls/": pullsHandler(CURRENT_HEAD),
      "/git/ref/heads/": branchRefHandler(CURRENT_HEAD),
    });
    const result = evaluateSemanticGreen(PR, REPO, {
      skipNamedMergeGate: true,
      requireCandidateValidation: true,
      checkLifecycleDirty: false,
      prHeadSha: PR_HEAD,
      localHeadSha: PR_HEAD,
      candidateValidationAttestation: validAttestation(),
      resolveLifecycleDirty: () => null,
      runGh,
    });
    expect(result.ok).toBe(true);
    expect(result.payload.pr_head_sha).toBe(PR_HEAD);
  });

  it("evaluateNonCascadeCandidateGreen always requires attestation", () => {
    const runGh = makeRunGh({
      "/pulls/": pullsHandler(CURRENT_HEAD),
      "/git/ref/heads/": branchRefHandler(CURRENT_HEAD),
    });
    const missing = evaluateNonCascadeCandidateGreen(PR, REPO, {
      skipNamedMergeGate: true,
      checkLifecycleDirty: false,
      localHeadSha: PR_HEAD,
      runGh,
    });
    expect(missing.ok).toBe(false);
    expect(missing.outcome).toBe("candidate-validation-missing-or-stale");

    const ok = evaluateNonCascadeCandidateGreen(PR, REPO, {
      skipNamedMergeGate: true,
      checkLifecycleDirty: false,
      localHeadSha: PR_HEAD,
      candidateValidationAttestation: validAttestation(),
      runGh,
    });
    expect(ok.ok).toBe(true);
  });

  it("buildCandidateValidationAttestationFromProbe rejects forged commands and non-zero exits", () => {
    expect(
      buildCandidateValidationAttestationFromProbe({
        pr_head_sha: PR_HEAD,
        target_head_sha: CURRENT_HEAD,
        command: "true",
        exit_code: 0,
      }).ok,
    ).toBe(false);
    expect(
      buildCandidateValidationAttestationFromProbe({
        pr_head_sha: PR_HEAD,
        target_head_sha: CURRENT_HEAD,
        command: "task check",
        exit_code: 1,
      }).ok,
    ).toBe(false);
    const built = buildCandidateValidationAttestationFromProbe({
      pr_head_sha: PR_HEAD,
      target_head_sha: CURRENT_HEAD,
      command: "  deft   check  ",
      exit_code: 0,
      attested_at: "2026-10-08T12:00:00Z",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("unreachable");
    expect(built.attestation.command).toBe("deft check");
    expect(ALLOWED_CANDIDATE_VALIDATION_COMMANDS).toContain(built.attestation.command);
    expect(validateCandidateAttestation(built.attestation, PR_HEAD, CURRENT_HEAD)).toBeNull();
  });

  it("validateCandidateAttestation rejects non-allowlisted commands like true", () => {
    const forged = { ...validAttestation(), command: "true" };
    expect(validateCandidateAttestation(forged, PR_HEAD, CURRENT_HEAD)).toContain(
      "ALLOWED_CANDIDATE_VALIDATION_COMMANDS",
    );
  });
});

describe("always-on named Merge gate (#6071)", () => {
  const greenNamed = {
    name: MERGE_GATE_TASK_CHECK_NAME,
    status: "completed",
    conclusion: "success",
  };
  const redNamed = {
    name: MERGE_GATE_TASK_CHECK_NAME,
    status: "completed",
    conclusion: "failure",
  };

  it("refuses ordinary merge when master Merge gate (task check) is red", () => {
    const result = evaluateSemanticGreen(PR, REPO, {
      cascadeMode: false,
      namedMergeGateTipSha: CURRENT_HEAD,
      namedMergeGateCheckRuns: [redNamed],
      hotfixAdmission: {
        admitted: false,
        shape: null,
        skipIssue: null,
        actorLogin: null,
        reason: null,
        outcome: null,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe(OUTCOME_MASTER_MERGE_GATE_RED);
    expect(result.error).toContain(MERGE_GATE_TASK_CHECK_NAME);
  });

  it("allows hotfix-labeled restore-green PR when master Merge gate (task check) is red", () => {
    const result = evaluateSemanticGreen(PR, REPO, {
      cascadeMode: false,
      namedMergeGateTipSha: CURRENT_HEAD,
      namedMergeGateCheckRuns: [redNamed],
      hotfixAdmission: {
        admitted: true,
        shape: "A",
        skipIssue: null,
        actorLogin: "MScottAdams",
        reason: null,
        outcome: null,
      },
    });
    expect(result.ok).toBe(true);
  });

  it("allows hotfix-labeled cited-skip PR when master Merge gate (task check) is red", () => {
    const result = evaluateSemanticGreen(PR, REPO, {
      cascadeMode: false,
      namedMergeGateTipSha: CURRENT_HEAD,
      namedMergeGateCheckRuns: [redNamed],
      hotfixAdmission: {
        admitted: true,
        shape: "B",
        skipIssue: 6066,
        actorLogin: "MScottAdams",
        reason: null,
        outcome: null,
      },
    });
    expect(result.ok).toBe(true);
  });

  it("refuses hotfix label without matching body line", () => {
    const parsed = parseHotfixShape("Just a hotfix without the required line");
    expect(parsed.shape).toBeNull();
    const admission = evaluateHotfixAdmission(PR, REPO, {
      hotfixAdmission: {
        admitted: false,
        shape: null,
        skipIssue: null,
        actorLogin: "MScottAdams",
        reason:
          "hotfix label present without a matching shape (A) or (B) body line; refuse (#6071).",
        outcome: "hotfix-shape-invalid",
      },
    });
    expect(admission.admitted).toBe(false);
    expect(admission.outcome).toBe("hotfix-shape-invalid");
  });

  it("refuses hotfix-labeled PR that is neither restore-green nor cited-skip", () => {
    const result = evaluateAlwaysOnNamedMergeGate(PR, REPO, {
      tipSha: CURRENT_HEAD,
      checkRuns: [redNamed],
      hotfixAdmission: {
        admitted: false,
        shape: null,
        skipIssue: null,
        actorLogin: "MScottAdams",
        reason:
          "hotfix label present without a matching shape (A) or (B) body line; refuse (#6071).",
        outcome: "hotfix-shape-invalid",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("hotfix-shape-invalid");
  });

  it("refuses when master Merge gate (task check) is still pending past timeout (fail-closed)", () => {
    const status = evaluateNamedMergeGateFromRuns(
      CURRENT_HEAD,
      [
        {
          name: MERGE_GATE_TASK_CHECK_NAME,
          status: "in_progress",
          conclusion: "none",
          started_at: "2020-01-01T00:00:00Z",
        },
      ],
      { pendingTimeoutMinutes: 30, nowMs: Date.parse("2020-01-01T01:00:00Z") },
    );
    expect(status.disposition).toBe("pending");
    expect(status.error).toContain("pending past timeout");
  });

  it("refuses when the Merge gate check-runs read fails (fail-closed)", () => {
    const result = evaluateAlwaysOnNamedMergeGate(PR, REPO, {
      tipSha: CURRENT_HEAD,
      runGh: () => ({ returncode: 1, stdout: "", stderr: "api down" }),
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe(OUTCOME_MASTER_MERGE_GATE_RED);
    expect(result.error).toContain("check-runs read failed");
  });

  it("refuses when the exact check name Merge gate (task check) is absent (fail-closed)", () => {
    const status = evaluateNamedMergeGateFromRuns(CURRENT_HEAD, [
      { name: "CI", status: "completed", conclusion: "success" },
    ]);
    expect(status.disposition).toBe("missing");
  });

  it("admits consumer repos when Merge gate (task check) is absent (consumer contract)", () => {
    const result = evaluateAlwaysOnNamedMergeGate(PR, "acme/app", {
      tipSha: CURRENT_HEAD,
      checkRuns: [{ name: "CI", status: "completed", conclusion: "success" }],
    });
    expect(result.ok).toBe(true);
    expect(result.status.disposition).toBe("missing");
    expect(result.error).toBeNull();
  });

  it("still refuses deftai/directive when Merge gate (task check) is absent", () => {
    const result = evaluateAlwaysOnNamedMergeGate(PR, REPO, {
      tipSha: CURRENT_HEAD,
      checkRuns: [{ name: "CI", status: "completed", conclusion: "success" }],
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe(OUTCOME_MASTER_MERGE_GATE_RED);
    expect(result.status.disposition).toBe("missing");
  });

  it("still refuses consumer repos when Merge gate (task check) is red", () => {
    const result = evaluateAlwaysOnNamedMergeGate(PR, "acme/app", {
      tipSha: CURRENT_HEAD,
      checkRuns: [redNamed],
      hotfixAdmission: {
        admitted: false,
        shape: null,
        skipIssue: null,
        actorLogin: null,
        reason: null,
        outcome: null,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe(OUTCOME_MASTER_MERGE_GATE_RED);
  });

  it("does not invoke task check or check:merge for the red-master gate", () => {
    const cmds: string[] = [];
    evaluateAlwaysOnNamedMergeGate(PR, REPO, {
      tipSha: CURRENT_HEAD,
      checkRuns: [greenNamed],
      runGh: (cmd) => {
        cmds.push(cmd.join(" "));
        return { returncode: 1, stdout: "", stderr: "unused" };
      },
    });
    expect(cmds.every((c) => !c.includes("task check") && !c.includes("check:merge"))).toBe(true);
  });

  it("refuses under DEFT_NO_NETWORK=1 (Recut-2)", () => {
    const result = evaluateAlwaysOnNamedMergeGate(PR, REPO, {
      tipSha: CURRENT_HEAD,
      checkRuns: [greenNamed],
      env: { DEFT_NO_NETWORK: "1" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("DEFT_NO_NETWORK");
  });

  it("returns first-hotfix bootstrap recovery when tip is red and PR is unknown", () => {
    const result = evaluateAlwaysOnNamedMergeGate(null, REPO, {
      tipSha: CURRENT_HEAD,
      checkRuns: [redNamed],
      firstHotfixBootstrap: true,
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe(OUTCOME_FIRST_HOTFIX_BOOTSTRAP);
    expect(result.error).toMatch(/First-hotfix bootstrap/);
    expect(result.hotfix?.outcome).toBe(OUTCOME_FIRST_HOTFIX_BOOTSTRAP);
  });

  it("refuses Bot hotfix actor and accepts maintainer-class without actor≠author", () => {
    const bot = evaluateHotfixAdmission(PR, REPO, {
      hotfixAdmission: {
        admitted: false,
        shape: "A",
        skipIssue: null,
        actorLogin: "greptile-apps[bot]",
        reason: "hotfix label actor greptile-apps[bot] is a Bot; refuse (#6071).",
        outcome: "hotfix-actor-denied",
      },
    });
    expect(bot.admitted).toBe(false);
    expect(bot.outcome).toBe("hotfix-actor-denied");

    const sameAuthor = evaluateHotfixAdmission(PR, REPO, {
      hotfixAdmission: {
        admitted: true,
        shape: "A",
        skipIssue: null,
        actorLogin: "MScottAdams",
        reason: null,
        outcome: null,
      },
    });
    expect(sameAuthor.admitted).toBe(true);
  });

  it("refuses shape B when cited issue lacks skipped-tests (#6071)", () => {
    const fork = "acme/fork";
    const runGh = (args: readonly string[]) => {
      const path = args.join(" ");
      if (path.includes(`repos/${fork}/pulls/${PR}`)) {
        return {
          returncode: 0,
          stdout: JSON.stringify({
            labels: [{ name: "hotfix" }],
            body: "Hotfix skip: deftai/directive#6066\n",
          }),
          stderr: "",
        };
      }
      if (path.includes(`repos/${fork}/issues/${PR}/events`)) {
        return {
          returncode: 0,
          stdout: JSON.stringify([
            {
              event: "labeled",
              label: { name: "hotfix" },
              actor: { login: "MScottAdams", type: "User" },
              author_association: "MEMBER",
            },
          ]),
          stderr: "",
        };
      }
      if (path.includes("repos/deftai/directive/issues/6066")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({
            state: "open",
            body: "no skipped-tests fence",
            created_at: "2026-01-01T00:00:00Z",
          }),
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: `unexpected ${path}` };
    };
    const missingBlock = evaluateHotfixAdmission(PR, fork, {
      runGh,
      maintainerLogins: ["MScottAdams"],
    });
    expect(missingBlock.admitted).toBe(false);
    expect(missingBlock.outcome).toBe(OUTCOME_HOTFIX_SHAPE_INVALID);
    expect(missingBlock.reason).toMatch(/skipped-tests/);
    expect(missingBlock.reason).toMatch(/deftai\/directive#6066/);
  });

  it("parses exactly one hotfix shape A or B", () => {
    expect(parseHotfixShape("Hotfix for red Merge gate (task check): flake in suite\n").shape).toBe(
      "A",
    );
    expect(parseHotfixShape("Hotfix skip: deftai/directive#6066\n").shape).toBe("B");
    expect(
      parseHotfixShape(
        "Hotfix for red Merge gate (task check): x\nHotfix skip: deftai/directive#1\n",
      ).ambiguous,
    ).toBe(true);
    expect(
      parseHotfixShape("Hotfix skip: deftai/directive#1\nHotfix skip: deftai/directive#2\n")
        .ambiguous,
    ).toBe(true);
    expect(
      parseHotfixShape(
        "Hotfix for red Merge gate (task check): one\nHotfix for red Merge gate (task check): two\n",
      ).ambiguous,
    ).toBe(true);
  });
});

describe("content-contract: three-axis semantic policy (#4888)", () => {
  const repoRoot = join(__dirname, "..", "..", "..", "..");

  it("locks scm three-axis rule, probe symbol, and lessons Canonical-encoding", () => {
    const scm = readFileSync(join(repoRoot, "content/scm/github.md"), "utf8");
    expect(scm).toContain("three-axis");
    expect(scm).toContain("textual");
    expect(scm).toContain("behavioral");
    expect(scm).toContain("policy");
    expect(scm).toContain("evaluateSemanticGreen");
    expect(scm).toContain("requireCandidateValidation");
    expect(scm).toContain("evaluateNonCascadeCandidateGreen");
    expect(scm).toContain("#4888");
    expect(scm).toContain("#633");
    expect(scm).toMatch(/#4883/);

    const lessonsPack = readFileSync(
      join(repoRoot, "content/packs/lessons/lessons-pack-0.1.json"),
      "utf8",
    );
    expect(lessonsPack).toContain("#4888");
    expect(lessonsPack).toContain("Canonical encoding");
    expect(lessonsPack).toContain("evaluateSemanticGreen");
    expect(lessonsPack).toContain("three-axis");

    const metaLessons = readFileSync(join(repoRoot, "meta/lessons.md"), "utf8");
    expect(metaLessons).toMatch(/## .+ \(2026-10\)/);
    expect(metaLessons).toContain("#4888");
    expect(metaLessons).toContain("Canonical encoding");
  });
});
