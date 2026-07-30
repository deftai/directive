/**
 * Finish-loop grant gate (#871): require a live human-origin grant covering
 * edit/push/pr/merge (finish-loop template ops), or DEFT_ALLOW_FINISH_LOOP=1.
 *
 * Agent-authored grants never satisfy. No second mint path.
 */

import {
  FINISH_LOOP_OPERATIONS,
  FINISH_LOOP_TEMPLATE_NAME,
} from "../authz/templates.js";
import { isHumanOriginGrant, isRejectedOriginKind } from "../authz/origin.js";
import { listActiveHumanGrants, listGrants, loadAuthzState } from "../authz/store.js";
import type { AuthzOperation, HumanOriginGrant } from "../authz/types.js";
import type { FinishLoopGrantGateResult } from "./types.js";

export type EnvMap = Readonly<Record<string, string | undefined>>;

const ENV_BYPASS = "DEFT_ALLOW_FINISH_LOOP";

function envTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function grantLive(grant: HumanOriginGrant, now: Date): {
  ok: boolean;
  code: FinishLoopGrantGateResult["code"];
  reason: string;
} {
  if (!isHumanOriginGrant(grant)) {
    const kind = grant.origin.kind;
    if (isRejectedOriginKind(kind)) {
      return {
        ok: false,
        code: "authz-grant-origin-reject",
        reason:
          `Directive denied finish-loop: grant ${grant.id} origin.kind=${kind} is ` +
          "agent/self-authored and cannot authorize walk-away ops. " +
          `Human action required: \`deft authz:grant -- --template ${FINISH_LOOP_TEMPLATE_NAME}\`.`,
      };
    }
    return {
      ok: false,
      code: "authz-grant-origin-reject",
      reason:
        `Directive denied finish-loop: grant ${grant.id} lacks human-origin provenance. ` +
        `Human action required: \`deft authz:grant -- --template ${FINISH_LOOP_TEMPLATE_NAME}\`.`,
    };
  }
  if (grant.semantics.revokedAt !== null) {
    return {
      ok: false,
      code: "authz-grant-revoked",
      reason: `Directive denied finish-loop: grant ${grant.id} was revoked at ${grant.semantics.revokedAt}.`,
    };
  }
  if (grant.semantics.singleUse && grant.semantics.usedAt !== null) {
    return {
      ok: false,
      code: "authz-grant-single-use-spent",
      reason: `Directive denied finish-loop: single-use grant ${grant.id} already spent.`,
    };
  }
  if (grant.semantics.expiresAt !== null) {
    const exp = Date.parse(grant.semantics.expiresAt);
    if (Number.isNaN(exp) || exp <= now.getTime()) {
      return {
        ok: false,
        code: "authz-grant-expired",
        reason:
          `Directive denied finish-loop: grant ${grant.id} expired at ${grant.semantics.expiresAt}. ` +
          `Human action required: mint a fresh grant via \`deft authz:grant -- --template ${FINISH_LOOP_TEMPLATE_NAME}\`.`,
      };
    }
  }
  return { ok: true, code: "finish-loop-allow", reason: "ok" };
}

/**
 * True when grant.operations covers every finish-loop op (edit, push, pr, merge).
 * A single grant may cover the full set; partial coverage reports missing ops.
 */
export function grantCoversFinishLoopOps(grant: HumanOriginGrant): {
  covered: boolean;
  missing: AuthzOperation[];
} {
  const have = new Set(grant.scope.operations.map((o) => o.toLowerCase()));
  const missing = FINISH_LOOP_OPERATIONS.filter((op) => !have.has(op.toLowerCase()));
  return { covered: missing.length === 0, missing: [...missing] };
}

export interface EvaluateFinishLoopGrantInput {
  readonly projectRoot: string;
  readonly grants?: readonly HumanOriginGrant[];
  readonly env?: EnvMap;
  readonly now?: Date;
  /** When set, require grant to cover at least this op (default: full finish-loop set). */
  readonly requireFullSet?: boolean;
  readonly op?: AuthzOperation;
}

/**
 * Fail-closed gate for finish-loop / pr:finish-loop entry.
 */
export function evaluateFinishLoopGrant(
  input: EvaluateFinishLoopGrantInput,
): FinishLoopGrantGateResult {
  const env: EnvMap = input.env ?? (process.env as EnvMap);
  if (envTruthy(env[ENV_BYPASS])) {
    return {
      allowed: true,
      code: "finish-loop-env-bypass",
      reason: `Directive allowed finish-loop via ephemeral env bypass ${ENV_BYPASS}=1.`,
      grantId: null,
      missingOps: [],
    };
  }

  const now = input.now ?? new Date();
  const state = loadAuthzState(input.projectRoot);
  // Prefer active grants; if none, still inspect disk grants so expiry/origin
  // denials surface as grant-expired / origin-reject rather than silent missing.
  let grants: readonly HumanOriginGrant[];
  if (input.grants !== undefined) {
    grants = input.grants;
  } else {
    const active = listActiveHumanGrants(input.projectRoot, state, now);
    grants = active.length > 0 ? active : listGrants(input.projectRoot);
  }

  let lastDeny: FinishLoopGrantGateResult | null = null;

  for (const grant of grants) {
    const live = grantLive(grant, now);
    if (!live.ok) {
      lastDeny = {
        allowed: false,
        code: live.code,
        reason: live.reason,
        grantId: grant.id,
        missingOps: [],
      };
      continue;
    }

    if (input.op !== undefined) {
      const have = grant.scope.operations.map((o) => o.toLowerCase());
      if (!have.includes(input.op.toLowerCase())) {
        lastDeny = {
          allowed: false,
          code: "authz-grant-scope-deny",
          reason:
            `Directive denied finish-loop: grant ${grant.id} ops=[${grant.scope.operations.join(",")}] ` +
            `does not cover '${input.op}'. Human action required: ` +
            `\`deft authz:grant -- --template ${FINISH_LOOP_TEMPLATE_NAME}\`.`,
          grantId: grant.id,
          missingOps: [input.op],
        };
        continue;
      }
      return {
        allowed: true,
        code: "finish-loop-allow",
        reason: `Directive allowed finish-loop op '${input.op}' via human-origin grant ${grant.id}.`,
        grantId: grant.id,
        missingOps: [],
      };
    }

    const cover = grantCoversFinishLoopOps(grant);
    if (!cover.covered && input.requireFullSet !== false) {
      lastDeny = {
        allowed: false,
        code: "authz-grant-scope-deny",
        reason:
          `Directive denied finish-loop: grant ${grant.id} missing ops ` +
          `[${cover.missing.join(",")}]. Finish-loop requires ` +
          `[${FINISH_LOOP_OPERATIONS.join(",")}]. Human action required: ` +
          `\`deft authz:grant -- --template ${FINISH_LOOP_TEMPLATE_NAME}\`.`,
        grantId: grant.id,
        missingOps: cover.missing,
      };
      continue;
    }

    return {
      allowed: true,
      code: "finish-loop-allow",
      reason: `Directive allowed finish-loop via human-origin grant ${grant.id}.`,
      grantId: grant.id,
      missingOps: [],
    };
  }

  if (lastDeny !== null) return lastDeny;

  return {
    allowed: false,
    code: "authz-grant-missing",
    reason:
      "Directive denied finish-loop: no human-origin grant covers edit/push/pr/merge " +
      `and ${ENV_BYPASS} is not set. Human action required: ` +
      `\`deft authz:grant -- --template ${FINISH_LOOP_TEMPLATE_NAME}\` ` +
      `(or set ${ENV_BYPASS}=1 for a single-shell ephemeral bypass). ` +
      "Release-class verbs are NOT authorized by this template.",
    grantId: null,
    missingOps: [...FINISH_LOOP_OPERATIONS],
  };
}
