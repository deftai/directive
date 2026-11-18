/**
 * Reason-specific diagnostics for standing ingest-ready chips (#4970).
 *
 * Shared by the read-only stale-ready scan, ingest refusal, and ingest-ready
 * proof-fail when the current labels already carry ingest-ready. Identity is
 * the evaluated candidate's resolved OWNER/NAME and issue number. Callers
 * never re-resolve the command target from the reader's checkout.
 */

import { ACCEPTED_PAIN_LIST_FORMS } from "./citation-grammar.js";
import {
  type CompletedArcVerdict,
  extractOperativeTargetDigest,
  hashIssueBodyBytes,
  type TargetDigestAdmission,
} from "./completed-arc-record.js";

export const INGEST_READY_CHIP = "design-critique:ingest-ready";

export const PAIN_COVERAGE_REASONS = [
  "missing-pain",
  "malformed-pain",
  "unrelieved-pain",
  "unresolved-pain-audit",
] as const;

export type PainCoverageReason = (typeof PAIN_COVERAGE_REASONS)[number];

const PAIN_COVERAGE_REASON_SET = new Set<string>(PAIN_COVERAGE_REASONS);

export function isPainCoverageReason(reason: string): reason is PainCoverageReason {
  return PAIN_COVERAGE_REASON_SET.has(reason);
}

export const PAIN_COVERAGE_REQUIREMENT =
  "Current pain coverage (#4496) requires an operative nonempty Stop 1 pain: list " +
  `(${ACCEPTED_PAIN_LIST_FORMS.join(" | ")}), corresponding lean dispositions, ` +
  "and a later critic carrying operative audit-targets: for asserted ids.";

const CHIP_COMMAND_RE =
  /task scm:issue:design-critique-chip -- --repo ([^/\s]+\/[^/\s]+) --issue ([1-9][0-9]*) --chip mechanism-shaped/;

export function mechanismShapedChipCommand(repo: string, issueNumber: number): string {
  return (
    `task scm:issue:design-critique-chip -- --repo ${repo} --issue ${issueNumber} ` +
    "--chip mechanism-shaped"
  );
}

function oneLineCommand(command: string): string {
  return command.replace(/\r?\n/g, " ");
}

/** Parse the operator chip argv out of mapping text. Null when the command is absent. */
export function extractChipCommandArgv(text: string): string[] | null {
  const match = CHIP_COMMAND_RE.exec(text);
  const repo = match?.[1];
  const issue = match?.[2];
  if (repo === undefined || issue === undefined) return null;
  return ["--repo", repo, "--issue", issue, "--chip", "mechanism-shaped"];
}

export type StaleReadyDiagnosticVerdict =
  | CompletedArcVerdict
  | { readonly status: "unknown"; readonly detail: string };

export interface StaleReadyDiagnosticInput {
  readonly repo: string;
  readonly issueNumber: number;
  readonly labels: readonly string[];
  readonly verdict: StaleReadyDiagnosticVerdict;
  readonly digestAdmission?: TargetDigestAdmission;
  readonly liveIssueBody?: string;
  readonly citedLeanBody?: string;
}

export interface StaleReadyDiagnostic {
  readonly text: string;
  readonly recoveryCommand: string | null;
  readonly kind: "unknown" | "mismatch";
  readonly reason: string;
}

function standingMismatchLine(
  repo: string,
  issueNumber: number,
  labels: readonly string[],
): string {
  if (!labels.includes(INGEST_READY_CHIP)) return "";
  return (
    `Standing ${INGEST_READY_CHIP} on ${repo}#${issueNumber} ` +
    "does not establish a completed record."
  );
}

function missingPainRecovery(repo: string, issueNumber: number): string[] {
  const command = oneLineCommand(mechanismShapedChipCommand(repo, issueNumber));
  return [
    "Recovery (missing-pain later-arc; do not edit the old Stop 1, invent audit evidence, or grandfather missing pain coverage):",
    "1. Post a new Stop 1 with an operative nonempty pain: list.",
    `2. Operator-directed: ${command}`,
    "3. Post a successor lean with valid pain dispositions.",
    "4. Dispatch a later critic carrying operative audit-targets: for asserted ids.",
    "5. Post a completed-arc record citing that new lean.",
    "6. Then the existing guarded ingest-ready write.",
  ];
}

function trailingNewlineNote(
  digestAdmission: TargetDigestAdmission | undefined,
  liveIssueBody: string | undefined,
  citedLeanBody: string | undefined,
): string {
  if (digestAdmission === undefined || digestAdmission.status !== "blocked") return "";
  if (liveIssueBody === undefined || citedLeanBody === undefined) return "";
  const pinned = extractOperativeTargetDigest(citedLeanBody);
  if (pinned === null) return "";
  if (hashIssueBodyBytes(`${liveIssueBody}\n`) !== pinned) return "";
  return (
    "A verified match against sha256(body + newline) is a trailing-newline diagnostic only. " +
    "It is not admission and not an automatic body rewrite."
  );
}

function staleTargetDetail(
  digestAdmission: TargetDigestAdmission | undefined,
  fallback: string,
): string {
  if (digestAdmission !== undefined && digestAdmission.status === "blocked") {
    return digestAdmission.detail;
  }
  return fallback;
}

/**
 * One mapping for scan / ingest refuse / standing ingest-ready proof-fail.
 * Does not grant admission and does not assert record age.
 */
export function formatStaleIngestReadyDiagnostic(
  input: StaleReadyDiagnosticInput,
): StaleReadyDiagnostic {
  const { repo, issueNumber, labels, verdict } = input;
  const identity = `${repo}#${issueNumber}`;
  const standing = standingMismatchLine(repo, issueNumber, labels);
  const lines: string[] = [];

  if (verdict.status === "unknown") {
    lines.push(`${identity}: unknown (${verdict.detail})`);
    if (standing.length > 0) lines.push(standing);
    return {
      text: lines.join("\n"),
      recoveryCommand: null,
      kind: "unknown",
      reason: "unknown",
    };
  }

  const digestBlocked =
    input.digestAdmission !== undefined && input.digestAdmission.status === "blocked";
  let reason: string;
  let detail: string;
  if (digestBlocked) {
    reason = "stale-target";
    detail = staleTargetDetail(input.digestAdmission, "exact-byte digest mismatch");
  } else if (verdict.status === "blocked") {
    reason = verdict.reason;
    detail = verdict.detail;
  } else if (verdict.status === "not-in-arc") {
    reason = "not-in-arc";
    detail = "live thread is not a complete completed-arc record";
  } else {
    reason = "complete";
    detail = "completed-arc record is present";
  }

  lines.push(`${identity}: ${reason} (${detail})`);
  if (standing.length > 0) lines.push(standing);

  if (reason === "stale-target") {
    lines.push(
      "Exact-byte Target-digest mismatch on the live REST issue body. " +
        "This does not assert body drift, and a corrected digest alone does not complete the arc.",
    );
    lines.push(
      "Remedies: (1) restore the issue body to the arced text; " +
        "(2) record an operator drop after ingest with the acceptance-disposition grant " +
        "(--disposition not_applicable); " +
        "(3) post a later lean for an addition or rewording.",
    );
    const newlineNote = trailingNewlineNote(
      input.digestAdmission,
      input.liveIssueBody,
      input.citedLeanBody,
    );
    if (newlineNote.length > 0) lines.push(newlineNote);
  } else if (isPainCoverageReason(reason)) {
    lines.push(PAIN_COVERAGE_REQUIREMENT);
    if (reason === "missing-pain") {
      lines.push(...missingPainRecovery(repo, issueNumber));
    }
  }

  const recoveryCommand =
    reason === "missing-pain"
      ? oneLineCommand(mechanismShapedChipCommand(repo, issueNumber))
      : null;
  return {
    text: lines.join("\n"),
    recoveryCommand,
    kind: "mismatch",
    reason,
  };
}
