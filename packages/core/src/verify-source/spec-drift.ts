/**
 * Semantic spec-vs-reality drift audit (#1589 Prefer-A Bound C2).
 *
 * Three-state: 0 clean / 1 drift / 2 unassessable|config.
 * Distinct from fail-closed verify:spec-prd-fresh (banner/projection freshness).
 * Discharge only against baseline revision + per-completion requirements/delta coverage.
 */

import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { resolveAuditPath, resolveLifecycleRoot, resolveSpecArtifactPath } from "../layout/resolve.js";
import {
  type SpecGuardResolved,
  resolveSpecGuard,
  SPEC_IMPACT_KEY,
  readSpecImpact,
} from "../policy/spec-guard.js";

export const SPEC_DRIFT_LEDGER_NAME = "spec-drift-ledger.json";

export interface SpecDriftFinding {
  readonly scopeId: string;
  readonly reason: string;
  readonly specImpact: string | null;
  readonly completedAt: string | null;
}

export interface SpecDriftLedger {
  readonly baselineRevision: string | null;
  readonly unresolved: SpecDriftFinding[];
}

export interface SpecDriftResult {
  readonly code: 0 | 1 | 2;
  readonly state: "clean" | "drift" | "unassessable";
  readonly message: string;
  readonly findings: readonly SpecDriftFinding[];
  readonly baselineRevision: string | null;
  readonly guard: SpecGuardResolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLedger(projectRoot: string): SpecDriftLedger {
  const path = resolveAuditPath(projectRoot, SPEC_DRIFT_LEDGER_NAME);
  if (!existsSync(path)) {
    return { baselineRevision: null, unresolved: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(raw)) return { baselineRevision: null, unresolved: [] };
    const baselineRevision =
      typeof raw.baselineRevision === "string" ? raw.baselineRevision : null;
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
        });
      }
    }
    return { baselineRevision, unresolved };
  } catch {
    return { baselineRevision: null, unresolved: [] };
  }
}

function resolveBaselineRevision(projectRoot: string): string | null {
  try {
    const specPath = resolveSpecArtifactPath(projectRoot);
    if (!existsSync(specPath)) return null;
    const text = readFileSync(specPath, "utf8");
    const data = JSON.parse(text) as unknown;
    if (!isRecord(data)) return null;
    const info = isRecord(data.xBRIEFInfo)
      ? data.xBRIEFInfo
      : isRecord(data.vBRIEFInfo)
        ? data.vBRIEFInfo
        : null;
    if (info !== null && typeof info.updated === "string") return info.updated;
    if (isRecord(data.plan) && typeof data.plan.id === "string") return data.plan.id;
    return `bytes:${text.length}`;
  } catch {
    return null;
  }
}

/** Evaluate semantic drift for audit / advise surfaces. */
export function evaluateSpecDrift(projectRoot: string): SpecDriftResult {
  const root = resolve(projectRoot);
  let hasSpec = false;
  try {
    hasSpec = existsSync(resolveSpecArtifactPath(root));
  } catch {
    hasSpec = false;
  }
  const guard = resolveSpecGuard(root, { hasSpecification: hasSpec });

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

  const ledger = readLedger(root);
  // Discharge only when ledger baseline matches live revision AND unresolved is empty.
  if (
    ledger.baselineRevision !== null &&
    ledger.baselineRevision === baselineRevision &&
    ledger.unresolved.length === 0
  ) {
    return {
      code: 0,
      state: "clean",
      message: `verify:spec-drift: clean against baseline ${baselineRevision}`,
      findings: [],
      baselineRevision,
      guard,
    };
  }

  if (ledger.unresolved.length > 0) {
    // Stale ledger against a different baseline cannot clear by registry/render alone.
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
      };
    }
    return {
      code: 1,
      state: "drift",
      message: `verify:spec-drift: ${ledger.unresolved.length} unresolved completion(s) lack requirements/delta coverage`,
      findings: ledger.unresolved,
      baselineRevision,
      guard,
    };
  }

  return {
    code: 0,
    state: "clean",
    message: `verify:spec-drift: clean (no unresolved ledger rows) baseline=${baselineRevision}`,
    findings: [],
    baselineRevision,
    guard,
  };
}

export interface SpecDriftCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runSpecDriftCli(argv: string[]): SpecDriftCliResult {
  let projectRoot = ".";
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { exitCode: 2, stdout: "", stderr: "argument --project-root: expected one argument\n" };
      }
      projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      return {
        exitCode: 0,
        stdout:
          "Usage: verify:spec-drift [--project-root <dir>] [--json]\n" +
          "Three-state semantic drift audit (0 clean / 1 drift / 2 unassessable). Distinct from verify:spec-prd-fresh.\n",
        stderr: "",
      };
    } else if (arg !== undefined && arg.length > 0) {
      return { exitCode: 2, stdout: "", stderr: `unknown argument: ${arg}\n` };
    }
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
  const text = `${result.message}\n`;
  return {
    exitCode: result.code,
    stdout: stream === "stdout" ? text : "",
    stderr: stream === "stderr" ? text : "",
  };
}

export function writeSpecDriftLedger(projectRoot: string, ledger: SpecDriftLedger): string {
  const root = resolve(projectRoot);
  const abs = resolveAuditPath(root, SPEC_DRIFT_LEDGER_NAME);
  const rel = relative(root, abs).replace(/\\/g, "/");
  containedWrite({
    root,
    target: rel,
    data: `${JSON.stringify(ledger, null, 2)}\n`,
    mode: existsSync(abs) ? "replace" : "create",
  });
  return abs;
}

/** Record advise-mode drift for a completing scope (extends #2566 sync hook). */
export function recordScopeCompleteDriftAdvise(
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

  const finding = findingFromScopeCompletion(scopeData, scopeRelPath);
  if (finding === null) return null;

  const baselineRevision = resolveBaselineRevision(root);
  const ledger = readLedger(root);
  const next: SpecDriftLedger = {
    baselineRevision: ledger.baselineRevision ?? baselineRevision,
    unresolved: [
      ...ledger.unresolved.filter((f) => f.scopeId !== finding.scopeId),
      finding,
    ],
  };
  writeSpecDriftLedger(root, next);
  return finding;
}

/** Build a ledger finding from a completing scope brief (used by specification-sync). */
export function findingFromScopeCompletion(
  scopeData: Record<string, unknown>,
  scopeRelPath: string,
): SpecDriftFinding | null {
  const plan = isRecord(scopeData.plan) ? scopeData.plan : null;
  if (plan === null) return null;
  const items = Array.isArray(plan.items) ? plan.items : [];
  let impact = readSpecImpact(plan);
  for (const item of items) {
    if (!isRecord(item)) continue;
    const itemImpact = readSpecImpact(item);
    if (itemImpact === "delta" || itemImpact === "new") {
      impact = itemImpact;
      break;
    }
    if (impact === null && itemImpact === "none") impact = "none";
  }
  // Bare plan.policy / bare specImpact keys do not count (#1650).
  if (typeof plan.specImpact === "string" && impact === null) {
    // ignore bare key
  }
  if (impact === "delta" || impact === "new") {
    return null;
  }
  const title = typeof plan.title === "string" ? plan.title : scopeRelPath;
  const tags = Array.isArray(plan.tags) ? plan.tags.map(String) : [];
  const shapeChanging =
    tags.some((t) => /rfc|adr|epic|requirement/i.test(t)) ||
    /rfc|adr|epic/i.test(title) ||
    items.length > 0;
  if (!shapeChanging && impact === "none") {
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
