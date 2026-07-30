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
  type VerbClassificationTable,
} from "./verb-classification.js";

export interface EvaluateClosedVerbInput {
  readonly verb: string;
  /** Release version / tag / target id (e.g. 0.30.0 or v0.30.0). */
  readonly target: string | null;
  readonly grants: readonly HumanOriginGrant[];
  /** Env map; defaults to process.env when omitted. */
  readonly env?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;
  readonly now?: Date;
  /** Injected table for unit tests; otherwise load/builtin. */
  readonly classification?: VerbClassificationTable;
  readonly projectRoot?: string | null;
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
    reason,
    verb: input.verb,
    target: input.target,
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
    reason,
    verb: input.verb,
    target: input.target,
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
    if (!Number.isNaN(exp) && exp <= now.getTime()) {
      return {
        ok: false,
        code: "closed-verb-deny-expired",
        reason:
          `Directive denied closed verb: grant ${grant.id} expired at ${grant.semantics.expiresAt}. ` +
          "Human action required: mint a fresh grant via `deft authz:grant`.",
      };
    }
  }
  return { ok: true };
}

/**
 * Pure closed-verb gate. Fail closed for unknown verbs and missing grants.
 */
export function evaluateClosedVerb(input: EvaluateClosedVerbInput): ClosedVerbDecision {
  const table = input.classification ?? builtinReleaseVerbClassification();
  const verbKey = input.verb.trim().toLowerCase();
  const row = getVerbRow(table, verbKey);
  if (row === null) {
    return deny(
      "closed-verb-unknown",
      `Directive denied closed verb: unknown verb '${input.verb}'. ` +
        "Known Wave 4 release-class verbs: release-cut, release-publish, release-rollback.",
      input,
    );
  }

  const skillPointer = `${row.skill} ${row.phase}`;
  const envBypassKey = row.env_bypass;
  const env = input.env ?? process.env;
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
    if (!evidenceSatisfiesImplementationApproval({ grant })) {
      const validity = grantValidity(grant, now);
      if (!validity.ok) {
        lastReject = { code: validity.code, reason: validity.reason, id: grant.id };
        continue;
      }
      lastReject = {
        code: "closed-verb-deny-origin",
        reason:
          `Directive denied closed verb: grant ${grant.id} does not satisfy human-origin ` +
          "implementation approval (self-authored lifecycle/dispatch tokens never count).",
        id: grant.id,
      };
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
      "Note: #871 finish-loop remains Wave 5 — not authorized by this gate.",
    input,
    { envBypassKey, skillPointer },
  );
}

/** Map verb name → DEFT_ALLOW_* key (from builtin table). */
export function closedVerbEnvBypassKey(verb: string): string | null {
  const row = getVerbRow(builtinReleaseVerbClassification(), verb);
  return row?.env_bypass ?? null;
}
