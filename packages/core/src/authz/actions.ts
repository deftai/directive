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
  listActiveHumanGrants,
  listGrants,
  loadAuthzState,
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
