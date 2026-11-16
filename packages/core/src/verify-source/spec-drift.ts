/**
 * Semantic spec-vs-reality drift audit (#1589 Prefer-A Bound C2 / #5350 C3).
 *
 * Three-state: 0 clean / 1 drift / 2 unassessable|config.
 * Distinct from fail-closed verify:spec-prd-fresh (banner/projection freshness).
 * Enforcement ladder: advise (soft) → shadow (warn) → enforce (hard).
 * Discharge under shadow/enforce requires per-item coverage + rewrite proof
 * on durable SPECIFICATION (or a live spec-drift-override mint).
 *
 * Storage (#6335): each completion writes its rows to its own row file,
 * `xbrief/.audit/spec-drift/<scopeId>.json`, so parallel completion PRs never
 * edit one shared file. `spec-drift-ledger.json` stays as header
 * (`baselineRevision`, `cutoverBoundary`) and legacy rows; only seed/reseed
 * write it. Readers merge header + legacy rows + row files; a row file, empty
 * or not, replaces the legacy rows for its scope. The rewrite proof reads both
 * fingerprints from the story's own delivery commits, never a stored value.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  listActiveHumanGrants,
  loadAuthzState,
  loadGrant,
  markGrantUsed,
  saveGrant,
} from "../authz/store.js";
import type { HumanOriginGrant } from "../authz/types.js";
import {
  ContainedWriteError,
  ContainedWriteErrorCode,
  containedRemove,
  containedWrite,
} from "../fs/contained-write.js";
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
import { defaultGitRunner, type GitRunner } from "../session/git.js";

export const SPEC_DRIFT_LEDGER_NAME = "spec-drift-ledger.json";
/** Folder of per-story row files beside the ledger header (#6335). */
export const SPEC_DRIFT_ROWS_DIR_NAME = "spec-drift";
export const SPEC_DRIFT_LEDGER_LOCK_NAME = ".spec-drift-ledger.pair.lock.tmp";
export const SPEC_DRIFT_OVERRIDE_TEMPLATE = "spec-drift-override";
export const SPEC_DRIFT_OVERRIDE_BASELINE_PREFIX = "spec-drift-override:baseline:";
export const SPEC_DRIFT_OVERRIDE_SCOPE_PREFIX = "spec-drift-override:scope:";
export const SPEC_DRIFT_OVERRIDE_ITEM_PREFIX = "spec-drift-override:item:";
/** Declared requirement refs rewritten by a completing item (may differ from item id). */
export const AFFECTED_REQUIREMENT_REFS_KEY = "x-directive/affectedRequirementRefs";

function ledgerAbsPath(projectRoot: string): string {
  return resolveAuditPath(projectRoot, SPEC_DRIFT_LEDGER_NAME);
}

function ledgerLockAbsPath(projectRoot: string): string {
  return resolveAuditPath(projectRoot, SPEC_DRIFT_LEDGER_LOCK_NAME);
}

function hasLedgerFile(projectRoot: string): boolean {
  return existsSync(ledgerAbsPath(projectRoot));
}

function rowsDirAbsPath(projectRoot: string): string {
  return resolveAuditPath(projectRoot, SPEC_DRIFT_ROWS_DIR_NAME);
}

/** File name of a scope's row file: the scopeId with unsafe characters replaced (#6335). */
export function specDriftRowFileName(scopeId: string): string {
  return `${scopeId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

function rowFileAbsPath(projectRoot: string, scopeId: string): string {
  return join(rowsDirAbsPath(projectRoot), specDriftRowFileName(scopeId));
}

function listRowFileNames(projectRoot: string): string[] {
  const dir = rowsDirAbsPath(projectRoot);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

/** Ledger header or any row file present: a drift record exists (#6335). */
function hasLedgerData(projectRoot: string): boolean {
  return hasLedgerFile(projectRoot) || listRowFileNames(projectRoot).length > 0;
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
  /**
   * Legacy field, read from old files only. Nothing writes a non-null value and
   * the rewrite proof never reads it (#6335).
   */
  readonly lastRequirementsFingerprint: string | null;
  /** Cutover/grandfather boundary — empty advise ledger is not proven under enforce. */
  readonly cutoverBoundary: string | null;
  /** Merged view only: scopes that have a row file (#6335). */
  readonly rowFileScopes?: readonly string[];
}

/** One scope's rows in `xbrief/.audit/spec-drift/<scopeId>.json` (#6335). */
export interface SpecDriftRowFile {
  readonly scopeId: string;
  readonly unresolved: SpecDriftFinding[];
  readonly coverage: SpecDriftCoverageRecord[];
  readonly shadowFindings: SpecDriftFinding[];
}

/**
 * Delivery commits for the rewrite proof (#6335): the commit the delivery was
 * applied onto and the delivery itself. In-PR: merge base and branch head.
 * Post-merge: first parent and the product merge commit.
 */
export interface SpecDriftDelivery {
  readonly baseCommit: string | null;
  readonly deliveryCommit: string | null;
  readonly runGit?: GitRunner;
}

/** A delivery, or a thunk that resolves it only when the proof needs it. */
export type SpecDriftDeliverySource = SpecDriftDelivery | (() => SpecDriftDelivery);

export interface SpecDriftDeliveryOptions {
  readonly delivery?: SpecDriftDeliverySource | null;
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
        coveredItemIds: Array.isArray(item.coveredItemIds) ? item.coveredItemIds.map(String) : [],
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
      typeof raw.lastRequirementsFingerprint === "string" ? raw.lastRequirementsFingerprint : null,
    cutoverBoundary: typeof raw.cutoverBoundary === "string" ? raw.cutoverBoundary : null,
  };
}

/** The ledger file alone: header plus legacy rows. */
function readLegacyLedger(projectRoot: string): SpecDriftLedger {
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

/** Parse one row file; rows for another scope are dropped (a row file holds one scope). */
function parseRowFile(raw: unknown): SpecDriftRowFile | null {
  if (!isRecord(raw) || typeof raw.scopeId !== "string" || raw.scopeId.length === 0) {
    return null;
  }
  const scopeId = raw.scopeId;
  const rows = normalizeLedger(raw);
  return {
    scopeId,
    unresolved: rows.unresolved.filter((f) => f.scopeId === scopeId),
    coverage: rows.coverage.filter((c) => c.scopeId === scopeId),
    shadowFindings: rows.shadowFindings.filter((f) => f.scopeId === scopeId),
  };
}

/** Every row file under `xbrief/.audit/spec-drift/`, in file-name order (#6335). */
export function readSpecDriftRowFiles(projectRoot: string): SpecDriftRowFile[] {
  const root = resolve(projectRoot);
  const dir = rowsDirAbsPath(root);
  const out: SpecDriftRowFile[] = [];
  for (const name of listRowFileNames(root)) {
    try {
      const parsed = parseRowFile(JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown);
      if (parsed !== null) out.push(parsed);
    } catch {
      /* unreadable row file — skip */
    }
  }
  return out;
}

/**
 * Merged view (#6335): ledger header, legacy rows and row files. A row file,
 * empty or not, replaces the legacy rows for its scope.
 */
function readLedger(projectRoot: string): SpecDriftLedger {
  const legacy = readLegacyLedger(projectRoot);
  const rowFiles = readSpecDriftRowFiles(projectRoot);
  const replaced = new Set(rowFiles.map((r) => r.scopeId));
  return {
    baselineRevision: legacy.baselineRevision,
    lastRequirementsFingerprint: legacy.lastRequirementsFingerprint,
    cutoverBoundary: legacy.cutoverBoundary,
    unresolved: [
      ...legacy.unresolved.filter((f) => !replaced.has(f.scopeId)),
      ...rowFiles.flatMap((r) => r.unresolved),
    ],
    coverage: [
      ...legacy.coverage.filter((c) => !replaced.has(c.scopeId)),
      ...rowFiles.flatMap((r) => r.coverage),
    ],
    shadowFindings: [
      ...legacy.shadowFindings.filter((f) => !replaced.has(f.scopeId)),
      ...rowFiles.flatMap((r) => r.shadowFindings),
    ],
    rowFileScopes: [...replaced],
  };
}

function scopeRows(ledger: SpecDriftLedger, scopeId: string): Omit<SpecDriftRowFile, "scopeId"> {
  return {
    unresolved: ledger.unresolved.filter((f) => f.scopeId === scopeId),
    coverage: ledger.coverage.filter((c) => c.scopeId === scopeId),
    shadowFindings: ledger.shadowFindings.filter((f) => f.scopeId === scopeId),
  };
}

function scopeHasRows(ledger: SpecDriftLedger, scopeId: string): boolean {
  const rows = scopeRows(ledger, scopeId);
  return rows.unresolved.length + rows.coverage.length + rows.shadowFindings.length > 0;
}

/** Write (or overwrite) one scope's row file (#6335). Returns the absolute path. */
export function writeSpecDriftRowFile(projectRoot: string, rows: SpecDriftRowFile): string {
  const root = resolve(projectRoot);
  const abs = rowFileAbsPath(root, rows.scopeId);
  const rel = relative(root, abs).replace(/\\/g, "/");
  const payload: SpecDriftRowFile = {
    scopeId: rows.scopeId,
    unresolved: [...rows.unresolved],
    coverage: [...rows.coverage],
    shadowFindings: [...rows.shadowFindings],
  };
  containedWrite({
    root,
    target: rel,
    data: `${JSON.stringify(payload, null, 2)}\n`,
    mode: existsSync(abs) ? "replace" : "create",
  });
  return abs;
}

function removeSpecDriftRowFile(projectRoot: string, scopeId: string): void {
  const root = resolve(projectRoot);
  const abs = rowFileAbsPath(root, scopeId);
  if (!existsSync(abs)) return;
  containedRemove({ root, target: relative(root, abs).replace(/\\/g, "/") });
}

function resolveDeliverySource(
  source: SpecDriftDeliverySource | null | undefined,
): SpecDriftDelivery | null {
  if (source === undefined || source === null) return null;
  try {
    return typeof source === "function" ? source() : source;
  } catch {
    return null;
  }
}

function requirementsFingerprintAtCommit(
  root: string,
  specRel: string,
  commit: string,
  runGit: GitRunner,
): string | null {
  try {
    const shown = runGit(root, ["show", `${commit}:./${specRel}`]);
    if (shown.code !== 0) return null;
    const data = JSON.parse(shown.stdout) as unknown;
    return isRecord(data) ? requirementsFingerprint(data) : null;
  } catch {
    return null;
  }
}

/**
 * Both rewrite-proof fingerprints from the story's own delivery (#6335): the
 * durable SPEC at the delivery's base commit and at the delivery commit. No
 * delivery, or a commit git cannot read, gives nulls (unassessable).
 */
export function resolveDeliveryRequirementsFingerprints(
  projectRoot: string,
  source: SpecDriftDeliverySource | null | undefined,
): { readonly before: string | null; readonly after: string | null } {
  const delivery = resolveDeliverySource(source);
  if (
    delivery === null ||
    delivery.baseCommit === null ||
    delivery.deliveryCommit === null ||
    delivery.baseCommit.trim().length === 0 ||
    delivery.deliveryCommit.trim().length === 0
  ) {
    return { before: null, after: null };
  }
  const root = resolve(projectRoot);
  let specRel: string;
  try {
    specRel = relative(root, resolveSpecArtifactPath(root)).replace(/\\/g, "/");
  } catch {
    return { before: null, after: null };
  }
  const runGit = delivery.runGit ?? defaultGitRunner;
  return {
    before: requirementsFingerprintAtCommit(root, specRel, delivery.baseCommit.trim(), runGit),
    after: requirementsFingerprintAtCommit(root, specRel, delivery.deliveryCommit.trim(), runGit),
  };
}

/**
 * Reused rewrite evidence across scopes (#6335): two `rewrite` coverage rows of
 * different scopes with the same before/after pair. One finding per later row.
 */
export function findReusedRewriteEvidence(
  coverage: readonly SpecDriftCoverageRecord[],
): SpecDriftFinding[] {
  const firstByPair = new Map<string, SpecDriftCoverageRecord>();
  const out: SpecDriftFinding[] = [];
  for (const row of coverage) {
    if (row.source !== "rewrite") continue;
    const key = `${row.beforeRequirementsFingerprint}\u0000${row.afterRequirementsFingerprint}`;
    const first = firstByPair.get(key);
    if (first === undefined) {
      firstByPair.set(key, row);
      continue;
    }
    if (first.scopeId === row.scopeId) continue;
    out.push({
      scopeId: row.scopeId,
      reason:
        `rewrite proof failed: before/after evidence already consumed (reused-evidence) ` +
        `by scope ${first.scopeId}`,
      specImpact: "delta",
      completedAt: row.recordedAt,
      uncoveredItemIds: [...row.coveredItemIds],
    });
  }
  return out;
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

/** Collect requirement id/ref strings from durable SPEC plan.requirements / metadata. */
function listDurableRequirementRefs(projectRoot: string): string[] {
  const data = readDurableSpec(projectRoot);
  if (data === null || !isRecord(data.plan)) return [];
  const plan = data.plan;
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.trim().length > 0) out.push(value.trim());
    else if (isRecord(value)) {
      if (typeof value.id === "string" && value.id.trim().length > 0) out.push(value.id.trim());
      else if (typeof value.ref === "string" && value.ref.trim().length > 0)
        out.push(value.ref.trim());
    }
  };
  if (Array.isArray(plan.requirements)) {
    for (const row of plan.requirements) push(row);
  }
  const metadata = isRecord(plan.metadata) ? plan.metadata : null;
  if (metadata !== null && Array.isArray(metadata.requirement_ids)) {
    for (const row of metadata.requirement_ids) push(row);
  }
  return [...new Set(out)];
}

export function durableSpecHasRequirementRefs(projectRoot: string): boolean {
  return listDurableRequirementRefs(projectRoot).length > 0;
}

/**
 * Collect affected requirement refs for rewrite proof (#5350 limb 4).
 * Union of: (1) covered item ids that equal durable requirement refs, and
 * (2) declared `x-directive/affectedRequirementRefs` on those items (must be
 * durable refs — inventing non-SPEC ids does not prove coverage). Item id `i1`
 * rewriting separately-identified `req-1` is valid when the item declares it.
 */
export function extractAffectedRequirementRefs(
  projectRoot: string,
  coveredItemIds: readonly string[],
  scopeData?: Record<string, unknown>,
): string[] {
  const refs = listDurableRequirementRefs(projectRoot);
  if (refs.length === 0) return [];
  const durable = new Set(refs);
  const out = new Set<string>();
  const covered = new Set(coveredItemIds.map(String));
  for (const id of covered) {
    if (durable.has(id)) out.add(id);
  }
  if (scopeData !== undefined && isRecord(scopeData.plan)) {
    for (const declared of collectDeclaredAffectedRequirementRefs(scopeData.plan, covered)) {
      if (durable.has(declared)) out.add(declared);
    }
  }
  return [...out];
}

function readDeclaredAffectedRefs(node: Record<string, unknown>): string[] {
  const raw = node[AFFECTED_REQUIREMENT_REFS_KEY] ?? node.affectedRequirementRefs;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(String)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function collectDeclaredAffectedRequirementRefs(
  plan: Record<string, unknown>,
  coveredItemIds: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (!isRecord(node)) return;
    const id = typeof node.id === "string" ? node.id : null;
    if (id !== null && coveredItemIds.has(id)) {
      out.push(...readDeclaredAffectedRefs(node));
    }
    if (Array.isArray(node.items)) {
      for (const child of node.items) walk(child);
    }
    if (Array.isArray(node.subItems)) {
      for (const child of node.subItems) walk(child);
    }
  };
  if (typeof plan.id === "string" && coveredItemIds.has(plan.id)) {
    out.push(...readDeclaredAffectedRefs(plan));
  }
  if (Array.isArray(plan.items)) {
    for (const child of plan.items) walk(child);
  }
  if (Array.isArray(plan.subItems)) {
    for (const child of plan.subItems) walk(child);
  }
  return out;
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
  /** When true, empty affected refs fail (SPEC exposes requirements). */
  readonly requireAffectedRefs?: boolean;
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
  const affected = [...(input.affectedRequirementRefs ?? [])];
  // Whole-SPEC fingerprint churn alone must not prove an unrelated scope's coverage
  // when the durable SPEC exposes requirement refs (#5350 limb 4 / Greptile P1).
  if (affected.length === 0 && input.requireAffectedRefs === true) {
    return {
      ok: false,
      reason:
        "rewrite proof failed: affected requirement refs required when durable SPEC has requirements (unrelated whole-SPEC churn is not coverage)",
    };
  }
  return {
    ok: true,
    record: {
      scopeId: input.scopeId,
      coveredItemIds: [...input.coveredItemIds],
      beforeRequirementsFingerprint: before,
      afterRequirementsFingerprint: after,
      affectedRequirementRefs: affected,
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

type LedgerLockResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

/**
 * Clear single-use spent marker after a failed lifecycle that already marked the grant.
 * Uses existing store load/save (no authz/** expansion — class 4 / #4980).
 */
function clearGrantUsedAt(projectRoot: string, grantId: string): HumanOriginGrant | null {
  const grant = loadGrant(projectRoot, grantId);
  if (grant === null) return null;
  if (!grant.semantics.singleUse) return grant;
  if (grant.semantics.usedAt === null) return grant;
  const restored: HumanOriginGrant = {
    ...grant,
    semantics: {
      ...grant.semantics,
      usedAt: null,
    },
  };
  const wrote = saveGrant(projectRoot, restored);
  if (!wrote.ok) return null;
  return restored;
}

function withLedgerLock<T>(
  projectRoot: string,
  enforcement: SpecGuardEnforcement,
  fn: () => T,
): LedgerLockResult<T> {
  if (enforcement !== "enforce") {
    return { ok: true, value: fn() };
  }
  const root = resolve(projectRoot);
  const lockPath = ledgerLockAbsPath(root);
  const lockBody = `${process.pid}\n${new Date().toISOString()}\n`;
  try {
    containedWrite({ root, target: lockPath, data: lockBody, mode: "create" });
  } catch (err) {
    const exists =
      err instanceof ContainedWriteError && err.code === ContainedWriteErrorCode.EXISTS;
    return {
      ok: false,
      message: exists
        ? `spec-drift ledger lock failed under enforce (${SPEC_DRIFT_LEDGER_LOCK_NAME}): lock held`
        : `spec-drift ledger lock failed under enforce (${SPEC_DRIFT_LEDGER_LOCK_NAME}): ${String(err)}`,
    };
  }
  try {
    return { ok: true, value: fn() };
  } finally {
    try {
      containedRemove({ root, target: lockPath });
    } catch {
      /* ignore */
    }
  }
}

export function writeSpecDriftLedger(
  projectRoot: string,
  ledger: SpecDriftLedger,
  options: {
    readonly enforcement?: SpecGuardEnforcement;
    /** Caller already holds withLedgerLock (full RMW). */
    readonly alreadyLocked?: boolean;
  } = {},
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
  const write = (): string => {
    containedWrite({
      root,
      target: rel,
      data: `${JSON.stringify(payload, null, 2)}\n`,
      mode: existsSync(abs) ? "replace" : "create",
    });
    return abs;
  };
  if (options.alreadyLocked === true || enforcement !== "enforce") {
    return write();
  }
  const locked = withLedgerLock(root, enforcement, write);
  // Lock refuse is returned-failure (empty path); callers that need enforce RMW
  // hold withLedgerLock themselves and pass alreadyLocked.
  if (!locked.ok) {
    return "";
  }
  return locked.value;
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

  // Reseed check+write under the same enforce lock so a concurrent completion
  // cannot land unresolved findings between the check and the empty replace.
  const apply = (): {
    readonly ok: boolean;
    readonly message: string;
    readonly baselineRevision: string | null;
  } => {
    const stillExists = hasLedgerFile(root);
    if (stillExists && options.reseed === true) {
      const prior = readLedger(root);
      if (prior.unresolved.length > 0) {
        return {
          ok: false,
          message:
            `spec-drift reseed refused: ${prior.unresolved.length} unresolved completion(s) remain — ` +
            "resolve coverage before reseeding (reseed must not erase known drift)",
          baselineRevision,
        };
      }
    }
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const ledger: SpecDriftLedger = {
      baselineRevision,
      unresolved: [],
      coverage: [],
      shadowFindings: [],
      // #6335: no stored last fingerprint; the rewrite proof reads delivery commits.
      lastRequirementsFingerprint: null,
      cutoverBoundary: options.reseed === true || !stillExists ? now : null,
    };
    writeSpecDriftLedger(root, ledger, {
      enforcement: "enforce",
      alreadyLocked: true,
    });
    return {
      ok: true,
      message: `spec-drift ledger ${options.reseed === true ? "reseeded" : "seeded"} at baseline ${baselineRevision}`,
      baselineRevision,
    };
  };

  const locked = withLedgerLock(root, "enforce", apply);
  if (!locked.ok) {
    return {
      ok: false,
      message: locked.message,
      baselineRevision,
    };
  }
  return locked.value;
}

/** Deep-clone the on-disk ledger for failed-move restore (pre-record snapshot). */
export function snapshotSpecDriftLedger(projectRoot: string): SpecDriftLedger {
  const ledger = readLedger(resolve(projectRoot));
  return {
    baselineRevision: ledger.baselineRevision,
    unresolved: ledger.unresolved.map((f) => ({ ...f })),
    coverage: ledger.coverage.map((c) => ({
      ...c,
      coveredItemIds: [...c.coveredItemIds],
      affectedRequirementRefs: [...c.affectedRequirementRefs],
    })),
    shadowFindings: ledger.shadowFindings.map((f) => ({ ...f })),
    lastRequirementsFingerprint: ledger.lastRequirementsFingerprint,
    cutoverBoundary: ledger.cutoverBoundary,
    rowFileScopes: [...(ledger.rowFileScopes ?? [])],
  };
}

/**
 * Surgical failed-move rollback (#5350 / #6335).
 * With a pre-record snapshot: restore THIS scope's one row file to the snapshot —
 * its prior rows, or absent when it had no row file then (legacy rows for the
 * scope apply again). Other scopes' row files and the ledger are not touched.
 * Without a snapshot: write an empty row file so the scope's rows are cleared.
 * Only clears single-use grants spent by THIS attempt (`spentGrantIds`).
 */
export function rollbackScopeCompleteDrift(
  projectRoot: string,
  scopeId: string,
  options: {
    readonly priorLedger?: SpecDriftLedger;
    readonly spentGrantIds?: readonly string[];
  } = {},
): { readonly ok: boolean; readonly message: string } {
  const root = resolve(projectRoot);
  const prior = options.priorLedger;
  const locked = withLedgerLock(root, "enforce", () => {
    if (!hasLedgerData(root) && prior === undefined) {
      return { ok: true, message: "no ledger to roll back" };
    }
    const current = readLedger(root);
    if (prior !== undefined) {
      const priorRows = scopeRows(prior, scopeId);
      const priorHadRowFile =
        prior.rowFileScopes !== undefined
          ? prior.rowFileScopes.includes(scopeId)
          : scopeHasRows(prior, scopeId);
      if (priorHadRowFile) {
        writeSpecDriftRowFile(root, { scopeId, ...priorRows });
      } else {
        removeSpecDriftRowFile(root, scopeId);
      }
      for (const grantId of options.spentGrantIds ?? []) {
        if (grantId.length > 0) clearGrantUsedAt(root, grantId);
      }
      return {
        ok: true,
        message: `surgically restored the pre-record row file for scope ${scopeId} (other scopes preserved)`,
      };
    }
    // Legacy path: scopeId wipe — only when no snapshot was captured.
    const grantIdsToClear =
      options.spentGrantIds ??
      current.coverage
        .filter((c) => c.scopeId === scopeId && typeof c.grantId === "string")
        .map((c) => c.grantId as string);
    if (scopeHasRows(current, scopeId) || (current.rowFileScopes ?? []).includes(scopeId)) {
      writeSpecDriftRowFile(root, { scopeId, unresolved: [], coverage: [], shadowFindings: [] });
    }
    for (const grantId of grantIdsToClear) {
      if (grantId.length > 0) clearGrantUsedAt(root, grantId);
    }
    return {
      ok: true,
      message: `rolled back spec-drift ledger rows for scope ${scopeId}`,
    };
  });
  if (!locked.ok) {
    return { ok: false, message: locked.message };
  }
  return locked.value;
}

/** Grant ids newly present on coverage after a record vs a prior snapshot (this scope only). */
export function spentGrantIdsSinceSnapshot(
  prior: SpecDriftLedger,
  current: SpecDriftLedger,
  scopeId?: string,
): string[] {
  const before = new Set(
    prior.coverage
      .filter((c) => scopeId === undefined || c.scopeId === scopeId)
      .map((c) => c.grantId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  const spent: string[] = [];
  for (const row of current.coverage) {
    if (scopeId !== undefined && row.scopeId !== scopeId) continue;
    if (typeof row.grantId === "string" && row.grantId.length > 0 && !before.has(row.grantId)) {
      spent.push(row.grantId);
    }
  }
  return spent;
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

  if (!hasLedgerData(root)) {
    // Under enforce, empty advise-era absence is unassessable until seed/cutover.
    // Under shadow, same state is a warning only — must not fail CI (#5350 limb 2/3).
    const msg =
      enforcement === "enforce"
        ? "verify:spec-drift: drift ledger missing under enforce — unassessable until seed/reseed or reconstruct (empty advise ledger is not proven)"
        : "verify:spec-drift: drift ledger missing — coverage unknown until scope-complete records or an operator seeds the ledger";
    if (enforcement === "shadow") {
      return {
        code: 0,
        state: "unassessable",
        message: `verify:spec-drift shadow warning: ${msg}`,
        findings: [],
        baselineRevision,
        guard,
      };
    }
    return {
      code: 2,
      state: "unassessable",
      message: msg,
      findings: [],
      baselineRevision,
      guard,
    };
  }

  // #6335: header + legacy rows + row files; reused rewrite evidence across all
  // of them counts as unresolved drift.
  const merged = readLedger(root);
  const ledger: SpecDriftLedger = {
    ...merged,
    // Row files carry no baseline. With no header file yet (never seeded), judge
    // the rows against the live baseline, as the first completion's write did
    // before #6335. Only seed/reseed write a header.
    baselineRevision: hasLedgerFile(root) ? merged.baselineRevision : baselineRevision,
    unresolved: [...merged.unresolved, ...findReusedRewriteEvidence(merged.coverage)],
  };

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
      const driftMsg =
        `verify:spec-drift: unresolved drift remains after baseline moved ` +
        `(ledger=${ledger.baselineRevision} live=${baselineRevision}); ` +
        `registry/render-only touches do not clear requirements/delta coverage`;
      if (enforcement === "shadow") {
        return {
          code: 0,
          state: "drift",
          message: `verify:spec-drift shadow warning: ${driftMsg}`,
          findings: ledger.unresolved,
          baselineRevision,
          guard,
          shadowFindings: ledger.shadowFindings,
        };
      }
      return {
        code: 1,
        state: "drift",
        message: driftMsg,
        findings: ledger.unresolved,
        baselineRevision,
        guard,
        shadowFindings: ledger.shadowFindings,
      };
    }
    const unresolvedMsg = `verify:spec-drift: ${ledger.unresolved.length} unresolved completion(s) lack requirements/delta coverage`;
    if (enforcement === "shadow") {
      return {
        code: 0,
        state: "drift",
        message: `verify:spec-drift shadow warning: ${unresolvedMsg}`,
        findings: ledger.unresolved,
        baselineRevision,
        guard,
        shadowFindings: ledger.shadowFindings,
      };
    }
    return {
      code: 1,
      state: "drift",
      message: unresolvedMsg,
      findings: ledger.unresolved,
      baselineRevision,
      guard,
      shadowFindings: ledger.shadowFindings,
    };
  }

  if (ledger.baselineRevision === null) {
    const unsetMsg =
      "verify:spec-drift: ledger present but baselineRevision unset — seed baseline before claiming clean";
    if (enforcement === "shadow") {
      return {
        code: 0,
        state: "unassessable",
        message: `verify:spec-drift shadow warning: ${unsetMsg}`,
        findings: [],
        baselineRevision,
        guard,
        shadowFindings: ledger.shadowFindings,
      };
    }
    return {
      code: 2,
      state: "unassessable",
      message: unsetMsg,
      findings: [],
      baselineRevision,
      guard,
      shadowFindings: ledger.shadowFindings,
    };
  }

  const mismatchMsg = `verify:spec-drift: ledger baseline ${ledger.baselineRevision} does not match live ${baselineRevision}`;
  if (enforcement === "shadow") {
    return {
      code: 0,
      state: "drift",
      message: `verify:spec-drift shadow warning: ${mismatchMsg}`,
      findings: [],
      baselineRevision,
      guard,
      shadowFindings: ledger.shadowFindings,
    };
  }
  return {
    code: 1,
    state: "drift",
    message: mismatchMsg,
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
  options: SpecDriftDeliveryOptions = {},
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

  // Limb 7: empty advise ledger is not proven under enforce.
  if (enforcement === "enforce" && !hasLedgerFile(root)) {
    return {
      ok: false,
      message:
        "scope:complete refused under specGuard enforce: drift ledger missing — unassessable until seed/reseed (empty advise ledger is not proven)",
      enforcement,
      finding: {
        scopeId: scopeIdFrom(scopeData, scopeRelPath),
        reason: "drift ledger missing under enforce",
        specImpact: null,
        completedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        uncoveredItemIds: [],
      },
      shadowFinding: null,
    };
  }

  const coverage = evaluateCompletionCoverage(scopeData, scopeRelPath, enforcement);
  const scopeId = scopeIdFrom(scopeData, scopeRelPath);
  const baselineRevision = resolveBaselineRevision(root);
  const ledger = readLedger(root);

  let finding = coverage.finding;

  // Override hatch may discharge uncovered (missing impact) item ids (#5350 limb 5).
  const uncoveredForOverride = finding?.uncoveredItemIds ?? [];
  if (finding !== null && uncoveredForOverride.length > 0 && baselineRevision !== null) {
    const grant = findLiveSpecDriftOverrideGrant(
      root,
      scopeId,
      uncoveredForOverride,
      baselineRevision,
    );
    if (grant !== null) {
      finding = null;
    }
  }

  if (finding === null && coverage.needsRewriteProof) {
    const affected = extractAffectedRequirementRefs(root, coverage.deltaOrNewItemIds, scopeData);
    // #6335: both ends from the story's own delivery; reuse over every other scope's rows.
    const fps = resolveDeliveryRequirementsFingerprints(root, options.delivery);
    const proof = evaluateRewriteProof({
      scopeId,
      coveredItemIds: coverage.deltaOrNewItemIds,
      beforeFingerprint: fps.before,
      afterFingerprint: fps.after,
      existingCoverage: ledger.coverage.filter((c) => c.scopeId !== scopeId),
      affectedRequirementRefs: affected,
      requireAffectedRefs: durableSpecHasRequirementRefs(root),
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
      message: finding !== null ? `spec-drift shadow warning: ${finding.reason}` : "",
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
 * Under enforce, ledger lock refuse returns a finding (fail closed, no throw).
 * Shadow records warnings without refuse.
 */
export function recordScopeCompleteDrift(
  projectRoot: string,
  scopeData: Record<string, unknown>,
  scopeRelPath: string,
  options: SpecDriftDeliveryOptions = {},
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

  if (enforcement === "advise") {
    return recordAdvisePath(root, scopeData, scopeRelPath, scopeId);
  }

  const mutate = (): SpecDriftFinding | null => {
    const coverage = evaluateCompletionCoverage(scopeData, scopeRelPath, enforcement);
    const ledger = readLedger(root);
    // #6335: both proof ends from the story's own delivery, resolved on first use.
    let fps: { readonly before: string | null; readonly after: string | null } | null = null;
    const deliveryFps = (): { readonly before: string | null; readonly after: string | null } => {
      fps ??= resolveDeliveryRequirementsFingerprints(root, options.delivery);
      return fps;
    };
    const hadScopeRecord =
      scopeHasRows(ledger, scopeId) || (ledger.rowFileScopes ?? []).includes(scopeId);
    const own = scopeRows(ledger, scopeId);
    // Reused evidence: every other scope's rows (row files and legacy rows).
    const otherCoverage = ledger.coverage.filter((c) => c.scopeId !== scopeId);

    let coverageRecords = [...own.coverage];
    let unresolved: SpecDriftFinding[] = [];
    let shadowFindings: SpecDriftFinding[] = [];
    let finding: SpecDriftFinding | null = coverage.finding;

    // Override hatch may discharge uncovered (missing impact) item ids.
    const uncoveredForOverride = finding?.uncoveredItemIds ?? [];
    if (finding !== null && uncoveredForOverride.length > 0 && baselineRevision !== null) {
      const grant = findLiveSpecDriftOverrideGrant(
        root,
        scopeId,
        uncoveredForOverride,
        baselineRevision,
      );
      if (grant !== null) {
        markGrantUsed(root, grant.id);
        coverageRecords = [
          {
            scopeId,
            coveredItemIds: [...uncoveredForOverride],
            beforeRequirementsFingerprint: deliveryFps().before ?? "override",
            afterRequirementsFingerprint: deliveryFps().after ?? "override",
            affectedRequirementRefs: [],
            recordedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
            source: "override",
            grantId: grant.id,
          },
        ];
        finding = null;
      }
    }

    if (finding === null && coverage.needsRewriteProof) {
      const affected = extractAffectedRequirementRefs(root, coverage.deltaOrNewItemIds, scopeData);
      const proof = evaluateRewriteProof({
        scopeId,
        coveredItemIds: coverage.deltaOrNewItemIds,
        beforeFingerprint: deliveryFps().before,
        afterFingerprint: deliveryFps().after,
        existingCoverage: otherCoverage,
        affectedRequirementRefs: affected,
        requireAffectedRefs: durableSpecHasRequirementRefs(root),
      });
      if (proof.ok) {
        coverageRecords = [proof.record];
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
            {
              scopeId,
              coveredItemIds: [...coverage.deltaOrNewItemIds],
              beforeRequirementsFingerprint: deliveryFps().before ?? "override",
              afterRequirementsFingerprint: deliveryFps().after ?? "override",
              affectedRequirementRefs: affected,
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
        shadowFindings = [finding];
      } else {
        unresolved = [finding];
      }
    }

    // #6335: nothing to record and no earlier record for this scope → no row file.
    if (
      !hadScopeRecord &&
      unresolved.length === 0 &&
      shadowFindings.length === 0 &&
      coverageRecords.length === 0
    ) {
      return null;
    }

    // One row file per story; the ledger file is not written.
    writeSpecDriftRowFile(root, {
      scopeId,
      unresolved,
      coverage: coverageRecords,
      shadowFindings,
    });
    return enforcement === "shadow" ? null : finding;
  };

  // Limb 7: under enforce, lock the full read-modify-write so concurrent completions
  // cannot overwrite each other's coverage/findings.
  if (enforcement === "enforce") {
    const locked = withLedgerLock(root, enforcement, mutate);
    if (!locked.ok) {
      return {
        scopeId,
        reason: locked.message,
        specImpact: null,
        completedAt: null,
      };
    }
    return locked.value;
  }
  return mutate();
}

/**
 * Advise record (#6335): the scope's row file holds its finding, or is written
 * empty when a retry clears a finding that the ledger or an earlier row file
 * holds. The scope's coverage and shadow rows carry over unchanged.
 */
function recordAdvisePath(
  root: string,
  scopeData: Record<string, unknown>,
  scopeRelPath: string,
  scopeId: string,
): SpecDriftFinding | null {
  const finding = findingFromScopeCompletionAdvise(scopeData, scopeRelPath);
  const rowScopeId = finding?.scopeId ?? scopeId;
  const ledger = readLedger(root);
  const own = scopeRows(ledger, rowScopeId);
  const hadScopeRecord =
    scopeHasRows(ledger, rowScopeId) || (ledger.rowFileScopes ?? []).includes(rowScopeId);

  if (finding === null) {
    if (!hadScopeRecord) {
      return null;
    }
    writeSpecDriftRowFile(root, {
      scopeId: rowScopeId,
      unresolved: [],
      coverage: own.coverage,
      shadowFindings: own.shadowFindings,
    });
    return null;
  }

  writeSpecDriftRowFile(root, {
    scopeId: rowScopeId,
    unresolved: [finding],
    coverage: own.coverage,
    shadowFindings: own.shadowFindings,
  });
  return finding;
}

/** Back-compat alias used by specification-sync (#1589 C2). */
export function recordScopeCompleteDriftAdvise(
  projectRoot: string,
  scopeData: Record<string, unknown>,
  scopeRelPath: string,
  options: SpecDriftDeliveryOptions = {},
): SpecDriftFinding | null {
  return recordScopeCompleteDrift(projectRoot, scopeData, scopeRelPath, options);
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
