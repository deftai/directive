/**
 * Repository-controlled pre-PR controller (#4912 Limbs 1 and 3).
 * Code/policy bind to an approved protected revision independent of the PR
 * under review. Incomplete, failed, and interrupted runs mint no pass.
 * Opening the skill file and generic mark-complete cannot mint a pass.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  inspectGateOverrideGrant,
  isGateOverrideEligibleRefuseCode,
  loadGateOverrideAdmission,
} from "../authz/gate-override.js";
import {
  type CoverageApplicabilityDeps,
  evaluateCoverageApplicability,
} from "../coverage-applicability/index.js";
import { evaluateCoverageHotspots } from "../coverage-hotspots/evaluate.js";
import { isCoverageModeSkipAuthorized, resolveCoverageMode } from "../policy/coverage-mode.js";
import {
  COVERAGE_HEADROOM_MODE_SKIP,
  COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP,
  COVERAGE_HEADROOM_WAIVED_SKIP,
  isAllowedSkip,
  PRE_PR_CONTROLLER_VERSION,
  PRE_PR_PHASES,
  PRE_PR_WORKFLOW_VERSION,
  type PrePrPhaseId,
  type PrePrPhaseSpec,
  phaseSpec,
} from "./phases.js";
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
  type PrePrDecision,
  type PrePrExecutionRecord,
  type PrePrInputBinding,
  PUBLISHER_REQUIRED,
  type SemanticEvidence,
  SKILL_FILE_OPEN_NOT_COMPLETION,
  sha256Hex,
  utcIso,
} from "./types.js";

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
  observation: Omit<CommandObservation, "completedAt"> & { readonly now?: Date },
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
        : isAllowedSkip(observation.phaseId, observation.skipReason);
    // Exit 4 waived must not mark the run failed (#5674); exit 0 alone is measured pass.
    const failed = observation.exitCode !== 0 && !skipOk;
    const row: CommandObservation = {
      phaseId: observation.phaseId,
      command: observation.command,
      exitCode: observation.exitCode,
      inputHash: observation.inputHash,
      skipReason: observation.skipReason,
      completedAt: utcIso(observation.now),
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
      const reportPath = join(projectRoot, "coverage", "coverage-final.json");
      if (!existsSync(reportPath)) {
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
    if (row.exitCode === 5) {
      if (row.skipReason !== COVERAGE_HEADROOM_MODE_SKIP) return false;
      if (spec.command === null || !coverageHotspotsCommandMatches(row.command, spec.command)) {
        return false;
      }
      if (existsSync(join(projectRoot, "coverage", "coverage-final.json"))) return false;
      return isCoverageModeSkipAuthorized(resolveCoverageMode(projectRoot).mode);
    }

    // Authorized N/A is exit 3 only (hotspots emits 3 when inert + no report).
    // Exit 1 measured floor fails must not launder into skip via inert re-derivation.
    // When coverage-final.json exists, Prefer-A keeps the Istanbul floor — refuse skip.
    if (row.exitCode !== 3) return false;
    if (row.skipReason !== COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP) return false;
    if (existsSync(join(projectRoot, "coverage", "coverage-final.json"))) return false;
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
    if (!spec.required) continue;
    const ok =
      spec.kind === "command-observable"
        ? commandSatisfied(record, spec.id, options)
        : semanticSatisfied(record, spec.id);
    if (!ok) {
      return deny(
        "deny-omitted-phase",
        `required phase ${spec.id} has no controller-observed pass`,
      );
    }
    const at = phaseObservedAt(record, spec);
    if (at === null || at.length === 0) {
      return deny(
        "deny-omitted-phase",
        `required phase ${spec.id} has no controller-observed pass`,
      );
    }
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
 * Mint a pass only with publisher credentials. Incomplete/failed/interrupted
 * runs stay non-pass. Agent shells do not receive `publisher`.
 */
export function completeRun(
  store: PrePrExecutionStore,
  publisher: unknown,
  runId: string,
  now?: Date,
  options?: {
    readonly projectRoot?: string;
    readonly applicabilityDeps?: CoverageApplicabilityDeps;
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
  const observables = runObservablesComplete(current, options);
  if (!observables.ok) return observables;
  const published: PrePrExecutionRecord = {
    ...current,
    state: "complete",
    outcome: "pass",
    completedAt: utcIso(now),
    publishedAt: utcIso(now),
  };
  store.put(published);
  return { ok: true, code: "allow-pass", message: `published ${runId}` };
}

export function controllerPublisher(): PrePrPublisher {
  return mintPublisher();
}

export { isPublisher };
