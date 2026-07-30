/**
 * Authz mutation evaluation: UAT lease + human-origin grant gates (#2944).
 *
 * Composes with runtimeAuthority (#1394 / #2711): this layer answers "did a
 * human authorize this cohort/op/surface?" — not path capability policy.
 */

import { matchAny } from "../orchestration/pathspec.js";
import {
  evidenceSatisfiesImplementationApproval,
  isHumanOrigin,
  isHumanOriginGrant,
  isRejectedOriginKind,
} from "./origin.js";
import type {
  AuthzDecision,
  AuthzDecisionCode,
  AuthzOperation,
  AuthzState,
  GrantScope,
  HumanOriginGrant,
  UatLease,
} from "./types.js";

/** Paths that remain writable under UAT without a fix-cohort grant (evidence / defect capture). */
export const UAT_SAFE_WRITE_GLOBS: readonly string[] = [
  "xbrief/proposed/**",
  "vbrief/proposed/**",
  "**/evidence/**",
  "**/uat-evidence/**",
  "incidents/**",
];

export interface EvaluateAuthzInput {
  readonly state: AuthzState;
  readonly grants: readonly HumanOriginGrant[];
  readonly op: AuthzOperation | "test" | "evidence" | "unknown";
  /** Project-relative POSIX path for edit ops; null when unclassifiable. */
  readonly path: string | null;
  readonly now?: Date;
  /** Optional structural context the grant may bind to. */
  readonly repo?: string | null;
  readonly branch?: string | null;
  readonly worktree?: string | null;
  readonly planRef?: string | null;
  readonly storyIds?: readonly string[];
  readonly issueIds?: readonly number[];
}

function deny(
  code: AuthzDecisionCode,
  reason: string,
  input: EvaluateAuthzInput,
  grant: HumanOriginGrant | null = null,
): AuthzDecision {
  return {
    allowed: false,
    code,
    reason,
    humanApprovalRef: grant?.id ?? null,
    approvedScope: grant?.scope ?? null,
    attemptedOp: input.op,
    path: input.path,
  };
}

function allow(
  code: AuthzDecisionCode,
  reason: string,
  input: EvaluateAuthzInput,
  grant: HumanOriginGrant | null = null,
): AuthzDecision {
  return {
    allowed: true,
    code,
    reason,
    humanApprovalRef: grant?.id ?? null,
    approvedScope: grant?.scope ?? null,
    attemptedOp: input.op,
    path: input.path,
  };
}

function activeUat(state: AuthzState): UatLease | null {
  const uat = state.uat;
  if (uat === null || !uat.active) return null;
  // startedBy must itself be human-origin — agent-minted UAT start is ignored.
  if (!isHumanOrigin(uat.startedBy)) return null;
  return uat;
}

function isUatSafeWritePath(path: string | null): boolean {
  if (path === null) return false;
  return matchAny(UAT_SAFE_WRITE_GLOBS, path);
}

function grantCoversOp(grant: HumanOriginGrant, op: AuthzOperation): boolean {
  return grant.scope.operations.includes(op);
}

function grantCoversSurface(grant: HumanOriginGrant, path: string | null): boolean {
  if (path === null) {
    // Unclassifiable path: require empty surfaces (unrestricted) to allow.
    return grant.scope.surfaces.length === 0;
  }
  if (grant.scope.surfaces.length === 0) return true;
  return matchAny(grant.scope.surfaces, path);
}

/**
 * Structural context binding: when a grant pins a field, the attempt must supply
 * a matching value. Missing attempt context does NOT skip the check (fail closed).
 */
function grantContextMatches(grant: HumanOriginGrant, input: EvaluateAuthzInput): boolean {
  const s = grant.scope;
  if (s.repo !== null) {
    if (input.repo === null || input.repo === undefined) return false;
    if (s.repo.toLowerCase() !== input.repo.toLowerCase()) return false;
  }
  if (s.branch !== null) {
    if (input.branch === null || input.branch === undefined) return false;
    if (s.branch !== input.branch) return false;
  }
  if (s.worktree !== null) {
    if (input.worktree === null || input.worktree === undefined) return false;
    if (s.worktree !== input.worktree) return false;
  }
  if (s.planRef !== null) {
    if (input.planRef === null || input.planRef === undefined) return false;
    if (s.planRef !== input.planRef) return false;
  }
  if (s.storyIds.length > 0) {
    const attempt = input.storyIds ?? [];
    if (attempt.length === 0) return false;
    const want = new Set(s.storyIds);
    if (!attempt.some((id) => want.has(id))) return false;
  }
  if (s.issueIds.length > 0) {
    const attempt = input.issueIds ?? [];
    if (attempt.length === 0) return false;
    const want = new Set(s.issueIds);
    if (!attempt.some((id) => want.has(id))) return false;
  }
  return true;
}

function grantValidity(
  grant: HumanOriginGrant,
  now: Date,
): { ok: true } | { ok: false; code: AuthzDecisionCode; reason: string } {
  if (!isHumanOriginGrant(grant)) {
    const kind = grant.origin.kind;
    if (isRejectedOriginKind(kind)) {
      return {
        ok: false,
        code: "authz-grant-origin-reject",
        reason:
          `Directive denied this mutation: grant ${grant.id} origin.kind=${kind} is ` +
          "agent/self-authored and cannot satisfy an implementation-approval gate. " +
          "Human action required: run `deft authz:grant` (operator-cli) for the approved cohort.",
      };
    }
    return {
      ok: false,
      code: "authz-grant-origin-reject",
      reason:
        `Directive denied this mutation: grant ${grant.id} lacks human-origin provenance. ` +
        "Human action required: mint a grant via `deft authz:grant` with operator-cli origin.",
    };
  }
  if (grant.semantics.revokedAt !== null) {
    return {
      ok: false,
      code: "authz-grant-revoked",
      reason: `Directive denied this mutation: grant ${grant.id} was revoked at ${grant.semantics.revokedAt}.`,
    };
  }
  if (grant.semantics.singleUse && grant.semantics.usedAt !== null) {
    return {
      ok: false,
      code: "authz-grant-single-use-spent",
      reason: `Directive denied this mutation: single-use grant ${grant.id} already spent at ${grant.semantics.usedAt}.`,
    };
  }
  if (grant.semantics.expiresAt !== null) {
    const exp = Date.parse(grant.semantics.expiresAt);
    if (!Number.isNaN(exp) && exp <= now.getTime()) {
      return {
        ok: false,
        code: "authz-grant-expired",
        reason:
          `Directive denied this mutation: grant ${grant.id} expired at ${grant.semantics.expiresAt}. ` +
          "Human action required: mint a fresh grant via `deft authz:grant`.",
      };
    }
  }
  return { ok: true };
}

/**
 * Find a live human-origin grant that structurally covers the attempted op/surface.
 * Returns the first matching grant, or the best rejection reason if none match.
 */
function findCoveringGrant(
  input: EvaluateAuthzInput,
  op: AuthzOperation,
): { grant: HumanOriginGrant } | { grant: null; code: AuthzDecisionCode; reason: string } {
  const now = input.now ?? new Date();
  let lastReject: { code: AuthzDecisionCode; reason: string } | null = null;

  for (const grant of input.grants) {
    // Production path: only human-origin grants satisfy implementation approval (#2944).
    if (!evidenceSatisfiesImplementationApproval({ grant })) {
      const validity = grantValidity(grant, now);
      if (!validity.ok) {
        lastReject = { code: validity.code, reason: validity.reason };
        continue;
      }
      lastReject = {
        code: "authz-grant-origin-reject",
        reason:
          `Directive denied this mutation: grant ${grant.id} does not satisfy human-origin ` +
          "implementation approval (self-authored lifecycle/dispatch tokens never count). " +
          "Human action required: run `deft authz:grant`.",
      };
      continue;
    }
    const validity = grantValidity(grant, now);
    if (!validity.ok) {
      lastReject = { code: validity.code, reason: validity.reason };
      continue;
    }
    // Under active UAT, product mutations require a named fix cohort.
    if (grant.scope.cohortId === null || grant.scope.cohortId.length === 0) {
      lastReject = {
        code: "authz-grant-scope-deny",
        reason:
          `Directive denied this mutation under active UAT: grant ${grant.id} has no named ` +
          "fix cohort (cohortId). Approving product changes during UAT requires a named " +
          "cohort via `deft authz:grant -- --cohort <id> ...`.",
      };
      continue;
    }
    if (!grantCoversOp(grant, op)) {
      lastReject = {
        code: "authz-grant-scope-deny",
        reason:
          `Directive denied this mutation: grant ${grant.id} does not include operation ` +
          `'${String(op).replace(/[\r\n]/g, " ")}'. Human action required: mint/extend a grant ` +
          `with operations including ${String(op).replace(/[\r\n]/g, " ")} ` +
          `(\`deft authz:grant -- --operations ${String(op).replace(/[\r\n]/g, " ")},...\`).`,
      };
      continue;
    }
    if (op === "edit" && !grantCoversSurface(grant, input.path)) {
      lastReject = {
        code: "authz-grant-scope-deny",
        reason:
          `Directive denied this mutation: path ${input.path ?? "(unknown)"} is outside ` +
          `grant ${grant.id} surfaces. Human action required: include the surface in the ` +
          "approved grant (`deft authz:grant -- --surfaces <glob>`).",
      };
      continue;
    }
    if (!grantContextMatches(grant, input)) {
      lastReject = {
        code: "authz-grant-scope-deny",
        reason:
          `Directive denied this mutation: grant ${grant.id} is bound to a different ` +
          "repo/branch/plan/story context than the attempted operation.",
      };
      continue;
    }
    return { grant };
  }

  if (lastReject !== null) return { grant: null, ...lastReject };
  return {
    grant: null,
    code: "authz-grant-missing",
    reason:
      "Directive denied this mutation: no human-origin approval grant covers the attempted " +
      `operation '${op}'. Human action required: run \`deft authz:grant\` for the approved ` +
      "cohort (self-authored xBRIEF/lifecycle/dispatch tokens do not count).",
  };
}

/**
 * Evaluate a mutation under UAT lease + human-origin grants.
 *
 * When UAT is inactive, returns allow/authz-inactive (no new denials) so Wave 1
 * does not break non-UAT workflows. When UAT is active, product mutations fail
 * closed unless a named fix-cohort human-origin grant covers the op/surface.
 * Test / evidence / issue_mutation ops stay allowed under UAT without a grant.
 */
export function evaluateAuthzMutation(input: EvaluateAuthzInput): AuthzDecision {
  const uat = activeUat(input.state);

  // Always-allowed under UAT (and outside UAT): tests, evidence, issue filing.
  if (input.op === "test" || input.op === "evidence" || input.op === "issue_mutation") {
    return allow(
      uat !== null ? "authz-allow" : "authz-inactive",
      uat !== null
        ? `Directive allowed ${input.op} under active UAT campaign ${uat.campaignId}.`
        : `Directive authz inactive; ${input.op} unrestricted by Wave 1 gates.`,
      input,
    );
  }

  if (uat === null) {
    // Outside UAT: Wave 1 does not require grants for every edit (that would
    // break normal implement sessions). Self-authored evidence still never
    // counts if a caller asks isHumanOriginGrant / evidenceSatisfies… —
    // the hard fail-closed posture is the active UAT lease.
    return allow(
      "authz-inactive",
      "Directive authz UAT lease inactive; mutation not gated by Wave 1 UAT fail-closed path.",
      input,
    );
  }

  // Active UAT: product mutations require a named fix-cohort human-origin grant.
  if (input.op === "unknown") {
    return deny(
      "authz-uat-deny",
      `Directive denied unclassifiable mutation under active UAT campaign ${uat.campaignId}. ` +
        "Fail closed: classify the operation or suspend UAT (`deft authz:uat-suspend`) / " +
        "mint a named fix cohort (`deft authz:grant -- --cohort <id>`).",
      input,
    );
  }

  // Safe write paths (defect capture / evidence) stay open without a cohort grant.
  if (input.op === "edit" && isUatSafeWritePath(input.path)) {
    return allow(
      "authz-allow",
      `Directive allowed UAT-safe write to ${input.path} (evidence/defect capture) ` +
        `under campaign ${uat.campaignId}.`,
      input,
    );
  }

  const covered = findCoveringGrant(input, input.op);
  if (covered.grant === null) {
    return deny(
      covered.code,
      covered.reason.includes("active UAT")
        ? covered.reason
        : `${covered.reason} Active UAT campaign: ${uat.campaignId}.`,
      input,
    );
  }

  return allow(
    "authz-allow",
    `Directive allowed ${input.op} under UAT campaign ${uat.campaignId} via human-origin ` +
      `grant ${covered.grant.id} (cohort ${covered.grant.scope.cohortId ?? "n/a"}).`,
    input,
    covered.grant,
  );
}

/**
 * Whether a decision should mark a single-use grant spent after allow.
 * Callers (dispatcher) persist via markGrantUsed.
 */
export function shouldConsumeSingleUseGrant(decision: AuthzDecision): boolean {
  return decision.allowed && decision.humanApprovalRef !== null && decision.code === "authz-allow";
}

/** Snapshot of approved scope for audit/deny messages. */
export function describeScope(scope: GrantScope | null): string {
  if (scope === null) return "(none)";
  const parts = [
    `ops=[${scope.operations.join(",")}]`,
    `surfaces=${scope.surfaces.length === 0 ? "*" : scope.surfaces.join("|")}`,
    scope.cohortId === null ? null : `cohort=${scope.cohortId}`,
    scope.planRef === null ? null : `plan=${scope.planRef}`,
  ].filter((p): p is string => p !== null);
  return parts.join(" ");
}
