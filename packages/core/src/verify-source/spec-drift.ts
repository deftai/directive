/**
 * Semantic spec-vs-reality drift audit (#1589 Prefer-A Bound C2 / #5350 C3).
 *
 * Three-state: 0 clean / 1 drift / 2 unassessable|config.
 * Distinct from fail-closed verify:spec-prd-fresh (banner/projection freshness).
 * Enforcement ladder: advise (soft) → shadow (warn) → enforce (hard).
 * Discharge under shadow/enforce requires per-item coverage + rewrite proof
 * on durable SPECIFICATION (or a live spec-drift-override mint).
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { listActiveHumanGrants, loadAuthzState, markGrantUsed } from "../authz/store.js";
import type { HumanOriginGrant } from "../authz/types.js";
import { containedWrite } from "../fs/contained-write.js";
import {
  resolveAuditPath,
  resolveLifecycleRoot,
  resolveSpecArtifactPath,
} from "../layout/resolve.js";
import {
  readSpecImpact,
  resolveSpecGuard,
  SPEC_IMPACT_KEY,
  type SpecGuardEnforcement,
  type SpecGuardResolved,
} from "../policy/spec-guard.js";

export const SPEC_DRIFT_LEDGER_NAME = "spec-drift-ledger.json";
export const SPEC_DRIFT_LEDGER_LOCK_NAME = ".spec-drift-ledger.pair.lock.tmp";
export const SPEC_DRIFT_OVERRIDE_TEMPLATE = "spec-drift-override";
export const SPEC_DRIFT_OVERRIDE_BASELINE_PREFIX = "spec-drift-override:baseline:";
export const SPEC_DRIFT_OVERRIDE_SCOPE_PREFIX = "spec-drift-override:scope:";
export const SPEC_DRIFT_OVERRIDE_ITEM_PREFIX = "spec-drift-override:item:";

function ledgerAbsPath(projectRoot: string): string {
  return resolveAuditPath(projectRoot, SPEC_DRIFT_LEDGER_NAME);
}

function ledgerLockAbsPath(projectRoot: string): string {
  return resolveAuditPath(projectRoot, SPEC_DRIFT_LEDGER_LOCK_NAME);
}

function hasLedgerFile(projectRoot: string): boolean {
  return existsSync(ledgerAbsPath(projectRoot));
}

export interface SpecDriftFinding {
  readonly scopeId: string;
  readonly reason: string;
  readonly specImpact: string | null;
  readonly completedAt: string | null;
  /** Present under shadow/enforce when specific items lack coverage. */
  readonly uncoveredItemIds?: readonly string[];
}

export interface SpecDriftCoverageRecord {
  readonly scopeId: string;
  readonly coveredItemIds: readonly string[];
  readonly beforeRequirementsFingerprint: string;
  readonly afterRequirementsFingerprint: string;
  readonly affectedRequirementRefs: readonly string[];
  readonly recordedAt: string;
  readonly source: "rewrite" | "override" | "cutover";
  readonly grantId?: string;
}

export interface SpecDriftLedger {
  readonly baselineRevision: string | null;
  readonly unresolved: SpecDriftFinding[];
  readonly coverage: SpecDriftCoverageRecord[];
  readonly shadowFindings: SpecDriftFinding[];
  /** Fingerprint of last known requirements-only durable SPEC projection. */
  readonly lastRequirementsFingerprint: string | null;
  /** Cutover/grandfather boundary — empty advise ledger is not proven under enforce. */
  readonly cutoverBoundary: string | null;
}

export interface SpecDriftResult {
  readonly code: 0 | 1 | 2;
  readonly state: "clean" | "drift" | "unassessable";
  readonly message: string;
  readonly findings: readonly SpecDriftFinding[];
  readonly baselineRevision: string | null;
  readonly guard: SpecGuardResolved;
  /** Shadow-mode warnings (never alone cause CI fail). */
  readonly shadowFindings?: readonly SpecDriftFinding[];
}

export interface ScopeCompleteDriftGateResult {
  readonly ok: boolean;
  readonly message: string;
  readonly enforcement: SpecGuardEnforcement;
  readonly finding: SpecDriftFinding | null;
  readonly shadowFinding: SpecDriftFinding | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyLedger(): SpecDriftLedger {
  return {
    baselineRevision: null,
    unresolved: [],
    coverage: [],
    shadowFindings: [],
    lastRequirementsFingerprint: null,
    cutoverBoundary: null,
  };
}

function normalizeLedger(raw: Record<string, unknown>): SpecDriftLedger {
  const baselineRevision = typeof raw.baselineRevision === "string" ? raw.baselineRevision : null;
  const unresolved: SpecDriftFinding[] = [];
  if (Array.isArray(raw.unresolved)) {
    for (const item of raw.unresolved) {
      if (!isRecord(item)) continue;
      if (typeof item.scopeId !== "string") continue;
      unresolved.push({
        scopeId: item.scopeId,
        reason: typeof item.reason === "string" ? item.reason : "unresolved drift",
        specImpact: typeof item.specImpact === "string" ? item.specImpact : null,
        completedAt: typeof item.completedAt === "string" ? item.completedAt : null,
        uncoveredItemIds: Array.isArray(item.uncoveredItemIds)
          ? item.uncoveredItemIds.map(String)
          : undefined,
      });
    }
  }
  const coverage: SpecDriftCoverageRecord[] = [];
  if (Array.isArray(raw.coverage)) {
    for (const item of raw.coverage) {
      if (!isRecord(item)) continue;
      if (typeof item.scopeId !== "string") continue;
      if (typeof item.beforeRequirementsFingerprint !== "string") continue;
      if (typeof item.afterRequirementsFingerprint !== "string") continue;
      coverage.push({
        scopeId: item.scopeId,
        coveredItemIds: Array.isArray(item.coveredItemIds)
          ? item.coveredItemIds.map(String)
          : [],
        beforeRequirementsFingerprint: item.beforeRequirementsFingerprint,
        afterRequirementsFingerprint: item.afterRequirementsFingerprint,
        affectedRequirementRefs: Array.isArray(item.affectedRequirementRefs)
          ? item.affectedRequirementRefs.map(String)
          : [],
        recordedAt:
          typeof item.recordedAt === "string"
            ? item.recordedAt
            : new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        source:
          item.source === "override" || item.source === "cutover" || item.source === "rewrite"
            ? item.source
            : "rewrite",
        grantId: typeof item.grantId === "string" ? item.grantId : undefined,
      });
    }
  }
  const shadowFindings: SpecDriftFinding[] = [];
  if (Array.isArray(raw.shadowFindings)) {
    for (const item of raw.shadowFindings) {
      if (!isRecord(item)) continue;
      if (typeof item.scopeId !== "string") continue;
      shadowFindings.push({
        scopeId: item.scopeId,
        reason: typeof item.reason === "string" ? item.reason : "shadow finding",
        specImpact: typeof item.specImpact === "string" ? item.specImpact : null,
        completedAt: typeof item.completedAt === "string" ? item.completedAt : null,
        uncoveredItemIds: Array.isArray(item.uncoveredItemIds)
          ? item.uncoveredItemIds.map(String)
          : undefined,
      });
    }
  }
  return {
    baselineRevision,
    unresolved,
    coverage,
    shadowFindings,
    lastRequirementsFingerprint:
      typeof raw.lastRequirementsFingerprint === "string"
        ? raw.lastRequirementsFingerprint
        : null,
    cutoverBoundary: typeof raw.cutoverBoundary === "string" ? raw.cutoverBoundary : null,
  };
}

function readLedger(projectRoot: string): SpecDriftLedger {
  const path = ledgerAbsPath(projectRoot);
  if (!existsSync(path)) {
    return emptyLedger();
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(raw)) return emptyLedger();
    return normalizeLedger(raw);
  } catch {
    return emptyLedger();
  }
}

function contentFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Hash requirements-bearing plan fields only (ignore status/path metadata churn). */
export function requirementsFingerprint(data: Record<string, unknown>): string | null {
  if (!isRecord(data.plan)) return null;
  const plan = data.plan;
  const metadata = isRecord(plan.metadata) ? plan.metadata : null;
  const slice = {
    id: typeof plan.id === "string" ? plan.id : null,
    title: typeof plan.title === "string" ? plan.title : null,
    narratives: isRecord(plan.narratives) ? plan.narratives : null,
    items: Array.isArray(plan.items) ? plan.items : null,
    requirements: Array.isArray(plan.requirements)
      ? plan.requirements
      : (plan.requirements ?? null),
    requirementIds:
      metadata !== null && Array.isArray(metadata.requirement_ids)
        ? metadata.requirement_ids
        : null,
  };
  return contentFingerprint(JSON.stringify(slice));
}

function readDurableSpec(projectRoot: string): Record<string, unknown> | null {
  try {
    const specPath = resolveSpecArtifactPath(projectRoot);
    if (!existsSync(specPath)) return null;
    const data = JSON.parse(readFileSync(specPath, "utf8")) as unknown;
    return isRecord(data) ? data : null;
  } catch {
    return null;
  }
}

/** Stable baseline revision: metadata when present, requirements-content-bound. */
export function resolveBaselineRevision(projectRoot: string): string | null {
  try {
    const data = readDurableSpec(projectRoot);
    if (data === null) return null;
    const fingerprint = requirementsFingerprint(data);
    if (fingerprint === null) return null;
    const info = isRecord(data.xBRIEFInfo)
      ? data.xBRIEFInfo
      : isRecord(data.vBRIEFInfo)
        ? data.vBRIEFInfo
        : null;
    if (info !== null && typeof info.updated === "string") {
      return `${info.updated}#${fingerprint}`;
    }
    if (isRecord(data.plan) && typeof data.plan.id === "string") {
      return `${data.plan.id}#${fingerprint}`;
    }
    return `req:${fingerprint}`;
  } catch {
    return null;
  }
}

export function resolveLiveRequirementsFingerprint(projectRoot: string): string | null {
  const data = readDurableSpec(projectRoot);
  if (data === null) return null;
  return requirementsFingerprint(data);
}

interface SpecImpactCollector {
  deltaOrNew: "delta" | "new" | null;
  seenNone: boolean;
}

function collectSpecImpacts(node: unknown, into: SpecImpactCollector): void {
  if (!isRecord(node)) return;
  const impact = readSpecImpact(node);
  if (impact === "delta" || impact === "new") {
    into.deltaOrNew = impact;
  } else if (impact === "none" && into.seenNone === false && into.deltaOrNew === null) {
    into.seenNone = true;
  }
  if (Array.isArray(node.items)) {
    for (const child of node.items) collectSpecImpacts(child, into);
  }
  if (Array.isArray(node.subItems)) {
    for (const child of node.subItems) collectSpecImpacts(child, into);
  }
}

export interface PerItemImpact {
  readonly itemId: string;
  readonly impact: "none" | "delta" | "new" | null;
  readonly shapeChanging: boolean;
}

function itemLooksShapeChanging(node: Record<string, unknown>): boolean {
  const title = typeof node.title === "string" ? node.title : "";
  const tags = Array.isArray(node.tags) ? node.tags.map(String) : [];
  const hasChildren =
    (Array.isArray(node.items) && node.items.length > 0) ||
    (Array.isArray(node.subItems) && node.subItems.length > 0);
  return (
    tags.some((t) => /rfc|adr|epic|requirement/i.test(t)) ||
    /rfc|adr|epic/i.test(title) ||
    hasChildren ||
    typeof node.id === "string"
  );
}

/** Walk shape-changing items/subItems for per-item impact (#5350 limb 6). */
export function collectPerItemSpecImpacts(plan: Record<string, unknown>): PerItemImpact[] {
  const out: PerItemImpact[] = [];
  const walk = (node: unknown, inheritedShape: boolean): void => {
    if (!isRecord(node)) return;
    const id = typeof node.id === "string" ? node.id : null;
    const impact = readSpecImpact(node);
    const shapeChanging = inheritedShape || itemLooksShapeChanging(node);
    if (id !== null && shapeChanging) {
      out.push({ itemId: id, impact, shapeChanging: true });
    }
    if (Array.isArray(node.items)) {
      for (const child of node.items) walk(child, false);
    }
    if (Array.isArray(node.subItems)) {
      for (const child of node.subItems) walk(child, false);
    }
  };
  // Plan root may itself carry impact without an item id.
  const rootImpact = readSpecImpact(plan);
  if (rootImpact !== null && typeof plan.id === "string") {
    out.push({ itemId: plan.id, impact: rootImpact, shapeChanging: true });
  }
  if (Array.isArray(plan.items)) {
    for (const child of plan.items) walk(child, false);
  }
  if (Array.isArray(plan.subItems)) {
    for (const child of plan.subItems) walk(child, false);
  }
  return out;
}

function scopeIdFrom(scopeData: Record<string, unknown>, scopeRelPath: string): string {
  const plan = isRecord(scopeData.plan) ? scopeData.plan : null;
  return plan !== null && typeof plan.id === "string" ? plan.id : scopeRelPath;
}

function isShapeChangingPlan(plan: Record<string, unknown>): boolean {
  const title = typeof plan.title === "string" ? plan.title : "";
  const tags = Array.isArray(plan.tags) ? plan.tags.map(String) : [];
  const items = Array.isArray(plan.items) ? plan.items : [];
  return (
    tags.some((t) => /rfc|adr|epic|requirement/i.test(t)) ||
    /rfc|adr|epic/i.test(title) ||
    items.length > 0
  );
}

/** Advise-mode OR-aggregate finding (kept soft for #5315). */
export function findingFromScopeCompletionAdvise(
  scopeData: Record<string, unknown>,
  scopeRelPath: string,
): SpecDriftFinding | null {
  const plan = isRecord(scopeData.plan) ? scopeData.plan : null;
  if (plan === null) return null;
  const collector: SpecImpactCollector = { deltaOrNew: null, seenNone: false };
  collectSpecImpacts(plan, collector);
  const impact: "none" | "delta" | "new" | null =
    collector.deltaOrNew !== null ? collector.deltaOrNew : collector.seenNone ? "none" : null;
  if (typeof plan.specImpact === "string" && impact === null) {
    // ignore bare key
  }
  if (impact === "delta" || impact === "new") {
    return null;
  }
  if (!isShapeChangingPlan(plan) && impact === "none") {
    return null;
  }
  if (!isShapeChangingPlan(plan) && impact === null) {
    return null;
  }
  return {
    scopeId: typeof plan.id === "string" ? plan.id : scopeRelPath,
    reason:
      impact === null
        ? `shape-changing completion missing ${SPEC_IMPACT_KEY} (none|delta|new)`
        : `specImpact=none without requirements/delta coverage for shape-changing completion`,
    specImpact: impact,
    completedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

/** @deprecated Prefer findingFromScopeCompletionAdvise / evaluateCompletionCoverage. */
export function findingFromScopeCompletion(
  scopeData: Record<string, unknown>,
  scopeRelPath: string,
): SpecDriftFinding | null {
  return findingFromScopeCompletionAdvise(scopeData, scopeRelPath);
}

export interface RewriteProofInput {
  readonly scopeId: string;
  readonly coveredItemIds: readonly string[];
  readonly beforeFingerprint: string | null;
  readonly afterFingerprint: string | null;
  readonly existingCoverage: readonly SpecDriftCoverageRecord[];
  readonly affectedRequirementRefs?: readonly string[];
}

export type RewriteProofResult =
  | {
      readonly ok: true;
      readonly record: SpecDriftCoverageRecord;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Completion-scoped rewrite proof on durable SPEC requirements projection (#5350 limb 4).
 * Timestamp/status/path-only churn fails; reused before→after evidence fails.
 */
export function evaluateRewriteProof(input: RewriteProofInput): RewriteProofResult {
  const before = input.beforeFingerprint;
  const after = input.afterFingerprint;
  if (before === null || after === null) {
    return {
      ok: false,
      reason:
        "rewrite proof unassessable: missing before/after requirements fingerprint on durable SPECIFICATION",
    };
  }
  if (before === after) {
    return {
      ok: false,
      reason:
        "rewrite proof failed: requirements-only durable SPEC projection unchanged (timestamp/status/path-only churn does not count)",
    };
  }
  const reused = input.existingCoverage.some(
    (c) =>
      c.beforeRequirementsFingerprint === before &&
      c.afterRequirementsFingerprint === after &&
      c.source === "rewrite",
  );
  if (reused) {
    return {
      ok: false,
      reason: "rewrite proof failed: before/after evidence already consumed (reused-evidence)",
    };
  }
  if (input.coveredItemIds.length === 0) {
    return {
      ok: false,
      reason: "rewrite proof failed: no covered item ids for delta|new completion",
    };
  }
  return {
    ok: true,
    record: {
      scopeId: input.scopeId,
      coveredItemIds: [...input.coveredItemIds],
      beforeRequirementsFingerprint: before,
      afterRequirementsFingerprint: after,
      affectedRequirementRefs: [...(input.affectedRequirementRefs ?? [])],
      recordedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      source: "rewrite",
    },
  };
}

function grantMatchesOverride(
  grant: HumanOriginGrant,
  scopeId: string,
  itemIds: readonly string[],
  baselineRevision: string,
): boolean {
  if (grant.origin.kind !== "operator-cli") return false;
  const eventOk =
    typeof grant.origin.eventRef === "string" &&
    grant.origin.eventRef.startsWith(`template:${SPEC_DRIFT_OVERRIDE_TEMPLATE}`);
  const surfaceTemplate = grant.scope.surfaces.some((s) =>
    s.startsWith(SPEC_DRIFT_OVERRIDE_SCOPE_PREFIX),
  );
  if (!eventOk && !surfaceTemplate) return false;
  if (grant.semantics.revokedAt !== null) return false;
  if (grant.semantics.expiresAt !== null) {
    const exp = Date.parse(grant.semantics.expiresAt);
    if (Number.isFinite(exp) && exp <= Date.now()) return false;
  }
  if (grant.semantics.singleUse && grant.semantics.usedAt !== null) return false;
  if (grant.scope.planRef !== scopeId) return false;
  const boundItems = new Set(grant.scope.storyIds.map(String));
  for (const id of itemIds) {
    if (!boundItems.has(id)) return false;
  }
  const baselineSurface = `${SPEC_DRIFT_OVERRIDE_BASELINE_PREFIX}${baselineRevision}`;
  if (!grant.scope.surfaces.includes(baselineSurface)) return false;
  return true;
}

/** Find a live unspent Wave-1 override grant for bound scope/items/revision (S2). */
export function findLiveSpecDriftOverrideGrant(
  projectRoot: string,
  scopeId: string,
  itemIds: readonly string[],
  baselineRevision: string,
): HumanOriginGrant | null {
  const state = loadAuthzState(projectRoot);
  const grants = listActiveHumanGrants(projectRoot, state);
  for (const g of grants) {
    if (grantMatchesOverride(g, scopeId, itemIds, baselineRevision)) {
      return g;
    }
  }
  return null;
}

export interface CompletionCoverageEvaluation {
  readonly finding: SpecDriftFinding | null;
  readonly coveredItemIds: readonly string[];
  readonly uncoveredItemIds: readonly string[];
  readonly needsRewriteProof: boolean;
  readonly deltaOrNewItemIds: readonly string[];
}

/**
 * Per-completion coverage under shadow/enforce; advise keeps whole-scope OR (#5350 limb 6).
 */
export function evaluateCompletionCoverage(
  scopeData: Record<string, unknown>,
  scopeRelPath: string,
  enforcement: SpecGuardEnforcement,
): CompletionCoverageEvaluation {
  if (enforcement === "advise") {
    const finding = findingFromScopeCompletionAdvise(scopeData, scopeRelPath);
    return {
      finding,
      coveredItemIds: [],
      uncoveredItemIds: finding === null ? [] : [],
      needsRewriteProof: false,
      deltaOrNewItemIds: [],
    };
  }

  const plan = isRecord(scopeData.plan) ? scopeData.plan : null;
  if (plan === null) {
    return {
      finding: null,
      coveredItemIds: [],
      uncoveredItemIds: [],
      needsRewriteProof: false,
      deltaOrNewItemIds: [],
    };
  }

  if (!isShapeChangingPlan(plan)) {
    const rootImpact = readSpecImpact(plan);
    if (rootImpact === "none" || rootImpact === null) {
      return {
        finding: null,
        coveredItemIds: [],
        uncoveredItemIds: [],
        needsRewriteProof: false,
        deltaOrNewItemIds: [],
      };
    }
  }

  const perItem = collectPerItemSpecImpacts(plan);
  // If no item ids but shape-changing, require plan-level namespaced impact.
  if (perItem.length === 0) {
    const rootImpact = readSpecImpact(plan);
    if (rootImpact === "delta" || rootImpact === "new") {
      const scopeId = scopeIdFrom(scopeData, scopeRelPath);
      return {
        finding: null,
        coveredItemIds: [scopeId],
        uncoveredItemIds: [],
        needsRewriteProof: true,
        deltaOrNewItemIds: [scopeId],
      };
    }
    if (!isShapeChangingPlan(plan)) {
      return {
        finding: null,
        coveredItemIds: [],
        uncoveredItemIds: [],
        needsRewriteProof: false,
        deltaOrNewItemIds: [],
      };
    }
    return {
      finding: {
        scopeId: scopeIdFrom(scopeData, scopeRelPath),
        reason: `shape-changing completion missing per-item ${SPEC_IMPACT_KEY} under ${enforcement}`,
        specImpact: rootImpact,
        completedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        uncoveredItemIds: [],
      },
      coveredItemIds: [],
      uncoveredItemIds: [],
      needsRewriteProof: false,
      deltaOrNewItemIds: [],
    };
  }

  const uncovered: string[] = [];
  const covered: string[] = [];
  const deltaOrNew: string[] = [];
  for (const row of perItem) {
    if (row.impact === null) {
      uncovered.push(row.itemId);
    } else if (row.impact === "none") {
      covered.push(row.itemId);
    } else {
      covered.push(row.itemId);
      deltaOrNew.push(row.itemId);
    }
  }

  if (uncovered.length > 0) {
    return {
      finding: {
        scopeId: scopeIdFrom(scopeData, scopeRelPath),
        reason: `per-item ${SPEC_IMPACT_KEY} uncovered under ${enforcement}: ${uncovered.join(",")}`,
        specImpact: null,
        completedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        uncoveredItemIds: uncovered,
      },
      coveredItemIds: covered,
      uncoveredItemIds: uncovered,
      needsRewriteProof: deltaOrNew.length > 0,
      deltaOrNewItemIds: deltaOrNew,
    };
  }

  return {
    finding: null,
    coveredItemIds: covered,
    uncoveredItemIds: [],
    needsRewriteProof: deltaOrNew.length > 0,
    deltaOrNewItemIds: deltaOrNew,
  };
}

function withLedgerLock<T>(
  projectRoot: string,
  enforcement: SpecGuardEnforcement,
  fn: () => T,
): T {
  if (enforcement !== "enforce") {
    return fn();
  }
  const lockPath = ledgerLockAbsPath(projectRoot);
  let fd: number | null = null;
  try {
    fd = openSync(lockPath, "wx");
    writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    return fn();
  } catch (err) {
    throw new Error(
      `spec-drift ledger lock failed under enforce (${SPEC_DRIFT_LEDGER_LOCK_NAME}): ${String(err)}`,
    );
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }
  }
}

export function writeSpecDriftLedger(
  projectRoot: string,
  ledger: SpecDriftLedger,
  options: { readonly enforcement?: SpecGuardEnforcement } = {},
): string {
  const root = resolve(projectRoot);
  const abs = resolveAuditPath(root, SPEC_DRIFT_LEDGER_NAME);
  const rel = relative(root, abs).replace(/\\/g, "/");
  const enforcement = options.enforcement ?? "advise";
  const payload: SpecDriftLedger = {
    baselineRevision: ledger.baselineRevision,
    unresolved: [...ledger.unresolved],
    coverage: [...ledger.coverage],
    shadowFindings: [...ledger.shadowFindings],
    lastRequirementsFingerprint: ledger.lastRequirementsFingerprint,
    cutoverBoundary: ledger.cutoverBoundary,
  };
  return withLedgerLock(root, enforcement, () => {
    containedWrite({
      root,
      target: rel,
      data: `${JSON.stringify(payload, null, 2)}\n`,
      mode: existsSync(abs) ? "replace" : "create",
    });
    return abs;
  });
}

/** Seed or reseed the drift ledger from the live durable SPEC baseline (#5350 limb 7). */
export function seedSpecDriftLedger(
  projectRoot: string,
  options: { readonly reseed?: boolean; readonly actor?: string } = {},
): {
  readonly ok: boolean;
  readonly message: string;
  readonly baselineRevision: string | null;
} {
  const root = resolve(projectRoot);
  const baselineRevision = resolveBaselineRevision(root);
  const fingerprint = resolveLiveRequirementsFingerprint(root);
  if (baselineRevision === null || fingerprint === null) {
    return {
      ok: false,
      message:
        "spec-drift seed refused: durable SPECIFICATION baseline unknown — reconstruct first",
      baselineRevision: null,
    };
  }
  const existing = hasLedgerFile(root);
  if (existing && options.reseed !== true) {
    return {
      ok: false,
      message: "spec-drift ledger already present — pass --reseed to replace (records cutover)",
      baselineRevision,
    };
  }
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const ledger: SpecDriftLedger = {
    baselineRevision,
    unresolved: [],
    coverage: [],
    shadowFindings: [],
    lastRequirementsFingerprint: fingerprint,
    cutoverBoundary: options.reseed === true || !existing ? now : null,
  };
  writeSpecDriftLedger(root, ledger, { enforcement: "enforce" });
  return {
    ok: true,
    message: `spec-drift ledger ${options.reseed === true ? "reseeded" : "seeded"} at baseline ${baselineRevision}`,
    baselineRevision,
  };
}

/** Evaluate semantic drift for audit / advise / shadow / enforce surfaces. */
export function evaluateSpecDrift(projectRoot: string): SpecDriftResult {
  const root = resolve(projectRoot);
  let hasSpec = false;
  try {
    hasSpec = existsSync(resolveSpecArtifactPath(root));
  } catch {
    hasSpec = false;
  }
  const guard = resolveSpecGuard(root, { hasSpecification: hasSpec });
  const enforcement = guard.driftGuard.enforcement;

  if (!guard.enabled) {
    return {
      code: 0,
      state: "clean",
      message: "verify:spec-drift: specGuard disabled — no semantic drift audit",
      findings: [],
      baselineRevision: null,
      guard,
    };
  }

  if (guard.source === "default-on-error" && guard.error !== null) {
    return {
      code: 2,
      state: "unassessable",
      message: `verify:spec-drift: invalid specGuard configuration (${guard.error}); refusing silent default`,
      findings: [],
      baselineRevision: null,
      guard,
    };
  }

  try {
    resolveLifecycleRoot(root);
  } catch (err) {
    return {
      code: 2,
      state: "unassessable",
      message: `verify:spec-drift: lifecycle layout unavailable: ${String(err)}`,
      findings: [],
      baselineRevision: null,
      guard,
    };
  }

  const baselineRevision = resolveBaselineRevision(root);
  if (baselineRevision === null || guard.baselineStatus === "unknown") {
    return {
      code: 2,
      state: "unassessable",
      message:
        "verify:spec-drift: baseline revision unknown/unhardened — reconstruct a trustworthy specification first (spec:reconstruct)",
      findings: [],
      baselineRevision: null,
      guard,
    };
  }

  if (!hasLedgerFile(root)) {
    // Under enforce, empty advise-era absence is unassessable until seed/cutover.
    const msg =
      enforcement === "enforce"
        ? "verify:spec-drift: drift ledger missing under enforce — unassessable until seed/reseed or reconstruct (empty advise ledger is not proven)"
        : "verify:spec-drift: drift ledger missing — coverage unknown until scope-complete records or an operator seeds the ledger";
    return {
      code: 2,
      state: "unassessable",
      message: msg,
      findings: [],
      baselineRevision,
      guard,
    };
  }

  const ledger = readLedger(root);

  // Enforce cutover: ledger without cutover/coverage history from advise era stays informational
  // only when unresolved empty AND baseline matches — but missing cutover with prior empty
  // advise seed still counts once seeded. Prefer cutoverBoundary when reseeded.
  if (
    ledger.baselineRevision !== null &&
    ledger.baselineRevision === baselineRevision &&
    ledger.unresolved.length === 0
  ) {
    const shadow = ledger.shadowFindings;
    return {
      code: 0,
      state: "clean",
      message: `verify:spec-drift: clean against baseline ${baselineRevision}`,
      findings: [],
      baselineRevision,
      guard,
      shadowFindings: shadow,
    };
  }

  if (ledger.unresolved.length > 0) {
    if (ledger.baselineRevision !== null && ledger.baselineRevision !== baselineRevision) {
      return {
        code: 1,
        state: "drift",
        message:
          `verify:spec-drift: unresolved drift remains after baseline moved ` +
          `(ledger=${ledger.baselineRevision} live=${baselineRevision}); ` +
          `registry/render-only touches do not clear requirements/delta coverage`,
        findings: ledger.unresolved,
        baselineRevision,
        guard,
        shadowFindings: ledger.shadowFindings,
      };
    }
    return {
      code: 1,
      state: "drift",
      message: `verify:spec-drift: ${ledger.unresolved.length} unresolved completion(s) lack requirements/delta coverage`,
      findings: ledger.unresolved,
      baselineRevision,
      guard,
      shadowFindings: ledger.shadowFindings,
    };
  }

  if (ledger.baselineRevision === null) {
    return {
      code: 2,
      state: "unassessable",
      message:
        "verify:spec-drift: ledger present but baselineRevision unset — seed baseline before claiming clean",
      findings: [],
      baselineRevision,
      guard,
      shadowFindings: ledger.shadowFindings,
    };
  }

  return {
    code: 1,
    state: "drift",
    message: `verify:spec-drift: ledger baseline ${ledger.baselineRevision} does not match live ${baselineRevision}`,
    findings: [],
    baselineRevision,
    guard,
    shadowFindings: ledger.shadowFindings,
  };
}

/**
 * Pre-move gate for scope:complete (#5350 limb 3).
 * advise: always ok (soft). shadow: ok with optional shadow finding. enforce: refuse on fail.
 */
export function gateScopeCompleteSpecDrift(
  projectRoot: string,
  scopeData: Record<string, unknown>,
  scopeRelPath: string,
): ScopeCompleteDriftGateResult {
  const root = resolve(projectRoot);
  let hasSpec = false;
  try {
    hasSpec = existsSync(resolveSpecArtifactPath(root));
  } catch {
    hasSpec = false;
  }
  const guard = resolveSpecGuard(root, { hasSpecification: hasSpec });
  const enforcement = guard.driftGuard.enforcement;
  if (!guard.enabled) {
    return { ok: true, message: "", enforcement, finding: null, shadowFinding: null };
  }
  const trigger = guard.driftGuard.trigger;
  if (trigger !== "scope-complete" && trigger !== "both") {
    return { ok: true, message: "", enforcement, finding: null, shadowFinding: null };
  }

  if (enforcement === "advise") {
    return { ok: true, message: "", enforcement, finding: null, shadowFinding: null };
  }

  const coverage = evaluateCompletionCoverage(scopeData, scopeRelPath, enforcement);
  const scopeId = scopeIdFrom(scopeData, scopeRelPath);
  const baselineRevision = resolveBaselineRevision(root);
  const ledger = readLedger(root);
  const afterFp = resolveLiveRequirementsFingerprint(root);
  const beforeFp = ledger.lastRequirementsFingerprint;

  let finding = coverage.finding;

  if (finding === null && coverage.needsRewriteProof) {
    const proof = evaluateRewriteProof({
      scopeId,
      coveredItemIds: coverage.deltaOrNewItemIds,
      beforeFingerprint: beforeFp,
      afterFingerprint: afterFp,
      existingCoverage: ledger.coverage,
    });
    if (!proof.ok) {
      // Override hatch (enforce only for refuse relief; shadow still warns).
      if (baselineRevision !== null) {
        const grant = findLiveSpecDriftOverrideGrant(
          root,
          scopeId,
          coverage.deltaOrNewItemIds,
          baselineRevision,
        );
        if (grant !== null) {
          finding = null;
        } else {
          finding = {
            scopeId,
            reason: proof.reason,
            specImpact: "delta",
            completedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
            uncoveredItemIds: [...coverage.deltaOrNewItemIds],
          };
        }
      } else {
        finding = {
          scopeId,
          reason: proof.reason,
          specImpact: "delta",
          completedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
          uncoveredItemIds: [...coverage.deltaOrNewItemIds],
        };
      }
    }
  }

  if (enforcement === "shadow") {
    return {
      ok: true,
      message:
        finding !== null
          ? `spec-drift shadow warning: ${finding.reason}`
          : "",
      enforcement,
      finding: null,
      shadowFinding: finding,
    };
  }

  // enforce
  if (finding !== null) {
    return {
      ok: false,
      message: `scope:complete refused under specGuard enforce: ${finding.reason}`,
      enforcement,
      finding,
      shadowFinding: null,
    };
  }
  return { ok: true, message: "", enforcement, finding: null, shadowFinding: null };
}

/**
 * Record completion drift after lifecycle move. Branches on enforcement (#5350).
 * Under enforce, write failures throw (fail closed). Shadow records warnings without refuse.
 */
export function recordScopeCompleteDrift(
  projectRoot: string,
  scopeData: Record<string, unknown>,
  scopeRelPath: string,
): SpecDriftFinding | null {
  const root = resolve(projectRoot);
  let hasSpec = false;
  try {
    hasSpec = existsSync(resolveSpecArtifactPath(root));
  } catch {
    hasSpec = false;
  }
  const guard = resolveSpecGuard(root, { hasSpecification: hasSpec });
  if (!guard.enabled) return null;
  const trigger = guard.driftGuard.trigger;
  if (trigger !== "scope-complete" && trigger !== "both") return null;

  const enforcement = guard.driftGuard.enforcement;
  const scopeId = scopeIdFrom(scopeData, scopeRelPath);
  const baselineRevision = resolveBaselineRevision(root);
  const afterFp = resolveLiveRequirementsFingerprint(root);

  if (enforcement === "advise") {
    return recordAdvisePath(root, scopeData, scopeRelPath, scopeId, baselineRevision);
  }

  const coverage = evaluateCompletionCoverage(scopeData, scopeRelPath, enforcement);
  const ledger = readLedger(root);
  const beforeFp = ledger.lastRequirementsFingerprint;

  let coverageRecords = [...ledger.coverage];
  let unresolved = ledger.unresolved.filter((f) => f.scopeId !== scopeId);
  let shadowFindings = ledger.shadowFindings.filter((f) => f.scopeId !== scopeId);
  let finding: SpecDriftFinding | null = coverage.finding;

  if (finding === null && coverage.needsRewriteProof) {
    const proof = evaluateRewriteProof({
      scopeId,
      coveredItemIds: coverage.deltaOrNewItemIds,
      beforeFingerprint: beforeFp,
      afterFingerprint: afterFp,
      existingCoverage: coverageRecords,
    });
    if (proof.ok) {
      coverageRecords = [...coverageRecords.filter((c) => c.scopeId !== scopeId), proof.record];
    } else if (baselineRevision !== null) {
      const grant = findLiveSpecDriftOverrideGrant(
        root,
        scopeId,
        coverage.deltaOrNewItemIds,
        baselineRevision,
      );
      if (grant !== null) {
        markGrantUsed(root, grant.id);
        coverageRecords = [
          ...coverageRecords.filter((c) => c.scopeId !== scopeId),
          {
            scopeId,
            coveredItemIds: [...coverage.deltaOrNewItemIds],
            beforeRequirementsFingerprint: beforeFp ?? "override",
            afterRequirementsFingerprint: afterFp ?? "override",
            affectedRequirementRefs: [],
            recordedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
            source: "override",
            grantId: grant.id,
          },
        ];
      } else {
        finding = {
          scopeId,
          reason: proof.reason,
          specImpact: "delta",
          completedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
          uncoveredItemIds: [...coverage.deltaOrNewItemIds],
        };
      }
    } else {
      finding = {
        scopeId,
        reason: proof.reason,
        specImpact: "delta",
        completedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        uncoveredItemIds: [...coverage.deltaOrNewItemIds],
      };
    }
  }

  if (finding !== null) {
    if (enforcement === "shadow") {
      shadowFindings = [...shadowFindings, finding];
    } else {
      unresolved = [...unresolved, finding];
    }
  }

  const next: SpecDriftLedger = {
    baselineRevision: ledger.baselineRevision ?? baselineRevision,
    unresolved,
    coverage: coverageRecords,
    shadowFindings,
    lastRequirementsFingerprint: afterFp ?? ledger.lastRequirementsFingerprint,
    cutoverBoundary: ledger.cutoverBoundary,
  };

  // Do not seed a brand-new empty ledger from a covered completion alone (advise-era rule).
  if (finding === null && !hasLedgerFile(root) && coverageRecords.length === 0) {
    return null;
  }
  if (!hasLedgerFile(root) && finding === null && coverageRecords.length === 0) {
    return null;
  }
  if (!hasLedgerFile(root) && finding === null) {
    // Coverage recorded implies ledger should exist under shadow/enforce.
  }

  writeSpecDriftLedger(root, next, { enforcement });
  return enforcement === "shadow" ? null : finding;
}

function recordAdvisePath(
  root: string,
  scopeData: Record<string, unknown>,
  scopeRelPath: string,
  scopeId: string,
  baselineRevision: string | null,
): SpecDriftFinding | null {
  const finding = findingFromScopeCompletionAdvise(scopeData, scopeRelPath);
  const ledger = readLedger(root);

  if (finding === null) {
    if (!hasLedgerFile(root)) {
      return null;
    }
    if (ledger.unresolved.some((f) => f.scopeId === scopeId)) {
      writeSpecDriftLedger(root, {
        ...ledger,
        baselineRevision: ledger.baselineRevision ?? baselineRevision,
        unresolved: ledger.unresolved.filter((f) => f.scopeId !== scopeId),
      });
    }
    return null;
  }

  const next: SpecDriftLedger = {
    ...ledger,
    baselineRevision: ledger.baselineRevision ?? baselineRevision,
    unresolved: [...ledger.unresolved.filter((f) => f.scopeId !== finding.scopeId), finding],
  };
  writeSpecDriftLedger(root, next);
  return finding;
}

/** Back-compat alias used by specification-sync (#1589 C2). */
export function recordScopeCompleteDriftAdvise(
  projectRoot: string,
  scopeData: Record<string, unknown>,
  scopeRelPath: string,
): SpecDriftFinding | null {
  return recordScopeCompleteDrift(projectRoot, scopeData, scopeRelPath);
}

export interface SpecDriftCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runSpecDriftCli(argv: string[]): SpecDriftCliResult {
  let projectRoot = ".";
  let json = false;
  let seed = false;
  let reseed = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "argument --project-root: expected one argument\n",
        };
      }
      projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--seed") {
      seed = true;
    } else if (arg === "--reseed") {
      reseed = true;
    } else if (arg === "--help" || arg === "-h") {
      return {
        exitCode: 0,
        stdout:
          "Usage: verify:spec-drift [--project-root <dir>] [--json] [--seed|--reseed]\n" +
          "Three-state semantic drift audit (0 clean / 1 drift / 2 unassessable).\n" +
          "Mode × exit: advise informational; shadow warns via shadowFindings (CI must not fail solely on shadow);\n" +
          "enforce fails closed on exit 1 and 2 for named consumers (scope:complete pre-move + tasks/verify.yml).\n" +
          "Not spliced into bare deft check in v1. Distinct from verify:spec-prd-fresh.\n",
        stderr: "",
      };
    } else if (arg !== undefined && arg.length > 0) {
      return { exitCode: 2, stdout: "", stderr: `unknown argument: ${arg}\n` };
    }
  }

  if (seed || reseed) {
    const seeded = seedSpecDriftLedger(projectRoot, { reseed });
    if (!seeded.ok) {
      return { exitCode: 2, stdout: "", stderr: `${seeded.message}\n` };
    }
    if (json) {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify(seeded, null, 2)}\n`,
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: `${seeded.message}\n`, stderr: "" };
  }

  const result = evaluateSpecDrift(projectRoot);
  if (json) {
    return {
      exitCode: result.code,
      stdout: `${JSON.stringify(result, null, 2)}\n`,
      stderr: "",
    };
  }
  const stream = result.code === 0 ? "stdout" : "stderr";
  let text = `${result.message}\n`;
  if (
    result.guard.driftGuard.enforcement === "shadow" &&
    result.shadowFindings !== undefined &&
    result.shadowFindings.length > 0
  ) {
    text += `shadow findings: ${result.shadowFindings.length}\n`;
  }
  return {
    exitCode: result.code,
    stdout: stream === "stdout" ? text : "",
    stderr: stream === "stderr" ? text : "",
  };
}
