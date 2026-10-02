/**
 * UAT write-class refuse at authz store SoT (#4233 / incomplete #3110).
 *
 * Pure predicates consulted by saveGrant / saveAuthzState. CLI keeps
 * refuseMintWhileUatActive stderr/exit adaptation; human-presence stays CLI-only.
 * Sealed campaign-end is a Symbol token — not stringly argv/grant JSON.
 * Factory lives only on `./authz/campaign-end-seal` (not this module).
 */

import { isUatCampaignEndSeal, type UatCampaignEndSeal } from "./seal-symbol.js";
import type {
  AuthzState,
  GrantScope,
  GrantSemantics,
  HumanOriginGrant,
  UatLease,
} from "./types.js";

export type { UatCampaignEndSeal } from "./seal-symbol.js";
export { isUatCampaignEndSeal } from "./seal-symbol.js";

export type GrantWriteIntentClass =
  | "grant-create"
  | "usedAt-only-consume"
  | "authority-field-mutate"
  | "noop";

export type AuthzStateWriteIntentClass =
  | "noop"
  | "pin-mutate"
  | "campaign-end"
  | "uat-field-mutate"
  | "uat-activate";

export type AuthzUatWriteRefuseCode =
  | "uat-grant-create"
  | "uat-authority-field-mutate"
  | "uat-pin-mutate"
  | "uat-campaign-end-unsealed"
  | "uat-field-mutate"
  | "uat-activate"
  | "store-write-lock-timeout"
  | "store-write-io";

export type AuthzUatWriteDecision =
  | { readonly ok: true; readonly intent: GrantWriteIntentClass | AuthzStateWriteIntentClass }
  | {
      readonly ok: false;
      readonly code: AuthzUatWriteRefuseCode;
      readonly reason: string;
      readonly intent: GrantWriteIntentClass | AuthzStateWriteIntentClass;
    };

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameNumberArray(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameNullable(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

function sameScope(a: GrantScope, b: GrantScope): boolean {
  return (
    sameNullable(a.planRef, b.planRef) &&
    sameNullable(a.repo, b.repo) &&
    sameNullable(a.branch, b.branch) &&
    sameNullable(a.worktree, b.worktree) &&
    sameStringArray(a.surfaces, b.surfaces) &&
    sameStringArray(a.operations, b.operations) &&
    sameStringArray(a.storyIds, b.storyIds) &&
    sameNumberArray(a.issueIds, b.issueIds) &&
    sameNullable(a.cohortId, b.cohortId) &&
    sameNullable(a.contentDigest ?? null, b.contentDigest ?? null) &&
    sameNullable(a.parentPath ?? null, b.parentPath ?? null) &&
    sameNullable(a.targetPath ?? null, b.targetPath ?? null)
  );
}

function sameOrigin(a: HumanOriginGrant["origin"], b: HumanOriginGrant["origin"]): boolean {
  return (
    a.kind === b.kind &&
    a.actor === b.actor &&
    a.mintedAt === b.mintedAt &&
    a.mintedVia === b.mintedVia &&
    sameNullable(a.eventRef, b.eventRef)
  );
}

function authoritySemanticsEqual(a: GrantSemantics, b: GrantSemantics): boolean {
  return (
    sameNullable(a.expiresAt, b.expiresAt) &&
    a.singleUse === b.singleUse &&
    sameNullable(a.revokedAt, b.revokedAt)
  );
}

/** Classify grant write against on-disk grant (usedAt-only is not an exists waive). */
export function classifyGrantWriteIntent(
  onDisk: HumanOriginGrant | null,
  incoming: HumanOriginGrant,
): GrantWriteIntentClass {
  if (onDisk === null) return "grant-create";
  if (onDisk.id !== incoming.id) return "grant-create";
  if (!sameOrigin(onDisk.origin, incoming.origin)) return "authority-field-mutate";
  if (!sameScope(onDisk.scope, incoming.scope)) return "authority-field-mutate";
  if (!authoritySemanticsEqual(onDisk.semantics, incoming.semantics)) {
    return "authority-field-mutate";
  }
  if (sameNullable(onDisk.semantics.usedAt, incoming.semantics.usedAt)) return "noop";
  // Consume is null→timestamp only. Unspend / usedAt rewrite is authority mutate (#4233).
  if (onDisk.semantics.usedAt == null && incoming.semantics.usedAt != null) {
    return "usedAt-only-consume";
  }
  return "authority-field-mutate";
}

function sameUatLease(a: UatLease, b: UatLease): boolean {
  return (
    a.active === b.active &&
    a.campaignId === b.campaignId &&
    a.startedAt === b.startedAt &&
    sameOrigin(a.startedBy, b.startedBy) &&
    sameNullable(a.suspendedAt, b.suspendedAt) &&
    sameNullable(a.note, b.note)
  );
}

/** Classify authz-state write against previous on-disk state. */
export function classifyAuthzStateWriteIntent(
  prev: AuthzState,
  next: AuthzState,
): AuthzStateWriteIntentClass {
  const pinChanged = !sameStringArray(prev.activeGrantIds, next.activeGrantIds);
  const prevActive = prev.uat?.active === true;
  const nextActive = next.uat?.active === true;

  if (prevActive && !nextActive) {
    // Campaign-end may set suspendedAt; pin + campaign identity must stay unchanged.
    if (pinChanged) return "pin-mutate";
    if (prev.uat === null || next.uat === null) return "uat-field-mutate";
    if (
      next.uat.campaignId !== prev.uat.campaignId ||
      next.uat.startedAt !== prev.uat.startedAt ||
      !sameOrigin(next.uat.startedBy, prev.uat.startedBy) ||
      !sameNullable(next.uat.note, prev.uat.note)
    ) {
      return "uat-field-mutate";
    }
    return "campaign-end";
  }
  if (!prevActive && nextActive) {
    if (pinChanged) return "pin-mutate";
    return "uat-activate";
  }
  if (pinChanged) return "pin-mutate";

  if (prev.uat === null && next.uat === null) return "noop";
  if (prev.uat === null || next.uat === null) {
    return "uat-field-mutate";
  }
  if (sameUatLease(prev.uat, next.uat)) return "noop";
  return "uat-field-mutate";
}

function refuse(
  code: AuthzUatWriteRefuseCode,
  intent: GrantWriteIntentClass | AuthzStateWriteIntentClass,
  detail: string,
): AuthzUatWriteDecision {
  return {
    ok: false,
    code,
    intent,
    reason:
      `Directive denied authz store write under active UAT (${code}): ${detail}. ` +
      "Mint / grant-create / authority-field mutate / pin mutate are hard-refused at the store SoT (#4233). " +
      "Campaign-end (uat.active true→false) requires the sealed CLI human-presence token after gateConfirm.",
  };
}

/**
 * Pure grant-write decision under the current authz state.
 * Outside active UAT: always ok. Under UAT: create + authority mutate refuse; usedAt-only ok.
 */
export function evaluateGrantWriteUnderUat(
  state: AuthzState,
  onDisk: HumanOriginGrant | null,
  incoming: HumanOriginGrant,
): AuthzUatWriteDecision {
  const intent = classifyGrantWriteIntent(onDisk, incoming);
  if (state.uat?.active !== true) {
    return { ok: true, intent };
  }
  if (intent === "grant-create") {
    return refuse("uat-grant-create", intent, `refusing grant create id=${incoming.id}`);
  }
  if (intent === "authority-field-mutate") {
    return refuse(
      "uat-authority-field-mutate",
      intent,
      `refusing authority-field mutate id=${incoming.id}`,
    );
  }
  return { ok: true, intent };
}

export interface EvaluateAuthzStateWriteOptions {
  readonly campaignEndSeal?: UatCampaignEndSeal;
}

/**
 * Pure authz-state write decision.
 * Sealed campaign-end waives only uat.active true→false; never pin/grant/authority mutate.
 */
export function evaluateAuthzStateWriteUnderUat(
  prev: AuthzState,
  next: AuthzState,
  options: EvaluateAuthzStateWriteOptions = {},
): AuthzUatWriteDecision {
  const intent = classifyAuthzStateWriteIntent(prev, next);
  const prevActive = prev.uat?.active === true;
  if (!prevActive) {
    return { ok: true, intent };
  }
  if (intent === "noop") return { ok: true, intent };
  if (intent === "pin-mutate") {
    return refuse("uat-pin-mutate", intent, "refusing activeGrantIds pin mutate");
  }
  if (intent === "campaign-end") {
    if (!isUatCampaignEndSeal(options.campaignEndSeal)) {
      return refuse(
        "uat-campaign-end-unsealed",
        intent,
        "refusing uat.active true→false without sealed campaign-end token",
      );
    }
    return { ok: true, intent };
  }
  if (intent === "uat-activate") {
    return refuse(
      "uat-activate",
      intent,
      "refusing UAT activate/replace while lease already active",
    );
  }
  return refuse("uat-field-mutate", intent, "refusing UAT field mutate while lease active");
}
