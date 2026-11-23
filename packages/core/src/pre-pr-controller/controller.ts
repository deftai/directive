/**
 * Repository-controlled pre-PR controller (#4912 Limbs 1 and 3).
 * Code/policy bind to an approved protected revision independent of the PR
 * under review. Incomplete, failed, and interrupted runs mint no pass.
 * Opening the skill file and generic mark-complete cannot mint a pass.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  inspectGateOverrideGrant,
  isGateOverrideEligibleRefuseCode,
  loadGateOverrideAdmission,
} from "../authz/gate-override.js";
import { evaluateClassChecks } from "../class-checks/evaluate.js";
import {
  type CoverageApplicabilityDeps,
  evaluateCoverageApplicability,
} from "../coverage-applicability/index.js";
import { evaluateCoverageHotspots } from "../coverage-hotspots/evaluate.js";
import { evaluate as evaluateEvaluatorSurface } from "../evaluator-surface/evaluate.js";
import { admittedUntiedWorktreeKey, type VerifyAcDispositionKind } from "../hooks/scope.js";
import { isCoverageModeSkipAuthorized, resolveCoverageMode } from "../policy/coverage-mode.js";
import { readPlanPolicy } from "../policy/plan-extensions.js";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import { FIRST_HOTFIX_BOOTSTRAP_RECOVERY } from "../pr-wait-mergeable/constants.js";
import { detectMergeQueue, type MergeQueueDetectFn } from "../pr-wait-mergeable/merge-queue.js";
import {
  evaluateAlwaysOnNamedMergeGate,
  type HotfixAdmission,
  type NamedMergeGateFn,
} from "../pr-wait-mergeable/semantic-green.js";
import {
  coverageReportPresence,
  prePrCoverageReportPath,
  resolveObservedRoot,
} from "./coverage-report.js";
import {
  COVERAGE_HEADROOM_MODE_SKIP,
  COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP,
  COVERAGE_HEADROOM_WAIVED_SKIP,
  isAllowedSkip,
  LINT_ITERATION_MODE_SKIP,
  MERGE_CHOKPOINT_NO_OBLIGATION_SKIP,
  PRE_PR_CONTROLLER_VERSION,
  PRE_PR_PHASES,
  PRE_PR_WORKFLOW_VERSION,
  type PrePrPhaseId,
  type PrePrPhaseSpec,
  phaseSpec,
  requiredPhases,
  VERIFY_AC_NO_OBLIGATION_EXIT,
} from "./phases.js";

/**
 * Resolve a numeric PR number without parsing opaque GraphQL `node_id` (#6071).
 * Order: explicit option → GITHUB_PR_NUMBER env → commits/<sha>/pulls REST.
 * ⊗ Digits from `prNodeId` (e.g. PR_kwDO…123) — those are not PR numbers.
 * Kept in controller.ts (in file_scope) so numeric-pr.ts is not an extra (#4956).
 */
export function resolveNumericPrNumber(input: {
  readonly explicit?: number | null;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly repo: string;
  readonly headSha: string;
  readonly runGh?: RunGhFn;
  /** Ignored on purpose — opaque GraphQL ids are never numeric PR sources. */
  readonly prNodeId?: string | null;
}): number | null {
  void input.prNodeId;
  if (typeof input.explicit === "number" && Number.isFinite(input.explicit) && input.explicit > 0) {
    return Math.trunc(input.explicit);
  }
  const envRaw = (input.env ?? process.env).GITHUB_PR_NUMBER?.trim() ?? "";
  if (/^\d+$/.test(envRaw)) {
    const n = Number(envRaw);
    if (n > 0) return n;
  }
  const sha = input.headSha.trim();
  if (sha.length === 0 || input.runGh === undefined) return null;
  const rc = input.runGh(["gh", "api", `repos/${input.repo}/commits/${sha}/pulls`]);
  if (rc.returncode !== 0 || !rc.stdout.trim()) return null;
  try {
    const payload = JSON.parse(rc.stdout) as unknown;
    if (!Array.isArray(payload) || payload.length === 0) return null;
    const first = payload[0];
    if (first === null || typeof first !== "object" || Array.isArray(first)) return null;
    const num = (first as Record<string, unknown>).number;
    return typeof num === "number" && Number.isFinite(num) && num > 0 ? Math.trunc(num) : null;
  } catch {
    return null;
  }
}

import {
  isPublisher,
  mintPublisher,
  opaqueRunId,
  type PrePrExecutionStore,
  type PrePrPublisher,
  requirePublisher,
} from "./store.js";
import {
  type ApprovedCriteria,
  type CommandObservation,
  deny,
  inputBindingHash,
  MARK_COMPLETE_NOT_AUTHORITY,
  PRE_PR_PUSH_STAGE_MARKER,
  type PrePrDecision,
  type PrePrExecutionRecord,
  type PrePrGateCheckResult,
  type PrePrInputBinding,
  type PrePrPushBinding,
  PUBLISHER_REQUIRED,
  type SemanticEvidence,
  SKILL_FILE_OPEN_NOT_COMPLETION,
  sha256Hex,
  utcIso,
} from "./types.js";

/** The two CI gates the lint_iteration observation records (#6336 item 4; #6040 lane). */
export const PRE_PR_LINT_GATE_CHECKS = ["verify:class-checks", "verify:evaluator-surface"] as const;

/**
 * Run `verify:class-checks` and `verify:evaluator-surface` in process against
 * the candidate tree (#6336 items 4 and 5). Same evaluators and messages as the
 * CI steps; no `deft check`, no test run, no whole-repo scan.
 */
export function runPrePrGateChecks(
  projectRoot: string,
  baseRef?: string | null,
): PrePrGateCheckResult[] {
  const root = resolve(projectRoot);
  // The run's recorded base drives both gates, so a branch without a
  // master/main ref still resolves the same merge base (#6336 Greptile P1).
  const base = typeof baseRef === "string" && baseRef.length > 0 ? baseRef : undefined;
  const classChecks = evaluateClassChecks(root, base === undefined ? {} : { baseRef: base });
  const surface = evaluateEvaluatorSurface(
    base === undefined ? { projectRoot: root } : { projectRoot: root, baseRef: base },
  );
  return [
    { gate: "verify:class-checks", exitCode: classChecks.exitCode, message: classChecks.message },
    { gate: "verify:evaluator-surface", exitCode: surface.code, message: surface.message },
  ];
}

/**
 * PR body text as pre-PR hashes it (#6336 item 8): CRLF / CR become LF and
 * trailing newlines are dropped, so a local body file and the body GitHub
 * stores hash the same when the text is the same.
 */
export function normalizePrBodyForHash(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}

/** sha256 hex of the normalised PR body (#6336 item 8). */
export function hashPrBody(text: string): string {
  return sha256Hex(normalizePrBodyForHash(text));
}

/** `--complete` on a head with no pull request (#6336 item 7). */
export function noPullRequestForHeadMessage(headSha: string): string {
  return (
    `No pull request exists for head ${headSha}. Next: push the branch and open it ` +
    "with `gh pr create --body-file <file>`."
  );
}

/** Both gate results are recorded on the row and each exited 0 (#6336). */
export function gateChecksSatisfied(row: CommandObservation): boolean {
  const recorded = row.gateChecks ?? [];
  // Exactly one result per gate, and it passed: a duplicate cannot mask a red one.
  return PRE_PR_LINT_GATE_CHECKS.every((gate) => {
    const forGate = recorded.filter((result) => result.gate === gate);
    return forGate.length === 1 && forGate[0]?.exitCode === 0;
  });
}

/** Failing gate results as one message, the gates' own text joined (#6336). */
export function gateChecksFailureMessage(results: readonly PrePrGateCheckResult[]): string | null {
  const failed = results.filter((result) => result.exitCode !== 0);
  if (failed.length === 0) return null;
  return failed.map((result) => `${result.gate}: ${result.message}`).join("\n");
}

/**
 * Independently hash reviewed-file contents. Callers cannot mint
 * `controllerObservedHash`; the CLI compares any supplied value to this.
 * Missing, unreadable, or directory paths fail closed (null).
 */
export function computeControllerObservedHash(input: {
  readonly reviewedFiles: readonly string[];
  readonly cwd?: string;
}): string | null {
  const files = [...input.reviewedFiles];
  if (files.length === 0) return null;
  const cwd = input.cwd ?? process.cwd();
  const rows: string[] = [];
  for (const rel of [...files].sort()) {
    const abs = isAbsolute(rel) ? rel : join(cwd, rel);
    try {
      if (!existsSync(abs)) return null;
      const digest = createHash("sha256").update(readFileSync(abs)).digest("hex");
      rows.push(`${rel.replaceAll("\\", "/")}:${digest}`);
    } catch {
      return null;
    }
  }
  return sha256Hex(JSON.stringify(rows));
}

/**
 * The default reviewed-file list for `--observe-semantic` (#6893): the present
 * changed files between base..head at the project root (deletions excluded),
 * repo-relative. Returns null when git cannot list them.
 */
export function listPresentChangedPathsBetween(
  projectRoot: string,
  baseSha: string,
  headSha: string,
): string[] | null {
  try {
    const out = execFileSync(
      "git",
      ["diff", "-z", "--name-only", "--diff-filter=d", `${baseSha}..${headSha}`],
      {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return out
      .split("\0")
      .filter((p) => p.length > 0)
      .map((p) => p.replaceAll("\\", "/"));
  } catch {
    return null;
  }
}

/**
 * What to do after a successful observe (#6893): the required phases with no
 * recorded row, in order; or start a new run when the run is failed or
 * interrupted; or run `--complete` when none are missing. It never claims a pass.
 */
export function prePrNextStep(record: PrePrExecutionRecord): string {
  if (record.state === "failed" || record.failedAt !== null) {
    return (
      "This run has a recorded failure and cannot pass. Next: start a new run " +
      "with `deft pre-pr:run` and record every required phase again."
    );
  }
  if (record.state === "interrupted" || record.interruptedAt !== null) {
    return (
      "This run was interrupted and cannot pass. Next: start a new run " +
      "with `deft pre-pr:run` and record every required phase again."
    );
  }
  const missing = requiredPhases()
    .filter((spec) =>
      spec.kind === "command-observable"
        ? !record.phaseEvidence.commands.some((c) => c.phaseId === spec.id)
        : !record.phaseEvidence.semantic.some((s) => s.phaseId === spec.id),
    )
    .map((spec) => spec.id);
  if (missing.length > 0) {
    return `Required phases not yet recorded, in order: ${missing.join(", ")}.`;
  }
  return (
    "Every required phase is recorded. Next: `deft pre-pr:run --complete --run-id " +
    `${record.id}\`; it checks each phase before it publishes anything.`
  );
}

/**
 * `plan.policy.requireBoundPrePrPush` as written: true, false, or null when not
 * set (#6893). Read here directly, as plan-sequence/approval-grant.ts does:
 * importing the pre-push module would close an import cycle through this file.
 */
export function readRequireBoundPrePrPushSetting(projectRoot: string): boolean | null {
  try {
    const pdPath = join(projectRoot, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    if (!existsSync(pdPath)) return null;
    const data = JSON.parse(readFileSync(pdPath, "utf8")) as { plan?: unknown };
    const policy = readPlanPolicy(data.plan);
    if (policy === null || typeof policy !== "object") return null;
    const raw = (policy as Record<string, unknown>).requireBoundPrePrPush;
    return typeof raw === "boolean" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * The push-gate line `--complete` prints on success (#6893): the policy value
 * and what the managed pre-push hook (`preflight-gh --pre-push-stdin`) does
 * with it. Completing a run is not push admission.
 */
export function describeBoundPrePrPushSetting(setting: boolean | null): string {
  const hook = "the managed pre-push hook (`preflight-gh --pre-push-stdin`)";
  const tail = " Completing a run is not push admission.";
  if (setting === true) {
    return (
      `Push gate: plan.policy.requireBoundPrePrPush is true, so ${hook} refuses a push ` +
      `of non-docs changes without a pre-PR pass bound to HEAD.${tail}`
    );
  }
  const value = setting === false ? "false" : "not set";
  const admit = setting === null ? " (`deft pre-pr:run --push-admit` treats not set as on.)" : "";
  return (
    `Push gate: plan.policy.requireBoundPrePrPush is ${value}, so ${hook} does not ` +
    `look for a pre-PR pass.${admit}${tail}`
  );
}

/** Deleted paths between base..head for pushBinding.reviewedDeletedPaths (#5804). */
function listDeletedPathsBetween(projectRoot: string, baseSha: string, headSha: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["diff", "-z", "--name-only", "--diff-filter=D", `${baseSha}..${headSha}`],
      {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return out
      .split("\0")
      .filter((p) => p.length > 0)
      .map((p) => p.replaceAll("\\", "/"));
  } catch {
    return [];
  }
}

export interface StartControllerRunInput {
  readonly repo: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly treeHash: string;
  readonly prBodyHash: string;
  readonly prNodeId: string | null;
  readonly criteria: ApprovedCriteria;
  readonly skillVersion: string;
  readonly policyVersion: string;
  readonly approvedRevisionSha: string;
  readonly now?: Date;
  readonly runId?: string;
}

export interface StartControllerRunResult {
  readonly ok: boolean;
  readonly runId: string | null;
  readonly decision: PrePrDecision;
}

export function startControllerRun(
  store: PrePrExecutionStore,
  input: StartControllerRunInput,
): StartControllerRunResult {
  const id = opaqueRunId(input.runId);
  const binding: PrePrInputBinding = {
    repo: input.repo,
    baseSha: input.baseSha,
    headSha: input.headSha,
    treeHash: input.treeHash,
    prBodyHash: input.prBodyHash,
    criteriaDigest: input.criteria.digest,
    skillVersion: input.skillVersion,
    policyVersion: input.policyVersion,
    controllerVersion: PRE_PR_CONTROLLER_VERSION,
    approvedRevisionSha: input.approvedRevisionSha,
  };
  const record: PrePrExecutionRecord = {
    schema: "deft.pre-pr-execution.v1",
    id,
    state: "started",
    outcome: "none",
    repo: input.repo,
    baseSha: input.baseSha,
    headSha: input.headSha,
    treeHash: input.treeHash,
    inputHash: inputBindingHash(binding),
    prNodeId: input.prNodeId,
    prBodyHash: input.prBodyHash,
    criteria: input.criteria,
    skillVersion: input.skillVersion,
    policyVersion: input.policyVersion,
    controllerVersion: PRE_PR_CONTROLLER_VERSION,
    workflowVersion: PRE_PR_WORKFLOW_VERSION,
    approvedRevisionSha: input.approvedRevisionSha,
    evaluationGeneration: input.criteria.generation,
    phaseEvidence: { commands: [], semantic: [] },
    reviewedFileManifest: [],
    reviewReportRef: null,
    finalNoChange: false,
    pushBinding: null,
    startedAt: utcIso(input.now),
    completedAt: null,
    interruptedAt: null,
    failedAt: null,
    publishedAt: null,
  };
  const d = store.put(record);
  if (!d.ok) return { ok: false, runId: null, decision: d };
  return {
    ok: true,
    runId: id,
    decision: { ok: true, code: "allow-pass", message: `started ${id}` },
  };
}

function mutate(
  store: PrePrExecutionStore,
  runId: string,
  fn: (record: PrePrExecutionRecord) => PrePrExecutionRecord | PrePrDecision,
): { record: PrePrExecutionRecord | null; decision: PrePrDecision } {
  const current = store.getById(runId);
  if (current === null) {
    return {
      record: null,
      decision: deny("deny-missing-record", `pre-PR run ${runId} is not in the private store`),
    };
  }
  if (current.outcome === "pass") {
    return { record: current, decision: deny("deny-incomplete", "pass already published") };
  }
  const next = fn(current);
  if ("ok" in next && "code" in next && !("schema" in next)) {
    return { record: current, decision: next };
  }
  const record = next as PrePrExecutionRecord;
  store.put(record);
  return { record, decision: { ok: true, code: "allow-pass", message: `updated ${runId}` } };
}

export function observeCommandPhase(
  store: PrePrExecutionStore,
  runId: string,
  observation: Omit<CommandObservation, "completedAt" | "observedProjectRoot"> & {
    readonly now?: Date;
  },
  options?: { readonly projectRoot?: string },
): PrePrDecision {
  const spec = phaseSpec(observation.phaseId);
  if (spec.kind !== "command-observable") {
    return deny(
      "deny-input-mismatch",
      `phase ${observation.phaseId} is semantic, not command-observable`,
    );
  }
  const projectRoot = options?.projectRoot ?? process.cwd();
  const { decision } = mutate(store, runId, (record) => {
    if (observation.inputHash !== record.inputHash) {
      return deny(
        "deny-input-mismatch",
        "command observation input hash does not match the run binding",
      );
    }
    const skipOk =
      observation.phaseId === "coverage_headroom"
        ? (observation.exitCode === 3 &&
            observation.skipReason === COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP) ||
          (observation.exitCode === 4 &&
            observation.skipReason === COVERAGE_HEADROOM_WAIVED_SKIP) ||
          (observation.exitCode === 5 &&
            observation.skipReason === COVERAGE_HEADROOM_MODE_SKIP &&
            isCoverageModeSkipAuthorized(resolveCoverageMode(projectRoot).mode))
        : observation.phaseId === "lint_iteration"
          ? observation.exitCode === 5 &&
            observation.skipReason === LINT_ITERATION_MODE_SKIP &&
            isCoverageModeSkipAuthorized(resolveCoverageMode(projectRoot).mode) &&
            observation.command.toLowerCase().includes("vitest")
          : isAllowedSkip(observation.phaseId, observation.skipReason);
    // Exit 4 waived must not mark the run failed (#5674); exit 0 alone is measured pass.
    const failed = observation.exitCode !== 0 && !skipOk;
    const recordsRoot =
      observation.phaseId === "coverage_headroom" || observation.phaseId === "lint_iteration";
    const row: CommandObservation = {
      phaseId: observation.phaseId,
      command: observation.command,
      exitCode: observation.exitCode,
      inputHash: observation.inputHash,
      skipReason: observation.skipReason,
      completedAt: utcIso(observation.now),
      ...(recordsRoot ? { observedProjectRoot: resolveObservedRoot(projectRoot) } : {}),
      ...(observation.phaseId === "lint_iteration" && observation.gateChecks !== undefined
        ? { gateChecks: [...observation.gateChecks] }
        : {}),
    };
    const next: PrePrExecutionRecord = {
      ...record,
      state: failed ? "failed" : "running",
      outcome: "none",
      failedAt: failed ? utcIso(observation.now) : record.failedAt,
      phaseEvidence: {
        commands: [...record.phaseEvidence.commands.filter((c) => c.phaseId !== row.phaseId), row],
        semantic: record.phaseEvidence.semantic,
      },
    };
    return next;
  });
  // #6336 item 4: a red gate result is recorded on the row (completion then
  // refuses with deny-omitted-phase) and named now with the gate's CI message.
  // The run is not marked failed: fix the change and observe again.
  if (decision.ok && observation.phaseId === "lint_iteration") {
    const failure = gateChecksFailureMessage(observation.gateChecks ?? []);
    if (failure !== null) return deny("deny-command-failure", failure);
  }
  return decision;
}

export function submitReviewerReport(
  store: PrePrExecutionStore,
  runId: string,
  evidence: Omit<SemanticEvidence, "recordedAt"> & { readonly now?: Date },
): PrePrDecision {
  const spec = phaseSpec(evidence.phaseId);
  if (spec.kind !== "semantic") {
    return deny("deny-input-mismatch", `phase ${evidence.phaseId} is command-observable`);
  }
  const { decision } = mutate(store, runId, (record) => {
    if (evidence.criteriaDigest !== record.criteria.digest) {
      return deny(
        "deny-criteria-invalidated",
        "semantic evidence criteria digest does not match approved criteria",
      );
    }
    const row: SemanticEvidence = {
      phaseId: evidence.phaseId,
      reviewedFileManifest: evidence.reviewedFileManifest,
      suppliedContentsHash: evidence.suppliedContentsHash,
      criteriaDigest: evidence.criteriaDigest,
      reviewerReportRef: evidence.reviewerReportRef,
      controllerObservedHash: evidence.controllerObservedHash,
      recordedAt: utcIso(evidence.now),
    };
    const hashesMatch = evidence.suppliedContentsHash === evidence.controllerObservedHash;
    let finalNoChange = record.finalNoChange;
    if (evidence.phaseId === "write" && !hashesMatch) {
      finalNoChange = false;
    }
    if (evidence.phaseId === "loop") {
      finalNoChange = hashesMatch;
    }
    const manifest =
      evidence.reviewedFileManifest.length > 0
        ? evidence.reviewedFileManifest
        : record.reviewedFileManifest;
    const next: PrePrExecutionRecord = {
      ...record,
      state: "running",
      finalNoChange,
      reviewedFileManifest: manifest,
      reviewReportRef: evidence.reviewerReportRef ?? record.reviewReportRef,
      phaseEvidence: {
        commands: record.phaseEvidence.commands,
        semantic: [...record.phaseEvidence.semantic.filter((s) => s.phaseId !== row.phaseId), row],
      },
    };
    return next;
  });
  return decision;
}

export function interruptRun(store: PrePrExecutionStore, runId: string, now?: Date): PrePrDecision {
  const { decision } = mutate(store, runId, (record) => ({
    ...record,
    state: "interrupted" as const,
    outcome: "none" as const,
    interruptedAt: utcIso(now),
  }));
  return decision;
}

export function failRun(store: PrePrExecutionStore, runId: string, now?: Date): PrePrDecision {
  const { decision } = mutate(store, runId, (record) => ({
    ...record,
    state: "failed" as const,
    outcome: "none" as const,
    failedAt: utcIso(now),
  }));
  return decision;
}

/** Agent-callable. Never mints a pass. */
export function markComplete(_store: PrePrExecutionStore, _runId: string): PrePrDecision {
  return deny("deny-mark-complete", MARK_COMPLETE_NOT_AUTHORITY);
}

/** Opening the skill file is not completion. */
export function noteSkillFileOpen(): PrePrDecision {
  return deny("deny-skill-file-open", SKILL_FILE_OPEN_NOT_COMPLETION);
}

/**
 * Safe observation-only flags for measured coverage_headroom commands.
 * Reject `--project-root` / `--base-ref` redirects — they can measure another tree
 * while the observation stays labeled with this run's inputHash (#5421).
 * `--attempt-id` / worktree / evaluator bind the #5674 waived arm without redirecting the tree.
 */
function isSafeCoverageHotspotsFlag(token: string): boolean {
  if (token === "--json" || token === "--quiet" || token === "-q") return true;
  if (token.startsWith("--attempt-id=")) return token.length > "--attempt-id=".length;
  if (token.startsWith("--worktree=")) return token.length > "--worktree=".length;
  if (token.startsWith("--evaluator-id=")) return token.length > "--evaluator-id=".length;
  return false;
}

function parseAttemptIdFromHotspotsCommand(command: string): string | null {
  // Last-wins — matches CLI argv parsing for duplicate --attempt-id (#5674 P2).
  const tokens = command.trim().replace(/\s+/g, " ").split(" ");
  let last: string | null = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (token.startsWith("--attempt-id=")) {
      const value = token.slice("--attempt-id=".length).trim();
      if (value.length > 0) last = value;
      continue;
    }
    if (token === "--attempt-id") {
      const value = (tokens[i + 1] ?? "").trim();
      if (value.length > 0) last = value;
      i += 1;
    }
  }
  return last;
}

/**
 * Accept the phase-spec hotspots command, plus documented wrappers / safe flags
 * (`--json`, `task coverage:hotspots`, `directive coverage:hotspots`, `--attempt-id`).
 */
function coverageHotspotsFlagsSafe(flags: readonly string[]): boolean {
  for (let i = 0; i < flags.length; i += 1) {
    const token = flags[i] ?? "";
    if (isSafeCoverageHotspotsFlag(token)) continue;
    if (token === "--attempt-id" || token === "--worktree" || token === "--evaluator-id") {
      const value = flags[i + 1];
      if (value === undefined || value.startsWith("--")) return false;
      i += 1;
      continue;
    }
    return false;
  }
  return true;
}

function coverageHotspotsCommandMatches(observed: string, specCommand: string): boolean {
  const normalized = observed.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return false;
  if (normalized === specCommand) return true;
  const tokens = normalized.split(" ");
  const head = tokens[0]?.toLowerCase() ?? "";
  const verb = tokens[1] ?? "";
  if ((head === "deft" || head === "directive") && verb === "coverage:hotspots") {
    return coverageHotspotsFlagsSafe(tokens.slice(2));
  }
  if (head === "task" && (verb === "coverage:hotspots" || verb === "deft:coverage:hotspots")) {
    const rest = tokens.slice(2);
    if (rest[0] === "--") return coverageHotspotsFlagsSafe(rest.slice(1));
    return coverageHotspotsFlagsSafe(rest);
  }
  return false;
}

/** Row was observed under the same (realpath) root that satisfaction runs under. */
function observedRootMatches(row: CommandObservation, projectRoot: string): boolean {
  const observed = row.observedProjectRoot;
  if (observed === undefined || observed === null) return false;
  const current = resolveObservedRoot(projectRoot);
  return current !== null && observed === current;
}

/**
 * Coverage-scoped satisfaction (#5421 / #5674 Prefer-A Bound):
 * - measured pass: exit 0 only when command matches the phase spec (hotspots)
 * - authorized N/A: exit 3 + N/A skip + controller re-derives inert
 * - waived refuse: exit 4 + waived skip + reload admission matching binding/attemptId
 * Exit 4 never satisfies as pass/exit 0. Arbitrary exit-0 audits fail.
 */
function commandSatisfied(
  record: PrePrExecutionRecord,
  phaseId: PrePrPhaseId,
  options?: {
    readonly projectRoot?: string;
    readonly applicabilityDeps?: CoverageApplicabilityDeps;
    /** Defaults to attempt id parsed from the hotspots command, else the run id. */
    readonly gateOverrideAttemptId?: string;
  },
): boolean {
  const row = record.phaseEvidence.commands.find((c) => c.phaseId === phaseId);
  if (row === undefined) return false;
  if (row.inputHash !== record.inputHash) return false;

  if (phaseId === "coverage_headroom") {
    const spec = phaseSpec(phaseId);
    if (row.exitCode === 0) {
      return spec.command !== null && coverageHotspotsCommandMatches(row.command, spec.command);
    }
    const projectRoot = options?.projectRoot ?? process.cwd();
    // Every non-zero coverage arm needs the row's observed root to match (one report path).
    if (!observedRootMatches(row, projectRoot)) return false;
    // lstat presence for the waived and mode arms (null: symlink, dir or error refuses).
    // The N/A arm does not look at the report.
    const reportPresence = (): "absent" | "present" | null =>
      coverageReportPresence(prePrCoverageReportPath(projectRoot));

    // #5674 waived arm: exit 4 + distinct waived token + live grant inspect +
    // measured-report recheck (revoke/expiry and Istanbul floor dominate).
    if (row.exitCode === 4) {
      if (row.skipReason !== COVERAGE_HEADROOM_WAIVED_SKIP) return false;
      if (spec.command === null || !coverageHotspotsCommandMatches(row.command, spec.command)) {
        return false;
      }
      const attemptId =
        (options?.gateOverrideAttemptId ?? "").trim() ||
        parseAttemptIdFromHotspotsCommand(row.command) ||
        record.id;
      const admission = loadGateOverrideAdmission(projectRoot, attemptId);
      if (admission === null) return false;
      if (admission.attemptId !== attemptId) return false;
      if (admission.baseSha !== record.baseSha) return false;
      if (admission.headSha !== record.headSha) return false;
      if (admission.treeHash !== record.treeHash) return false;
      if (!isGateOverrideEligibleRefuseCode(admission.refuseCode)) return false;
      // Referenced grant must still be live under inspect (revoke/expiry); do not
      // accept a different matching grant in place of the saved admission's grantId.
      const inspected = inspectGateOverrideGrant(projectRoot, {
        refuseCode: admission.refuseCode,
        baseSha: record.baseSha,
        headSha: record.headSha,
        treeHash: record.treeHash,
        attemptId,
        worktree: admission.worktree,
        evaluatorId: admission.evaluatorId,
      });
      if (!inspected.ok) return false;
      if (inspected.admission === null) return false;
      if (inspected.grant.id !== admission.grantId) return false;
      // Exit-4 waived: present report must measure pass (SLizard fp:c76cd7fc /
      // #5674 — failing report must not hide behind the saved waiver). Missing
      // report under initial|disabled reaches mode-skip posture (#5791) because
      // hotspots returns exit 4 before exit 5 when a waiver admits; under full,
      // missing report stays unsatisfied.
      const presence = reportPresence();
      if (presence === null) return false;
      if (presence === "absent") {
        return isCoverageModeSkipAuthorized(resolveCoverageMode(projectRoot).mode);
      }
      const measured = evaluateCoverageHotspots({
        projectRoot,
        checkApplicability: false,
        useDiffPaths: false,
      });
      return measured.exitCode === 0;
    }

    // #5791 mode arm: exit 5 + distinct mode token; re-read policy (not inert re-derive).
    // Report-present guard keeps the measured path — refuse mode skip when report exists.
    // Refuse outcomes stay on exit 2 / exit-4 waived — never launder through exit 5.
    if (row.exitCode === 5) {
      if (row.skipReason !== COVERAGE_HEADROOM_MODE_SKIP) return false;
      if (spec.command === null || !coverageHotspotsCommandMatches(row.command, spec.command)) {
        return false;
      }
      if (reportPresence() !== "absent") return false;
      if (!isCoverageModeSkipAuthorized(resolveCoverageMode(projectRoot).mode)) return false;
      const derived = evaluateCoverageApplicability(
        {
          projectRoot,
          baseSha: record.baseSha,
          headSha: record.headSha,
          treeHash: record.treeHash,
        },
        options?.applicabilityDeps,
      );
      if (derived.outcome === "refuse") return false;
      return true;
    }

    // Authorized N/A is exit 3 only. Exit 1 measured floor fails must not launder
    // into skip via inert re-derivation. N/A rests on applicability alone: the
    // controller re-derives not-applicable for the bound base/head/tree on a clean
    // tree; a report left by the run's own lint_iteration does not veto it.
    if (row.exitCode !== 3) return false;
    if (row.skipReason !== COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP) return false;
    if (spec.command === null || !coverageHotspotsCommandMatches(row.command, spec.command)) {
      return false;
    }
    try {
      const derived = evaluateCoverageApplicability(
        {
          projectRoot,
          baseSha: record.baseSha,
          headSha: record.headSha,
          treeHash: record.treeHash,
        },
        options?.applicabilityDeps,
      );
      return derived.outcome === "not-applicable";
    } catch {
      return false;
    }
  }

  // #5814 lint_iteration mode arm: exit 5 + distinct token; re-read coverageMode;
  // report-present guard refuses skip when coverage/coverage-final.json exists.
  if (phaseId === "lint_iteration") {
    // #6336 item 4: both CI gate results are required, also under the mode skip.
    if (!gateChecksSatisfied(row)) return false;
    if (row.exitCode === 0) return true;
    if (row.exitCode !== 5) return false;
    if (row.skipReason !== LINT_ITERATION_MODE_SKIP) return false;
    if (!row.command.toLowerCase().includes("vitest")) return false;
    const projectRoot = options?.projectRoot ?? process.cwd();
    if (!observedRootMatches(row, projectRoot)) return false;
    if (coverageReportPresence(prePrCoverageReportPath(projectRoot)) !== "absent") return false;
    return isCoverageModeSkipAuthorized(resolveCoverageMode(projectRoot).mode);
  }

  // #5855 Recut-8: merge_chokepoint no-obligation is exit 6 + closed skip token only.
  if (phaseId === "merge_chokepoint") {
    if (row.exitCode === 0) return true;
    if (row.exitCode !== VERIFY_AC_NO_OBLIGATION_EXIT) return false;
    return row.skipReason === MERGE_CHOKPOINT_NO_OBLIGATION_SKIP;
  }

  if (row.exitCode === 0) return true;
  return isAllowedSkip(phaseId, row.skipReason);
}

function semanticSatisfied(record: PrePrExecutionRecord, phaseId: PrePrPhaseId): boolean {
  const row = record.phaseEvidence.semantic.find((s) => s.phaseId === phaseId);
  if (row === undefined) return false;
  if (row.criteriaDigest !== record.criteria.digest) return false;
  if (row.suppliedContentsHash.length === 0 || row.controllerObservedHash.length === 0) {
    return false;
  }
  if (row.suppliedContentsHash !== row.controllerObservedHash) return false;
  if (phaseId === "loop") return record.finalNoChange;
  return true;
}

function phaseObservedAt(record: PrePrExecutionRecord, spec: PrePrPhaseSpec): string | null {
  if (spec.kind === "command-observable") {
    return record.phaseEvidence.commands.find((c) => c.phaseId === spec.id)?.completedAt ?? null;
  }
  return record.phaseEvidence.semantic.find((s) => s.phaseId === spec.id)?.recordedAt ?? null;
}

export function runObservablesComplete(
  record: PrePrExecutionRecord,
  options?: {
    readonly projectRoot?: string;
    readonly applicabilityDeps?: CoverageApplicabilityDeps;
  },
): PrePrDecision {
  if (record.state === "failed" || record.failedAt !== null) {
    return deny("deny-failed", "failed pre-PR run mints no pass");
  }
  if (record.state === "interrupted" || record.interruptedAt !== null) {
    return deny("deny-interrupted", "interrupted pre-PR run mints no pass");
  }
  let previousAt: string | null = null;
  let previousId: string | null = null;
  for (const spec of PRE_PR_PHASES) {
    const hasRow =
      spec.kind === "command-observable"
        ? record.phaseEvidence.commands.some((c) => c.phaseId === spec.id)
        : record.phaseEvidence.semantic.some((s) => s.phaseId === spec.id);
    // Omitted optional rows are fine; a present optional row must still satisfy (#6040).
    if (!spec.required && !hasRow) continue;
    const ok =
      spec.kind === "command-observable"
        ? commandSatisfied(record, spec.id, options)
        : semanticSatisfied(record, spec.id);
    if (!ok) {
      return deny(
        spec.required ? "deny-omitted-phase" : "deny-incomplete",
        spec.required
          ? `required phase ${spec.id} has no controller-observed pass`
          : `optional phase ${spec.id} observation is not satisfied`,
      );
    }
    const at = phaseObservedAt(record, spec);
    if (at === null || at.length === 0) {
      return deny(
        spec.required ? "deny-omitted-phase" : "deny-incomplete",
        spec.required
          ? `required phase ${spec.id} has no controller-observed pass`
          : `optional phase ${spec.id} observation is not satisfied`,
      );
    }
    if (!spec.required) continue;
    if (previousAt !== null && at < previousAt) {
      return deny(
        "deny-out-of-order",
        `required phase ${spec.id} is timestamped before ${previousId}`,
      );
    }
    previousAt = at;
    previousId = spec.id;
  }
  if (!record.finalNoChange) {
    return deny("deny-incomplete", "completion requires the skill final no-change pass");
  }
  return { ok: true, code: "allow-pass", message: "observables complete" };
}

/**
 * PushBinding fields for verify:ac disposition (#5855 Recut-8). Structural
 * extension so types.ts (outside merge-base file_scope) stays put.
 */
export type PrePrPushBindingWithDisposition = PrePrPushBinding & {
  readonly admittedUntiedWorktreeKey?: string;
  readonly verifyAcDisposition?: VerifyAcDispositionKind;
};

/** Read disposition fields off a stored pushBinding without widening types.ts. */
export function readPushBindingDisposition(binding: PrePrPushBinding | null | undefined): {
  readonly verifyAcDisposition: VerifyAcDispositionKind | null;
  readonly admittedUntiedWorktreeKey: string | null;
} {
  if (binding === null || binding === undefined) {
    return { verifyAcDisposition: null, admittedUntiedWorktreeKey: null };
  }
  const row = binding as PrePrPushBindingWithDisposition;
  const disposition = row.verifyAcDisposition;
  const key = row.admittedUntiedWorktreeKey;
  return {
    verifyAcDisposition:
      disposition === "executed-ac" || disposition === "no-obligation" ? disposition : null,
    admittedUntiedWorktreeKey: typeof key === "string" && key.trim().length > 0 ? key.trim() : null,
  };
}

/**
 * The verify:ac result that `pre-pr:run --complete` obtains itself (#6888).
 * - `evaluated-pass`: a brief was selected and its evaluation returned ok.
 * - `untied-no-obligation`: the branch is admitted untied (standalone exit 6).
 * - `no-target`: no brief was selected (standalone soft-missing exit 0).
 * - `fail`: any other result; `output` holds the verify:ac output.
 */
export type ControllerVerifyAcResult = {
  readonly kind: "evaluated-pass" | "untied-no-obligation" | "no-target" | "fail";
  readonly output: string;
};

/** Published-message note when verify:ac had no brief to run (#6888). */
export const VERIFY_AC_NO_TARGET_NOTE =
  "verify:ac had no brief to run; no verify:ac disposition recorded (#6888)";

/**
 * Revoke earlier passes when `--complete`'s verify:ac result fails or is absent
 * (#6888). This run, and every stored pass for the same repository and HEAD,
 * returns to an unpublished running state with no push binding, so the push
 * gate and evaluatePrePrEvidence refuse until a later complete passes. A failed
 * store write is returned, never thrown.
 */
export function revokePassesForHead(
  store: PrePrExecutionStore,
  current: PrePrExecutionRecord,
): PrePrDecision {
  const seen = new Set<string>();
  const targets = [current, ...store.list()].filter((rec) => {
    if (seen.has(rec.id)) return false;
    seen.add(rec.id);
    return (
      rec.outcome === "pass" &&
      (rec.id === current.id || (rec.repo === current.repo && rec.headSha === current.headSha))
    );
  });
  for (const rec of targets) {
    const put = store.put({
      ...rec,
      state: "running",
      outcome: "none",
      pushBinding: null,
      completedAt: null,
      publishedAt: null,
    });
    if (!put.ok) {
      return deny(
        "deny-incomplete",
        `verify:ac did not pass and earlier pass ${rec.id} could not be revoked: ${put.message} (#6888).`,
      );
    }
  }
  return {
    ok: true,
    code: "allow-pass",
    message: `revoked ${String(targets.length)} earlier pass(es)`,
  };
}

/**
 * Derive the verify:ac disposition from the controller-owned result only
 * (#6888). A merge_chokepoint row does not set it, and there is no fallback to
 * a caller-supplied disposition: a claimed value must equal the derived one.
 */
export function deriveVerifyAcDisposition(input: {
  readonly result: ControllerVerifyAcResult | null | undefined;
  readonly projectRoot?: string;
  readonly claimedDisposition?: VerifyAcDispositionKind | null;
}):
  | {
      readonly ok: true;
      readonly disposition: VerifyAcDispositionKind | null;
      readonly worktreeKey: string | null;
    }
  | { readonly ok: false; readonly message: string } {
  const result = input.result ?? null;
  if (result === null) {
    return {
      ok: false,
      message:
        "controller-owned verify:ac result is missing; pre-pr:run --complete runs verify:ac itself (#6888).",
    };
  }
  if (result.kind === "fail") {
    return {
      ok: false,
      message: "verify:ac failed; no pre-PR pass is published (#6888).",
    };
  }
  const disposition: VerifyAcDispositionKind | null =
    result.kind === "evaluated-pass"
      ? "executed-ac"
      : result.kind === "untied-no-obligation"
        ? "no-obligation"
        : null;
  const claimed = input.claimedDisposition ?? null;
  if (claimed !== null && claimed !== disposition) {
    return {
      ok: false,
      message: `--verify-ac-disposition ${claimed} differs from the controller's verify:ac result (${disposition ?? "no brief selected, no disposition"}) (#6888).`,
    };
  }
  if (disposition === "no-obligation") {
    const root = input.projectRoot ?? process.cwd();
    return { ok: true, disposition, worktreeKey: admittedUntiedWorktreeKey(root) };
  }
  return { ok: true, disposition, worktreeKey: null };
}

/**
 * Mint a pass only with publisher credentials. Incomplete/failed/interrupted
 * runs stay non-pass. Agent shells do not receive `publisher`.
 */
/**
 * True when the delivery branch requires a merge queue (#6295 item 6). A failed
 * or offline read keeps today's refusal (fail closed).
 */
function masterGateQueueMode(
  prNumber: number | null,
  repo: string,
  options:
    | {
        readonly mergeQueueFn?: MergeQueueDetectFn;
        readonly runGh?: RunGhFn;
        readonly env?: Readonly<Record<string, string | undefined>>;
      }
    | undefined,
): boolean {
  if (
    (options?.env ?? process.env).DEFT_NO_NETWORK === "1" &&
    options?.mergeQueueFn === undefined
  ) {
    return false;
  }
  const runGh = options?.runGh;
  const detect: MergeQueueDetectFn =
    options?.mergeQueueFn ??
    ((pr, r, branch) =>
      runGh === undefined
        ? detectMergeQueue(pr, r, branch)
        : detectMergeQueue(pr, r, branch, runGh));
  try {
    return detect(prNumber, repo, null).status === "queue";
  } catch {
    return false;
  }
}

export function completeRun(
  store: PrePrExecutionStore,
  publisher: unknown,
  runId: string,
  now?: Date,
  options?: {
    readonly projectRoot?: string;
    readonly applicabilityDeps?: CoverageApplicabilityDeps;
    /**
     * Controller-owned verify:ac result (#6888). Required: when it is absent or
     * `fail`, completeRun refuses and publishes nothing.
     */
    readonly verifyAcResult?: ControllerVerifyAcResult | null;
    /**
     * Optional caller claim (#6888). When set, it must equal the disposition
     * derived from `verifyAcResult`, or completeRun refuses.
     */
    readonly verifyAcDisposition?: VerifyAcDispositionKind | null;
    /** Always-on named Merge gate (#6071). */
    readonly namedMergeGateFn?: NamedMergeGateFn;
    readonly runGh?: RunGhFn;
    readonly hotfixAdmission?: HotfixAdmission | null;
    readonly skipNamedMergeGate?: boolean;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly firstHotfixBootstrap?: boolean;
    /** Numeric PR number — never derive from opaque prNodeId (#6071 Greptile). */
    readonly prNumber?: number | null;
    /**
     * Merge-queue detection (#6295 item 6). Consulted only when the named gate
     * is not green; a required queue removes the refusal. Defaults to branch
     * rules REST.
     */
    readonly mergeQueueFn?: MergeQueueDetectFn;
  },
): PrePrDecision {
  const creds = requirePublisher(publisher);
  if (!creds.ok) {
    return deny("deny-publisher-required", PUBLISHER_REQUIRED);
  }
  const current = store.getById(runId);
  if (current === null) {
    return deny("deny-missing-record", `pre-PR run ${runId} is not in the private store`);
  }
  // #6888: a failed or absent verify:ac result revokes earlier passes for this
  // HEAD before any other check, so a retry that fails cannot leave one standing.
  const verifyAcKind = options?.verifyAcResult?.kind ?? null;
  if (verifyAcKind === null || verifyAcKind === "fail") {
    const revoked = revokePassesForHead(store, current);
    if (!revoked.ok) return revoked;
  }
  // #6071: pre-PR refuses ordinary changes while master's named Merge gate is red.
  // #6336 item 7: a head with no pull request is named as such, with the next command.
  let noPullRequest: string | null = null;
  if (options?.skipNamedMergeGate !== true) {
    // Numeric PR only — pass opaque prNodeId so resolveNumericPrNumber can ignore it
    // (never digit-parse GraphQL node_id; #6071 Greptile sticky).
    const prNumber = resolveNumericPrNumber({
      explicit: options?.prNumber,
      env: options?.env,
      repo: current.repo,
      headSha: current.headSha,
      runGh: options?.runGh,
      prNodeId: current.prNodeId,
    });
    const bootstrapRequested = options?.firstHotfixBootstrap === true;
    // Only a lookup that actually ran (runGh supplied) may claim the PR is missing.
    if (prNumber === null && !bootstrapRequested && options?.runGh !== undefined) {
      noPullRequest = noPullRequestForHeadMessage(current.headSha);
    }
    const namedFn = options?.namedMergeGateFn ?? evaluateAlwaysOnNamedMergeGate;
    const named = namedFn(prNumber, current.repo, {
      runGh: options?.runGh,
      projectRoot: options?.projectRoot,
      hotfixAdmission: options?.hotfixAdmission,
      env: options?.env,
      // #6336 item 7: bootstrap only when requested, never because the PR number is missing.
      firstHotfixBootstrap: bootstrapRequested,
    });
    // #6295 item 6: refuse only when master's gate is red, never while it is
    // pending; with a required merge queue the refusal is removed entirely.
    if (!named.ok && named.status.disposition !== "pending") {
      const queue = masterGateQueueMode(prNumber, current.repo, options);
      if (!queue) {
        const cause =
          named.outcome === "first-hotfix-bootstrap"
            ? FIRST_HOTFIX_BOOTSTRAP_RECOVERY
            : (named.error ?? "named Merge gate refused");
        // #6893: the red gate first, the missing PR second.
        return deny(
          "deny-master-merge-gate-red",
          noPullRequest === null ? cause : `${cause} ${noPullRequest}`,
        );
      }
    }
  }
  const observables = runObservablesComplete(current, options);
  if (!observables.ok) return observables;
  const manifest = [...current.reviewedFileManifest];
  const observed =
    options?.projectRoot !== undefined && options.projectRoot.length > 0
      ? computeControllerObservedHash({
          reviewedFiles: manifest,
          cwd: options.projectRoot,
        })
      : (current.phaseEvidence.semantic.find((s) => s.phaseId === "loop")?.controllerObservedHash ??
        null);
  const reviewedDeletedPaths =
    options?.projectRoot !== undefined &&
    options.projectRoot.length > 0 &&
    current.baseSha.length > 0 &&
    current.headSha.length > 0
      ? listDeletedPathsBetween(options.projectRoot, current.baseSha, current.headSha)
      : [];
  // #6888: the disposition comes from the controller-owned verify:ac result only.
  const derived = deriveVerifyAcDisposition({
    result: options?.verifyAcResult,
    projectRoot: options?.projectRoot,
    claimedDisposition: options?.verifyAcDisposition ?? null,
  });
  if (!derived.ok) {
    return deny("deny-incomplete", derived.message);
  }
  if (derived.disposition === "no-obligation" && derived.worktreeKey === null) {
    return deny(
      "deny-incomplete",
      "no-obligation disposition requires admittedUntiedWorktreeKey (#5855).",
    );
  }
  let pushBinding: PrePrPushBinding | null =
    observed !== null && observed.length > 0 && manifest.length > 0
      ? {
          reviewedFileManifest: manifest,
          controllerObservedHash: observed,
          pushStageMarker: PRE_PR_PUSH_STAGE_MARKER,
          reviewedDeletedPaths,
        }
      : null;
  if (pushBinding !== null && derived.disposition !== null) {
    const withDisposition: PrePrPushBindingWithDisposition = {
      ...pushBinding,
      verifyAcDisposition: derived.disposition,
      ...(derived.disposition === "no-obligation" && derived.worktreeKey !== null
        ? { admittedUntiedWorktreeKey: derived.worktreeKey }
        : {}),
    };
    pushBinding = withDisposition;
  }
  const published: PrePrExecutionRecord = {
    ...current,
    state: "complete",
    outcome: "pass",
    pushBinding,
    completedAt: utcIso(now),
    publishedAt: utcIso(now),
  };
  store.put(published);
  const notes = [
    ...(options?.verifyAcResult?.kind === "no-target" ? [VERIFY_AC_NO_TARGET_NOTE] : []),
    ...(noPullRequest === null ? [] : [noPullRequest]),
  ];
  return {
    ok: true,
    code: "allow-pass",
    message: [`published ${runId}`, ...notes].join("; "),
  };
}

export function controllerPublisher(): PrePrPublisher {
  return mintPublisher();
}

export { isPublisher };
