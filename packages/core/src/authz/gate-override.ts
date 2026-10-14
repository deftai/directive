/**
 * Audited interactive human gate-override hatch (#5542 Prefer-A Bound).
 *
 * Sole mint path: mintHumanOriginGrant / operator-cli via authz:grant --template.
 * operator-session is non-admitting in v1. Inspection does not consume.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  ContainedWriteError,
  ContainedWriteErrorCode,
  containedRemove,
  containedWrite,
} from "../fs/contained-write.js";
import { assertWriteTargetSafe } from "../fs/projection-containment.js";
import { type MintGrantInput, type MintGrantResult, mintHumanOriginGrant } from "./actions.js";
import { isHumanOrigin, isHumanOriginKind } from "./origin.js";
import {
  claimSingleUseGrantForApply,
  type GrantClaimLockRecord,
  isGrantClaimLockReclaimable,
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
  // Grant-set worktree/evaluator limits always bind — omitting them on the
  // caller must not drop the limit (#5542 Greptile P1).
  if (parsed.worktree !== null && parsed.worktree.length > 0) {
    if ((binding.worktree ?? "").trim() !== parsed.worktree) return false;
  } else if (
    binding.worktree !== undefined &&
    binding.worktree !== null &&
    binding.worktree.trim().length > 0
  ) {
    return false;
  }
  if (parsed.evaluatorId !== null && parsed.evaluatorId.length > 0) {
    if ((binding.evaluatorId ?? "").trim() !== parsed.evaluatorId) return false;
  } else if (
    binding.evaluatorId !== undefined &&
    binding.evaluatorId !== null &&
    binding.evaluatorId.trim().length > 0
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
    // Template is single-use; CLI default false must not override (#5542).
    singleUse: true,
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
  // Hash the attempt id so a/b and a_b cannot collide on disk (#5542 Greptile P1).
  const safe = createHash("sha256").update(attemptId, "utf8").digest("hex");
  return join(admissionsDir(projectRoot), `${safe}.json`);
}

function admissionAttemptLockPath(projectRoot: string, attemptId: string): string {
  const safe = createHash("sha256").update(attemptId, "utf8").digest("hex");
  return join(resolve(projectRoot), ".deft", "authz", "locks", `gate-override-admit-${safe}.lock`);
}

function readAdmissionAttemptLockRecord(lockPath: string): GrantClaimLockRecord | null {
  try {
    const raw = readFileSync(lockPath, "utf8").trim();
    if (!raw.startsWith("{")) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    const pid = typeof o.pid === "number" ? o.pid : Number(o.pid);
    const startedAt = typeof o.startedAt === "string" ? o.startedAt : "";
    const token = typeof o.token === "string" ? o.token : "";
    if (!Number.isFinite(pid) || token.length === 0) return null;
    return { pid, startedAt, token };
  } catch {
    return null;
  }
}

/**
 * Rename-away reclaim for crashed attempt-lock holders (same shape as grant claim locks).
 * Unreadable/empty/partial records are NOT reclaimable — they may be an in-flight
 * exclusive create still publishing the owner body (#5542 Greptile P1).
 */
function tryReclaimDeadAdmissionAttemptLock(lockPath: string): boolean {
  const existing = readAdmissionAttemptLockRecord(lockPath);
  if (existing === null) return false;
  if (!isGrantClaimLockReclaimable(existing)) return false;
  const expectedPid = existing.pid;
  const expectedToken = existing.token;
  const side = `${lockPath}.reclaim.${randomBytes(6).toString("hex")}`;
  try {
    renameSync(lockPath, side);
  } catch {
    return false;
  }
  const got = readAdmissionAttemptLockRecord(side);
  const sameDead = got !== null && got.pid === expectedPid && got.token === expectedToken;
  if (!sameDead) {
    try {
      renameSync(side, lockPath);
    } catch {
      /* best-effort restore of live replacement */
    }
    return false;
  }
  try {
    rmSync(side, { force: true });
  } catch {
    /* best-effort side cleanup */
  }
  return true;
}

/**
 * Publish complete bytes at target with exclusive create semantics.
 * Temp+link (or Windows rename) so readers never observe an empty final path
 * mid-write (#5542 Greptile P1 live-lock / interrupted-admission).
 */
function writeExclusiveComplete(
  projectRoot: string,
  targetPath: string,
  data: string,
): void {
  const root = resolve(projectRoot);
  const abs = resolve(targetPath);
  assertWriteTargetSafe(root, abs);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = join(
    dirname(abs),
    `.${basename(abs)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    containedWrite({ root, target: tmp, data, mode: "create" });
    try {
      linkSync(tmp, abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        throw new ContainedWriteError(
          `contained write refused: target ${abs} already exists (mode=create)`,
          {
            code: ContainedWriteErrorCode.EXISTS,
            root,
            target: abs,
            offendingPath: abs,
          },
        );
      }
      // link may be unsupported; rename is exclusive on win32 when dest exists.
      try {
        renameSync(tmp, abs);
      } catch (renameErr) {
        const rcode = (renameErr as NodeJS.ErrnoException).code;
        if (rcode === "EEXIST" || rcode === "EPERM") {
          throw new ContainedWriteError(
            `contained write refused: target ${abs} already exists (mode=create)`,
            {
              code: ContainedWriteErrorCode.EXISTS,
              root,
              target: abs,
              offendingPath: abs,
            },
          );
        }
        throw renameErr;
      }
    }
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort temp cleanup */
    }
    throw err;
  }
  try {
    rmSync(tmp, { force: true });
  } catch {
    /* best-effort: rename already moved tmp; link leaves a second name */
  }
}

/**
 * Serialize admit/renew for one attempt id so concurrent renewers cannot delete
 * each other's replacement receipt (#5542 Greptile P1). Dead-owner locks reclaim
 * via rename-away (same recovery as claimSingleUseGrantForApply).
 */
function withAdmissionAttemptLock<T>(
  projectRoot: string,
  attemptId: string,
  fn: () => T,
): { ok: true; value: T } | { ok: false; reason: string } {
  const lockPath = admissionAttemptLockPath(projectRoot, attemptId);
  const lockToken = randomBytes(8).toString("hex");
  const lockBody = `${JSON.stringify({
    pid: process.pid,
    startedAt: utcIso(),
    token: lockToken,
  } satisfies GrantClaimLockRecord)}\n`;

  const tryCreate = (): boolean => {
    try {
      // Atomic exclusive publish — no empty final path for reclaim to steal.
      writeExclusiveComplete(projectRoot, lockPath, lockBody);
      return true;
    } catch (err) {
      if (err instanceof ContainedWriteError && err.code === ContainedWriteErrorCode.EXISTS) {
        return false;
      }
      throw err;
    }
  };

  let locked = false;
  try {
    locked = tryCreate();
    if (!locked && tryReclaimDeadAdmissionAttemptLock(lockPath)) {
      locked = tryCreate();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `gate-override: admission lock failed: ${msg}` };
  }
  if (!locked) {
    return {
      ok: false,
      reason: "gate-override: admission for attempt is reserved by a concurrent admit/renew; retry",
    };
  }
  try {
    return { ok: true, value: fn() };
  } finally {
    try {
      const rec = readAdmissionAttemptLockRecord(lockPath);
      if (rec !== null && rec.pid === process.pid && rec.token === lockToken) {
        rmSync(lockPath, { force: true });
      }
    } catch {
      // Lock release best-effort; leftover dead locks reclaim on next admit.
    }
  }
}

function isLiveAdmissionGrant(
  grant: HumanOriginGrant | null,
  binding: {
    readonly refuseCode: string;
    readonly baseSha: string;
    readonly headSha: string;
    readonly treeHash: string;
    readonly attemptId: string;
    readonly worktree?: string | null;
    readonly evaluatorId?: string | null;
  },
  now: Date,
): grant is HumanOriginGrant {
  if (grant === null) return false;
  return grantMatchesGateOverride(grant, binding, now);
}

/** Exclusive create of admission receipt. Concurrent admit fails closed. */
function writeAdmissionExclusive(projectRoot: string, targetPath: string, payload: unknown): void {
  writeExclusiveComplete(
    projectRoot,
    targetPath,
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

/** True when a receipt path exists but does not parse as a live admission. */
function isIncompleteAdmissionReceipt(projectRoot: string, attemptId: string): boolean {
  const path = admissionPath(projectRoot, attemptId.trim());
  if (!existsSync(path)) return false;
  return loadGateOverrideAdmission(projectRoot, attemptId) === null;
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
    if (admission.attemptId !== binding.attemptId.trim()) {
      return {
        ok: false,
        reason: "gate-override admission attempt id does not match requested attempt",
      };
    }
    const grant = loadGrant(projectRoot, admission.grantId);
    const admissionGrantLive =
      grant !== null &&
      grant.semantics.revokedAt === null &&
      (grant.semantics.expiresAt === null ||
        !Number.isFinite(Date.parse(grant.semantics.expiresAt)) ||
        Date.parse(grant.semantics.expiresAt) > now.getTime());
    // Stale admission (missing/revoked/expired grant): fall through so a renewed
    // matching grant can be discovered (#5542 Greptile P1).
    if (admissionGrantLive) {
      if (
        admission.refuseCode !== binding.refuseCode.trim() ||
        admission.baseSha !== binding.baseSha.trim() ||
        admission.headSha !== binding.headSha.trim() ||
        admission.treeHash !== binding.treeHash.trim()
      ) {
        return { ok: false, reason: "gate-override admission binding mismatch" };
      }
      // Re-enforce grant worktree/evaluator limits on inspect-of-receipt (#5542).
      if (!grantMatchesGateOverride(grant, binding, now)) {
        return {
          ok: false,
          reason: "gate-override admission no longer matches grant worktree/evaluator limits",
        };
      }
      const parsed = parseGateOverrideBinding(grant);
      if (parsed === null) {
        return { ok: false, reason: "gate-override grant surfaces unparseable" };
      }
      return { ok: true, grant, binding: parsed, admission };
    }
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

  const binding = {
    refuseCode,
    baseSha: input.baseSha,
    headSha: input.headSha,
    treeHash: input.treeHash,
    attemptId: input.attemptId,
    worktree: input.worktree,
    evaluatorId: input.evaluatorId,
  };

  // Hold an attempt-id lock across reuse / stale-replace / claim so concurrent
  // renewers re-read before deleting and cannot erase a winner's receipt (#5542).
  const locked = withAdmissionAttemptLock(projectRoot, input.attemptId, () => {
    let stalePriorFail: GateOverrideAdmitResult | null = null;
    let staleGrantId: string | null = null;
    // Clear empty/partial leftovers under the attempt lock so retries are not
    // permanently blocked by an interrupted exclusive create (#5542 Greptile P1).
    if (isIncompleteAdmissionReceipt(projectRoot, input.attemptId)) {
      containedRemove({
        root: resolve(projectRoot),
        target: admissionPath(projectRoot, input.attemptId),
      });
    }
    const prior = loadGateOverrideAdmission(projectRoot, input.attemptId);
    if (prior !== null) {
      if (prior.attemptId !== input.attemptId.trim()) {
        return {
          ok: false as const,
          code: "admission-mismatch" as const,
          reason: "gate-override: prior admission attempt id does not match requested attempt",
        };
      }
      if (
        prior.refuseCode !== refuseCode ||
        prior.baseSha !== input.baseSha.trim() ||
        prior.headSha !== input.headSha.trim() ||
        prior.treeHash !== input.treeHash.trim()
      ) {
        return {
          ok: false as const,
          code: "admission-mismatch" as const,
          reason: "gate-override: prior admission for attempt does not match refuse/tree binding",
        };
      }
      const grant = loadGrant(projectRoot, prior.grantId);
      if (grant === null) {
        stalePriorFail = {
          ok: false,
          code: "grant-missing",
          reason: `gate-override: admission grant ${prior.grantId} missing`,
        };
        staleGrantId = prior.grantId;
      } else if (grant.semantics.revokedAt !== null) {
        stalePriorFail = {
          ok: false,
          code: "revoked",
          reason: "gate-override: grant revoked after admission (revocation dominates)",
        };
        staleGrantId = prior.grantId;
      } else if (grant.semantics.expiresAt !== null) {
        const exp = Date.parse(grant.semantics.expiresAt);
        if (Number.isFinite(exp) && exp <= now.getTime()) {
          stalePriorFail = {
            ok: false,
            code: "expired",
            reason: "gate-override: grant expired after admission (expiry dominates recheck)",
          };
          staleGrantId = prior.grantId;
        }
      }
      // Live prior: reuse under the same lock.
      if (stalePriorFail === null) {
        if (!isLiveAdmissionGrant(grant, binding, now)) {
          return {
            ok: false as const,
            code: "admission-mismatch" as const,
            reason:
              "gate-override: prior admission no longer matches grant worktree/evaluator limits",
          };
        }
        return { ok: true as const, grant, receipt: prior, reused: true as const };
      }
    }

    const inspect = inspectGateOverrideGrant(projectRoot, binding, now);
    if (!inspect.ok) {
      if (stalePriorFail !== null) return stalePriorFail;
      return { ok: false as const, code: "grant-missing" as const, reason: inspect.reason };
    }

    // Under lock: re-read then drop only the still-stale receipt before claim.
    if (stalePriorFail !== null && staleGrantId !== null) {
      const current = loadGateOverrideAdmission(projectRoot, input.attemptId);
      if (current !== null) {
        const currentGrant = loadGrant(projectRoot, current.grantId);
        if (isLiveAdmissionGrant(currentGrant, binding, now)) {
          return {
            ok: true as const,
            grant: currentGrant,
            receipt: current,
            reused: true as const,
          };
        }
        if (current.grantId === staleGrantId) {
          containedRemove({
            root: resolve(projectRoot),
            target: admissionPath(projectRoot, input.attemptId),
          });
        }
      }
    }

    const grantId = inspect.grant.id;
    const claimed = claimSingleUseGrantForApply(projectRoot, grantId, {
      now,
      revalidate: (g) => {
        if (!grantMatchesGateOverride(g, binding, now)) {
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
          writeAdmissionExclusive(
            projectRoot,
            admissionPath(projectRoot, parsed.attemptId),
            receipt,
          );
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
      return { ok: false as const, code: "claim-failed" as const, reason: claimed.reason };
    }

    const receipt = loadGateOverrideAdmission(projectRoot, input.attemptId);
    if (receipt === null) {
      return {
        ok: false as const,
        code: "admission-missing" as const,
        reason: "gate-override: claim succeeded but admission receipt missing",
      };
    }
    return { ok: true as const, grant: claimed.grant, receipt, reused: false as const };
  });

  if (!locked.ok) {
    return { ok: false, code: "claim-failed", reason: locked.reason };
  }
  return locked.value;
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
