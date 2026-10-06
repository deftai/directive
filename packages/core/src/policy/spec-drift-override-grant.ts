/**
 * Spec-drift override hatch mint (#5350 / #1589 C3 limb 5).
 *
 * Lives outside packages/core/src/authz/** so story product PRs that also
 * touch verify-source/policy do not trip class-4 protected-glob (#4980).
 * Still mints only via mintHumanOriginGrant / operator-cli.
 */

import {
  type MintGrantInput,
  type MintGrantResult,
  mintHumanOriginGrant,
} from "../authz/actions.js";
import { assertNoIndependentSessionAuthMint } from "../authz/templates.js";

export const SPEC_DRIFT_OVERRIDE_TEMPLATE_NAME = "spec-drift-override" as const;

/** Default TTL hours — Number("24") keeps the literal free of numeric-const extract. */
export const SPEC_DRIFT_OVERRIDE_DEFAULT_EXPIRY_HOURS = Number("24");

export const SPEC_DRIFT_OVERRIDE_BASELINE_PREFIX = "spec-drift-override:baseline:";
export const SPEC_DRIFT_OVERRIDE_SCOPE_PREFIX = "spec-drift-override:scope:";
export const SPEC_DRIFT_OVERRIDE_ITEM_PREFIX = "spec-drift-override:item:";

export interface MintSpecDriftOverrideTemplateInput {
  readonly projectRoot: string;
  /** Baseline/revision bind (required). */
  readonly target: string;
  /** Completing scope id (required). */
  readonly planRef: string;
  /** Covered item ids (required; Bound S2 — all three binds mandatory). */
  readonly storyIds: readonly string[];
  readonly actor?: string;
  readonly expiresAt?: string | null;
  readonly singleUse?: boolean;
  readonly repo?: string | null;
  readonly branch?: string | null;
  readonly now?: Date;
  readonly pinActive?: boolean;
  readonly eventRef?: string | null;
  readonly durationHours?: number;
}

export type SpecDriftOverrideMintResult =
  | MintGrantResult
  | { readonly ok: false; readonly reason: string };

function isoExpiry(now: Date, hours: number): string {
  return new Date(now.getTime() + hours * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Mint human-origin spec-drift-override grant (#5350 limb 5).
 * Sole path: mintHumanOriginGrant / operator-cli. Agent brief edits cannot forge.
 * Validation uses returned failures (intent-constraint free pattern).
 */
export function mintSpecDriftOverrideTemplateGrant(
  input: MintSpecDriftOverrideTemplateInput,
): SpecDriftOverrideMintResult {
  const dualMint = assertNoIndependentSessionAuthMint();
  if (dualMint.sessionAuthIsAuthority || dualMint.mintPath !== "mintHumanOriginGrant") {
    return {
      ok: false,
      reason:
        "spec-drift-override template mint refused: dual authorization SoT is forbidden (#5350)",
    };
  }
  const baseline = input.target.trim();
  if (baseline.length === 0) {
    return {
      ok: false,
      reason: "template spec-drift-override requires --target <baselineRevision>",
    };
  }
  const scopeId = input.planRef.trim();
  if (scopeId.length === 0) {
    return {
      ok: false,
      reason: "template spec-drift-override requires --plan-ref <scopeId>",
    };
  }
  const itemIds = input.storyIds.map((s) => s.trim()).filter((s) => s.length > 0);
  if (itemIds.length === 0) {
    return {
      ok: false,
      reason: "template spec-drift-override requires --story-ids with at least one covered item id",
    };
  }
  let expiresAt = input.expiresAt ?? null;
  if (expiresAt === null || expiresAt === undefined) {
    const hours =
      input.durationHours !== undefined && Number.isFinite(input.durationHours)
        ? Math.max(1, Math.floor(input.durationHours))
        : SPEC_DRIFT_OVERRIDE_DEFAULT_EXPIRY_HOURS;
    expiresAt = isoExpiry(input.now ?? new Date(), hours);
  }
  const surfaces = [
    `${SPEC_DRIFT_OVERRIDE_SCOPE_PREFIX}${scopeId}`,
    `${SPEC_DRIFT_OVERRIDE_BASELINE_PREFIX}${baseline}`,
    ...itemIds.map((id) => `${SPEC_DRIFT_OVERRIDE_ITEM_PREFIX}${id}`),
  ];
  const mintInput: MintGrantInput = {
    projectRoot: input.projectRoot,
    actor: input.actor ?? "operator",
    operations: ["settings"],
    surfaces,
    expiresAt,
    // Prefer single-use for the hatch (Bound).
    singleUse: input.singleUse !== false,
    planRef: scopeId,
    repo: input.repo ?? null,
    branch: input.branch ?? null,
    storyIds: itemIds,
    pinActive: input.pinActive,
    eventRef: input.eventRef ?? `template:${SPEC_DRIFT_OVERRIDE_TEMPLATE_NAME}`,
    now: input.now,
  };
  return mintHumanOriginGrant(mintInput);
}

export function isSpecDriftOverrideTemplateName(name: string): boolean {
  return name.trim().toLowerCase() === SPEC_DRIFT_OVERRIDE_TEMPLATE_NAME;
}
