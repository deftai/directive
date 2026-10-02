/**
 * Operator-facing authz actions: UAT start/suspend, grant mint/revoke (#2944).
 * All mint paths stamp human-origin `operator-cli` provenance.
 */

import { randomBytes } from "node:crypto";
import {
  listActiveHumanGrants,
  listGrants,
  loadAuthzState,
  mintOperatorOrigin,
  saveAuthzState,
  saveGrant,
  utcIso,
} from "./store.js";
import type { AuthzOperation, AuthzState, HumanOriginGrant, UatLease } from "./types.js";
import { AUTHZ_OPERATIONS } from "./types.js";
import type { UatCampaignEndSeal } from "./uat-write-guard.js";

function newGrantId(now?: Date): string {
  const ts = (now ?? new Date())
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const suffix = randomBytes(3).toString("hex");
  return `grant-${ts}-${suffix}`;
}

export interface StartUatInput {
  readonly projectRoot: string;
  readonly campaignId: string;
  readonly actor?: string;
  readonly note?: string | null;
  readonly now?: Date;
}

export function startUatLease(input: StartUatInput): { state: AuthzState; lease: UatLease } {
  const actor = input.actor ?? "operator";
  const origin = mintOperatorOrigin(actor, "deft authz:uat-start", input.now);
  const lease: UatLease = {
    active: true,
    campaignId: input.campaignId.trim(),
    startedAt: origin.mintedAt,
    startedBy: origin,
    suspendedAt: null,
    note: input.note ?? null,
  };
  if (lease.campaignId.length === 0) {
    throw new Error("campaignId must be non-empty");
  }
  const prev = loadAuthzState(input.projectRoot);
  const state: AuthzState = {
    schemaVersion: 1,
    uat: lease,
    // #4233: carry pin forward — do not empty on UAT start.
    activeGrantIds: prev.activeGrantIds,
  };
  const wrote = saveAuthzState(input.projectRoot, state);
  if (!wrote.ok) {
    throw new Error(wrote.reason);
  }
  return { state, lease };
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

export function suspendUatLease(input: SuspendUatInput): AuthzState {
  const prev = loadAuthzState(input.projectRoot);
  if (prev.uat === null || !prev.uat.active) {
    return prev;
  }
  const state: AuthzState = {
    schemaVersion: 1,
    uat: {
      ...prev.uat,
      active: false,
      suspendedAt: utcIso(input.now),
    },
    activeGrantIds: prev.activeGrantIds,
  };
  const wrote = saveAuthzState(input.projectRoot, state, {
    campaignEndSeal: input.campaignEndSeal,
  });
  if (!wrote.ok) {
    throw new Error(wrote.reason);
  }
  return state;
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

export function mintHumanOriginGrant(input: MintGrantInput): HumanOriginGrant {
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
  const saved = saveGrant(input.projectRoot, grant);
  if (!saved.ok) {
    throw new Error(saved.reason);
  }
  if (input.pinActive) {
    const prev = loadAuthzState(input.projectRoot);
    const ids = new Set(prev.activeGrantIds);
    ids.add(grant.id);
    const pinned = saveAuthzState(input.projectRoot, {
      schemaVersion: 1,
      uat: prev.uat,
      activeGrantIds: [...ids],
    });
    if (!pinned.ok) {
      throw new Error(pinned.reason);
    }
  }
  return grant;
}

export interface RevokeGrantInput {
  readonly projectRoot: string;
  readonly grantId: string;
  readonly now?: Date;
}

export function revokeGrant(input: RevokeGrantInput): HumanOriginGrant | null {
  const all = listGrants(input.projectRoot);
  const found = all.find((g) => g.id === input.grantId);
  if (found === undefined) return null;
  const revoked: HumanOriginGrant = {
    ...found,
    semantics: {
      ...found.semantics,
      revokedAt: utcIso(input.now),
    },
  };
  const wrote = saveGrant(input.projectRoot, revoked);
  if (!wrote.ok) {
    throw new Error(wrote.reason);
  }
  return revoked;
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
