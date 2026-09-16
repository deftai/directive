/**
 * Bank / same-session cache reuse for verify:ac and scope:complete (#3387).
 *
 * Green bank + matching product-state hash -> accept without re-execution.
 * Missing, stale, or mismatched hash -> full walk. Empty/failing still refuse.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { type AcPassBankRecord, bankHasRunsSnapshot, readAcPassBank } from "./ac-pass-banking.js";
import { type HashProductStateInput, hashProductState } from "./product-state-hash.js";
import {
  type CachedVerifyAcSnapshot,
  readVerifyAcSessionCache,
  resolveVerifyAcSessionId,
  type VerifyAcSessionCacheRecord,
} from "./verify-ac-session-cache.js";

export type { AcServedFrom } from "./verify-ac-session-cache.js";

export type AcReuseDecision =
  | {
      readonly kind: "cache";
      readonly servedFrom: "cache";
      readonly hash: string;
      readonly cache: VerifyAcSessionCacheRecord;
    }
  | {
      readonly kind: "bank";
      readonly servedFrom: "bank";
      readonly hash: string;
      readonly bank: AcPassBankRecord;
    }
  | {
      readonly kind: "miss";
      readonly servedFrom: "executed";
      readonly hash: string | null;
      readonly reason: string;
    };

export interface ResolveAcReuseInput extends HashProductStateInput {
  readonly scopeId?: string | null;
  readonly sessionId?: string | null;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Default true. Complete walk uses bank; check uses cache then bank. */
  readonly allowCache?: boolean;
  readonly allowBank?: boolean;
  /** Collision-aware oracle key already computed by FromPath (#3337 / #4631). */
  readonly oracleScopeKey?: string | null;
  /** xBRIEF path for FromPath synthesis when oracleScopeKey is absent. */
  readonly xbriefPath?: string | null;
}

/** How resolveScopeIdForAcReuse chose the bank key (#4631 sidecar). */
export type AcScopeIdSource = "explicit" | "plan.id" | "oracle" | "none";

export interface AcScopeIdContext {
  readonly oracleScopeKey?: string | null;
  readonly xbriefPath?: string | null;
  readonly projectRoot?: string | null;
}

export interface AcScopeIdResolution {
  readonly scopeId: string | null;
  readonly source: AcScopeIdSource;
}

function isUsableBank(bank: AcPassBankRecord): boolean {
  if (bank.bankedAt === "1970-01-01T00:00:00Z") return false;
  const hash = bank.productStateHash;
  return typeof hash === "string" && hash.length > 0;
}

/**
 * Rel-path half of resolveOracleScopeKey (#3337). plan.id is handled first so
 * existing banks keyed by plan.id stay hittable; synthesis is path-only.
 * Keep `..` and other-volume absolute paths; collapsing those to basename
 * lets distinct outside-root briefs share a bank key (#4631 Greptile P1).
 */
export function collisionAwareOracleRelPath(xbriefPath: string, projectRoot: string): string {
  const abs = resolve(xbriefPath);
  const root = resolve(projectRoot);
  const rel = relative(root, abs).replace(/\\/g, "/");
  if (rel.length === 0 || isAbsolute(rel)) {
    return abs.replace(/\\/g, "/");
  }
  return rel;
}

function synthesizeOracleScopeId(context?: AcScopeIdContext | null): string | null {
  const oracle = context?.oracleScopeKey?.trim() ?? "";
  if (oracle.length > 0) return oracle;
  const xbriefPath = context?.xbriefPath?.trim() ?? "";
  if (xbriefPath.length === 0) return null;
  const projectRoot = context?.projectRoot?.trim() ?? "";
  if (projectRoot.length > 0) {
    const rel = collisionAwareOracleRelPath(xbriefPath, projectRoot);
    return rel.length > 0 ? rel : null;
  }
  const normalized = xbriefPath.replace(/\\/g, "/");
  if (isAbsolute(xbriefPath) || isAbsolute(normalized)) return null;
  return normalized;
}

/**
 * Sidecar for which key path ran (#4631). Key choice stays resolveScopeIdForAcReuse.
 */
export function resolveScopeIdForAcReuseDetailed(
  plan: Record<string, unknown>,
  explicit?: string | null,
  context?: AcScopeIdContext | null,
): AcScopeIdResolution {
  const injected = explicit?.trim() ?? "";
  if (injected.length > 0) {
    return { scopeId: injected, source: "explicit" };
  }
  if (typeof plan.id === "string" && plan.id.trim().length > 0) {
    return { scopeId: plan.id.trim(), source: "plan.id" };
  }
  const synthesized = synthesizeOracleScopeId(context);
  if (synthesized !== null) {
    return { scopeId: synthesized, source: "oracle" };
  }
  return { scopeId: null, source: "none" };
}

/**
 * One bank keyer for write and lookup (#4631). Explicit, then plan.id, else
 * collision-aware oracle path. Does not mint a fourth keyer or extend basename stem.
 */
export function resolveScopeIdForAcReuse(
  plan: Record<string, unknown>,
  explicit?: string | null,
  context?: AcScopeIdContext | null,
): string | null {
  return resolveScopeIdForAcReuseDetailed(plan, explicit, context).scopeId;
}

/**
 * Decide whether a green bank or same-session cache can replace execution.
 */
export function resolveAcReuse(input: ResolveAcReuseInput): AcReuseDecision {
  const allowCache = input.allowCache !== false;
  const allowBank = input.allowBank !== false;
  const scopeId = resolveScopeIdForAcReuse(input.plan, input.scopeId, {
    oracleScopeKey: input.oracleScopeKey,
    xbriefPath: input.xbriefPath,
    projectRoot: input.projectRoot,
  });
  if (scopeId === null) {
    return { kind: "miss", servedFrom: "executed", hash: null, reason: "no scope id" };
  }

  const hashed = hashProductState(input);
  if (!hashed.complete) {
    return {
      kind: "miss",
      servedFrom: "executed",
      hash: hashed.digest,
      reason: "incomplete product-state hash",
    };
  }

  const sessionId = resolveVerifyAcSessionId(input.env, input.sessionId);
  if (allowCache && sessionId !== null) {
    const cache = readVerifyAcSessionCache(input.projectRoot, sessionId, scopeId);
    if (cache !== null && cache.productStateHash === hashed.digest) {
      return { kind: "cache", servedFrom: "cache", hash: hashed.digest, cache };
    }
  }

  if (allowBank) {
    const bank = readAcPassBank(input.projectRoot, scopeId);
    if (bank !== null && isUsableBank(bank) && bank.productStateHash === hashed.digest) {
      if (!bankHasRunsSnapshot(bank)) {
        return {
          kind: "miss",
          servedFrom: "executed",
          hash: hashed.digest,
          reason: "v1 bank missing runs snapshot",
        };
      }
      return { kind: "bank", servedFrom: "bank", hash: hashed.digest, bank };
    }
    if (bank !== null && !isUsableBank(bank)) {
      return {
        kind: "miss",
        servedFrom: "executed",
        hash: hashed.digest,
        reason: "stale or incomplete bank",
      };
    }
    if (bank !== null && bank.productStateHash !== hashed.digest) {
      return {
        kind: "miss",
        servedFrom: "executed",
        hash: hashed.digest,
        reason: "product-state hash mismatch",
      };
    }
  }

  return {
    kind: "miss",
    servedFrom: "executed",
    hash: hashed.digest,
    reason: "no reusable result",
  };
}

export function snapshotFromReuseFields(input: {
  readonly ok: boolean;
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly commands: readonly unknown[];
  readonly runs: readonly unknown[];
  readonly rejected?: readonly unknown[];
  readonly sourceRung: string;
  readonly noneStated: boolean;
  readonly acceptance: unknown;
  readonly resolution: string;
  readonly resolvedCommandCount: number;
}): CachedVerifyAcSnapshot {
  return {
    ok: input.ok,
    code: input.code,
    message: input.message,
    commands: input.commands,
    runs: input.runs,
    rejected: input.rejected,
    sourceRung: input.sourceRung,
    noneStated: input.noneStated,
    acceptance: input.acceptance,
    resolution: input.resolution,
    resolvedCommandCount: input.resolvedCommandCount,
  };
}
