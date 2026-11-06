import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ResolveLifecycleDirtyFn,
  resolveLifecycleDirty,
  shasMatch,
} from "../pr-closeout-attestable/pr-head-assert.js";
import { buildCiSummaryLine, evaluateCiGate } from "../pr-merge-readiness/ci-gate.js";
import { defaultRunGh, fetchCheckRunsRest } from "../pr-merge-readiness/gh.js";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import { EXIT_CONFIG_ERROR, EXIT_TIMEOUT_OR_ESCALATION } from "./constants.js";

/** Machine-checkable candidate validation attestation (#4888 Prefer-A Bound). */
export const CANDIDATE_VALIDATION_SCHEMA = "deft.semantic-green.candidate-validation.v1" as const;

/** Named merge-chokepoint probes admitted for candidate attestation (#4888). */
export const ALLOWED_CANDIDATE_VALIDATION_COMMANDS = [
  "task check",
  "deft check",
  "task deft:check",
  "directive check",
] as const;

export type AllowedCandidateValidationCommand =
  (typeof ALLOWED_CANDIDATE_VALIDATION_COMMANDS)[number];

export const CANDIDATE_VALIDATION_PRODUCER =
  "deft.buildCandidateValidationAttestationFromProbe" as const;

export function normalizeCandidateCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/**
 * Blessed producer for candidate-validation attestations (#4888).
 * Rejects non-zero exits and non-allowlisted commands — callers must not hand-write success stamps.
 */
export type BuildCandidateValidationAttestationResult =
  | { readonly ok: true; readonly attestation: CandidateValidationAttestation }
  | { readonly ok: false; readonly error: string };

/** Returned-failure builder — no throw/reject; callers branch on ok (#4888 / intent-constraint). */
export function buildCandidateValidationAttestationFromProbe(input: {
  readonly pr_head_sha: string;
  readonly target_head_sha: string;
  readonly command: string;
  readonly exit_code: number;
  readonly attested_at?: string;
  readonly merge_result_sha?: string | null;
}): BuildCandidateValidationAttestationResult {
  const command = normalizeCandidateCommand(input.command);
  if (input.exit_code !== 0) {
    return {
      ok: false,
      error:
        "buildCandidateValidationAttestationFromProbe refuses non-zero exit_code (#4888); " +
        "run the named merge-chokepoint probe and pass its real exit.",
    };
  }
  if (!(ALLOWED_CANDIDATE_VALIDATION_COMMANDS as readonly string[]).includes(command)) {
    return {
      ok: false,
      error:
        "buildCandidateValidationAttestationFromProbe refuses command " +
        JSON.stringify(command) +
        " (#4888); allowed: " +
        ALLOWED_CANDIDATE_VALIDATION_COMMANDS.join(" | ") +
        ".",
    };
  }
  if (!input.pr_head_sha || !input.target_head_sha) {
    return {
      ok: false,
      error:
        "buildCandidateValidationAttestationFromProbe requires pr_head_sha and target_head_sha (#4888).",
    };
  }
  return {
    ok: true,
    attestation: {
      schema: CANDIDATE_VALIDATION_SCHEMA,
      pr_head_sha: input.pr_head_sha,
      target_head_sha: input.target_head_sha,
      command,
      exit_code: 0,
      attested_at: input.attested_at ?? new Date().toISOString(),
      merge_result_sha: input.merge_result_sha ?? null,
      producer: CANDIDATE_VALIDATION_PRODUCER,
    },
  };
}

export interface CandidateValidationAttestation {
  readonly schema: typeof CANDIDATE_VALIDATION_SCHEMA;
  readonly pr_head_sha: string;
  readonly target_head_sha: string;
  /** Named command that exited 0 against merge-with-current-base (e.g. `task check`). */
  readonly command: string;
  readonly exit_code: 0;
  readonly attested_at: string;
  /** Optional merge-result identity when produced. */
  readonly merge_result_sha?: string | null;
  /** Blessed producer id — only buildCandidateValidationAttestationFromProbe may set this. */
  readonly producer: typeof CANDIDATE_VALIDATION_PRODUCER;
}

export interface SemanticGreenOptions {
  /** Enable merge-cascade semantic-green checks (#2385). */
  readonly cascadeMode?: boolean;
  /** After a prior cascade merge, require target-branch CI green at HEAD before the next merge. */
  readonly requireMasterCiGreen?: boolean;
  /** Target branch for stale-base comparison (defaults to PR base.ref). */
  readonly baseBranch?: string | null;
  readonly runGh?: RunGhFn;
  /**
   * Non-cascade routes (conflict-resolve / behind-rebase / pre-push): require
   * machine-checkable candidate validation keyed to (pr_head_sha, target_head_sha) (#4888).
   * Additive; cascadeMode absolute stale-base refusal is unchanged.
   */
  readonly requireCandidateValidation?: boolean;
  /**
   * Attestation for the candidate SHA pair. Missing/stale/mismatched → fail closed.
   * Prose or agent-forged stamps without exit_code 0 + matching SHAs are not success.
   */
  readonly candidateValidationAttestation?: CandidateValidationAttestation | null;
  /** Injected PR head SHA (tests / callers that already fetched). */
  readonly prHeadSha?: string | null;
  /** Injected local HEAD for tree-identity check (pr-head-assert pattern). */
  readonly localHeadSha?: string | null;
  /** Injected dirty-lifecycle probe; when set, skips git status. */
  readonly resolveLifecycleDirty?: ResolveLifecycleDirtyFn;
  /** When false, skip dirty-lifecycle refuse (tests only). Default enabled when requireCandidateValidation. */
  readonly checkLifecycleDirty?: boolean;
  /** Project root for dirty-lifecycle probe (default cwd). */
  readonly projectRoot?: string;
}

export interface SemanticGreenPayload {
  readonly pr_base_sha: string | null;
  readonly target_branch: string | null;
  readonly target_head_sha: string | null;
  readonly master_ci: Record<string, unknown>;
  /** Present on #4888 candidate-validation path; optional for cascade-only callers. */
  readonly pr_head_sha?: string | null;
  /** Present when requireCandidateValidation ran; optional for cascade-only callers. */
  readonly candidate_validation?: Record<string, unknown> | null;
}

export interface SemanticGreenResult {
  readonly ok: boolean;
  readonly outcome: string | null;
  readonly exitCode: number | null;
  readonly error: string | null;
  readonly payload: SemanticGreenPayload;
}

function emptyPayload(): SemanticGreenPayload {
  return {
    pr_base_sha: null,
    pr_head_sha: null,
    target_branch: null,
    target_head_sha: null,
    master_ci: {},
    candidate_validation: null,
  };
}

function fetchPrShas(
  prNumber: number,
  repo: string,
  runGh: RunGhFn,
): {
  baseRef: string | null;
  baseSha: string | null;
  headSha: string | null;
  error: string | null;
} {
  const rc = runGh(["gh", "api", `repos/${repo}/pulls/${prNumber}`]);
  if (rc.returncode !== 0) {
    return {
      baseRef: null,
      baseSha: null,
      headSha: null,
      error: `gh api /pulls/${prNumber} failed: ${rc.stderr.trim()}`,
    };
  }
  if (!rc.stdout.trim()) {
    return {
      baseRef: null,
      baseSha: null,
      headSha: null,
      error: "empty body from gh api /pulls/<N>",
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rc.stdout) as unknown;
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    return {
      baseRef: null,
      baseSha: null,
      headSha: null,
      error: `could not parse PR JSON: ${message}`,
    };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      baseRef: null,
      baseSha: null,
      headSha: null,
      error: "unexpected PR JSON shape (not a dict)",
    };
  }
  const record = payload as Record<string, unknown>;
  const base = record.base;
  if (base === null || typeof base !== "object" || Array.isArray(base)) {
    return {
      baseRef: null,
      baseSha: null,
      headSha: null,
      error: "PR JSON missing base object",
    };
  }
  const baseRecord = base as Record<string, unknown>;
  const baseRef =
    typeof baseRecord.ref === "string" && baseRecord.ref.length > 0 ? baseRecord.ref : null;
  const baseSha =
    typeof baseRecord.sha === "string" && baseRecord.sha.length > 0 ? baseRecord.sha : null;
  const head = record.head;
  let headSha: string | null = null;
  if (head !== null && typeof head === "object" && !Array.isArray(head)) {
    const headRecord = head as Record<string, unknown>;
    if (typeof headRecord.sha === "string" && headRecord.sha.length > 0) {
      headSha = headRecord.sha;
    }
  }
  if (baseRef === null || baseSha === null) {
    return { baseRef, baseSha, headSha, error: "PR JSON missing base.ref or base.sha" };
  }
  return { baseRef, baseSha, headSha, error: null };
}

function fetchBranchHeadSha(
  repo: string,
  branch: string,
  runGh: RunGhFn,
): { sha: string | null; error: string | null } {
  const encoded = branch.split("/").map(encodeURIComponent).join("/");
  const rc = runGh(["gh", "api", `repos/${repo}/git/ref/heads/${encoded}`]);
  if (rc.returncode !== 0) {
    return {
      sha: null,
      error: `gh api /git/ref/heads/${branch} failed: ${rc.stderr.trim()}`,
    };
  }
  if (!rc.stdout.trim()) {
    return { sha: null, error: `empty body from gh api /git/ref/heads/${branch}` };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rc.stdout) as unknown;
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    return { sha: null, error: `could not parse branch ref JSON: ${message}` };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { sha: null, error: "unexpected branch ref JSON shape (not a dict)" };
  }
  const object = (payload as Record<string, unknown>).object;
  if (object === null || typeof object !== "object" || Array.isArray(object)) {
    return { sha: null, error: "branch ref JSON missing object.sha" };
  }
  const sha = (object as Record<string, unknown>).sha;
  if (typeof sha !== "string" || sha.length === 0) {
    return { sha: null, error: "branch ref JSON missing object.sha" };
  }
  return { sha, error: null };
}

function evaluateTargetBranchCi(
  repo: string,
  headSha: string,
  runGh: RunGhFn,
): { ok: boolean; error: string | null; masterCi: Record<string, unknown> } {
  const check = fetchCheckRunsRest(headSha, repo, runGh);
  if (check.error.length > 0) {
    return {
      ok: false,
      error:
        "Required CI check-runs on target branch HEAD could not be fetched; " +
        `fail closed (#2385). ${check.error}`,
      masterCi: { ready_state: "blocked", error: check.error },
    };
  }
  const ciResult = evaluateCiGate(check.checkRuns);
  const masterCi: Record<string, unknown> = {
    ...ciResult.summary,
    summary_line: buildCiSummaryLine(ciResult.summary),
  };
  if (ciResult.summary.ready_state !== "ready") {
    const detail =
      ciResult.failures.length > 0
        ? ciResult.failures.join(" ")
        : `target branch CI ready_state=${ciResult.summary.ready_state}`;
    return {
      ok: false,
      error:
        "Target branch CI is not green at current HEAD; block cascade merge until master is green (#2385). " +
        detail,
      masterCi,
    };
  }
  return { ok: true, error: null, masterCi };
}

/**
 * Validate a candidate-validation attestation against the live SHA pair (#4888).
 * Returns null when valid; otherwise a fail-closed reason naming the probe.
 */
export function validateCandidateAttestation(
  attestation: CandidateValidationAttestation | null | undefined,
  prHeadSha: string,
  targetHeadSha: string,
): string | null {
  if (attestation == null) {
    return (
      "Missing candidate-validation attestation for evaluateSemanticGreen (#4888). " +
      "Run a named merge-with-current-base probe (e.g. task check) and pass " +
      "deft.semantic-green.candidate-validation.v1 keyed to " +
      "(pr_head_sha=" +
      prHeadSha +
      ", target_head_sha=" +
      targetHeadSha +
      ")."
    );
  }
  if (attestation.producer !== CANDIDATE_VALIDATION_PRODUCER) {
    return (
      "Candidate-validation attestation missing blessed producer for evaluateSemanticGreen (#4888). " +
      "Create attestations only via buildCandidateValidationAttestationFromProbe after a controlled probe; " +
      "hand-written stamps are not success."
    );
  }
  if (attestation.schema !== CANDIDATE_VALIDATION_SCHEMA) {
    return (
      "Candidate-validation attestation schema mismatch for evaluateSemanticGreen (#4888): " +
      "expected " +
      CANDIDATE_VALIDATION_SCHEMA +
      "."
    );
  }
  if (attestation.exit_code !== 0) {
    return (
      "Candidate-validation attestation exit_code must be 0 for evaluateSemanticGreen (#4888); " +
      "prose or agent-forged stamps are not success."
    );
  }
  if (typeof attestation.command !== "string" || attestation.command.trim().length === 0) {
    return "Candidate-validation attestation missing named command for evaluateSemanticGreen (#4888).";
  }
  const normalizedCommand = normalizeCandidateCommand(attestation.command);
  if (!(ALLOWED_CANDIDATE_VALIDATION_COMMANDS as readonly string[]).includes(normalizedCommand)) {
    return (
      "Candidate-validation attestation command not in ALLOWED_CANDIDATE_VALIDATION_COMMANDS for evaluateSemanticGreen (#4888): " +
      JSON.stringify(attestation.command) +
      ". Use buildCandidateValidationAttestationFromProbe after a controlled probe (" +
      ALLOWED_CANDIDATE_VALIDATION_COMMANDS.join(" | ") +
      ")."
    );
  }
  if (!shasMatch(attestation.pr_head_sha, prHeadSha)) {
    return (
      "Stale candidate-validation attestation for evaluateSemanticGreen (#4888): " +
      "attested pr_head_sha=" +
      attestation.pr_head_sha +
      " does not match live pr_head=" +
      prHeadSha +
      ". Re-run the named probe against the current candidate SHA pair."
    );
  }
  if (!shasMatch(attestation.target_head_sha, targetHeadSha)) {
    return (
      "Stale candidate-validation attestation for evaluateSemanticGreen (#4888): " +
      "attested target_head_sha=" +
      attestation.target_head_sha +
      " does not match live target_head=" +
      targetHeadSha +
      ". Re-run the named probe against the current candidate SHA pair."
    );
  }
  return null;
}

function evaluateCandidateValidationLimb(
  prNumber: number,
  repo: string,
  options: SemanticGreenOptions,
  runGh: RunGhFn,
): SemanticGreenResult {
  const pr = fetchPrShas(prNumber, repo, runGh);
  if (pr.error !== null) {
    return {
      ok: false,
      outcome: "config-error",
      exitCode: EXIT_CONFIG_ERROR,
      error: pr.error,
      payload: {
        ...emptyPayload(),
        pr_base_sha: pr.baseSha,
        pr_head_sha: pr.headSha,
        target_branch: pr.baseRef,
      },
    };
  }

  const targetBranch = options.baseBranch ?? pr.baseRef;
  if (targetBranch === null || targetBranch.length === 0) {
    return {
      ok: false,
      outcome: "config-error",
      exitCode: EXIT_CONFIG_ERROR,
      error:
        "Could not resolve target branch for semantic-green candidate validation " +
        "(--base-branch or PR base.ref).",
      payload: {
        ...emptyPayload(),
        pr_base_sha: pr.baseSha,
        pr_head_sha: pr.headSha,
      },
    };
  }

  const branchHead = fetchBranchHeadSha(repo, targetBranch, runGh);
  if (branchHead.error !== null) {
    return {
      ok: false,
      outcome: "config-error",
      exitCode: EXIT_CONFIG_ERROR,
      error: branchHead.error,
      payload: {
        ...emptyPayload(),
        pr_base_sha: pr.baseSha,
        pr_head_sha: pr.headSha,
        target_branch: targetBranch,
      },
    };
  }

  if (
    typeof options.prHeadSha === "string" &&
    options.prHeadSha.length > 0 &&
    pr.headSha !== null &&
    pr.headSha.length > 0 &&
    !shasMatch(options.prHeadSha, pr.headSha)
  ) {
    return {
      ok: false,
      outcome: "candidate-validation-head-mismatch",
      exitCode: EXIT_TIMEOUT_OR_ESCALATION,
      error:
        "Supplied prHeadSha does not match live fetched PR head for evaluateSemanticGreen (#4888). " +
        `supplied=${options.prHeadSha} live=${pr.headSha}. ` +
        "Use the fetched head as authority; re-fetch before attesting.",
      payload: {
        ...emptyPayload(),
        pr_base_sha: pr.baseSha,
        pr_head_sha: pr.headSha,
        target_branch: targetBranch,
        target_head_sha: branchHead.sha,
      },
    };
  }

  const prHeadSha =
    typeof options.prHeadSha === "string" && options.prHeadSha.length > 0
      ? options.prHeadSha
      : pr.headSha;
  if (prHeadSha === null || prHeadSha.length === 0) {
    return {
      ok: false,
      outcome: "config-error",
      exitCode: EXIT_CONFIG_ERROR,
      error:
        "Could not resolve PR head SHA for candidate validation (#4888); " +
        "pass prHeadSha or ensure PR JSON includes head.sha.",
      payload: {
        ...emptyPayload(),
        pr_base_sha: pr.baseSha,
        target_branch: targetBranch,
        target_head_sha: branchHead.sha,
      },
    };
  }

  const targetHeadSha = branchHead.sha as string;
  const payloadBase: SemanticGreenPayload = {
    pr_base_sha: pr.baseSha,
    pr_head_sha: prHeadSha,
    target_branch: targetBranch,
    target_head_sha: targetHeadSha,
    master_ci: {},
    candidate_validation: null,
  };

  // Tree-identity / dirty checks reuse pr-head-assert patterns (#4888 / #3875).
  // Non-cascade Prefer-A: require a checked-out PR head so attestation is not for a foreign tree.
  if (
    options.requireCandidateValidation === true &&
    (typeof options.localHeadSha !== "string" || options.localHeadSha.length === 0)
  ) {
    return {
      ok: false,
      outcome: "candidate-validation-local-head-required",
      exitCode: EXIT_TIMEOUT_OR_ESCALATION,
      error:
        "localHeadSha is required for evaluateSemanticGreen candidate validation (#4888). " +
        "Check out the PR head (or linked worktree) and pass localHeadSha matching pr_head before attesting.",
      payload: payloadBase,
    };
  }
  if (typeof options.localHeadSha === "string" && options.localHeadSha.length > 0) {
    if (!shasMatch(options.localHeadSha, prHeadSha)) {
      return {
        ok: false,
        outcome: "candidate-validation-tree-mismatch",
        exitCode: EXIT_TIMEOUT_OR_ESCALATION,
        error:
          "Local HEAD does not match PR head SHA for evaluateSemanticGreen candidate validation (#4888). " +
          `local=${options.localHeadSha} pr_head=${prHeadSha}. ` +
          "Check out the PR head (or linked worktree) before attesting.",
        payload: payloadBase,
      };
    }
  }

  const checkDirty = options.checkLifecycleDirty !== false;
  if (checkDirty) {
    const projectRoot = options.projectRoot ?? process.cwd();
    const dirtyFn = options.resolveLifecycleDirty ?? resolveLifecycleDirty;
    const dirty = dirtyFn(projectRoot);
    if (dirty !== null && dirty.length > 0) {
      return {
        ok: false,
        outcome: "candidate-validation-dirty-tree",
        exitCode: EXIT_TIMEOUT_OR_ESCALATION,
        error:
          "Lifecycle paths are dirty for evaluateSemanticGreen candidate validation (#4888). " +
          `${dirty}. Commit or stash before attesting.`,
        payload: payloadBase,
      };
    }
  }

  const attestationError = validateCandidateAttestation(
    options.candidateValidationAttestation,
    prHeadSha,
    targetHeadSha,
  );
  if (attestationError !== null) {
    return {
      ok: false,
      outcome: "candidate-validation-missing-or-stale",
      exitCode: EXIT_TIMEOUT_OR_ESCALATION,
      error: attestationError,
      payload: {
        ...payloadBase,
        candidate_validation: {
          required: true,
          pr_head_sha: prHeadSha,
          target_head_sha: targetHeadSha,
          attestation_present: options.candidateValidationAttestation != null,
        },
      },
    };
  }

  const attestation = options.candidateValidationAttestation as CandidateValidationAttestation;
  return {
    ok: true,
    outcome: null,
    exitCode: null,
    error: null,
    payload: {
      ...payloadBase,
      candidate_validation: {
        required: true,
        schema: attestation.schema,
        command: attestation.command,
        exit_code: attestation.exit_code,
        pr_head_sha: attestation.pr_head_sha,
        target_head_sha: attestation.target_head_sha,
        attested_at: attestation.attested_at,
        merge_result_sha: attestation.merge_result_sha ?? null,
      },
    },
  };
}

/** Pre-merge semantic-green gate for merge cascades (#2385) and non-cascade candidate validation (#4888). */
export function evaluateSemanticGreen(
  prNumber: number,
  repo: string,
  options: SemanticGreenOptions = {},
): SemanticGreenResult {
  // Non-cascade candidate-validation limb (#4888). Does not replace cascade absolute refusal.
  if (options.cascadeMode !== true && options.requireCandidateValidation === true) {
    const runGh = options.runGh ?? defaultRunGh;
    return evaluateCandidateValidationLimb(prNumber, repo, options, runGh);
  }

  if (options.cascadeMode !== true) {
    return { ok: true, outcome: null, exitCode: null, error: null, payload: emptyPayload() };
  }

  const runGh = options.runGh ?? defaultRunGh;
  const prBase = fetchPrShas(prNumber, repo, runGh);
  if (prBase.error !== null) {
    return {
      ok: false,
      outcome: "config-error",
      exitCode: EXIT_CONFIG_ERROR,
      error: prBase.error,
      payload: {
        ...emptyPayload(),
        pr_base_sha: prBase.baseSha,
        pr_head_sha: prBase.headSha,
        target_branch: prBase.baseRef,
      },
    };
  }

  const targetBranch = options.baseBranch ?? prBase.baseRef;
  if (targetBranch === null || targetBranch.length === 0) {
    return {
      ok: false,
      outcome: "config-error",
      exitCode: EXIT_CONFIG_ERROR,
      error:
        "Could not resolve target branch for semantic-green gate (--base-branch or PR base.ref).",
      payload: {
        pr_base_sha: prBase.baseSha,
        pr_head_sha: prBase.headSha,
        target_branch: null,
        target_head_sha: null,
        master_ci: {},
        candidate_validation: null,
      },
    };
  }

  const branchHead = fetchBranchHeadSha(repo, targetBranch, runGh);
  if (branchHead.error !== null) {
    return {
      ok: false,
      outcome: "config-error",
      exitCode: EXIT_CONFIG_ERROR,
      error: branchHead.error,
      payload: {
        pr_base_sha: prBase.baseSha,
        pr_head_sha: prBase.headSha,
        target_branch: targetBranch,
        target_head_sha: null,
        master_ci: {},
        candidate_validation: null,
      },
    };
  }

  const payload: SemanticGreenPayload = {
    pr_base_sha: prBase.baseSha,
    pr_head_sha: prBase.headSha,
    target_branch: targetBranch,
    target_head_sha: branchHead.sha,
    master_ci: {},
    candidate_validation: null,
  };

  // Cascade absolute refusal (#2385): unchanged by #4888 candidate-validation limb.
  if (prBase.baseSha !== branchHead.sha) {
    return {
      ok: false,
      outcome: "semantic-stale-base",
      exitCode: EXIT_TIMEOUT_OR_ESCALATION,
      error:
        "PR base SHA is behind the current target branch HEAD (merge-tree-clean but semantically stale). " +
        `Rebase/update-branch onto ${targetBranch} at ${branchHead.sha} and wait for fresh green CI before cascade merge (#2385). ` +
        `pr_base=${prBase.baseSha} target_head=${branchHead.sha}`,
      payload,
    };
  }

  let cascadePayload = payload;
  if (options.requireMasterCiGreen === true) {
    const ci = evaluateTargetBranchCi(repo, branchHead.sha as string, runGh);
    if (!ci.ok) {
      return {
        ok: false,
        outcome: "master-ci-not-green",
        exitCode: EXIT_TIMEOUT_OR_ESCALATION,
        error: ci.error,
        payload: {
          ...payload,
          master_ci: ci.masterCi,
        },
      };
    }
    cascadePayload = {
      ...payload,
      master_ci: ci.masterCi,
    };
  }

  // Combined limbs: cascade absolute refusal first, then candidate validation (#4888).
  // Cascade-only callers (requireCandidateValidation unset) stay cascade-only.
  if (options.requireCandidateValidation === true) {
    const candidate = evaluateCandidateValidationLimb(prNumber, repo, options, runGh);
    if (Object.keys(cascadePayload.master_ci).length === 0) {
      return candidate;
    }
    return {
      ...candidate,
      payload: {
        ...candidate.payload,
        master_ci: cascadePayload.master_ci,
      },
    };
  }

  return { ok: true, outcome: null, exitCode: null, error: null, payload: cascadePayload };
}

/**
 * Non-cascade entry point for conflict-resolve / behind-rebase / pre-push (#4888).
 * Always requires machine-checkable candidate validation; use this instead of the
 * bare evaluateSemanticGreen no-op when cascadeMode is off.
 */
export function evaluateNonCascadeCandidateGreen(
  prNumber: number,
  repo: string,
  options: Omit<SemanticGreenOptions, "cascadeMode" | "requireCandidateValidation"> = {},
): SemanticGreenResult {
  return evaluateSemanticGreen(prNumber, repo, {
    ...options,
    cascadeMode: false,
    requireCandidateValidation: true,
  });
}

export type SemanticGreenFn = typeof evaluateSemanticGreen;

/** Exact required aggregator check name on master's tip (#6071). */
export const MASTER_MERGE_GATE_CHECK_NAME = "Merge gate (task check)";

/** Match pr:watch default max-wait for pending named-check age (#6071). */
export const NAMED_MERGE_GATE_PENDING_TIMEOUT_MS = 30 * 60 * 1000;

export const OUTCOME_MASTER_MERGE_GATE_RED = "master-merge-gate-red";
export const OUTCOME_HOTFIX_SHAPE_INVALID = "hotfix-shape-invalid";
export const OUTCOME_MASTER_MERGE_GATE_UNREADABLE = "master-merge-gate-unreadable";

const HOTFIX_SHAPE_A_RE =
  /^Hotfix for red Merge gate \(task check\):\s+\S.*$/m;
const HOTFIX_SHAPE_B_RE = /^Hotfix skip:\s+deftai\/directive#(\d+)\s*$/m;

export type HotfixShape = "A" | "B";

export type NamedMergeGateResult =
  | {
      readonly ok: true;
      readonly tipSha: string;
      readonly check: {
        readonly name: string;
        readonly status: string;
        readonly conclusion: string;
      };
      readonly hotfixEscape: boolean;
      readonly payload: Record<string, unknown>;
    }
  | {
      readonly ok: false;
      readonly outcome: string;
      readonly exitCode: number;
      readonly error: string;
      readonly tipSha: string | null;
      readonly payload: Record<string, unknown>;
    };

export type HotfixAdmissionResult =
  | {
      readonly admitted: true;
      readonly shape: HotfixShape;
      readonly actorLogin: string;
      readonly skipIssue?: number;
      readonly payload: Record<string, unknown>;
    }
  | {
      readonly admitted: false;
      readonly outcome: string;
      readonly error: string;
      readonly bootstrapRecovery: string | null;
      readonly payload: Record<string, unknown>;
    };

export function parseHotfixBodyShape(
  body: string | null | undefined,
): { shape: HotfixShape; skipIssue?: number } | null {
  if (typeof body !== "string" || body.length === 0) return null;
  const a = HOTFIX_SHAPE_A_RE.test(body);
  const bMatch = HOTFIX_SHAPE_B_RE.exec(body);
  const b = bMatch !== null;
  if (a === b) return null;
  if (a) return { shape: "A" };
  const issue = Number.parseInt(bMatch?.[1] ?? "", 10);
  if (!Number.isFinite(issue) || issue <= 0) return null;
  return { shape: "B", skipIssue: issue };
}

export function evaluateNamedMergeGateOnRuns(
  tipSha: string,
  checkRuns: readonly { name: string; status: string; conclusion: string; started_at?: string | null; created_at?: string | null }[],
  options: { readonly nowMs?: number; readonly pendingTimeoutMs?: number } = {},
): NamedMergeGateResult {
  const nowMs = options.nowMs ?? Date.now();
  const pendingTimeoutMs = options.pendingTimeoutMs ?? NAMED_MERGE_GATE_PENDING_TIMEOUT_MS;
  const matches = checkRuns.filter((r) => r.name === MASTER_MERGE_GATE_CHECK_NAME);
  if (matches.length === 0) {
    return {
      ok: false,
      outcome: OUTCOME_MASTER_MERGE_GATE_RED,
      exitCode: EXIT_TIMEOUT_OR_ESCALATION,
      error:
        `Required named check ${JSON.stringify(MASTER_MERGE_GATE_CHECK_NAME)} is missing on tip ${tipSha.slice(0, 12)}; ` +
        "fail closed until the constant matches CI (#6071).",
      tipSha,
      payload: {
        tip_sha: tipSha,
        named_check: MASTER_MERGE_GATE_CHECK_NAME,
        disposition: "missing",
      },
    };
  }
  const latest = matches[matches.length - 1]!;
  const payloadBase = {
    tip_sha: tipSha,
    named_check: MASTER_MERGE_GATE_CHECK_NAME,
    status: latest.status,
    conclusion: latest.conclusion,
  };
  if (latest.status !== "completed") {
    const startedRaw = latest.started_at ?? latest.created_at ?? null;
    const startedMs = startedRaw !== null ? Date.parse(startedRaw) : Number.NaN;
    const ageMs = Number.isFinite(startedMs) ? nowMs - startedMs : pendingTimeoutMs + 1;
    if (ageMs > pendingTimeoutMs) {
      return {
        ok: false,
        outcome: OUTCOME_MASTER_MERGE_GATE_RED,
        exitCode: EXIT_TIMEOUT_OR_ESCALATION,
        error:
          `Named check ${JSON.stringify(MASTER_MERGE_GATE_CHECK_NAME)} is still pending past timeout on tip ${tipSha.slice(0, 12)} (#6071).`,
        tipSha,
        payload: { ...payloadBase, disposition: "pending-timeout", age_ms: ageMs },
      };
    }
    return {
      ok: false,
      outcome: OUTCOME_MASTER_MERGE_GATE_RED,
      exitCode: EXIT_TIMEOUT_OR_ESCALATION,
      error:
        `Named check ${JSON.stringify(MASTER_MERGE_GATE_CHECK_NAME)} is not completed on tip ${tipSha.slice(0, 12)} (status=${latest.status}) (#6071).`,
      tipSha,
      payload: { ...payloadBase, disposition: "pending" },
    };
  }
  if (latest.conclusion === "skipped") {
    return {
      ok: false,
      outcome: OUTCOME_MASTER_MERGE_GATE_RED,
      exitCode: EXIT_TIMEOUT_OR_ESCALATION,
      error:
        `Named check ${JSON.stringify(MASTER_MERGE_GATE_CHECK_NAME)} concluded skipped on tip ${tipSha.slice(0, 12)}; refuse (#6071).`,
      tipSha,
      payload: { ...payloadBase, disposition: "skipped" },
    };
  }
  if (latest.conclusion !== "success") {
    return {
      ok: false,
      outcome: OUTCOME_MASTER_MERGE_GATE_RED,
      exitCode: EXIT_TIMEOUT_OR_ESCALATION,
      error:
        `Named check ${JSON.stringify(MASTER_MERGE_GATE_CHECK_NAME)} is red on tip ${tipSha.slice(0, 12)} ` +
        `(conclusion=${latest.conclusion}). Ordinary merges refuse until green; only a maintainer hotfix shape A/B may land (#6071).`,
      tipSha,
      payload: { ...payloadBase, disposition: "red" },
    };
  }
  return {
    ok: true,
    tipSha,
    check: {
      name: latest.name,
      status: latest.status,
      conclusion: latest.conclusion,
    },
    hotfixEscape: false,
    payload: { ...payloadBase, disposition: "success" },
  };
}

function fetchBranchHeadShaForNamedGate(
  repo: string,
  branch: string,
  runGh: RunGhFn,
): { sha: string | null; error: string | null } {
  return fetchBranchHeadSha(repo, branch, runGh);
}

function readMaintainerLogins(projectRoot: string | undefined): readonly string[] {
  if (projectRoot === undefined || projectRoot.length === 0) return [];
  try {
    const pdPath = join(projectRoot, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    if (!existsSync(pdPath)) return [];
    const raw = JSON.parse(readFileSync(pdPath, "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
    const plan = (raw as Record<string, unknown>).plan;
    if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return [];
    const policy =
      (plan as Record<string, unknown>)["x-directive/policy"] ??
      (plan as Record<string, unknown>).policy;
    if (policy === null || typeof policy !== "object" || Array.isArray(policy)) return [];
    const logins = (policy as Record<string, unknown>).maintainerLogins;
    if (!Array.isArray(logins)) return [];
    return logins.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  } catch {
    return [];
  }
}

function isMaintainerClassActor(
  login: string,
  associationOrPermission: string | null,
  maintainerLogins: readonly string[],
): boolean {
  const normalized = login.trim().toLowerCase();
  if (maintainerLogins.some((m) => m.trim().toLowerCase() === normalized)) return true;
  const assoc = (associationOrPermission ?? "").toUpperCase();
  return (
    assoc === "OWNER" ||
    assoc === "MEMBER" ||
    assoc === "ADMIN" ||
    assoc === "MAINTAIN" ||
    assoc === "WRITE"
  );
}

/**
 * Evaluate maintainer hotfix A/B admission for a live PR (#6071 Recut-2).
 * Does not require actor≠author. Bot actors and unauthorized humans refuse.
 */
export function evaluateHotfixAdmission(
  prNumber: number,
  repo: string,
  options: {
    readonly runGh?: RunGhFn;
    readonly projectRoot?: string;
    readonly body?: string | null;
    readonly labels?: readonly string[];
    readonly timelineJson?: unknown;
    readonly permissionJson?: unknown;
  } = {},
): HotfixAdmissionResult {
  const runGh = options.runGh ?? defaultRunGh;
  const bootstrapRecovery =
    "Master Merge gate (task check) is red. Ordinary pre-PR refuses. A human maintainer must open/label a draft PR with label `hotfix` and body shape (A) `Hotfix for red Merge gate (task check): <summary>` or (B) `Hotfix skip: deftai/directive#NNNN` (#6071).";

  let body = options.body ?? null;
  let labels = options.labels ?? null;
  if (body === null || labels === null) {
    const rc = runGh(["gh", "api", `repos/${repo}/pulls/${prNumber}`]);
    if (rc.returncode !== 0) {
      return {
        admitted: false,
        outcome: OUTCOME_HOTFIX_SHAPE_INVALID,
        error: `could not read PR #${prNumber} for hotfix admission: ${rc.stderr.trim()}`,
        bootstrapRecovery,
        payload: { provenance: "unreadable" },
      };
    }
    try {
      const pr = JSON.parse(rc.stdout) as Record<string, unknown>;
      if (body === null) body = typeof pr.body === "string" ? pr.body : "";
      if (labels === null) {
        const rawLabels = Array.isArray(pr.labels) ? pr.labels : [];
        labels = rawLabels
          .map((l) =>
            l !== null && typeof l === "object" && !Array.isArray(l)
              ? String((l as Record<string, unknown>).name ?? "")
              : "",
          )
          .filter((n) => n.length > 0);
      }
    } catch (exc: unknown) {
      const message = exc instanceof Error ? exc.message : String(exc);
      return {
        admitted: false,
        outcome: OUTCOME_HOTFIX_SHAPE_INVALID,
        error: `could not parse PR JSON for hotfix admission: ${message}`,
        bootstrapRecovery,
        payload: { provenance: "unreadable" },
      };
    }
  }

  if (!labels.includes("hotfix")) {
    return {
      admitted: false,
      outcome: OUTCOME_HOTFIX_SHAPE_INVALID,
      error: `PR #${prNumber} lacks label hotfix while master named Merge gate is not green (#6071).`,
      bootstrapRecovery,
      payload: { labels, shape: null },
    };
  }

  const shape = parseHotfixBodyShape(body);
  if (shape === null) {
    return {
      admitted: false,
      outcome: OUTCOME_HOTFIX_SHAPE_INVALID,
      error:
        `PR #${prNumber} has label hotfix but body matches neither shape (A) nor exactly one shape (B) (#6071).`,
      bootstrapRecovery,
      payload: { labels, shape: null },
    };
  }

  let timeline = options.timelineJson;
  if (timeline === undefined) {
    const rc = runGh([
      "gh",
      "api",
      `repos/${repo}/issues/${prNumber}/timeline?per_page=100`,
    ]);
    if (rc.returncode !== 0) {
      return {
        admitted: false,
        outcome: OUTCOME_HOTFIX_SHAPE_INVALID,
        error: `hotfix labeled-timeline provenance unreadable: ${rc.stderr.trim()}`,
        bootstrapRecovery,
        payload: { provenance: "unreadable", shape: shape.shape },
      };
    }
    try {
      timeline = JSON.parse(rc.stdout) as unknown;
    } catch (exc: unknown) {
      const message = exc instanceof Error ? exc.message : String(exc);
      return {
        admitted: false,
        outcome: OUTCOME_HOTFIX_SHAPE_INVALID,
        error: `hotfix labeled-timeline provenance unreadable: ${message}`,
        bootstrapRecovery,
        payload: { provenance: "unreadable", shape: shape.shape },
      };
    }
  }

  if (!Array.isArray(timeline)) {
    return {
      admitted: false,
      outcome: OUTCOME_HOTFIX_SHAPE_INVALID,
      error: "hotfix labeled-timeline provenance unreadable: not an array",
      bootstrapRecovery,
      payload: { provenance: "unreadable", shape: shape.shape },
    };
  }

  let actorLogin: string | null = null;
  let actorType: string | null = null;
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const ev = timeline[i];
    if (ev === null || typeof ev !== "object" || Array.isArray(ev)) continue;
    const rec = ev as Record<string, unknown>;
    if (rec.event !== "labeled") continue;
    const label = rec.label;
    const labelName =
      label !== null && typeof label === "object" && !Array.isArray(label)
        ? String((label as Record<string, unknown>).name ?? "")
        : "";
    if (labelName !== "hotfix") continue;
    const actor = rec.actor;
    if (actor !== null && typeof actor === "object" && !Array.isArray(actor)) {
      const a = actor as Record<string, unknown>;
      actorLogin = typeof a.login === "string" ? a.login : null;
      actorType = typeof a.type === "string" ? a.type : null;
    }
    break;
  }

  if (actorLogin === null || actorLogin.length === 0) {
    return {
      admitted: false,
      outcome: OUTCOME_HOTFIX_SHAPE_INVALID,
      error: "hotfix labeled-timeline actor missing; provenance unreadable (#6071).",
      bootstrapRecovery,
      payload: { provenance: "unreadable", shape: shape.shape },
    };
  }
  if ((actorType ?? "").toLowerCase() === "bot" || actorLogin.endsWith("[bot]")) {
    return {
      admitted: false,
      outcome: OUTCOME_HOTFIX_SHAPE_INVALID,
      error: `hotfix label actor ${actorLogin} is a Bot; maintainer-class human required (#6071).`,
      bootstrapRecovery,
      payload: { actor: actorLogin, actor_type: actorType, shape: shape.shape },
    };
  }

  const maintainerLogins = readMaintainerLogins(options.projectRoot);
  let permission = "NONE";
  if (options.permissionJson !== undefined) {
    const p = options.permissionJson;
    if (p !== null && typeof p === "object" && !Array.isArray(p)) {
      const perm = (p as Record<string, unknown>).permission;
      if (typeof perm === "string") permission = perm;
    }
  } else {
    const rc = runGh([
      "gh",
      "api",
      `repos/${repo}/collaborators/${encodeURIComponent(actorLogin)}/permission`,
    ]);
    if (rc.returncode === 0 && rc.stdout.trim()) {
      try {
        const parsed = JSON.parse(rc.stdout) as Record<string, unknown>;
        if (typeof parsed.permission === "string") permission = parsed.permission;
      } catch {
        permission = "NONE";
      }
    }
  }

  if (!isMaintainerClassActor(actorLogin, permission, maintainerLogins)) {
    return {
      admitted: false,
      outcome: OUTCOME_HOTFIX_SHAPE_INVALID,
      error:
        `hotfix label actor ${actorLogin} is not maintainer-class (OWNER/MEMBER or plan.policy.maintainerLogins) (#6071).`,
      bootstrapRecovery,
      payload: {
        actor: actorLogin,
        permission,
        shape: shape.shape,
      },
    };
  }

  return {
    admitted: true,
    shape: shape.shape,
    actorLogin,
    ...(shape.skipIssue !== undefined ? { skipIssue: shape.skipIssue } : {}),
    payload: {
      actor: actorLogin,
      permission,
      shape: shape.shape,
      skip_issue: shape.skipIssue ?? null,
    },
  };
}

export interface ReadNamedMasterMergeGateOptions {
  readonly runGh?: RunGhFn;
  readonly baseBranch?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly nowMs?: number;
  readonly pendingTimeoutMs?: number;
  readonly projectRoot?: string;
  /** When named check is not green, evaluate hotfix escape for this PR. */
  readonly prNumber?: number;
  readonly hotfixAdmission?: HotfixAdmissionResult | null;
  readonly allowHotfixEscape?: boolean;
}

/**
 * Always-on named Merge gate (task check) status read on master's tip (#6071).
 * Independent of cascadeMode / requireMasterCiGreen. DEFT_NO_NETWORK refuses.
 */
export function readNamedMasterMergeGate(
  repo: string,
  options: ReadNamedMasterMergeGateOptions = {},
): NamedMergeGateResult {
  const env = options.env ?? process.env;
  if ((env.DEFT_NO_NETWORK ?? "").trim() === "1") {
    return {
      ok: false,
      outcome: OUTCOME_MASTER_MERGE_GATE_UNREADABLE,
      exitCode: EXIT_CONFIG_ERROR,
      error:
        "DEFT_NO_NETWORK=1: named Merge gate (task check) status read refuses (API-unreadable) (#6071).",
      tipSha: null,
      payload: { disposition: "no-network" },
    };
  }

  const runGh = options.runGh ?? defaultRunGh;
  const branch = options.baseBranch && options.baseBranch.length > 0 ? options.baseBranch : "master";
  const head = fetchBranchHeadShaForNamedGate(repo, branch, runGh);
  if (head.error !== null || head.sha === null) {
    return {
      ok: false,
      outcome: OUTCOME_MASTER_MERGE_GATE_UNREADABLE,
      exitCode: EXIT_CONFIG_ERROR,
      error:
        `Named Merge gate tip read failed for ${branch}: ${head.error ?? "missing sha"} (#6071).`,
      tipSha: null,
      payload: { disposition: "api-fail", branch },
    };
  }

  const check = fetchCheckRunsRest(head.sha, repo, runGh);
  if (check.error.length > 0) {
    return {
      ok: false,
      outcome: OUTCOME_MASTER_MERGE_GATE_UNREADABLE,
      exitCode: EXIT_CONFIG_ERROR,
      error: `Named Merge gate check-runs API fail: ${check.error} (#6071).`,
      tipSha: head.sha,
      payload: { disposition: "api-fail", tip_sha: head.sha },
    };
  }

  const evaluated = evaluateNamedMergeGateOnRuns(head.sha, check.checkRuns, {
    nowMs: options.nowMs,
    pendingTimeoutMs: options.pendingTimeoutMs,
  });
  if (evaluated.ok) return evaluated;

  if (options.allowHotfixEscape === true && options.prNumber !== undefined) {
    const admission =
      options.hotfixAdmission ??
      evaluateHotfixAdmission(options.prNumber, repo, {
        runGh,
        projectRoot: options.projectRoot,
      });
    if (admission.admitted) {
      return {
        ok: true,
        tipSha: head.sha,
        check: {
          name: MASTER_MERGE_GATE_CHECK_NAME,
          status: "completed",
          conclusion: "failure",
        },
        hotfixEscape: true,
        payload: {
          ...evaluated.payload,
          hotfix_escape: true,
          hotfix: admission.payload,
        },
      };
    }
    return {
      ...evaluated,
      error: `${evaluated.error} Hotfix escape refused: ${admission.error}`,
      payload: {
        ...evaluated.payload,
        hotfix_escape: false,
        hotfix: admission.payload,
        bootstrap_recovery: admission.bootstrapRecovery,
      },
    };
  }

  return evaluated;
}
