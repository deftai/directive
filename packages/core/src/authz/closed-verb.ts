/**
 * Closed-verb evaluator for release-class high-blast verbs (#1095 Wave 4 / #2948).
 *
 * Allow only when:
 *   (a) DEFT_ALLOW_<VERB>=1 ephemeral env bypass, OR
 *   (b) a matching human-origin grant whose operations cover the verb and
 *       surfaces cover the target (empty surfaces = any target).
 *
 * Agent-authored / rejected-origin grants never satisfy. Does not invent a
 * second mint path — grants come from Wave 1 mintHumanOriginGrant / authz:grant.
 */

import {
  evidenceSatisfiesImplementationApproval,
  isHumanOriginGrant,
  isRejectedOriginKind,
} from "./origin.js";
import type { ClosedVerbDecision, ClosedVerbDecisionCode, HumanOriginGrant } from "./types.js";
import {
  builtinReleaseVerbClassification,
  getVerbRow,
  loadVerbClassification,
  type VerbClassificationTable,
} from "./verb-classification.js";

export type EnvMap = Readonly<Record<string, string | undefined>>;

export interface EvaluateClosedVerbInput {
  readonly verb: string;
  /** Release version / tag / target id (e.g. 0.30.0 or v0.30.0). */
  readonly target: string | null;
  readonly grants: readonly HumanOriginGrant[];
  /** Env map; defaults to process.env when omitted. */
  readonly env?: EnvMap;
  readonly now?: Date;
  /** Injected table for unit tests; otherwise load from projectRoot or builtin. */
  readonly classification?: VerbClassificationTable;
  /** Project root — loads conventions/verb-classification.json when set. */
  readonly projectRoot?: string | null;
  /** Optional structural context — when grant pins repo/branch, must match. */
  readonly repo?: string | null;
  readonly branch?: string | null;
}

function sanitize(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

function deny(
  code: ClosedVerbDecisionCode,
  reason: string,
  input: EvaluateClosedVerbInput,
  extra: {
    humanApprovalRef?: string | null;
    envBypassKey?: string | null;
    skillPointer?: string | null;
  } = {},
): ClosedVerbDecision {
  return {
    allowed: false,
    code,
    reason: sanitize(reason),
    verb: sanitize(input.verb),
    target: input.target === null ? null : sanitize(input.target),
    humanApprovalRef: extra.humanApprovalRef ?? null,
    envBypassKey: extra.envBypassKey ?? null,
    skillPointer: extra.skillPointer ?? null,
  };
}

function allow(
  code: ClosedVerbDecisionCode,
  reason: string,
  input: EvaluateClosedVerbInput,
  extra: {
    humanApprovalRef?: string | null;
    envBypassKey?: string | null;
    skillPointer?: string | null;
  } = {},
): ClosedVerbDecision {
  return {
    allowed: true,
    code,
    reason: sanitize(reason),
    verb: sanitize(input.verb),
    target: input.target === null ? null : sanitize(input.target),
    humanApprovalRef: extra.humanApprovalRef ?? null,
    envBypassKey: extra.envBypassKey ?? null,
    skillPointer: extra.skillPointer ?? null,
  };
}

/** Normalise version/target for surface matching (strip leading v, lower-case). */
export function normaliseClosedVerbTarget(target: string | null | undefined): string | null {
  if (target === null || target === undefined) return null;
  let t = target.trim();
  if (t.length === 0) return null;
  if (t.startsWith("v") || t.startsWith("V")) t = t.slice(1);
  return t.toLowerCase();
}

/** Surface forms that match a target (version, v-version, raw). */
export function targetSurfaceCandidates(target: string | null): string[] {
  if (target === null) return [];
  const raw = target.trim();
  const norm = normaliseClosedVerbTarget(target);
  const out = new Set<string>();
  if (raw.length > 0) out.add(raw);
  if (norm !== null) {
    out.add(norm);
    out.add(`v${norm}`);
  }
  return [...out];
}

function envTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function grantCoversOperation(grant: HumanOriginGrant, acceptedOps: readonly string[]): boolean {
  const want = new Set(acceptedOps.map((o) => o.toLowerCase()));
  return grant.scope.operations.some((op) => want.has(op.toLowerCase()));
}

/**
 * Target match: empty surfaces = unrestricted targets for this closed verb.
 * Non-empty: any surface must equal a candidate form of the target (exact).
 * Wildcard `*` is rejected for release-class (wildcard_allowed=false) unless
 * the classification row allows it (Wave 4 rows do not).
 */
function grantCoversTarget(
  grant: HumanOriginGrant,
  target: string | null,
  wildcardAllowed: boolean,
): boolean {
  if (grant.scope.surfaces.length === 0) return true;
  if (target === null) return false;
  const candidates = new Set(targetSurfaceCandidates(target).map((c) => c.toLowerCase()));
  for (const surface of grant.scope.surfaces) {
    const s = surface.trim();
    if (s === "*") {
      if (wildcardAllowed) return true;
      continue;
    }
    if (candidates.has(s.toLowerCase())) return true;
    const sn = normaliseClosedVerbTarget(s);
    if (sn !== null && candidates.has(sn)) return true;
  }
  return false;
}

/** When a grant pins repo/branch, the attempt must supply a matching value. */
function grantContextMatches(grant: HumanOriginGrant, input: EvaluateClosedVerbInput): boolean {
  const s = grant.scope;
  if (s.repo !== null) {
    if (input.repo === null || input.repo === undefined) return false;
    if (s.repo.toLowerCase() !== input.repo.toLowerCase()) return false;
  }
  if (s.branch !== null) {
    if (input.branch === null || input.branch === undefined) return false;
    if (s.branch !== input.branch) return false;
  }
  return true;
}

function grantValidity(
  grant: HumanOriginGrant,
  now: Date,
): { ok: true } | { ok: false; code: ClosedVerbDecisionCode; reason: string } {
  if (!isHumanOriginGrant(grant)) {
    const kind = grant.origin.kind;
    if (isRejectedOriginKind(kind)) {
      return {
        ok: false,
        code: "closed-verb-deny-origin",
        reason:
          `Directive denied closed verb: grant ${grant.id} origin.kind=${kind} is ` +
          "agent/self-authored and cannot authorize release-class verbs. " +
          "Human action required: `deft authz:grant -- --template <release-*> --target <ver>`.",
      };
    }
    return {
      ok: false,
      code: "closed-verb-deny-origin",
      reason:
        `Directive denied closed verb: grant ${grant.id} lacks human-origin provenance. ` +
        "Human action required: mint via `deft authz:grant` (operator-cli).",
    };
  }
  if (grant.semantics.revokedAt !== null) {
    return {
      ok: false,
      code: "closed-verb-deny-revoked",
      reason: `Directive denied closed verb: grant ${grant.id} was revoked at ${grant.semantics.revokedAt}.`,
    };
  }
  if (grant.semantics.singleUse && grant.semantics.usedAt !== null) {
    return {
      ok: false,
      code: "closed-verb-deny-spent",
      reason: `Directive denied closed verb: single-use grant ${grant.id} already spent at ${grant.semantics.usedAt}.`,
    };
  }
  if (grant.semantics.expiresAt !== null) {
    const exp = Date.parse(grant.semantics.expiresAt);
    // Fail closed on unparseable expiresAt (malformed must not count as forever-valid).
    if (Number.isNaN(exp) || exp <= now.getTime()) {
      return {
        ok: false,
        code: "closed-verb-deny-expired",
        reason:
          `Directive denied closed verb: grant ${grant.id} expired or has unparseable expiresAt ` +
          `(${grant.semantics.expiresAt}). Human action required: mint a fresh grant via \`deft authz:grant\`.`,
      };
    }
  }
  return { ok: true };
}

function resolveClassification(input: EvaluateClosedVerbInput): VerbClassificationTable {
  if (input.classification !== undefined) return input.classification;
  if (
    input.projectRoot !== null &&
    input.projectRoot !== undefined &&
    input.projectRoot.length > 0
  ) {
    return loadVerbClassification(input.projectRoot);
  }
  return builtinReleaseVerbClassification();
}

/**
 * Closed-verb gate. Fail closed for unknown verbs and missing grants.
 * Loads conventions/verb-classification.json when projectRoot is provided.
 */
export function evaluateClosedVerb(input: EvaluateClosedVerbInput): ClosedVerbDecision {
  const table = resolveClassification(input);
  const verbKey = sanitize(input.verb.trim().toLowerCase());
  const row = getVerbRow(table, verbKey);
  if (row === null) {
    return deny(
      "closed-verb-unknown",
      `Directive denied closed verb: unknown verb '${input.verb}'. ` +
        "Known Wave 4 release-class verbs: release-cut, release-publish, release-rollback.",
      input,
    );
  }

  const skillPointer = sanitize(`${row.skill} ${row.phase}`);
  const envBypassKey = row.env_bypass;
  const env: EnvMap = input.env ?? (process.env as EnvMap);
  if (envTruthy(env[envBypassKey])) {
    return allow(
      "closed-verb-env-bypass",
      `Directive allowed ${verbKey} via ephemeral env bypass ${envBypassKey}=1 ` +
        `(precondition: ${skillPointer}).`,
      input,
      { envBypassKey, skillPointer },
    );
  }

  const now = input.now ?? new Date();
  let lastReject: { code: ClosedVerbDecisionCode; reason: string; id?: string } | null = null;

  for (const grant of input.grants) {
    // evidenceSatisfiesImplementationApproval and grantValidity both reject
    // non-human origins; run full validity (origin + expiry + single-use + revoked).
    if (!evidenceSatisfiesImplementationApproval({ grant })) {
      const validity = grantValidity(grant, now);
      lastReject = validity.ok
        ? {
            code: "closed-verb-deny-origin",
            reason:
              `Directive denied closed verb: grant ${grant.id} does not satisfy human-origin ` +
              "implementation approval (self-authored lifecycle/dispatch tokens never count).",
            id: grant.id,
          }
        : { code: validity.code, reason: validity.reason, id: grant.id };
      continue;
    }
    const validity = grantValidity(grant, now);
    if (!validity.ok) {
      lastReject = { code: validity.code, reason: validity.reason, id: grant.id };
      continue;
    }
    if (!grantCoversOperation(grant, row.authz_operations)) {
      lastReject = {
        code: "closed-verb-deny-scope",
        reason:
          `Directive denied closed verb: grant ${grant.id} operations ` +
          `[${grant.scope.operations.join(",")}] do not cover '${verbKey}' ` +
          `(need one of: ${row.authz_operations.join(", ")}). ` +
          `Human action required: \`deft authz:grant -- --template ${verbKey} --target <ver>\`.`,
        id: grant.id,
      };
      continue;
    }
    if (!grantCoversTarget(grant, input.target, row.wildcard_allowed)) {
      lastReject = {
        code: "closed-verb-deny-scope",
        reason:
          `Directive denied closed verb: grant ${grant.id} surfaces ` +
          `[${grant.scope.surfaces.join("|") || "*"}] do not cover target ` +
          `'${input.target ?? "(none)"}'. Human action required: remint with ` +
          `\`--template ${verbKey} --target ${input.target ?? "<ver>"}\`.`,
        id: grant.id,
      };
      continue;
    }
    if (!grantContextMatches(grant, input)) {
      lastReject = {
        code: "closed-verb-deny-scope",
        reason:
          `Directive denied closed verb: grant ${grant.id} is bound to a different ` +
          "repo/branch context than the attempted operation.",
        id: grant.id,
      };
      continue;
    }
    return allow(
      "closed-verb-allow",
      `Directive allowed ${verbKey}` +
        (input.target !== null ? ` target=${input.target}` : "") +
        ` via human-origin grant ${grant.id} (precondition: ${skillPointer}).`,
      input,
      { humanApprovalRef: grant.id, skillPointer },
    );
  }

  if (lastReject !== null) {
    return deny(lastReject.code, lastReject.reason, input, {
      humanApprovalRef: lastReject.id ?? null,
      envBypassKey,
      skillPointer,
    });
  }

  return deny(
    "closed-verb-deny-missing",
    `Directive denied closed verb '${verbKey}'` +
      (input.target !== null ? ` target=${input.target}` : "") +
      `: no human-origin grant covers this verb/target and ${envBypassKey} is not set. ` +
      `Human action required: \`deft authz:grant -- --template ${verbKey}` +
      (input.target !== null ? ` --target ${input.target}` : " --target <ver>") +
      `\` or set ${envBypassKey}=1 for a single-shell ephemeral bypass. ` +
      `Skill precondition: ${skillPointer}. ` +
      "Note: walk-away finish-loop uses `authz:grant --template finish-loop` (#871), " +
      "not this release-class closed-verb template.",
    input,
    { envBypassKey, skillPointer },
  );
}

/** Map verb name → DEFT_ALLOW_* key (from loaded/builtin table). */
export function closedVerbEnvBypassKey(verb: string, projectRoot?: string | null): string | null {
  const table =
    projectRoot !== null && projectRoot !== undefined && projectRoot.length > 0
      ? loadVerbClassification(projectRoot)
      : builtinReleaseVerbClassification();
  const row = getVerbRow(table, verb);
  return row?.env_bypass ?? null;
}
