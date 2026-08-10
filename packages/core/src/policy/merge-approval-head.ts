/**
 * Head-bound human merge approval (#3235).
 *
 * Phase 5 → 6 `plan:approved` events authorize one immutable PR head.
 * When PR HEAD changes after approval (and GitHub auto-merge may still be
 * enabled), Directive fails closed: treats the approval as stale, attempts to
 * disable auto-merge, and emits recovery text requiring a fresh approval bound
 * to the current head.
 *
 * Prefer this path from finish-loop / pr-wait-mergeable / require-human-merge
 * consumers. Does not change consumer repository rulesets.
 */

import { join } from "node:path";
import { type BehavioralEventRecord, DEFAULT_EVENT_LOG, readEvents } from "../lifecycle/events.js";
import { captureExec } from "../pr-wait-mergeable/wrappers.js";
import { resolveBinary } from "../scm/binary.js";
import { resolveHumanMergePolicy } from "./require-human-merge.js";

/** Event name recorded at Phase 5 → 6 approval. */
export const PLAN_APPROVED_EVENT = "plan:approved";

export type MergeApprovalHeadStatus =
  /** approved_head_sha matches current_head_sha. */
  | "ok"
  /** Approval bound to a different head than current. */
  | "stale"
  /** Approval exists but was not bound to a head SHA. */
  | "missing_binding"
  /** No plan:approved record for this PR. */
  | "no_approval"
  /** Gate intentionally skipped (e.g. no PR / no current head). */
  | "skipped";

export interface PlanApprovedRecord {
  readonly head_sha: string | null;
  readonly pr_number: number | null;
  readonly approver: string | null;
  readonly plan_ref: string | null;
  readonly detected_at: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface MergeApprovalHeadResult {
  readonly status: MergeApprovalHeadStatus;
  /** False when merge must not proceed under head-bound contract. */
  readonly allowed: boolean;
  readonly approved_head_sha: string | null;
  readonly current_head_sha: string | null;
  readonly pr_number: number;
  readonly require_human_merge: boolean;
  readonly auto_merge_disabled: boolean | null;
  readonly message: string;
  readonly recovery: string | null;
}

export type DisableAutoMergeFn = (
  prNumber: number,
  repo: string | null,
) => { readonly ok: boolean; readonly stderr: string };

export type FetchPrHeadShaFn = (prNumber: number, repo: string | null) => string | null;

export type ReadEventsFn = (logPath?: string | null) => BehavioralEventRecord[];

/** Full Git object id length — approvals must bind to exact heads (#3235 / Greptile P1). */
export const FULL_HEAD_SHA_LEN = 40;

function isHexSha(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    const isDigit = c >= 48 && c <= 57;
    const isAf = c >= 97 && c <= 102;
    if (!isDigit && !isAf) return false;
  }
  return value.length > 0;
}

function normalizeSha(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length < FULL_HEAD_SHA_LEN) return null;
  if (!isHexSha(trimmed)) return null;
  // Bind to first 40 hex chars only (reject ambiguous longer tokens).
  return trimmed.slice(0, FULL_HEAD_SHA_LEN);
}

/**
 * Exact full-SHA equality only (#3235).
 * Prefix matching is forbidden: abbreviated approval SHAs must not authorize a later head.
 */
export function headShaMatches(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (left.length !== FULL_HEAD_SHA_LEN || right.length !== FULL_HEAD_SHA_LEN) return false;
  if (!isHexSha(left) || !isHexSha(right)) return false;
  return left === right;
}

/** Extract trailing decimal digits starting at index (no regex — CodeQL safe). */
function parseLeadingDigits(text: string, start: number): number | null {
  let digits = "";
  for (let i = start; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 48 || c > 57) break;
    digits += text[i];
  }
  if (digits.length === 0) return null;
  const n = Number.parseInt(digits, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function prNumberFromPayload(payload: Record<string, unknown>): number | null {
  const raw = payload.pr_number;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    let allDigits = trimmed.length > 0;
    for (let i = 0; i < trimmed.length; i += 1) {
      const c = trimmed.charCodeAt(i);
      if (c < 48 || c > 57) {
        allDigits = false;
        break;
      }
    }
    if (allDigits) return Number.parseInt(trimmed, 10);
  }
  const planRef = payload.plan_ref;
  if (typeof planRef === "string") {
    const lower = planRef.toLowerCase();
    const marker = "/pull/";
    const idx = lower.indexOf(marker);
    if (idx >= 0) {
      return parseLeadingDigits(planRef, idx + marker.length);
    }
  }
  return null;
}

function repositoryFromPayload(payload: Record<string, unknown>): string | null {
  if (typeof payload.repository === "string" && payload.repository.includes("/")) {
    return payload.repository.toLowerCase();
  }
  if (typeof payload.plan_ref === "string") {
    const lower = payload.plan_ref.toLowerCase();
    const marker = "github.com/";
    const idx = lower.indexOf(marker);
    if (idx >= 0) {
      const rest = payload.plan_ref.slice(idx + marker.length);
      const parts = rest.split("/");
      if (parts.length >= 2 && parts[0] && parts[1]) {
        return `${parts[0]}/${parts[1]}`.toLowerCase();
      }
    }
  }
  return null;
}

function toPlanApproved(record: BehavioralEventRecord): PlanApprovedRecord {
  const payload = record.payload;
  return {
    head_sha: normalizeSha(payload.head_sha),
    pr_number: prNumberFromPayload(payload),
    approver: typeof payload.approver === "string" ? payload.approver : null,
    plan_ref: typeof payload.plan_ref === "string" ? payload.plan_ref : null,
    detected_at: typeof record.detected_at === "string" ? record.detected_at : null,
    payload,
  };
}

/**
 * Latest plan:approved for a PR (by log order; last write wins).
 * When `repo` is set, prefer records whose repository/plan_ref matches (P2 #3235).
 */
export function findLatestPlanApprovalForPr(
  prNumber: number,
  options: {
    readonly logPath?: string | null;
    readonly readEventsFn?: ReadEventsFn;
    readonly records?: readonly BehavioralEventRecord[];
    /** owner/repo — scopes lookup when multiple remotes share a PR number. */
    readonly repo?: string | null;
  } = {},
): PlanApprovedRecord | null {
  const stream =
    options.records !== undefined
      ? options.records
      : (options.readEventsFn ?? readEvents)(options.logPath ?? null);
  const wantRepo =
    typeof options.repo === "string" && options.repo.includes("/")
      ? options.repo.toLowerCase()
      : null;
  let latest: PlanApprovedRecord | null = null;
  for (const record of stream) {
    if (record.event !== PLAN_APPROVED_EVENT) continue;
    const approved = toPlanApproved(record);
    if (approved.pr_number !== prNumber) continue;
    if (wantRepo !== null) {
      // When repo is known, never fall back to an unscoped same-number event
      // (cross-repo shadow / Greptile conf floor on #3235).
      const recRepo = repositoryFromPayload(record.payload);
      if (recRepo !== wantRepo) continue;
    }
    latest = approved;
  }
  return latest;
}

/** Recovery instructions when approval is stale or unbound. */
export function buildMergeApprovalRecovery(input: {
  readonly prNumber: number;
  readonly approvedHeadSha: string | null;
  readonly currentHeadSha: string | null;
  readonly status: MergeApprovalHeadStatus;
  readonly autoMergeDisabled: boolean | null;
}): string {
  const approved = input.approvedHeadSha ?? "<none>";
  const current = input.currentHeadSha ?? "<unknown>";
  const lines = [
    "Recovery (#3235 head-bound merge approval):",
    `  • approved_head_sha=${approved}`,
    `  • current_head_sha=${current}`,
  ];
  if (input.autoMergeDisabled === true) {
    lines.push("  • GitHub auto-merge was disabled for this PR (stale authorization revoked).");
  } else if (input.autoMergeDisabled === false) {
    lines.push(
      "  • Could not confirm auto-merge disable — run:",
      `      gh pr merge ${input.prNumber} --disable-auto`,
    );
  } else {
    lines.push(
      "  • If auto-merge is still enabled, disable it:",
      `      gh pr merge ${input.prNumber} --disable-auto`,
    );
  }
  lines.push(
    "  • Re-run Phase 5 → 6 approval for the CURRENT head:",
    "      task lifecycle:event -- emit plan:approved \\",
    "        --plan-ref <pr-url> --approver <login> --approval-phrase yes \\",
    `        --pr-number ${input.prNumber} --head-sha ${current}`,
    "  • Only after a fresh head-bound approval may auto-merge be re-enabled",
    "    or the human merge proceed for this head.",
  );
  if (input.status === "missing_binding") {
    lines.push(
      "  • Prior approval lacked --head-sha; re-emit with --head-sha bound to current HEAD.",
    );
  }
  return lines.join("\n");
}

export interface EvaluateMergeApprovalHeadInput {
  readonly prNumber: number;
  readonly currentHeadSha: string | null;
  readonly projectRoot?: string;
  readonly logPath?: string | null;
  readonly requireHumanMerge?: boolean;
  /** owner/repo for scoped approval lookup. */
  readonly repo?: string | null;
  /**
   * When true (default), approval without head_sha fails closed under
   * requireHumanMerge. When false, missing binding is advisory only.
   */
  readonly enforceStrictBinding?: boolean;
  /**
   * When true, run the gate whenever a plan:approved exists for the PR
   * (default). When false, only under requireHumanMerge.
   */
  readonly enforceWhenApprovalPresent?: boolean;
  readonly readEventsFn?: ReadEventsFn;
  readonly records?: readonly BehavioralEventRecord[];
  readonly approval?: PlanApprovedRecord | null;
}

/**
 * Pure evaluation: compare recorded approval head to current PR HEAD.
 */
export function evaluateMergeApprovalHead(
  input: EvaluateMergeApprovalHeadInput,
): MergeApprovalHeadResult {
  const prNumber = input.prNumber;
  const currentHeadSha = normalizeSha(input.currentHeadSha);
  const requireHumanMerge =
    input.requireHumanMerge !== undefined
      ? input.requireHumanMerge
      : input.projectRoot !== undefined
        ? resolveHumanMergePolicy(input.projectRoot).requireHumanMerge
        : false;

  const enforceWhenApprovalPresent = input.enforceWhenApprovalPresent !== false;
  const enforceStrictBinding = input.enforceStrictBinding !== false;

  if (prNumber <= 0) {
    return {
      status: "skipped",
      allowed: true,
      approved_head_sha: null,
      current_head_sha: currentHeadSha,
      pr_number: prNumber,
      require_human_merge: requireHumanMerge,
      auto_merge_disabled: null,
      message: "merge-approval-head: skipped (invalid pr number)",
      recovery: null,
    };
  }

  const resolvedLogPath =
    input.logPath !== undefined
      ? input.logPath
      : input.projectRoot !== undefined
        ? join(input.projectRoot, DEFAULT_EVENT_LOG)
        : null;

  const approval =
    input.approval !== undefined
      ? input.approval
      : findLatestPlanApprovalForPr(prNumber, {
          logPath: resolvedLogPath,
          readEventsFn: input.readEventsFn,
          records: input.records,
          repo: input.repo ?? null,
        });

  if (approval === null) {
    // No Directive-owned approval — gate is a no-op (human-merge policy is separate).
    return {
      status: "no_approval",
      allowed: true,
      approved_head_sha: null,
      current_head_sha: currentHeadSha,
      pr_number: prNumber,
      require_human_merge: requireHumanMerge,
      auto_merge_disabled: null,
      message: `merge-approval-head: no plan:approved for PR #${prNumber}`,
      recovery: null,
    };
  }

  if (!enforceWhenApprovalPresent && !requireHumanMerge) {
    return {
      status: "skipped",
      allowed: true,
      approved_head_sha: approval.head_sha,
      current_head_sha: currentHeadSha,
      pr_number: prNumber,
      require_human_merge: requireHumanMerge,
      auto_merge_disabled: null,
      message: "merge-approval-head: skipped (no requireHumanMerge / not enforcing)",
      recovery: null,
    };
  }

  if (approval.head_sha === null) {
    const recovery = buildMergeApprovalRecovery({
      prNumber,
      approvedHeadSha: null,
      currentHeadSha,
      status: "missing_binding",
      autoMergeDisabled: null,
    });
    const fail = enforceStrictBinding && (requireHumanMerge || enforceWhenApprovalPresent);
    return {
      status: "missing_binding",
      allowed: !fail,
      approved_head_sha: null,
      current_head_sha: currentHeadSha,
      pr_number: prNumber,
      require_human_merge: requireHumanMerge,
      auto_merge_disabled: null,
      message:
        `❌ merge-approval-head (#3235): plan:approved for PR #${prNumber} has no head_sha. ` +
        "Approval must bind to an exact PR head under requireHumanMerge / auto-merge.",
      recovery: fail ? recovery : null,
    };
  }

  if (currentHeadSha === null) {
    const recovery = buildMergeApprovalRecovery({
      prNumber,
      approvedHeadSha: approval.head_sha,
      currentHeadSha: null,
      status: "stale",
      autoMergeDisabled: null,
    });
    return {
      status: "stale",
      allowed: false,
      approved_head_sha: approval.head_sha,
      current_head_sha: null,
      pr_number: prNumber,
      require_human_merge: requireHumanMerge,
      auto_merge_disabled: null,
      message:
        `❌ merge-approval-head (#3235): cannot verify approval for PR #${prNumber} ` +
        `(approved_head_sha=${approval.head_sha}) — current HEAD unknown; fail closed.`,
      recovery,
    };
  }

  if (headShaMatches(approval.head_sha, currentHeadSha)) {
    return {
      status: "ok",
      allowed: true,
      approved_head_sha: approval.head_sha,
      current_head_sha: currentHeadSha,
      pr_number: prNumber,
      require_human_merge: requireHumanMerge,
      auto_merge_disabled: null,
      message:
        `✓ merge-approval-head: plan:approved for PR #${prNumber} bound to ` +
        `current head ${currentHeadSha.slice(0, 12)}`,
      recovery: null,
    };
  }

  const recovery = buildMergeApprovalRecovery({
    prNumber,
    approvedHeadSha: approval.head_sha,
    currentHeadSha,
    status: "stale",
    autoMergeDisabled: null,
  });
  return {
    status: "stale",
    allowed: false,
    approved_head_sha: approval.head_sha,
    current_head_sha: currentHeadSha,
    pr_number: prNumber,
    require_human_merge: requireHumanMerge,
    auto_merge_disabled: null,
    message:
      `❌ merge-approval-head (#3235): stale approval for PR #${prNumber}. ` +
      `approved_head_sha=${approval.head_sha} != current_head_sha=${currentHeadSha}. ` +
      "Human merge approval authorizes one immutable head; HEAD changed after approval.",
    recovery,
  };
}

/** Live `gh pr merge <N> --disable-auto` (best-effort). */
export function disablePullRequestAutoMerge(
  prNumber: number,
  repo: string | null,
  options: { readonly timeoutSec?: number } = {},
): { readonly ok: boolean; readonly stderr: string } {
  let binary: string;
  try {
    binary = resolveBinary();
  } catch {
    return { ok: false, stderr: "gh CLI not found" };
  }
  const args = ["pr", "merge", String(prNumber), "--disable-auto"];
  if (repo !== null && repo.length > 0) {
    args.push("--repo", repo);
  }
  const result = captureExec(binary, args, (options.timeoutSec ?? 60) * 1000);
  // gh returns 0 when disabled, and may return non-zero if auto-merge was not enabled
  // ("auto-merge is not enabled") — treat that as ok (already off).
  const stderr = result.stderr.trim();
  if (result.returncode === 0) {
    return { ok: true, stderr };
  }
  const low = stderr.toLowerCase();
  if (
    low.includes("not enabled") ||
    low.includes("auto-merge is disabled") ||
    low.includes("is not set to auto-merge")
  ) {
    return { ok: true, stderr };
  }
  return { ok: false, stderr };
}

/** REST HEAD read via `gh api repos/.../pulls/N --jq .head.sha`. */
export function fetchPrHeadShaRest(
  prNumber: number,
  repo: string | null,
  options: { readonly timeoutSec?: number } = {},
): string | null {
  if (repo === null || repo.length === 0) return null;
  let binary: string;
  try {
    binary = resolveBinary();
  } catch {
    return null;
  }
  const endpoint = `repos/${repo}/pulls/${prNumber}`;
  const result = captureExec(
    binary,
    ["api", endpoint, "--jq", ".head.sha"],
    (options.timeoutSec ?? 60) * 1000,
  );
  if (result.returncode !== 0) return null;
  return normalizeSha(result.stdout.trim());
}

export interface EnforceMergeApprovalHeadInput extends EvaluateMergeApprovalHeadInput {
  readonly repo?: string | null;
  /** When true (default on deny), attempt gh --disable-auto. */
  readonly disableAutoMergeOnDeny?: boolean;
  readonly disableAutoMergeFn?: DisableAutoMergeFn;
  readonly fetchHeadShaFn?: FetchPrHeadShaFn;
}

/**
 * Evaluate + on deny attempt to disable GitHub auto-merge and attach recovery.
 */
export function enforceMergeApprovalHead(
  input: EnforceMergeApprovalHeadInput,
): MergeApprovalHeadResult {
  let currentHeadSha = input.currentHeadSha;
  if (
    (currentHeadSha === null || currentHeadSha === undefined || currentHeadSha.trim() === "") &&
    input.fetchHeadShaFn !== undefined
  ) {
    currentHeadSha = input.fetchHeadShaFn(input.prNumber, input.repo ?? null);
  }

  const evaluated = evaluateMergeApprovalHead({
    ...input,
    currentHeadSha: currentHeadSha ?? null,
  });

  if (evaluated.allowed) {
    return evaluated;
  }

  const shouldDisable = input.disableAutoMergeOnDeny !== false;
  let autoMergeDisabled: boolean | null = null;
  if (shouldDisable) {
    const disableFn = input.disableAutoMergeFn ?? disablePullRequestAutoMerge;
    const disabled = disableFn(input.prNumber, input.repo ?? null);
    autoMergeDisabled = disabled.ok;
  }

  const recovery = buildMergeApprovalRecovery({
    prNumber: input.prNumber,
    approvedHeadSha: evaluated.approved_head_sha,
    currentHeadSha: evaluated.current_head_sha,
    status: evaluated.status,
    autoMergeDisabled,
  });

  return {
    ...evaluated,
    auto_merge_disabled: autoMergeDisabled,
    message: evaluated.message,
    recovery,
  };
}

/** Strip trailing path separators without regex (CodeQL-safe). */
function trimTrailingSeparators(path: string): string {
  let end = path.length;
  while (end > 0) {
    const ch = path.charCodeAt(end - 1);
    if (ch === 47 || ch === 92) {
      // / or \
      end -= 1;
      continue;
    }
    break;
  }
  return path.slice(0, end);
}

/** Default event log path relative to project root. */
export function defaultMergeApprovalEventLog(projectRoot: string): string {
  const root = trimTrailingSeparators(projectRoot);
  const log = DEFAULT_EVENT_LOG.split("\\").join("/");
  return `${root}/${log}`;
}
