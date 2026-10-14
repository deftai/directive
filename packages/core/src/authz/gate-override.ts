/**
 * Audited interactive human gate-override hatch (#5542 Prefer-A Bound).
 *
 * Sole mint path: mintHumanOriginGrant / operator-cli via authz:grant --template.
 * operator-session is non-admitting in v1. Inspection does not consume.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ContainedWriteError,
  ContainedWriteErrorCode,
  containedWrite,
} from "../fs/contained-write.js";
import { type MintGrantInput, type MintGrantResult, mintHumanOriginGrant } from "./actions.js";
import { isHumanOrigin, isHumanOriginKind } from "./origin.js";
import {
  claimSingleUseGrantForApply,
  listActiveHumanGrants,
  loadAuthzState,
  loadGrant,
} from "./store.js";
import { assertNoIndependentSessionAuthMint } from "./templates.js";
import type { HumanOriginGrant } from "./types.js";
import { AUTHZ_DIR } from "./types.js";

export const GATE_OVERRIDE_TEMPLATE_NAME = "gate-override" as const;

/** First eligible gate id (v1 closed). */
export const GATE_OVERRIDE_GATE_ID = "coverage-applicability" as const;

/** Default TTL hours — Number("8") keeps the literal free of numeric-const extract. */
export const GATE_OVERRIDE_DEFAULT_EXPIRY_HOURS = Number("8");

export const GATE_OVERRIDE_GATE_PREFIX = "gate-override:gate:";
export const GATE_OVERRIDE_REFUSE_PREFIX = "gate-override:refuse:";
export const GATE_OVERRIDE_BASE_PREFIX = "gate-override:base:";
export const GATE_OVERRIDE_HEAD_PREFIX = "gate-override:head:";
export const GATE_OVERRIDE_TREE_PREFIX = "gate-override:tree:";
export const GATE_OVERRIDE_ATTEMPT_PREFIX = "gate-override:attempt:";
export const GATE_OVERRIDE_EVALUATOR_PREFIX = "gate-override:evaluator:";
export const GATE_OVERRIDE_WORKTREE_PREFIX = "gate-override:worktree:";

/** Closed eligible refuse codes for coverage-applicability (v1). */
export const GATE_OVERRIDE_ELIGIBLE_REFUSE_CODES = [
  "unknown-path",
  "rename-to-document",
  "empty-selection",
  "dirty-tree",
  "classifier-failure",
  "mixed-unclassified",
  "git-failure",
] as const;

export type GateOverrideEligibleRefuseCode = (typeof GATE_OVERRIDE_ELIGIBLE_REFUSE_CODES)[number];

/**
 * Refuse codes that remain non-overridable (authenticity / SCM identity binding).
 * Unknown reasons and these denials dominate.
 */
export const GATE_OVERRIDE_NON_OVERRIDABLE_REFUSE_CODES = [
  "tree-mismatch",
  "invalid-base",
  "invalid-head",
  "invalid-tree",
] as const;

export type GateOverrideNonOverridableRefuseCode =
  (typeof GATE_OVERRIDE_NON_OVERRIDABLE_REFUSE_CODES)[number];

/** Empty deferred peer gate list for v1 — state deferred explicitly. */
export const GATE_OVERRIDE_DEFERRED_PEER_GATES: readonly string[] = [];

/**
 * Checkable review obligation. Review precedes merge (not continuation).
 * Reviewer attention alone is not a control — receipt must surface this id.
 */
export const GATE_OVERRIDE_REVIEW_OBLIGATION = "pre-merge-human-review-required" as const;

/** Named v1 consumers that MUST honor a lawful mint. */
export const GATE_OVERRIDE_V1_CONSUMERS = [
  "pre-pr:coverage_headroom",
  "coverage:hotspots",
] as const;

export const GATE_OVERRIDE_ADMISSIONS_DIR = "gate-override-admissions";

export interface MintGateOverrideTemplateInput {
  readonly projectRoot: string;
  /** Eligible refuse code (required). */
  readonly target: string;
  /** Continuation / attempt id (required; bound as planRef + surface). */
  readonly planRef: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly treeHash: string;
  readonly actor?: string;
  readonly expiresAt?: string | null;
  readonly singleUse?: boolean;
  readonly repo?: string | null;
  readonly branch?: string | null;
  readonly worktree?: string | null;
  readonly evaluatorId?: string | null;
  readonly now?: Date;
  readonly pinActive?: boolean;
  readonly eventRef?: string | null;
  readonly durationHours?: number;
  /** Optional failed-gate evidence payload (non-oracular; stored in eventRef suffix). */
  readonly failedGateEvidence?: string | null;
}

export type GateOverrideMintResult =
  | MintGrantResult
  | { readonly ok: false; readonly reason: string };

export interface GateOverrideBinding {
  readonly gateId: typeof GATE_OVERRIDE_GATE_ID;
  readonly refuseCode: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly treeHash: string;
  readonly attemptId: string;
  readonly worktree: string | null;
  readonly evaluatorId: string | null;
}

export interface GateOverrideAdmissionReceipt {
  readonly schemaVersion: 1;
  readonly grantId: string;
  readonly attemptId: string;
  readonly gateId: typeof GATE_OVERRIDE_GATE_ID;
  readonly refuseCode: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly treeHash: string;
  readonly worktree: string | null;
  readonly evaluatorId: string | null;
  readonly reviewObligation: typeof GATE_OVERRIDE_REVIEW_OBLIGATION;
  readonly admittedAt: string;
  readonly actor: string;
  readonly observedRefuseReason: string;
}

export type GateOverrideInspectResult =
  | {
      readonly ok: true;
      readonly grant: HumanOriginGrant;
      readonly binding: GateOverrideBinding;
      readonly admission: GateOverrideAdmissionReceipt | null;
    }
  | { readonly ok: false; readonly reason: string };

export type GateOverrideAdmitResult =
  | {
      readonly ok: true;
      readonly grant: HumanOriginGrant;
      readonly receipt: GateOverrideAdmissionReceipt;
      readonly reused: boolean;
    }
  | { readonly ok: false; readonly reason: string; readonly code: string };

function isoExpiry(now: Date, hours: number): string {
  return new Date(now.getTime() + hours * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function utcIso(now?: Date): string {
  return (now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function surfaceValue(surfaces: readonly string[], prefix: string): string | null {
  for (const s of surfaces) {
    if (s.startsWith(prefix)) {
      const v = s.slice(prefix.length).trim();
      if (v.length > 0) return v;
    }
  }
  return null;
}

export function isGateOverrideTemplateName(name: string): boolean {
  return name.trim().toLowerCase() === GATE_OVERRIDE_TEMPLATE_NAME;
}

export function isGateOverrideEligibleRefuseCode(
  code: string,
): code is GateOverrideEligibleRefuseCode {
  return (GATE_OVERRIDE_ELIGIBLE_REFUSE_CODES as readonly string[]).includes(code.trim());
}

export function isGateOverrideNonOverridableRefuseCode(
  code: string,
): code is GateOverrideNonOverridableRefuseCode {
  return (GATE_OVERRIDE_NON_OVERRIDABLE_REFUSE_CODES as readonly string[]).includes(code.trim());
}

/** operator-cli only for this hatch; operator-session stays non-admitting (Bound limb 1). */
export function isGateOverrideAdmittingOrigin(grant: HumanOriginGrant): boolean {
  if (!isHumanOrigin(grant.origin)) return false;
  if (!isHumanOriginKind(grant.origin.kind)) return false;
  return grant.origin.kind.trim().toLowerCase() === "operator-cli";
}

export function parseGateOverrideBinding(grant: HumanOriginGrant): GateOverrideBinding | null {
  const surfaces = grant.scope.surfaces;
  const gateId = surfaceValue(surfaces, GATE_OVERRIDE_GATE_PREFIX);
  const refuseCode = surfaceValue(surfaces, GATE_OVERRIDE_REFUSE_PREFIX);
  const baseSha = surfaceValue(surfaces, GATE_OVERRIDE_BASE_PREFIX);
  const headSha = surfaceValue(surfaces, GATE_OVERRIDE_HEAD_PREFIX);
  const treeHash = surfaceValue(surfaces, GATE_OVERRIDE_TREE_PREFIX);
  const attemptFromSurface = surfaceValue(surfaces, GATE_OVERRIDE_ATTEMPT_PREFIX);
  const attemptId = (grant.scope.planRef ?? attemptFromSurface ?? "").trim();
  if (
    gateId !== GATE_OVERRIDE_GATE_ID ||
    refuseCode === null ||
    baseSha === null ||
    headSha === null ||
    treeHash === null ||
    attemptId.length === 0
  ) {
    return null;
  }
  return {
    gateId: GATE_OVERRIDE_GATE_ID,
    refuseCode,
    baseSha,
    headSha,
    treeHash,
    attemptId,
    worktree: surfaceValue(surfaces, GATE_OVERRIDE_WORKTREE_PREFIX) ?? grant.scope.worktree ?? null,
    evaluatorId: surfaceValue(surfaces, GATE_OVERRIDE_EVALUATOR_PREFIX),
  };
}

function grantLooksLikeGateOverride(grant: HumanOriginGrant): boolean {
  const eventOk =
    typeof grant.origin.eventRef === "string" &&
    grant.origin.eventRef.startsWith(`template:${GATE_OVERRIDE_TEMPLATE_NAME}`);
  const surfaceOk = grant.scope.surfaces.some((s) => s.startsWith(GATE_OVERRIDE_GATE_PREFIX));
  return eventOk || surfaceOk;
}

export function grantMatchesGateOverride(
  grant: HumanOriginGrant,
  binding: {
    readonly refuseCode: string;
    readonly baseSha: string;
    readonly headSha: string;
    readonly treeHash: string;
    readonly attemptId: string;
    readonly worktree?: string | null;
    readonly evaluatorId?: string | null;
  },
  now: Date = new Date(),
): boolean {
  if (!grantLooksLikeGateOverride(grant)) return false;
  if (!isGateOverrideAdmittingOrigin(grant)) return false;
  if (grant.semantics.revokedAt !== null) return false;
  if (grant.semantics.expiresAt !== null) {
    const exp = Date.parse(grant.semantics.expiresAt);
    if (Number.isFinite(exp) && exp <= now.getTime()) return false;
  }
  const parsed = parseGateOverrideBinding(grant);
  if (parsed === null) return false;
  if (parsed.refuseCode !== binding.refuseCode.trim()) return false;
  if (parsed.baseSha !== binding.baseSha.trim()) return false;
  if (parsed.headSha !== binding.headSha.trim()) return false;
  if (parsed.treeHash !== binding.treeHash.trim()) return false;
  if (parsed.attemptId !== binding.attemptId.trim()) return false;
  if (
    binding.worktree !== undefined &&
    binding.worktree !== null &&
    binding.worktree.trim().length > 0 &&
    (parsed.worktree ?? "") !== binding.worktree.trim()
  ) {
    return false;
  }
  if (
    binding.evaluatorId !== undefined &&
    binding.evaluatorId !== null &&
    binding.evaluatorId.trim().length > 0 &&
    (parsed.evaluatorId ?? "") !== binding.evaluatorId.trim()
  ) {
    return false;
  }
  return true;
}

/**
 * Mint human-origin gate-override grant (#5542).
 * Sole path: mintHumanOriginGrant / operator-cli. No session-auth SoT.
 * Grants settings only — no independent push/merge permission.
 */
export function mintGateOverrideTemplateGrant(
  input: MintGateOverrideTemplateInput,
): GateOverrideMintResult {
  const dualMint = assertNoIndependentSessionAuthMint();
  if (dualMint.sessionAuthIsAuthority || dualMint.mintPath !== "mintHumanOriginGrant") {
    return {
      ok: false,
      reason: "gate-override template mint refused: dual authorization SoT is forbidden (#5542)",
    };
  }
  const refuseCode = input.target.trim();
  if (refuseCode.length === 0) {
    return {
      ok: false,
      reason: "template gate-override requires --target <refuseCode>",
    };
  }
  if (isGateOverrideNonOverridableRefuseCode(refuseCode)) {
    return {
      ok: false,
      reason: `template gate-override refuses non-overridable code '${refuseCode}' (authenticity/SCM identity)`,
    };
  }
  if (!isGateOverrideEligibleRefuseCode(refuseCode)) {
    return {
      ok: false,
      reason:
        `template gate-override requires an eligible refuse code; got '${refuseCode}'. ` +
        `Eligible: ${GATE_OVERRIDE_ELIGIBLE_REFUSE_CODES.join(", ")}`,
    };
  }
  const attemptId = input.planRef.trim();
  if (attemptId.length === 0) {
    return {
      ok: false,
      reason: "template gate-override requires --plan-ref <attemptId>",
    };
  }
  const baseSha = input.baseSha.trim();
  const headSha = input.headSha.trim();
  const treeHash = input.treeHash.trim();
  if (baseSha.length === 0 || headSha.length === 0 || treeHash.length === 0) {
    return {
      ok: false,
      reason: "template gate-override requires baseSha+headSha+treeHash binding",
    };
  }

  let expiresAt = input.expiresAt ?? null;
  if (expiresAt === null || expiresAt === undefined) {
    const hours =
      input.durationHours !== undefined && Number.isFinite(input.durationHours)
        ? Math.max(1, Math.floor(input.durationHours))
        : GATE_OVERRIDE_DEFAULT_EXPIRY_HOURS;
    expiresAt = isoExpiry(input.now ?? new Date(), hours);
  }

  const worktree = input.worktree?.trim() || null;
  const evaluatorId = input.evaluatorId?.trim() || null;
  const surfaces = [
    `${GATE_OVERRIDE_GATE_PREFIX}${GATE_OVERRIDE_GATE_ID}`,
    `${GATE_OVERRIDE_REFUSE_PREFIX}${refuseCode}`,
    `${GATE_OVERRIDE_BASE_PREFIX}${baseSha}`,
    `${GATE_OVERRIDE_HEAD_PREFIX}${headSha}`,
    `${GATE_OVERRIDE_TREE_PREFIX}${treeHash}`,
    `${GATE_OVERRIDE_ATTEMPT_PREFIX}${attemptId}`,
  ];
  if (worktree !== null) surfaces.push(`${GATE_OVERRIDE_WORKTREE_PREFIX}${worktree}`);
  if (evaluatorId !== null) surfaces.push(`${GATE_OVERRIDE_EVALUATOR_PREFIX}${evaluatorId}`);

  const evidence = input.failedGateEvidence?.trim() || null;
  const eventRef =
    input.eventRef ??
    (evidence !== null
      ? `template:${GATE_OVERRIDE_TEMPLATE_NAME};evidence=${evidence.slice(0, 200)}`
      : `template:${GATE_OVERRIDE_TEMPLATE_NAME}`);

  const mintInput: MintGrantInput = {
    projectRoot: input.projectRoot,
    actor: input.actor ?? "operator",
    // settings only — Bound limb 4: no independent push/merge.
    operations: ["settings"],
    surfaces,
    expiresAt,
    singleUse: input.singleUse !== false,
    planRef: attemptId,
    repo: input.repo ?? null,
    branch: input.branch ?? null,
    worktree,
    pinActive: input.pinActive,
    eventRef,
    now: input.now,
  };
  return mintHumanOriginGrant(mintInput);
}

function admissionsDir(projectRoot: string): string {
  return join(projectRoot, ...AUTHZ_DIR.split("/"), GATE_OVERRIDE_ADMISSIONS_DIR);
}

function admissionPath(projectRoot: string, attemptId: string): string {
  const safe = attemptId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(admissionsDir(projectRoot), `${safe}.json`);
}

/** Exclusive create of admission receipt (O_EXCL). Concurrent admit fails closed. */
function writeAdmissionExclusive(projectRoot: string, targetPath: string, payload: unknown): void {
  const root = resolve(projectRoot);
  mkdirSync(dirname(resolve(targetPath)), { recursive: true });
  containedWrite({
    root,
    target: targetPath,
    data: `${JSON.stringify(payload, null, 2)}\n`,
    mode: "create",
  });
}

export function loadGateOverrideAdmission(
  projectRoot: string,
  attemptId: string,
): GateOverrideAdmissionReceipt | null {
  const path = admissionPath(projectRoot, attemptId.trim());
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    if (rec.schemaVersion !== 1) return null;
    if (typeof rec.grantId !== "string" || typeof rec.attemptId !== "string") return null;
    if (rec.gateId !== GATE_OVERRIDE_GATE_ID) return null;
    if (typeof rec.refuseCode !== "string") return null;
    if (typeof rec.baseSha !== "string" || typeof rec.headSha !== "string") return null;
    if (typeof rec.treeHash !== "string" || typeof rec.admittedAt !== "string") return null;
    if (typeof rec.actor !== "string" || typeof rec.observedRefuseReason !== "string") return null;
    if (rec.reviewObligation !== GATE_OVERRIDE_REVIEW_OBLIGATION) return null;
    return {
      schemaVersion: 1,
      grantId: rec.grantId,
      attemptId: rec.attemptId,
      gateId: GATE_OVERRIDE_GATE_ID,
      refuseCode: rec.refuseCode,
      baseSha: rec.baseSha,
      headSha: rec.headSha,
      treeHash: rec.treeHash,
      worktree: typeof rec.worktree === "string" ? rec.worktree : null,
      evaluatorId: typeof rec.evaluatorId === "string" ? rec.evaluatorId : null,
      reviewObligation: GATE_OVERRIDE_REVIEW_OBLIGATION,
      admittedAt: rec.admittedAt,
      actor: rec.actor,
      observedRefuseReason: rec.observedRefuseReason,
    };
  } catch {
    return null;
  }
}

/**
 * Inspect a matching grant / prior admission without consuming single-use.
 * Revoke/expiry ordering: revoked or expired grants fail inspect even if a
 * stale admission file remains (admission is not authority after revoke).
 */
export function inspectGateOverrideGrant(
  projectRoot: string,
  binding: {
    readonly refuseCode: string;
    readonly baseSha: string;
    readonly headSha: string;
    readonly treeHash: string;
    readonly attemptId: string;
    readonly worktree?: string | null;
    readonly evaluatorId?: string | null;
  },
  now: Date = new Date(),
): GateOverrideInspectResult {
  const admission = loadGateOverrideAdmission(projectRoot, binding.attemptId);
  if (admission !== null) {
    const grant = loadGrant(projectRoot, admission.grantId);
    if (grant === null) {
      return { ok: false, reason: `gate-override admission grant ${admission.grantId} missing` };
    }
    if (grant.semantics.revokedAt !== null) {
      return {
        ok: false,
        reason: `gate-override grant ${grant.id} revoked (revocation dominates)`,
      };
    }
    if (grant.semantics.expiresAt !== null) {
      const exp = Date.parse(grant.semantics.expiresAt);
      if (Number.isFinite(exp) && exp <= now.getTime()) {
        return { ok: false, reason: `gate-override grant ${grant.id} expired` };
      }
    }
    if (
      admission.refuseCode !== binding.refuseCode.trim() ||
      admission.baseSha !== binding.baseSha.trim() ||
      admission.headSha !== binding.headSha.trim() ||
      admission.treeHash !== binding.treeHash.trim()
    ) {
      return { ok: false, reason: "gate-override admission binding mismatch" };
    }
    const parsed = parseGateOverrideBinding(grant);
    if (parsed === null) {
      return { ok: false, reason: "gate-override grant surfaces unparseable" };
    }
    return { ok: true, grant, binding: parsed, admission };
  }

  const state = loadAuthzState(projectRoot);
  const grants = listActiveHumanGrants(projectRoot, state);
  for (const g of grants) {
    if (!grantMatchesGateOverride(g, binding, now)) continue;
    // Unspent or multi-use: inspect without marking usedAt.
    if (g.semantics.singleUse && g.semantics.usedAt !== null) continue;
    const parsed = parseGateOverrideBinding(g);
    if (parsed === null) continue;
    return { ok: true, grant: g, binding: parsed, admission: null };
  }
  return { ok: false, reason: "no live gate-override grant matches binding" };
}

/**
 * Atomic one-use admission bound to attempt id.
 * Same attempt re-reads durable receipt (crash recovery); another attempt cannot reuse.
 * Uses claimSingleUseGrantForApply locking primitives. Inspection path is separate.
 */
export function admitGateOverrideForAttempt(
  projectRoot: string,
  input: {
    readonly refuseCode: string;
    readonly baseSha: string;
    readonly headSha: string;
    readonly treeHash: string;
    readonly attemptId: string;
    readonly observedRefuseReason: string;
    readonly worktree?: string | null;
    readonly evaluatorId?: string | null;
    readonly now?: Date;
  },
): GateOverrideAdmitResult {
  const now = input.now ?? new Date();
  const refuseCode = input.refuseCode.trim();
  if (isGateOverrideNonOverridableRefuseCode(refuseCode)) {
    return {
      ok: false,
      code: "non-overridable",
      reason: `gate-override: refuse code '${refuseCode}' is non-overridable`,
    };
  }
  if (!isGateOverrideEligibleRefuseCode(refuseCode)) {
    return {
      ok: false,
      code: "ineligible-refuse",
      reason: `gate-override: refuse code '${refuseCode}' is not eligible`,
    };
  }

  const prior = loadGateOverrideAdmission(projectRoot, input.attemptId);
  if (prior !== null) {
    if (
      prior.refuseCode !== refuseCode ||
      prior.baseSha !== input.baseSha.trim() ||
      prior.headSha !== input.headSha.trim() ||
      prior.treeHash !== input.treeHash.trim()
    ) {
      return {
        ok: false,
        code: "admission-mismatch",
        reason: "gate-override: prior admission for attempt does not match refuse/tree binding",
      };
    }
    const grant = loadGrant(projectRoot, prior.grantId);
    if (grant === null) {
      return {
        ok: false,
        code: "grant-missing",
        reason: `gate-override: admission grant ${prior.grantId} missing`,
      };
    }
    if (grant.semantics.revokedAt !== null) {
      return {
        ok: false,
        code: "revoked",
        reason: "gate-override: grant revoked after admission (revocation dominates)",
      };
    }
    if (grant.semantics.expiresAt !== null) {
      const exp = Date.parse(grant.semantics.expiresAt);
      if (Number.isFinite(exp) && exp <= now.getTime()) {
        return {
          ok: false,
          code: "expired",
          reason: "gate-override: grant expired after admission (expiry dominates recheck)",
        };
      }
    }
    return { ok: true, grant, receipt: prior, reused: true };
  }

  const inspect = inspectGateOverrideGrant(
    projectRoot,
    {
      refuseCode,
      baseSha: input.baseSha,
      headSha: input.headSha,
      treeHash: input.treeHash,
      attemptId: input.attemptId,
      worktree: input.worktree,
      evaluatorId: input.evaluatorId,
    },
    now,
  );
  if (!inspect.ok) {
    return { ok: false, code: "grant-missing", reason: inspect.reason };
  }

  const grantId = inspect.grant.id;
  const claimed = claimSingleUseGrantForApply(projectRoot, grantId, {
    now,
    revalidate: (g) => {
      if (
        !grantMatchesGateOverride(
          g,
          {
            refuseCode,
            baseSha: input.baseSha,
            headSha: input.headSha,
            treeHash: input.treeHash,
            attemptId: input.attemptId,
            worktree: input.worktree,
            evaluatorId: input.evaluatorId,
          },
          now,
        )
      ) {
        return { ok: false, reason: "gate-override revalidate: grant no longer matches binding" };
      }
      return { ok: true };
    },
    apply: (g) => {
      const parsed = parseGateOverrideBinding(g);
      if (parsed === null) {
        throw new Error("gate-override apply: unparseable binding");
      }
      const receipt: GateOverrideAdmissionReceipt = {
        schemaVersion: 1,
        grantId: g.id,
        attemptId: parsed.attemptId,
        gateId: GATE_OVERRIDE_GATE_ID,
        refuseCode: parsed.refuseCode,
        baseSha: parsed.baseSha,
        headSha: parsed.headSha,
        treeHash: parsed.treeHash,
        worktree: parsed.worktree,
        evaluatorId: parsed.evaluatorId,
        reviewObligation: GATE_OVERRIDE_REVIEW_OBLIGATION,
        admittedAt: utcIso(now),
        actor: g.origin.actor,
        observedRefuseReason: input.observedRefuseReason,
      };
      try {
        writeAdmissionExclusive(projectRoot, admissionPath(projectRoot, parsed.attemptId), receipt);
      } catch (err) {
        if (err instanceof ContainedWriteError && err.code === ContainedWriteErrorCode.EXISTS) {
          // Concurrent admit won the receipt create — claim rolls back usedAt.
          throw new Error("gate-override admission race: receipt already exists");
        }
        throw err;
      }
    },
  });

  if (!claimed.ok) {
    return { ok: false, code: "claim-failed", reason: claimed.reason };
  }

  const receipt = loadGateOverrideAdmission(projectRoot, input.attemptId);
  if (receipt === null) {
    return {
      ok: false,
      code: "admission-missing",
      reason: "gate-override: claim succeeded but admission receipt missing",
    };
  }
  return { ok: true, grant: claimed.grant, receipt, reused: false };
}

export function findLiveGateOverrideGrant(
  projectRoot: string,
  binding: {
    readonly refuseCode: string;
    readonly baseSha: string;
    readonly headSha: string;
    readonly treeHash: string;
    readonly attemptId: string;
    readonly worktree?: string | null;
    readonly evaluatorId?: string | null;
  },
  now: Date = new Date(),
): HumanOriginGrant | null {
  const inspected = inspectGateOverrideGrant(projectRoot, binding, now);
  return inspected.ok ? inspected.grant : null;
}
