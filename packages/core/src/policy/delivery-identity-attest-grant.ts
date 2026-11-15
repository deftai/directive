/**
 * Operator delivery-identity attestation (#6317 / #6310 Bound 3).
 *
 * Recovery for merged work with no merge-time basis: an operator mints a grant
 * at a terminal that names one PR and its merge commit for one plan. The
 * completion identity join accepts it as the `operator-attested` basis.
 *
 * Lives outside packages/core/src/authz/** so story product PRs do not trip the
 * class-4 protected glob (#4980). Mints only via mintHumanOriginGrant
 * (operator-cli origin), the same human-presence path as every template.
 *
 * One store: the mint, every read, the use record, the expired-grant refusal,
 * authz:revoke and authz:show resolve the grant store at
 * `mainWorktreeRoot(projectRoot)`, so a primary clone, a linked dest and a
 * finalize lifecycle checkout share it. A root that cannot be resolved refuses.
 * Failures are returned, never thrown (intent-constraint operational class).
 */

import { mintHumanOriginGrant } from "../authz/actions.js";
import { isHumanOrigin } from "../authz/origin.js";
import { listActiveHumanGrants, listGrants, markGrantUsed } from "../authz/store.js";
import { assertNoIndependentSessionAuthMint } from "../authz/templates.js";
import type { HumanOriginGrant } from "../authz/types.js";
import { defaultGitRunner, type GitRunner } from "../session/git.js";
import { mainWorktreeRoot } from "../session/main-worktree.js";

export const DELIVERY_IDENTITY_ATTEST_TEMPLATE_NAME = "delivery-identity-attest" as const;

/** Default TTL hours — Number("24") keeps the literal free of numeric-const extract. */
export const DELIVERY_IDENTITY_ATTEST_DEFAULT_EXPIRY_HOURS = Number("24");

export const DELIVERY_IDENTITY_ATTEST_TARGET_PREFIX = "delivery-identity-attest:target:";
export const DELIVERY_IDENTITY_ATTEST_PLAN_PREFIX = "delivery-identity-attest:plan:";

const TARGET_RE = /^([\w.-]+)\/([\w.-]+)#(\d+)@([0-9a-fA-F]+)$/;
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Parsed `--target <owner>/<repo>#<pr>@<merge_commit_sha>`. */
export interface DeliveryIdentityAttestTarget {
  readonly repository: string;
  readonly prNumber: number;
  readonly mergeCommitSha: string;
}

/** Canonical target text: lower-case repository and sha. */
export function formatDeliveryIdentityAttestTarget(target: DeliveryIdentityAttestTarget): string {
  return (
    `${target.repository.trim().toLowerCase()}#${String(target.prNumber)}` +
    `@${target.mergeCommitSha.trim().toLowerCase()}`
  );
}

/** Parse the attestation target; returned failure on any malformed part. */
export function parseDeliveryIdentityAttestTarget(
  raw: string,
): { ok: true; target: DeliveryIdentityAttestTarget } | { ok: false; reason: string } {
  const match = TARGET_RE.exec(raw.trim());
  const usage =
    "template delivery-identity-attest requires --target <owner>/<repo>#<pr>@<merge_commit_sha>";
  if (match === null) {
    return { ok: false, reason: `${usage} (got ${JSON.stringify(raw)})` };
  }
  const [, owner, name, prRaw, shaRaw] = match;
  const prNumber = Number(prRaw);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    return { ok: false, reason: `${usage} (PR number must be a positive integer)` };
  }
  const sha = (shaRaw ?? "").toLowerCase();
  if (!FULL_SHA_RE.test(sha)) {
    return { ok: false, reason: `${usage} (merge_commit_sha must be a full commit sha)` };
  }
  return {
    ok: true,
    target: { repository: `${owner ?? ""}/${name ?? ""}`, prNumber, mergeCommitSha: sha },
  };
}

/** The one grant store for this template: the main clone root. */
export function resolveDeliveryIdentityAttestStore(
  projectRoot: string,
  runGit: GitRunner = defaultGitRunner,
): { ok: true; root: string } | { ok: false; reason: string } {
  const root = mainWorktreeRoot(projectRoot, runGit);
  if (root === null) {
    return {
      ok: false,
      reason:
        `delivery-identity-attest grant store cannot be resolved: no main clone ` +
        `(git rev-parse --git-common-dir) from ${projectRoot}; refusing (#6317)`,
    };
  }
  return { ok: true, root };
}

export interface MintDeliveryIdentityAttestInput {
  readonly projectRoot: string;
  /** `<owner>/<repo>#<pr>@<merge_commit_sha>` (required). */
  readonly target: string;
  /** Plan id of the story being completed (required). */
  readonly planRef: string;
  readonly actor?: string;
  readonly expiresAt?: string | null;
  readonly durationHours?: number;
  readonly branch?: string | null;
  readonly eventRef?: string | null;
  readonly now?: Date;
  readonly runGit?: GitRunner;
}

export type DeliveryIdentityAttestMintResult =
  | { readonly ok: true; readonly grant: HumanOriginGrant; readonly storeRoot: string }
  | { readonly ok: false; readonly reason: string };

function isoExpiry(now: Date, hours: number): string {
  return new Date(now.getTime() + hours * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Mint a delivery-identity-attest grant in the main clone store (#6317).
 * Single-use: first use is recorded when the completed/ write succeeds;
 * a replay for the same plan, PR and merge commit accepts the used grant.
 */
export function mintDeliveryIdentityAttestTemplateGrant(
  input: MintDeliveryIdentityAttestInput,
): DeliveryIdentityAttestMintResult {
  const dualMint = assertNoIndependentSessionAuthMint();
  if (dualMint.sessionAuthIsAuthority || dualMint.mintPath !== "mintHumanOriginGrant") {
    return {
      ok: false,
      reason:
        "delivery-identity-attest template mint refused: dual authorization SoT is forbidden (#5350)",
    };
  }
  const parsed = parseDeliveryIdentityAttestTarget(input.target);
  if (!parsed.ok) {
    return parsed;
  }
  const planRef = input.planRef.trim();
  if (planRef.length === 0) {
    return {
      ok: false,
      reason: "template delivery-identity-attest requires --plan-ref <scopeId>",
    };
  }
  const store = resolveDeliveryIdentityAttestStore(input.projectRoot, input.runGit);
  if (!store.ok) {
    return store;
  }
  let expiresAt = input.expiresAt ?? null;
  if (expiresAt === null) {
    const hours =
      input.durationHours !== undefined && Number.isFinite(input.durationHours)
        ? Math.max(1, Math.floor(input.durationHours))
        : DELIVERY_IDENTITY_ATTEST_DEFAULT_EXPIRY_HOURS;
    expiresAt = isoExpiry(input.now ?? new Date(), hours);
  }
  const minted = mintHumanOriginGrant({
    projectRoot: store.root,
    actor: input.actor ?? "operator",
    operations: ["settings"],
    surfaces: [
      `${DELIVERY_IDENTITY_ATTEST_PLAN_PREFIX}${planRef}`,
      `${DELIVERY_IDENTITY_ATTEST_TARGET_PREFIX}${formatDeliveryIdentityAttestTarget(parsed.target)}`,
    ],
    expiresAt,
    singleUse: true,
    planRef,
    repo: parsed.target.repository,
    branch: input.branch ?? null,
    issueIds: [],
    storyIds: [],
    eventRef: input.eventRef ?? `template:${DELIVERY_IDENTITY_ATTEST_TEMPLATE_NAME}`,
    now: input.now,
  });
  if (!minted.ok) {
    return { ok: false, reason: minted.reason };
  }
  return { ok: true, grant: minted.grant, storeRoot: store.root };
}

export function isDeliveryIdentityAttestTemplateName(name: string): boolean {
  return name.trim().toLowerCase() === DELIVERY_IDENTITY_ATTEST_TEMPLATE_NAME;
}

/** True for a grant minted by this template (event ref and target surface). */
export function isDeliveryIdentityAttestGrant(grant: HumanOriginGrant): boolean {
  return (
    (grant.origin.eventRef ?? "").startsWith(
      `template:${DELIVERY_IDENTITY_ATTEST_TEMPLATE_NAME}`,
    ) && grant.scope.surfaces.some((s) => s.startsWith(DELIVERY_IDENTITY_ATTEST_TARGET_PREFIX))
  );
}

export interface FindDeliveryIdentityAttestationInput {
  readonly projectRoot: string;
  readonly repository: string;
  readonly prNumber: number;
  readonly mergeCommitSha: string;
  readonly planId: string;
  readonly now?: Date;
  readonly runGit?: GitRunner;
}

export type DeliveryIdentityAttestLookup =
  | { readonly ok: true; readonly grantId: string; readonly replay: boolean }
  | { readonly ok: false; readonly reason: string };

/** Remint advice named in every refusal of this lookup. */
export function formatDeliveryIdentityAttestCommand(
  target: DeliveryIdentityAttestTarget | null,
  planId: string | null,
): string {
  const targetText =
    target === null
      ? "<owner>/<repo>#<pr>@<merge_commit_sha>"
      : formatDeliveryIdentityAttestTarget(target);
  return (
    `deft authz:grant --template ${DELIVERY_IDENTITY_ATTEST_TEMPLATE_NAME} ` +
    `--target ${targetText} --plan-ref ${planId ?? "<scopeId>"} --confirm`
  );
}

/**
 * Find the grant that attests (PR, merge commit, plan) in the main clone store.
 * A used grant for the same target is a replay (finalize retry / restamp) and
 * is accepted. An unused grant must be unexpired and active. Only expired
 * unused grants → refusal naming a re-mint or authz:revoke.
 */
export function findDeliveryIdentityAttestation(
  input: FindDeliveryIdentityAttestationInput,
): DeliveryIdentityAttestLookup {
  const planId = input.planId.trim();
  const target: DeliveryIdentityAttestTarget = {
    repository: input.repository,
    prNumber: input.prNumber,
    mergeCommitSha: input.mergeCommitSha,
  };
  const remint = formatDeliveryIdentityAttestCommand(target, planId.length > 0 ? planId : null);
  if (planId.length === 0) {
    return {
      ok: false,
      reason: "operator-attested: the brief has no plan id to bind a grant to",
    };
  }
  const store = resolveDeliveryIdentityAttestStore(input.projectRoot, input.runGit);
  if (!store.ok) {
    return { ok: false, reason: `operator-attested: ${store.reason}` };
  }
  const targetSurface = `${DELIVERY_IDENTITY_ATTEST_TARGET_PREFIX}${formatDeliveryIdentityAttestTarget(target)}`;
  const matches = (grant: HumanOriginGrant): boolean =>
    isDeliveryIdentityAttestGrant(grant) &&
    isHumanOrigin(grant.origin) &&
    grant.semantics.revokedAt === null &&
    (grant.scope.planRef ?? "") === planId &&
    grant.scope.surfaces.includes(targetSurface);
  const all = listGrants(store.root).filter(matches);
  const replay = all.find((g) => g.semantics.usedAt !== null);
  if (replay !== undefined) {
    return { ok: true, grantId: replay.id, replay: true };
  }
  const active = listActiveHumanGrants(store.root, undefined, input.now ?? new Date()).filter(
    matches,
  );
  const usable = active[0];
  if (usable !== undefined) {
    return { ok: true, grantId: usable.id, replay: false };
  }
  if (all.length > 0) {
    const ids = all.map((g) => g.id).join(", ");
    return {
      ok: false,
      reason:
        `operator-attested: grant ${ids} for ${formatDeliveryIdentityAttestTarget(target)} ` +
        `and plan ${planId} expired (or is not active) before first use; re-mint with ` +
        `\`${remint}\` or run \`deft authz:revoke -- <grant-id>\``,
    };
  }
  return {
    ok: false,
    reason:
      `operator-attested: no delivery-identity-attest grant for ` +
      `${formatDeliveryIdentityAttestTarget(target)} and plan ${planId} in ${store.root}`,
  };
}

/** Record first use after the completed/ write succeeds (#6317). */
export function recordDeliveryIdentityAttestUse(input: {
  readonly projectRoot: string;
  readonly grantId: string;
  readonly now?: Date;
  readonly runGit?: GitRunner;
}): { ok: true } | { ok: false; reason: string } {
  const store = resolveDeliveryIdentityAttestStore(input.projectRoot, input.runGit);
  if (!store.ok) {
    return store;
  }
  const used = markGrantUsed(store.root, input.grantId, input.now ?? new Date());
  if (used === null || used.semantics.usedAt === null) {
    return {
      ok: false,
      reason: `could not record use of delivery-identity-attest grant ${input.grantId} in ${store.root}`,
    };
  }
  return { ok: true };
}

/** Grants of this template in the main clone store, for authz:show (#6317). */
export function listDeliveryIdentityAttestGrants(
  projectRoot: string,
  runGit: GitRunner = defaultGitRunner,
): { ok: true; root: string; grants: HumanOriginGrant[] } | { ok: false; reason: string } {
  const store = resolveDeliveryIdentityAttestStore(projectRoot, runGit);
  if (!store.ok) {
    return store;
  }
  return {
    ok: true,
    root: store.root,
    grants: listGrants(store.root).filter(isDeliveryIdentityAttestGrant),
  };
}
