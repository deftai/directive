/**
 * Distinct pre-PR execution record (#4912). Not one-PR-unit consent.
 * Schema is independent of `deft.one-pr-unit.v1`.
 */

import { createHash } from "node:crypto";
import type { PrePrPhaseId } from "./phases.js";

export const PRE_PR_EXECUTION_SCHEMA = "deft.pre-pr-execution.v1" as const;

export const DISK_STORE_NOT_SOT =
  "gitignored .deft/pre-pr-controller disk store is not the verifier-visible record";

export const RUN_ID_LOOKUP_HINT =
  "author-supplied pre-PR run id is a lookup hint only; the private store is authoritative";

export const MARK_COMPLETE_NOT_AUTHORITY = "generic mark-complete cannot mint a pre-PR pass";

export const SKILL_FILE_OPEN_NOT_COMPLETION = "opening the pre-PR skill file is not completion";

export const ONE_PR_UNIT_NOT_PRE_PR = "one-PR-unit verdict is not pre-PR success";

export const CHECKBOX_NOT_AUTHORITY =
  "checkbox parsers, gitignored pr:ready markers, and author-supplied completion tokens remain non-authority";

export const PUBLISHER_REQUIRED =
  "passing pre-PR records require controller publisher credentials the implementing agent does not hold";

export type PrePrRunState = "started" | "running" | "failed" | "interrupted" | "complete";

export type PrePrOutcome = "none" | "pass" | "block";

export interface PrePrLiveBinding {
  readonly repo: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly prNodeId: string | null;
  readonly prBodyHash: string;
}

export interface PrePrInputBinding {
  readonly repo: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly treeHash: string;
  readonly prBodyHash: string;
  readonly criteriaDigest: string;
  readonly skillVersion: string;
  readonly policyVersion: string;
  readonly controllerVersion: string;
  readonly approvedRevisionSha: string;
}

export interface CommandObservation {
  readonly phaseId: PrePrPhaseId;
  readonly command: string;
  readonly exitCode: number;
  readonly inputHash: string;
  readonly completedAt: string;
  readonly skipReason: string | null;
}

export interface SemanticEvidence {
  readonly phaseId: PrePrPhaseId;
  readonly reviewedFileManifest: readonly string[];
  readonly suppliedContentsHash: string;
  readonly criteriaDigest: string;
  /** Reviewer prose is evidence-to-validate; it never drives transitions. */
  readonly reviewerReportRef: string | null;
  readonly controllerObservedHash: string;
  readonly recordedAt: string;
}

export interface PrePrPhaseEvidence {
  readonly commands: readonly CommandObservation[];
  readonly semantic: readonly SemanticEvidence[];
}

export interface ApprovedCriteria {
  readonly digest: string;
  readonly generation: number;
  readonly sourceRevisionSha: string;
  readonly scopeDigest: string;
  readonly acceptanceDigest: string;
}

/** Canonical private-store claim. `id` is a lookup key, not a bearer. */
export interface PrePrExecutionRecord {
  readonly schema: typeof PRE_PR_EXECUTION_SCHEMA;
  readonly id: string;
  readonly state: PrePrRunState;
  readonly outcome: PrePrOutcome;
  readonly repo: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly treeHash: string;
  readonly inputHash: string;
  readonly prNodeId: string | null;
  readonly prBodyHash: string;
  readonly criteria: ApprovedCriteria;
  readonly skillVersion: string;
  readonly policyVersion: string;
  readonly controllerVersion: string;
  readonly workflowVersion: string;
  readonly approvedRevisionSha: string;
  readonly evaluationGeneration: number;
  readonly phaseEvidence: PrePrPhaseEvidence;
  readonly reviewedFileManifest: readonly string[];
  readonly reviewReportRef: string | null;
  readonly finalNoChange: boolean;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly interruptedAt: string | null;
  readonly failedAt: string | null;
  readonly publishedAt: string | null;
}

export type PrePrDecisionCode =
  | "allow-pass"
  | "deny-missing-record"
  | "deny-not-bearer"
  | "deny-disk-not-sot"
  | "deny-binding"
  | "deny-incomplete"
  | "deny-failed"
  | "deny-interrupted"
  | "deny-omitted-phase"
  | "deny-command-failure"
  | "deny-input-mismatch"
  | "deny-criteria-invalidated"
  | "deny-generation-stale"
  | "deny-head-weakening"
  | "deny-out-of-order"
  | "deny-skill-file-open"
  | "deny-mark-complete"
  | "deny-one-pr-unit-not-pre-pr"
  | "deny-checkbox-not-authority"
  | "deny-author-token"
  | "deny-publisher-required"
  | "deny-reuse-mismatch";

export interface PrePrDecision {
  readonly ok: boolean;
  readonly code: PrePrDecisionCode;
  readonly message: string;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function utcIso(now?: Date): string {
  const dt = now ?? new Date();
  return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function inputBindingHash(binding: PrePrInputBinding): string {
  return sha256Hex(
    JSON.stringify({
      repo: binding.repo,
      baseSha: binding.baseSha,
      headSha: binding.headSha,
      treeHash: binding.treeHash,
      prBodyHash: binding.prBodyHash,
      criteriaDigest: binding.criteriaDigest,
      skillVersion: binding.skillVersion,
      policyVersion: binding.policyVersion,
      controllerVersion: binding.controllerVersion,
      approvedRevisionSha: binding.approvedRevisionSha,
    }),
  );
}

export function deny(code: PrePrDecision["code"], message: string): PrePrDecision {
  return { ok: false, code, message };
}

export function allow(code: PrePrDecision["code"], message: string): PrePrDecision {
  return { ok: true, code, message };
}
