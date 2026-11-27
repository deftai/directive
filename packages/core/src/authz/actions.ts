/**
 * Operator-facing authz actions: UAT start/suspend, grant mint/revoke (#2944).
 * All mint paths stamp human-origin `operator-cli` provenance.
 *
 * UAT store-write refuse (#4233) surfaces as returned failures from these
 * actions (and from saveGrant/saveAuthzState). Validation of empty campaignId /
 * operations keeps the pre-existing throw sites.
 */

import { randomBytes } from "node:crypto";
import {
  endDelegation,
  evaluateDelegableMint,
  isDelegationIdLive,
  readLiveDelegation,
} from "./delegation/store.js";
import {
  DELEGABLE_GRANT_VERB,
  DELEGATED_AUTHORITY_MAX_EXPIRY_HOURS,
  type DelegatedCompletion,
} from "./delegation/types.js";
import {
  listActiveHumanGrants,
  listGrants,
  loadAuthzState,
  mintDelegatedOrigin,
  mintOperatorOrigin,
  mutateAuthzState,
  persistMintedGrant,
  saveGrant,
  utcIso,
} from "./store.js";
import type { AuthzOperation, AuthzState, HumanOriginGrant, UatLease } from "./types.js";
import { AUTHZ_OPERATIONS } from "./types.js";
import type { AuthzUatWriteRefuseCode, UatCampaignEndSeal } from "./uat-write-guard.js";

function newGrantId(now?: Date): string {
  const ts = (now ?? new Date())
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const suffix = randomBytes(3).toString("hex");
  return `grant-${ts}-${suffix}`;
}

/** Returned failure when store SoT refuses a write under active UAT (#4233). */
export type AuthzActionWriteFailure = {
  readonly ok: false;
  readonly code: AuthzUatWriteRefuseCode;
  readonly reason: string;
};

export interface StartUatInput {
  readonly projectRoot: string;
  readonly campaignId: string;
  readonly actor?: string;
  readonly note?: string | null;
  readonly now?: Date;
}

export type StartUatResult =
  | { readonly ok: true; readonly state: AuthzState; readonly lease: UatLease }
  | AuthzActionWriteFailure;

export function startUatLease(input: StartUatInput): StartUatResult {
  const actor = input.actor ?? "operator";
  const origin = mintOperatorOrigin(actor, "deft authz:uat-start", input.now);
  const campaignId = input.campaignId.trim();
  if (campaignId.length === 0) {
    throw new Error("campaignId must be non-empty");
  }
  const lease: UatLease = {
    active: true,
    campaignId,
    startedAt: origin.mintedAt,
    startedBy: origin,
    suspendedAt: null,
    note: input.note ?? null,
  };
  // Pin must be read under the store lock so a concurrent pinned mint is not lost (#4233).
  const wrote = mutateAuthzState(input.projectRoot, (prev) => ({
    schemaVersion: 1,
    uat: lease,
    activeGrantIds: prev.activeGrantIds,
  }));
  if (!wrote.ok) {
    return { ok: false, code: wrote.code, reason: wrote.reason };
  }
  // UAT start ends any live delegation (#7420 B2). Liveness also refuses while
  // UAT is active; this records the end reason. Best effort: never fails UAT.
  try {
    endDelegation(input.projectRoot, "uat-start", { now: input.now });
  } catch {
    /* liveness check still refuses under UAT */
  }
  return { ok: true, state: wrote.state, lease };
}

export interface SuspendUatInput {
  readonly projectRoot: string;
  readonly actor?: string;
  readonly now?: Date;
  /**
   * Sealed campaign-end token from CLI after gateConfirm (#4233).
   * Required when flipping uat.active true→false; not stringly argv/JSON.
   */
  readonly campaignEndSeal?: UatCampaignEndSeal;
}

export type SuspendUatResult =
  | { readonly ok: true; readonly state: AuthzState }
  | AuthzActionWriteFailure;

export function suspendUatLease(input: SuspendUatInput): SuspendUatResult {
  const wrote = mutateAuthzState(
    input.projectRoot,
    (prev) => {
      if (prev.uat === null || !prev.uat.active) {
        return prev;
      }
      return {
        schemaVersion: 1,
        uat: {
          ...prev.uat,
          active: false,
          suspendedAt: utcIso(input.now),
        },
        activeGrantIds: prev.activeGrantIds,
      };
    },
    { campaignEndSeal: input.campaignEndSeal },
  );
  if (!wrote.ok) {
    return { ok: false, code: wrote.code, reason: wrote.reason };
  }
  return { ok: true, state: wrote.state };
}

export interface MintGrantInput {
  readonly projectRoot: string;
  readonly actor?: string;
  readonly operations: readonly AuthzOperation[];
  readonly surfaces?: readonly string[];
  readonly cohortId?: string | null;
  readonly planRef?: string | null;
  readonly repo?: string | null;
  readonly branch?: string | null;
  readonly worktree?: string | null;
  readonly storyIds?: readonly string[];
  readonly issueIds?: readonly number[];
  readonly expiresAt?: string | null;
  readonly singleUse?: boolean;
  readonly eventRef?: string | null;
  readonly grantId?: string;
  readonly now?: Date;
  /** When true, pin grant id into state.activeGrantIds. */
  readonly pinActive?: boolean;
  /** SHA-256 hex of exact draft bytes for scope.decompose.apply.structural (#3239). */
  readonly contentDigest?: string | null;
  /** Project-relative parent artifact path (#3239). */
  readonly parentPath?: string | null;
  /** Project-relative draft/target path (#3239). */
  readonly targetPath?: string | null;
}

export type MintGrantResult =
  | { readonly ok: true; readonly grant: HumanOriginGrant }
  | AuthzActionWriteFailure;

export function mintHumanOriginGrant(input: MintGrantInput): MintGrantResult {
  if (input.operations.length === 0) {
    throw new Error("operations must include at least one AuthzOperation");
  }
  const allowed = new Set<string>(AUTHZ_OPERATIONS);
  for (const op of input.operations) {
    if (!allowed.has(op)) {
      throw new Error(`unknown operation: ${op}`);
    }
  }
  const origin = mintOperatorOrigin(
    input.actor ?? "operator",
    "deft authz:grant",
    input.now,
    input.eventRef ?? null,
  );
  const grant: HumanOriginGrant = {
    schemaVersion: 1,
    id: input.grantId ?? newGrantId(input.now),
    origin,
    scope: {
      planRef: input.planRef ?? null,
      repo: input.repo ?? null,
      branch: input.branch ?? null,
      worktree: input.worktree ?? null,
      surfaces: input.surfaces ?? [],
      operations: [...input.operations],
      storyIds: input.storyIds ?? [],
      issueIds: input.issueIds ?? [],
      cohortId: input.cohortId ?? null,
      contentDigest: input.contentDigest ?? null,
      parentPath: input.parentPath ?? null,
      targetPath: input.targetPath ?? null,
    },
    semantics: {
      expiresAt: input.expiresAt ?? null,
      singleUse: input.singleUse === true,
      usedAt: null,
      revokedAt: null,
    },
  };
  // Grant + optional pin are one store transaction: pin refuse does not leave
  // an authorizing grant on disk; empty→first pin seeds older active grants (#4233).
  const saved = persistMintedGrant(input.projectRoot, grant, {
    pinActive: input.pinActive === true,
  });
  if (!saved.ok) {
    return { ok: false, code: saved.code, reason: saved.reason };
  }
  return { ok: true, grant };
}

export interface MintDelegatedReleaseGrantInput {
  readonly projectRoot: string;
  /** The delegated completion from the harness-attended request (#7420 B3). */
  readonly completion: DelegatedCompletion;
  /** Release template; must equal `completion.template` and be one of the four. */
  readonly template: string;
  /** Target surfaces resolved from the template (version forms). */
  readonly surfaces: readonly string[];
  /** Template default expiry; clamped to the delegation and the cap. */
  readonly expiresAt: string | null;
  readonly actor?: string;
  readonly singleUse?: boolean;
  readonly planRef?: string | null;
  readonly repo?: string | null;
  readonly branch?: string | null;
  readonly now?: Date;
  /** Seam: store root of the delegation (tests). */
  readonly delegationStoreRoot?: string;
}

/**
 * Mint a release grant under a live delegation (#7420 B3 / B4). The grant has
 * the delegated origin (never human origin), exactly one operation equal to
 * its template, and an expiry no later than the delegation. Refuses when the
 * template is not one of the four, when the completion is not for this
 * template, or when the delegation is no longer live.
 */
export type MintDelegatedGrantResult =
  | { readonly ok: true; readonly grant: HumanOriginGrant }
  | {
      readonly ok: false;
      readonly code: AuthzUatWriteRefuseCode | "delegation-refused";
      readonly reason: string;
    };

export function mintDelegatedReleaseGrant(
  input: MintDelegatedReleaseGrantInput,
): MintDelegatedGrantResult {
  const now = input.now ?? new Date();
  const template = input.template.trim().toLowerCase();
  const policy = evaluateDelegableMint({ verb: DELEGABLE_GRANT_VERB, template });
  if (!policy.ok) return { ok: false, code: "delegation-refused", reason: policy.reason };
  if (input.completion.verb !== DELEGABLE_GRANT_VERB || input.completion.template !== template) {
    return {
      ok: false,
      code: "delegation-refused",
      reason: `delegated completion is for ${input.completion.verb} ${input.completion.template ?? "(no template)"}, not authz:grant ${template}`,
    };
  }
  const live = readLiveDelegation(input.projectRoot, {
    now,
    ...(input.delegationStoreRoot !== undefined ? { storeRoot: input.delegationStoreRoot } : {}),
  });
  if (!isDelegationIdLive(live, input.completion.delegationId) || live === null) {
    return {
      ok: false,
      code: "delegation-refused",
      reason: `delegation ${input.completion.delegationId} is not live; nothing minted`,
    };
  }
  const capMs = now.getTime() + DELEGATED_AUTHORITY_MAX_EXPIRY_HOURS * 3600 * 1000;
  const candidates = [Date.parse(live.expiresAt), capMs];
  if (input.expiresAt !== null) {
    const asked = Date.parse(input.expiresAt);
    if (Number.isNaN(asked)) {
      return { ok: false, code: "delegation-refused", reason: "unparseable expiresAt" };
    }
    candidates.push(asked);
  }
  const expiresMs = Math.min(...candidates);
  if (!(expiresMs > now.getTime())) {
    return {
      ok: false,
      code: "delegation-refused",
      reason: "delegated grant would already be expired",
    };
  }
  const grant: HumanOriginGrant = {
    schemaVersion: 1,
    id: newGrantId(now),
    origin: mintDelegatedOrigin({
      actor: input.actor ?? "operator",
      delegationId: input.completion.delegationId,
      template,
      now,
      eventRef: `harness-attended:${input.completion.requestId}`,
    }),
    scope: {
      planRef: input.planRef ?? null,
      repo: input.repo ?? null,
      branch: input.branch ?? null,
      worktree: null,
      surfaces: [...input.surfaces],
      operations: [template as AuthzOperation],
      storyIds: [],
      issueIds: [],
      cohortId: null,
      contentDigest: null,
      parentPath: null,
      targetPath: null,
    },
    semantics: {
      expiresAt: utcIso(new Date(expiresMs)),
      singleUse: input.singleUse === true,
      usedAt: null,
      revokedAt: null,
    },
  };
  // Never pinned: a pin is human-origin activation (#4233); delegated grants
  // are read only by evaluateClosedVerb via listDelegatedGrants.
  const saved = persistMintedGrant(input.projectRoot, grant, { pinActive: false });
  if (!saved.ok) return { ok: false, code: saved.code, reason: saved.reason };
  return { ok: true, grant };
}

export interface RevokeGrantInput {
  readonly projectRoot: string;
  readonly grantId: string;
  readonly now?: Date;
}

export type RevokeGrantResult =
  | { readonly ok: true; readonly grant: HumanOriginGrant | null }
  | AuthzActionWriteFailure;

export function revokeGrant(input: RevokeGrantInput): RevokeGrantResult {
  const all = listGrants(input.projectRoot);
  const found = all.find((g) => g.id === input.grantId);
  if (found === undefined) return { ok: true, grant: null };
  const revoked: HumanOriginGrant = {
    ...found,
    semantics: {
      ...found.semantics,
      revokedAt: utcIso(input.now),
    },
  };
  const wrote = saveGrant(input.projectRoot, revoked);
  if (!wrote.ok) {
    return { ok: false, code: wrote.code, reason: wrote.reason };
  }
  return { ok: true, grant: revoked };
}

export function showAuthzSnapshot(projectRoot: string): {
  state: AuthzState;
  activeGrants: HumanOriginGrant[];
  allGrants: HumanOriginGrant[];
} {
  const state = loadAuthzState(projectRoot);
  return {
    state,
    activeGrants: listActiveHumanGrants(projectRoot, state),
    allGrants: listGrants(projectRoot),
  };
}
