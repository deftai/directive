/**
 * Operator acceptance-disposition grant (#6318 / #6310 Bound 4).
 *
 * An operator defers one or more acceptance items to a later issue without
 * editing the active brief. At mint the grant records, for each covered id, a
 * digest of `acceptance.clauses[id].text` (resolved by clause id) or, for a
 * plan item that is not a clause, of its title. `scope:complete` applies the
 * covered `deferred` dispositions in memory before the merge stamper and writes
 * them only with the `completed/` write.
 *
 * Lives outside packages/core/src/authz/** so story product PRs do not trip the
 * class-4 protected glob (#4980). Mints only via mintHumanOriginGrant
 * (operator-cli origin), the same human-presence path as every template.
 *
 * One store (#6317): the mint, every read, the use record, the expired-grant
 * refusal, authz:revoke and authz:show resolve the grant store at
 * `mainWorktreeRoot(projectRoot)`. Failures are returned, never thrown.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mintHumanOriginGrant } from "../authz/actions.js";
import { isHumanOrigin } from "../authz/origin.js";
import { listActiveHumanGrants, listGrants, markGrantUsed } from "../authz/store.js";
import { assertNoIndependentSessionAuthMint } from "../authz/templates.js";
import type { HumanOriginGrant } from "../authz/types.js";
import {
  ACCEPTANCE_DISPOSITION_KEY,
  ACCEPTANCE_DISPOSITION_TEMPLATE_NAME,
  type AcceptanceDispositionRecord,
  applyGrantedDispositions,
  formatAcceptanceDispositionCommand,
  type GrantedDisposition,
  type GrantedDispositionOriginals,
} from "../scope/acceptance-evidence.js";
import { defaultGitRunner, type GitRunner } from "../session/git.js";
import { mainWorktreeRoot } from "../session/main-worktree.js";
import { readAcceptanceClauses } from "../verify-ac/clauses.js";
import { DELIVERY_IDENTITY_ATTEST_DEFAULT_EXPIRY_HOURS } from "./delivery-identity-attest-grant.js";

// The template name and its command formatter live in scope/acceptance-evidence
// so the completion gate can print the grant (#7099); re-exported here.
export { ACCEPTANCE_DISPOSITION_TEMPLATE_NAME, formatAcceptanceDispositionCommand };

/** Same default TTL as delivery-identity-attest (24 hours). */
export const ACCEPTANCE_DISPOSITION_DEFAULT_EXPIRY_HOURS =
  DELIVERY_IDENTITY_ATTEST_DEFAULT_EXPIRY_HOURS;

export const ACCEPTANCE_DISPOSITION_PLAN_PREFIX = "acceptance-disposition:plan:";
export const ACCEPTANCE_DISPOSITION_ITEM_PREFIX = "acceptance-disposition:item:";
export const ACCEPTANCE_DISPOSITION_DEFERRED_TO_PREFIX = "acceptance-disposition:deferred-to:";
export const ACCEPTANCE_DISPOSITION_REASON_PREFIX = "acceptance-disposition:reason:";
/** Stored disposition value (#6644). A grant without it reads as `deferred`. */
export const ACCEPTANCE_DISPOSITION_VALUE_PREFIX = "acceptance-disposition:disposition:";

/** Values the grant can record (#6644). `deferred` is the default. */
export const ACCEPTANCE_GRANT_DISPOSITIONS = ["deferred", "not_applicable", "waived"] as const;
export type AcceptanceGrantDisposition = (typeof ACCEPTANCE_GRANT_DISPOSITIONS)[number];

function isGrantDisposition(value: string): value is AcceptanceGrantDisposition {
  return (ACCEPTANCE_GRANT_DISPOSITIONS as readonly string[]).includes(value);
}
/** Millisecond mint time: origin.mintedAt has whole seconds only (#6343 review). */
export const ACCEPTANCE_DISPOSITION_MINTED_AT_PREFIX = "acceptance-disposition:minted-at:";

const DIGEST_SEPARATOR = "@sha256:";
const CLAUSE_ID_RE = /^clause[.:](\d+)$/;
const BARE_CLAUSE_ID_RE = /^[1-9]\d*$/;
const ISSUE_NUMBER_RE = /^\d+$/;
const OWNER_REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const BRIEF_DIRS = ["xbrief", "vbrief"] as const;
/** Open folders first; completed/ last so a restamp can take a replacement grant. */
const BRIEF_FOLDERS = ["active", "pending", "proposed", "completed"] as const;

export function isAcceptanceDispositionTemplateName(name: string): boolean {
  return name.trim().toLowerCase() === ACCEPTANCE_DISPOSITION_TEMPLATE_NAME;
}

/** True for a grant minted by this template (event ref and plan surface). */
export function isAcceptanceDispositionGrant(grant: HumanOriginGrant): boolean {
  return (
    (grant.origin.eventRef ?? "").startsWith(`template:${ACCEPTANCE_DISPOSITION_TEMPLATE_NAME}`) &&
    grant.scope.surfaces.some((s) => s.startsWith(ACCEPTANCE_DISPOSITION_PLAN_PREFIX))
  );
}

/** The one grant store: the main clone root (same store as #6317). */
export function resolveAcceptanceDispositionStore(
  projectRoot: string,
  runGit: GitRunner = defaultGitRunner,
): { ok: true; root: string } | { ok: false; reason: string } {
  const root = mainWorktreeRoot(projectRoot, runGit);
  if (root === null) {
    return {
      ok: false,
      reason:
        `acceptance-disposition grant store cannot be resolved: no main clone ` +
        `(git rev-parse --git-common-dir) from ${projectRoot}; refusing (#6318)`,
    };
  }
  return { ok: true, root };
}

/** sha256 hex of the covered text. */
export function acceptanceDispositionDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Canonical item id: `clause:N` becomes `clause.N`; other ids are trimmed. */
export function canonicalAcceptanceDispositionId(raw: string): string {
  const id = raw.trim();
  const match = CLAUSE_ID_RE.exec(id);
  return match === null ? id : `clause.${match[1]}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function findItemTitle(items: unknown, wanted: string): string | null {
  if (!Array.isArray(items)) return null;
  for (const entry of items) {
    const item = asRecord(entry);
    if (item === null) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (id === wanted) {
      return typeof item.title === "string" && item.title.trim().length > 0 ? item.title : null;
    }
    const nested = findItemTitle(item.subItems, wanted) ?? findItemTitle(item.items, wanted);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * Text a covered id binds to: `acceptance.clauses[id].text` for a clause id
 * (`clause.N`), else the title of the plan item with that id. A bare integer id
 * that names a clause binds to that clause's text too, the same rule the granted
 * set uses (#6644 review), so a changed clause needs a new grant. Null when the
 * id resolves to neither.
 */
export function acceptanceDispositionCoverText(
  plan: Record<string, unknown>,
  itemId: string,
): string | null {
  const id = canonicalAcceptanceDispositionId(itemId);
  const match = CLAUSE_ID_RE.exec(id);
  const bare = BARE_CLAUSE_ID_RE.test(id) ? Number(id) : null;
  const clauseId = match !== null ? Number(match[1]) : bare;
  if (clauseId !== null) {
    const clause = readAcceptanceClauses(plan.acceptance).find((c) => c.id === clauseId);
    if (clause !== undefined) return clause.text;
  }
  return findItemTitle(plan.items, id);
}

/** Parse `--deferred-to <issue>`: `N`, `#N` or `owner/repo#N`. */
export function parseAcceptanceDispositionDeferredTo(
  raw: string,
): { ok: true; target: string; issueNumber: number } | { ok: false; reason: string } {
  const text = raw.trim();
  const usage =
    "template acceptance-disposition requires --deferred-to <issue> (N, #N or owner/repo#N)";
  // Split on the last `#` instead of one combined regex (CodeQL polynomial-redos).
  const hash = text.lastIndexOf("#");
  const repoPart = hash > 0 ? text.slice(0, hash) : null;
  const numberPart = hash >= 0 ? text.slice(hash + 1) : text;
  if (!ISSUE_NUMBER_RE.test(numberPart) || (repoPart !== null && !OWNER_REPO_RE.test(repoPart))) {
    return { ok: false, reason: `${usage} (got ${JSON.stringify(raw)})` };
  }
  const issueNumber = Number(numberPart);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    return { ok: false, reason: `${usage} (issue number must be a positive integer)` };
  }
  const repo = repoPart ?? undefined;
  return {
    ok: true,
    target:
      repo === undefined
        ? `#${String(issueNumber)}`
        : `${repo.toLowerCase()}#${String(issueNumber)}`,
    issueNumber,
  };
}

/** Find the brief (active, pending, proposed, then completed) whose plan.id is `planId`. */
function findBriefPlan(root: string, planId: string): Record<string, unknown> | null {
  for (const dir of BRIEF_DIRS) {
    for (const folder of BRIEF_FOLDERS) {
      const folderPath = join(root, dir, folder);
      let names: string[];
      try {
        names = readdirSync(folderPath).filter((n) => n.endsWith(".json"));
      } catch {
        continue;
      }
      for (const name of names) {
        try {
          const data = asRecord(JSON.parse(readFileSync(join(folderPath, name), "utf8")));
          const plan = asRecord(data?.plan);
          if (plan !== null && typeof plan.id === "string" && plan.id.trim() === planId) {
            return plan;
          }
        } catch {
          // skip unreadable briefs
        }
      }
    }
  }
  return null;
}

function hasReadableExpiry(expiresAt: string): boolean {
  return !Number.isNaN(Date.parse(expiresAt));
}

/** True when the grant has a readable expiry later than `now`. */
function expiresAfter(grant: HumanOriginGrant, now: Date): boolean {
  const expiresAt = grant.semantics.expiresAt;
  return (
    expiresAt !== null && hasReadableExpiry(expiresAt) && Date.parse(expiresAt) > now.getTime()
  );
}

function isoExpiry(now: Date, hours: number): string {
  return new Date(now.getTime() + hours * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface MintAcceptanceDispositionInput {
  readonly projectRoot: string;
  /** Plan id of the story (required). */
  readonly planRef: string;
  /** Covered item ids: `clause.N` or a plan item id (required). */
  readonly storyIds: readonly string[];
  /** Value recorded (default `deferred`) (#6644). */
  readonly disposition?: string;
  /** Issue the covered items are deferred to: required for `deferred`, refused otherwise. */
  readonly deferredTo?: string;
  /** One-line reason (required). */
  readonly reason: string;
  readonly actor?: string;
  readonly expiresAt?: string | null;
  readonly branch?: string | null;
  readonly now?: Date;
  readonly runGit?: GitRunner;
}

export type AcceptanceDispositionMintResult =
  | {
      readonly ok: true;
      readonly grant: HumanOriginGrant;
      readonly storeRoot: string;
      readonly itemIds: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Mint an acceptance-disposition grant in the main clone store (#6318).
 * Every operator input is validated here; any failure is returned.
 */
export function mintAcceptanceDispositionTemplateGrant(
  input: MintAcceptanceDispositionInput,
): AcceptanceDispositionMintResult {
  const dualMint = assertNoIndependentSessionAuthMint();
  if (dualMint.sessionAuthIsAuthority || dualMint.mintPath !== "mintHumanOriginGrant") {
    return {
      ok: false,
      reason:
        "acceptance-disposition template mint refused: dual authorization SoT is forbidden (#5350)",
    };
  }
  const planRef = input.planRef.trim();
  if (planRef.length === 0) {
    return { ok: false, reason: "template acceptance-disposition requires --plan-ref <scopeId>" };
  }
  const itemIds = [
    ...new Set(input.storyIds.map(canonicalAcceptanceDispositionId).filter((s) => s.length > 0)),
  ];
  if (itemIds.length === 0) {
    return {
      ok: false,
      reason:
        "template acceptance-disposition requires --story-ids <itemIds> (clause.N or item id)",
    };
  }
  const disposition = (input.disposition ?? "deferred").trim();
  if (!isGrantDisposition(disposition)) {
    return {
      ok: false,
      reason:
        `template acceptance-disposition: --disposition ${JSON.stringify(input.disposition)} ` +
        `must be one of ${ACCEPTANCE_GRANT_DISPOSITIONS.join(", ")}`,
    };
  }
  const hasDeferredTo = input.deferredTo !== undefined && input.deferredTo.trim().length > 0;
  if (disposition !== "deferred" && input.deferredTo !== undefined) {
    return {
      ok: false,
      reason: `template acceptance-disposition: --deferred-to is refused for --disposition ${disposition}`,
    };
  }
  const deferred =
    disposition === "deferred"
      ? parseAcceptanceDispositionDeferredTo(hasDeferredTo ? (input.deferredTo as string) : "")
      : null;
  if (deferred !== null && !deferred.ok) return deferred;
  const reason = input.reason.trim();
  if (reason.length === 0 || /[\r\n]/.test(reason)) {
    return {
      ok: false,
      reason: "template acceptance-disposition requires --reason <text> on one non-empty line",
    };
  }
  const now = input.now ?? new Date();
  let expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && !hasReadableExpiry(expiresAt)) {
    return {
      ok: false,
      reason: `template acceptance-disposition: --expires ${JSON.stringify(expiresAt)} is not a readable date`,
    };
  }
  if (expiresAt !== null && Date.parse(expiresAt) <= now.getTime()) {
    return {
      ok: false,
      reason: `template acceptance-disposition: --expires ${JSON.stringify(expiresAt)} is not in the future`,
    };
  }
  const store = resolveAcceptanceDispositionStore(input.projectRoot, input.runGit);
  if (!store.ok) return store;
  const plan = findBriefPlan(input.projectRoot, planRef) ?? findBriefPlan(store.root, planRef);
  if (plan === null) {
    return {
      ok: false,
      reason:
        `template acceptance-disposition: no active, pending, proposed or completed brief has plan id ` +
        `${planRef} in ${input.projectRoot} or ${store.root}`,
    };
  }
  const itemSurfaces: string[] = [];
  for (const id of itemIds) {
    const text = acceptanceDispositionCoverText(plan, id);
    if (text === null) {
      return {
        ok: false,
        reason:
          `template acceptance-disposition: ${id} is neither an acceptance clause ` +
          `(clause.N) nor a plan item with a title in plan ${planRef}`,
      };
    }
    itemSurfaces.push(
      `${ACCEPTANCE_DISPOSITION_ITEM_PREFIX}${id}${DIGEST_SEPARATOR}${acceptanceDispositionDigest(text)}`,
    );
  }
  if (expiresAt === null) {
    expiresAt = isoExpiry(now, ACCEPTANCE_DISPOSITION_DEFAULT_EXPIRY_HOURS);
  }
  const minted = mintHumanOriginGrant({
    projectRoot: store.root,
    actor: input.actor ?? "operator",
    operations: ["settings"],
    surfaces: [
      `${ACCEPTANCE_DISPOSITION_PLAN_PREFIX}${planRef}`,
      ...(deferred !== null && deferred.ok
        ? [`${ACCEPTANCE_DISPOSITION_DEFERRED_TO_PREFIX}${deferred.target}`]
        : []),
      `${ACCEPTANCE_DISPOSITION_VALUE_PREFIX}${disposition}`,
      `${ACCEPTANCE_DISPOSITION_REASON_PREFIX}${reason}`,
      `${ACCEPTANCE_DISPOSITION_MINTED_AT_PREFIX}${now.toISOString()}`,
      ...itemSurfaces,
    ],
    expiresAt,
    singleUse: true,
    planRef,
    branch: input.branch ?? null,
    issueIds: deferred !== null && deferred.ok ? [deferred.issueNumber] : [],
    storyIds: itemIds,
    eventRef: `template:${ACCEPTANCE_DISPOSITION_TEMPLATE_NAME}`,
    now,
  });
  if (!minted.ok) {
    return { ok: false, reason: minted.reason };
  }
  return { ok: true, grant: minted.grant, storeRoot: store.root, itemIds };
}

/** Fields read back from a grant of this template; null when malformed. */
interface GrantView {
  readonly grant: HumanOriginGrant;
  readonly planId: string;
  /** Null for `not_applicable` and `waived` (#6644). */
  readonly deferredTo: string | null;
  readonly disposition: AcceptanceGrantDisposition;
  readonly reason: string;
  readonly digests: ReadonlyMap<string, string>;
  readonly mintedMs: number;
}

function surfaceValue(grant: HumanOriginGrant, prefix: string): string | null {
  const surface = grant.scope.surfaces.find((s) => s.startsWith(prefix));
  return surface === undefined ? null : surface.slice(prefix.length);
}

function viewOf(grant: HumanOriginGrant): GrantView | null {
  const planId = surfaceValue(grant, ACCEPTANCE_DISPOSITION_PLAN_PREFIX);
  const deferredTo = surfaceValue(grant, ACCEPTANCE_DISPOSITION_DEFERRED_TO_PREFIX);
  const reason = surfaceValue(grant, ACCEPTANCE_DISPOSITION_REASON_PREFIX);
  const stored = surfaceValue(grant, ACCEPTANCE_DISPOSITION_VALUE_PREFIX);
  // A grant minted before #6644 has no stored value and reads as `deferred`.
  const disposition = stored === null ? "deferred" : stored.trim();
  if (!isGrantDisposition(disposition)) return null;
  if (planId === null || reason === null || reason.trim().length === 0) return null;
  // deferred-to is required for `deferred` (stored or absent) only.
  if (disposition === "deferred" && deferredTo === null) return null;
  const digests = new Map<string, string>();
  for (const surface of grant.scope.surfaces) {
    if (!surface.startsWith(ACCEPTANCE_DISPOSITION_ITEM_PREFIX)) continue;
    const body = surface.slice(ACCEPTANCE_DISPOSITION_ITEM_PREFIX.length);
    const at = body.lastIndexOf(DIGEST_SEPARATOR);
    const id = at <= 0 ? "" : body.slice(0, at);
    const digest = at <= 0 ? "" : body.slice(at + DIGEST_SEPARATOR.length);
    if (id.length === 0 || !SHA256_HEX_RE.test(digest)) return null;
    digests.set(id, digest);
  }
  if (digests.size === 0) return null;
  const mintedAt = surfaceValue(grant, ACCEPTANCE_DISPOSITION_MINTED_AT_PREFIX);
  const preciseMs = mintedAt === null ? Number.NaN : Date.parse(mintedAt);
  return {
    grant,
    planId,
    deferredTo: disposition === "deferred" ? deferredTo : null,
    disposition,
    reason: reason.trim(),
    digests,
    mintedMs: Number.isNaN(preciseMs) ? Date.parse(grant.origin.mintedAt) : preciseMs,
  };
}

/** Grants of this template for one plan in the store: human origin, not revoked. */
function planGrantViews(storeRoot: string, planId: string): GrantView[] {
  return listGrants(storeRoot)
    .filter(
      (g) =>
        isAcceptanceDispositionGrant(g) &&
        isHumanOrigin(g.origin) &&
        g.semantics.revokedAt === null &&
        (g.scope.planRef ?? "") === planId,
    )
    .map(viewOf)
    .filter((v): v is GrantView => v !== null && v.planId === planId);
}

/**
 * Unused acceptance-disposition grant that touches planId on one identifier and
 * disagrees on the other (#7254). Wholly-other-plan grants are ignored.
 */
function unusedDisagreeingPlanGrant(
  storeRoot: string,
  planId: string,
): { grantId: string; planRef: string; surfacePlanId: string } | null {
  for (const grant of listGrants(storeRoot)) {
    if (!isAcceptanceDispositionGrant(grant) || !isHumanOrigin(grant.origin)) continue;
    if (grant.semantics.revokedAt !== null || grant.semantics.usedAt !== null) continue;
    const planRef = (grant.scope.planRef ?? "").trim();
    const surfacePlanId = (surfaceValue(grant, ACCEPTANCE_DISPOSITION_PLAN_PREFIX) ?? "").trim();
    if (planRef !== planId && surfacePlanId !== planId) continue;
    if (planRef === surfacePlanId) continue;
    return { grantId: grant.id, planRef, surfacePlanId };
  }
  return null;
}

/** One covered item resolved to its grant. */
export interface AcceptanceDispositionGrantCover {
  readonly itemId: string;
  readonly grantId: string;
  readonly deferredTo: string | null;
  readonly disposition: AcceptanceGrantDisposition;
  readonly reason: string;
  /** True when the grant was already used (finalize retry / restamp). */
  readonly replay: boolean;
  readonly grant: HumanOriginGrant;
}

export type AcceptanceDispositionResolution =
  | { readonly ok: true; readonly covers: readonly AcceptanceDispositionGrantCover[] }
  | { readonly ok: false; readonly reason: string };

export interface ResolveAcceptanceDispositionInput {
  readonly projectRoot: string;
  readonly plan: Record<string, unknown>;
  readonly now?: Date;
  readonly runGit?: GitRunner;
}

/**
 * Resolve the grants that cover this plan at completion (#6318 / #7254).
 *
 * A used grant is a replay and is accepted; an unused grant must carry a
 * readable expiry that is still ahead and be active. Per covered id the latest
 * usable grant wins, and it must still match the digest of the current clause
 * text (or item title); a mismatch refuses and names a re-mint. An expired or
 * inactive unused grant refuses unless a later usable grant covers the same
 * plan and every one of its ids. When the main-clone store cannot be resolved,
 * refuse with that reason so clause-walk-failed cannot hide a missed deferral
 * (#7254). An unused grant whose planRef and plan surface disagree for this
 * plan.id also refuses; a grant that wholly belongs to another plan is ignored.
 */
export function resolveAcceptanceDispositionGrants(
  input: ResolveAcceptanceDispositionInput,
): AcceptanceDispositionResolution {
  const planId = typeof input.plan.id === "string" ? input.plan.id.trim() : "";
  if (planId.length === 0) return { ok: true, covers: [] };
  const store = resolveAcceptanceDispositionStore(input.projectRoot, input.runGit);
  if (!store.ok) return store;
  const disagree = unusedDisagreeingPlanGrant(store.root, planId);
  if (disagree !== null) {
    return {
      ok: false,
      reason:
        `acceptance-disposition grant ${disagree.grantId} has disagreeing plan identifiers ` +
        `(planRef=${JSON.stringify(disagree.planRef)}, surface=${JSON.stringify(disagree.surfacePlanId)}) ` +
        `for plan ${planId}; refuse so a mismatched grant cannot authorize or silently miss (#7254)`,
    };
  }
  const now = input.now ?? new Date();
  const views = planGrantViews(store.root, planId);
  if (views.length === 0) return { ok: true, covers: [] };
  const activeIds = new Set(listActiveHumanGrants(store.root, undefined, now).map((g) => g.id));
  const usable: GrantView[] = [];
  const stale: GrantView[] = [];
  for (const view of views) {
    const used = view.grant.semantics.usedAt !== null;
    const live = !used && activeIds.has(view.grant.id) && expiresAfter(view.grant, now);
    (used || live ? usable : stale).push(view);
  }
  for (const old of stale) {
    const superseded = [...old.digests.keys()].every((id) =>
      usable.some((u) => u.mintedMs > old.mintedMs && u.digests.has(id)),
    );
    if (!superseded) {
      const remint = formatAcceptanceDispositionCommand(
        planId,
        [...old.digests.keys()],
        old.deferredTo,
        old.disposition,
      );
      return {
        ok: false,
        reason:
          `acceptance-disposition grant ${old.grant.id} for plan ${planId} expired (or is not ` +
          `active) before first use; re-mint with \`${remint}\` or run ` +
          `\`deft authz:revoke -- ${old.grant.id}\` (#6318)`,
      };
    }
  }
  const latest = new Map<string, GrantView>();
  for (const view of usable) {
    for (const id of view.digests.keys()) {
      const current = latest.get(id);
      if (current === undefined || view.mintedMs > current.mintedMs) latest.set(id, view);
    }
  }
  const covers: AcceptanceDispositionGrantCover[] = [];
  for (const [id, view] of latest) {
    const text = acceptanceDispositionCoverText(input.plan, id);
    const digest = text === null ? null : acceptanceDispositionDigest(text);
    if (digest === null || digest !== view.digests.get(id)) {
      const remint = formatAcceptanceDispositionCommand(
        planId,
        [id],
        view.deferredTo,
        view.disposition,
      );
      const what =
        text === null
          ? `${id} no longer resolves to a clause or plan item`
          : `the text of ${id} changed after grant ${view.grant.id} was minted`;
      return {
        ok: false,
        reason: `acceptance-disposition: ${what} in plan ${planId}; re-mint with \`${remint}\` (#6318)`,
      };
    }
    covers.push({
      itemId: id,
      grantId: view.grant.id,
      deferredTo: view.deferredTo,
      disposition: view.disposition,
      reason: view.reason,
      replay: view.grant.semantics.usedAt !== null,
      grant: view.grant,
    });
  }
  return { ok: true, covers };
}

/**
 * The disposition a cover writes (the grant's stored value), with the grant id
 * in provenance. `deferred_to` is written for `deferred` only (#6644).
 */
export function acceptanceDispositionRecordFor(
  cover: AcceptanceDispositionGrantCover,
  recordedAt: string,
): AcceptanceDispositionRecord {
  const origin = cover.grant.origin;
  return {
    disposition: cover.disposition,
    reason: cover.reason,
    provenance: {
      kind: origin.kind,
      actor: origin.actor,
      mintedAt: origin.mintedAt,
      mintedVia: origin.mintedVia,
      eventRef: origin.eventRef,
      grantId: cover.grantId,
    },
    recorded_at: recordedAt,
    ...(cover.disposition === "deferred" && cover.deferredTo !== null
      ? { deferred_to: cover.deferredTo }
      : {}),
  };
}

/** A clause stamped from a grant in this run (#6644 granted set). */
export interface GrantedClause {
  readonly id: number;
  readonly disposition: AcceptanceGrantDisposition;
  readonly reason: string;
}

export type ApplyAcceptanceDispositionResult =
  | {
      readonly ok: true;
      readonly appliedIds: readonly string[];
      /**
       * Clauses stamped from a grant in this run (#6644). The only input of the
       * completion walk's granted set; a disposition written into the brief is not.
       */
      readonly grantedClauses: readonly GrantedClause[];
      /** Covered items as they were before the apply, for the mid-flight write. */
      readonly originals: GrantedDispositionOriginals;
      /** Unused grants whose first use is recorded after the completed/ write. */
      readonly grantIdsToRecord: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Complete-prep step (#6318): resolve the grants for this plan and apply the
 * covered `deferred` dispositions in memory. Runs after
 * persistClauseKeyedPendingItems and before stampMergeFromCompletionProvenance.
 */
export function applyAcceptanceDispositionGrants(input: {
  readonly projectRoot: string;
  readonly plan: Record<string, unknown>;
  readonly now: Date;
  readonly recordedAt: string;
  readonly runGit?: GitRunner;
}): ApplyAcceptanceDispositionResult {
  const resolved = resolveAcceptanceDispositionGrants(input);
  if (!resolved.ok) return resolved;
  const applied = applyGrantedDispositions(
    input.plan,
    resolved.covers.map((cover) => ({
      itemId: cover.itemId,
      record: acceptanceDispositionRecordFor(cover, input.recordedAt),
    })),
  );
  if (applied.missingIds.length > 0) {
    return {
      ok: false,
      reason:
        `acceptance-disposition: covered item(s) ${applied.missingIds.join(", ")} have no plan ` +
        `item to carry the disposition (#6318)`,
    };
  }
  const grantIdsToRecord = [
    ...new Set(resolved.covers.filter((c) => !c.replay).map((c) => c.grantId)),
  ];
  const appliedSet = new Set(applied.appliedIds);
  const grantedClauses: GrantedClause[] = [];
  // A bare integer id names clause N when acceptance.clauses has it, the same
  // rule findClauseKeyedItem and citedItemKey use (#6644 review).
  const clauseIds = new Set(readAcceptanceClauses(input.plan.acceptance).map((c) => c.id));
  const seen = new Set<number>();
  for (const cover of resolved.covers) {
    if (!appliedSet.has(cover.itemId)) continue;
    const prefixed = CLAUSE_ID_RE.exec(cover.itemId);
    const bare = BARE_CLAUSE_ID_RE.test(cover.itemId.trim()) ? Number(cover.itemId.trim()) : null;
    const id =
      prefixed !== null ? Number(prefixed[1]) : bare !== null && clauseIds.has(bare) ? bare : null;
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    grantedClauses.push({ id, disposition: cover.disposition, reason: cover.reason });
  }
  // #7254: every digest-matching clause.N cover must enter grantedClauses (the
  // #6644 leave-out input). Refuse naming the grant when a cover is dropped.
  for (const cover of resolved.covers) {
    const prefixed = CLAUSE_ID_RE.exec(cover.itemId);
    const bare = BARE_CLAUSE_ID_RE.test(cover.itemId.trim()) ? Number(cover.itemId.trim()) : null;
    const id =
      prefixed !== null ? Number(prefixed[1]) : bare !== null && clauseIds.has(bare) ? bare : null;
    if (id === null) continue;
    if (!seen.has(id)) {
      return {
        ok: false,
        reason:
          `acceptance-disposition: grant ${cover.grantId} covered clause.${String(id)} but it did ` +
          `not enter grantedClauses after apply; refusing so clause-walk-failed cannot hide a ` +
          `missed deferral (#7254)`,
      };
    }
  }
  return {
    ok: true,
    appliedIds: applied.appliedIds,
    grantedClauses,
    originals: applied.originals,
    grantIdsToRecord,
  };
}

interface CitedGrant {
  readonly itemId: string;
  readonly grantId: string;
  /** Kept on rewrite so a restamp does not churn the date; never proof of use. */
  readonly recordedAt: string;
}

/**
 * Grant key for a plan item id. A bare integer id (`"2"` or `2`) names clause N
 * when acceptance.clauses has it, the same rule findClauseKeyedItem uses when
 * the grant is applied (#6343 review); other ids canonicalize as at mint.
 */
function citedItemKey(id: unknown, clauseIds: ReadonlySet<number>): string {
  const raw = typeof id === "number" && Number.isInteger(id) ? String(id) : id;
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  // Exact String(N) only, as findClauseKeyedItem matches it ("02" is not clause 2).
  if (clauseIds.has(Number(trimmed)) && String(Number(trimmed)) === trimmed) {
    return `clause.${trimmed}`;
  }
  return canonicalAcceptanceDispositionId(trimmed);
}

function collectCitedGrants(
  items: unknown,
  out: CitedGrant[],
  clauseIds: ReadonlySet<number>,
): CitedGrant[] {
  if (!Array.isArray(items)) return out;
  for (const entry of items) {
    const item = asRecord(entry);
    if (item === null) continue;
    const disposition = asRecord(item[ACCEPTANCE_DISPOSITION_KEY]);
    const provenance = asRecord(disposition?.provenance);
    const grantId = typeof provenance?.grantId === "string" ? provenance.grantId.trim() : "";
    const itemId = citedItemKey(item.id, clauseIds);
    const recordedAt =
      typeof disposition?.recorded_at === "string" ? disposition.recorded_at.trim() : "";
    if (grantId.length > 0 && itemId.length > 0) out.push({ itemId, grantId, recordedAt });
    collectCitedGrants(item.subItems, out, clauseIds);
    collectCitedGrants(item.items, out, clauseIds);
  }
  return out;
}

/**
 * Restamp of a brief already in completed/ (#6343 review): every disposition
 * that cites an acceptance-disposition grant is a replay. The cited grant is
 * accepted while it is in the main clone store for this plan, covers the item
 * and matches the digest of the current clause text (or item title), and is
 * used or still live. The brief's own `recorded_at` is never trusted as proof
 * of use (#6343 review). The cited disposition is rewritten from its grant
 * (`deferred`, the grant's reason and `deferred_to`, the grant id), so a
 * hand-edited disposition does not survive a restamp. Otherwise the latest used or live grant for the plan that covers the
 * item with a matching digest replaces it, and its disposition is applied to
 * the plan before the write (an operator mints one for the completed brief).
 * With neither, restamp refuses and names a re-mint. A brief that cites no
 * grant passes untouched.
 */
export function checkCitedAcceptanceDispositionGrants(input: {
  readonly projectRoot: string;
  readonly plan: Record<string, unknown>;
  readonly now?: Date;
  readonly recordedAt?: string;
  readonly runGit?: GitRunner;
}):
  | {
      ok: true;
      grantIdsToRecord: readonly string[];
      replacedIds: readonly string[];
      rewrittenIds: readonly string[];
    }
  | { ok: false; reason: string } {
  const clauseIds = new Set(readAcceptanceClauses(input.plan.acceptance).map((c) => c.id));
  const cited = collectCitedGrants(input.plan.items, [], clauseIds);
  if (cited.length === 0) {
    return { ok: true, grantIdsToRecord: [], replacedIds: [], rewrittenIds: [] };
  }
  const planId = typeof input.plan.id === "string" ? input.plan.id.trim() : "";
  const store = resolveAcceptanceDispositionStore(input.projectRoot, input.runGit);
  if (!store.ok) return store;
  const now = input.now ?? new Date();
  const views = planId.length === 0 ? [] : planGrantViews(store.root, planId);
  const activeIds = new Set(listActiveHumanGrants(store.root, undefined, now).map((g) => g.id));
  const used = (v: GrantView): boolean => v.grant.semantics.usedAt !== null;
  const live = (v: GrantView): boolean =>
    !used(v) && activeIds.has(v.grant.id) && expiresAfter(v.grant, now);
  const toRecord = new Set<string>();
  const replacements: GrantedDisposition[] = [];
  const rewrites: GrantedDisposition[] = [];
  const coverOf = (itemId: string, v: GrantView): AcceptanceDispositionGrantCover => ({
    itemId,
    grantId: v.grant.id,
    deferredTo: v.deferredTo,
    disposition: v.disposition,
    reason: v.reason,
    replay: used(v),
    grant: v.grant,
  });
  for (const { itemId, grantId, recordedAt } of cited) {
    const text = acceptanceDispositionCoverText(input.plan, itemId);
    const digest = text === null ? null : acceptanceDispositionDigest(text);
    const matches = (v: GrantView): boolean => digest !== null && v.digests.get(itemId) === digest;
    const view = views.find((v) => v.grant.id === grantId);
    if (view !== undefined && matches(view) && (used(view) || live(view))) {
      rewrites.push({
        itemId,
        record: acceptanceDispositionRecordFor(
          coverOf(itemId, view),
          recordedAt.length > 0 ? recordedAt : (input.recordedAt ?? now.toISOString()),
        ),
      });
      if (!used(view)) toRecord.add(grantId);
      continue;
    }
    const replacement = views
      .filter((v) => v.grant.id !== grantId && (used(v) || live(v)) && matches(v))
      .sort((a, b) => b.mintedMs - a.mintedMs)[0];
    if (replacement !== undefined) {
      replacements.push({
        itemId,
        record: acceptanceDispositionRecordFor(
          coverOf(itemId, replacement),
          input.recordedAt ?? now.toISOString(),
        ),
      });
      if (!used(replacement)) toRecord.add(replacement.grant.id);
      continue;
    }
    const problem =
      view === undefined
        ? `grant ${grantId} is not in ${store.root} for plan ${planId || "(no id)"} (revoked or missing)`
        : view.digests.get(itemId) === undefined
          ? `grant ${grantId} does not cover ${itemId}`
          : !matches(view)
            ? `the text of ${itemId} changed after grant ${grantId} was minted`
            : `grant ${grantId} expired (or is not active) before first use`;
    const remint = formatAcceptanceDispositionCommand(
      planId.length > 0 ? planId : null,
      [itemId],
      view?.deferredTo ?? null,
      view?.disposition ?? "deferred",
    );
    return {
      ok: false,
      reason:
        `acceptance-disposition (restamp): ${problem}; mint a replacement for the completed ` +
        `brief with \`${remint}\` and run scope:complete again (#6318)`,
    };
  }
  const rewritten = applyGrantedDispositions(input.plan, rewrites);
  const applied = applyGrantedDispositions(input.plan, replacements);
  return {
    ok: true,
    grantIdsToRecord: [...toRecord],
    replacedIds: [...applied.appliedIds],
    rewrittenIds: [...rewritten.appliedIds],
  };
}

/** Record first use after the completed/ write succeeds (#6318). */
export function recordAcceptanceDispositionUse(input: {
  readonly projectRoot: string;
  readonly grantIds: readonly string[];
  readonly now?: Date;
  readonly runGit?: GitRunner;
}): { ok: true } | { ok: false; reason: string } {
  if (input.grantIds.length === 0) return { ok: true };
  const store = resolveAcceptanceDispositionStore(input.projectRoot, input.runGit);
  if (!store.ok) return store;
  const failed = input.grantIds.filter((id) => {
    const used = markGrantUsed(store.root, id, input.now ?? new Date());
    return used === null || used.semantics.usedAt === null;
  });
  if (failed.length > 0) {
    return {
      ok: false,
      reason: `could not record use of acceptance-disposition grant(s) ${failed.join(", ")} in ${store.root}`,
    };
  }
  return { ok: true };
}

/** Grants of this template in the main clone store, for authz:show (#6318). */
export function listAcceptanceDispositionGrants(
  projectRoot: string,
  runGit: GitRunner = defaultGitRunner,
): { ok: true; root: string; grants: HumanOriginGrant[] } | { ok: false; reason: string } {
  const store = resolveAcceptanceDispositionStore(projectRoot, runGit);
  if (!store.ok) return store;
  return {
    ok: true,
    root: store.root,
    grants: listGrants(store.root).filter(isAcceptanceDispositionGrant),
  };
}
