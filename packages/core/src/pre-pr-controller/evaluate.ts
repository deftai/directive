/**
 * Distinct pre-PR pass predicate (#4912). Does not reuse one-PR-unit verdict.
 * Private store is authoritative; presented run ids are lookup hints.
 */

import { runObservablesComplete } from "./controller.js";
import { evaluateCriteriaAuthority } from "./criteria.js";
import type { PrePrExecutionStore } from "./store.js";
import { resolveRecordFromStore } from "./store.js";
import {
  type ApprovedCriteria,
  CHECKBOX_NOT_AUTHORITY,
  DISK_STORE_NOT_SOT,
  deny,
  ONE_PR_UNIT_NOT_PRE_PR,
  type PrePrDecision,
  type PrePrExecutionRecord,
  type PrePrLiveBinding,
  RUN_ID_LOOKUP_HINT,
} from "./types.js";

export interface EvaluatePrePrEvidenceInput {
  /** Record resolved from the private store. Null means no store hit. */
  readonly record: PrePrExecutionRecord | null;
  readonly liveBinding: PrePrLiveBinding;
  /** Author-supplied run id. Lookup hint only. */
  readonly presentedRunId?: string | null;
  readonly presentedIdWithoutStore?: boolean;
  readonly approvedCriteria: ApprovedCriteria;
  readonly currentGeneration: number;
  readonly headCriteria?: ApprovedCriteria | null;
  readonly lastInvalidationAt?: string | null;
  /** One-PR-unit ok is not pre-PR success. */
  readonly onePrUnitOk?: boolean;
  readonly checkboxComplete?: boolean;
  readonly authorToken?: string | null;
  readonly diskJsonPath?: string | null;
}

export function evaluatePrePrEvidence(input: EvaluatePrePrEvidenceInput): PrePrDecision {
  if (input.onePrUnitOk === true && input.record === null) {
    return deny("deny-one-pr-unit-not-pre-pr", ONE_PR_UNIT_NOT_PRE_PR);
  }
  if (input.checkboxComplete === true && input.record === null) {
    return deny("deny-checkbox-not-authority", CHECKBOX_NOT_AUTHORITY);
  }
  const token = input.authorToken?.trim() ?? "";
  if (token.length > 0 && input.record === null) {
    return deny("deny-author-token", CHECKBOX_NOT_AUTHORITY);
  }
  if (input.diskJsonPath !== undefined && input.diskJsonPath !== null && input.record === null) {
    return deny("deny-disk-not-sot", DISK_STORE_NOT_SOT);
  }
  if (input.presentedIdWithoutStore === true && input.record === null) {
    return deny("deny-not-bearer", RUN_ID_LOOKUP_HINT);
  }
  if (input.record === null) {
    return deny(
      "deny-missing-record",
      "no controller-issued pre-PR completion record in the private store",
    );
  }
  return evaluateStoredRecord(input, input.record);
}

function evaluateStoredRecord(
  input: EvaluatePrePrEvidenceInput,
  record: PrePrExecutionRecord,
): PrePrDecision {
  const live = input.liveBinding;
  if (record.repo.toLowerCase() !== live.repo.toLowerCase()) {
    return deny("deny-binding", `pre-PR record ${record.id} is bound to repo ${record.repo}`);
  }
  if (record.baseSha !== live.baseSha || record.headSha !== live.headSha) {
    return deny("deny-binding", `pre-PR record ${record.id} does not match live base/head SHAs`);
  }
  const recNode = record.prNodeId?.trim() ?? "";
  const liveNode = live.prNodeId?.trim() ?? "";
  if (recNode.length > 0 || liveNode.length > 0) {
    if (recNode.length === 0 || liveNode.length === 0 || recNode !== liveNode) {
      return deny("deny-binding", `pre-PR record ${record.id} is bound to a different PR node id`);
    }
  }
  if (live.prBodyHash !== record.prBodyHash) {
    return deny("deny-binding", `pre-PR record ${record.id} does not match live PR body hash`);
  }
  if (record.outcome !== "pass" || record.state !== "complete" || record.publishedAt === null) {
    if (record.state === "failed") return deny("deny-failed", "failed pre-PR run mints no pass");
    if (record.state === "interrupted") {
      return deny("deny-interrupted", "interrupted pre-PR run mints no pass");
    }
    return deny("deny-incomplete", "incomplete pre-PR run mints no pass");
  }
  const observables = runObservablesComplete(record);
  if (!observables.ok) return observables;
  return evaluateCriteriaAuthority({
    record,
    currentGeneration: input.currentGeneration,
    approved: input.approvedCriteria,
    headCriteria: input.headCriteria ?? null,
    lastInvalidationAt: input.lastInvalidationAt ?? null,
  });
}

export function evaluateLivePrePrCheck(input: {
  readonly store: PrePrExecutionStore;
  readonly liveBinding: PrePrLiveBinding;
  readonly presentedRunId?: string | null;
  readonly approvedCriteria: ApprovedCriteria;
  readonly currentGeneration: number;
  readonly headCriteria?: ApprovedCriteria | null;
  readonly lastInvalidationAt?: string | null;
}): PrePrDecision {
  const presented = input.presentedRunId?.trim() ?? "";
  const record = resolveRecordFromStore(input.store, {
    id: presented.length > 0 ? presented : null,
    prNodeId: input.liveBinding.prNodeId,
  });
  return evaluatePrePrEvidence({
    record,
    liveBinding: input.liveBinding,
    presentedRunId: presented.length > 0 ? presented : null,
    presentedIdWithoutStore: presented.length > 0 && record === null,
    approvedCriteria: input.approvedCriteria,
    currentGeneration: input.currentGeneration,
    headCriteria: input.headCriteria,
    lastInvalidationAt: input.lastInvalidationAt,
  });
}

export function canReuseCommandResult(input: {
  readonly previousInputHash: string;
  readonly currentInputHash: string;
  readonly previousCommand: string;
  readonly currentCommand: string;
  readonly previousExitCode: number;
}): PrePrDecision {
  if (input.previousInputHash !== input.currentInputHash) {
    return deny(
      "deny-reuse-mismatch",
      "reuse of a check result requires a full input-binding match",
    );
  }
  if (input.previousCommand !== input.currentCommand) {
    return deny("deny-reuse-mismatch", "reuse of a check result requires the same command");
  }
  if (input.previousExitCode !== 0) {
    return deny("deny-command-failure", "failed command results cannot be reused as a pass");
  }
  return { ok: true, code: "allow-pass", message: "full input-binding match; reuse allowed" };
}
