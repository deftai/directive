/**
 * Completed lifecycle consistency verifier (#3242 / epic #3237 Q4).
 *
 * Simple fail-closed rule for stories:
 * 1. File in `completed/` must have plan.status matching a completed-folder
 *    terminal status (`completed` or `failed` per D2/D13).
 * 2. Every plan.items entry (and nested items/subItems) must be terminal
 *    (not pending/proposed/running).
 *
 * Used by doctor (corpus scan) and scope:complete (post-reconcile assert).
 * Does not couple history/changes ledgers.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  hasArtifactSuffix,
  LEGACY_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_DIR,
} from "../layout/resolve.js";
import { FOLDER_ALLOWED_STATUSES } from "../vbrief-validate/constants.js";

/** Item statuses that still represent unfinished checklist work (#2862 / #3240 / #3242). */
export const NON_TERMINAL_ITEM_STATUSES = new Set(["pending", "proposed", "running"]);

/** Statuses allowed under completed/ (D2/D13). */
export const COMPLETED_FOLDER_PLAN_STATUSES: ReadonlySet<string> =
  FOLDER_ALLOWED_STATUSES.completed as ReadonlySet<string>;

export type CompletedConsistencyKind = "status_mismatch" | "open_items" | "unreadable";

export interface OpenItemHit {
  readonly path: string;
  readonly status: string;
  readonly title: string;
}

export interface CompletedConsistencyFinding {
  /** Lifecycle-relative path, e.g. `completed/foo.xbrief.json`. */
  readonly relPath: string;
  readonly planStatus: string;
  readonly folder: "completed";
  readonly kind: CompletedConsistencyKind;
  /** Human detail including exact path + statuses. */
  readonly detail: string;
  readonly openItems?: readonly OpenItemHit[];
}

export interface CompletedConsistencyResult {
  readonly ok: boolean;
  readonly findings: readonly CompletedConsistencyFinding[];
  readonly message: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  /* v8 ignore next 3 -- non-object / array inputs */
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function itemLabel(item: Record<string, unknown>, path: string): string {
  if (typeof item.title === "string" && item.title.trim().length > 0) {
    return item.title.trim();
  }
  if (typeof item.id === "string" && item.id.trim().length > 0) {
    return item.id.trim();
  }
  return path;
}

/**
 * Collect non-terminal plan.items / subItems / nested items.
 */
export function collectOpenPlanItems(items: unknown, pathPrefix = "plan.items"): OpenItemHit[] {
  const hits: OpenItemHit[] = [];
  if (!Array.isArray(items)) {
    return hits;
  }
  items.forEach((item, index) => {
    const path = `${pathPrefix}[${index}]`;
    const rec = asRecord(item);
    /* v8 ignore next -- skip non-object item slots */
    if (rec === null) return;
    const status = String(rec.status ?? "").trim();
    if (NON_TERMINAL_ITEM_STATUSES.has(status) || status.length === 0) {
      hits.push({
        path,
        status: status.length > 0 ? status : "(empty)",
        title: itemLabel(rec, path),
      });
    }
    hits.push(...collectOpenPlanItems(rec.subItems, `${path}.subItems`));
    hits.push(...collectOpenPlanItems(rec.items, `${path}.items`));
  });
  return hits;
}

/**
 * Evaluate Q4 consistency for a single plan that claims completed lifecycle.
 *
 * @param plan - plan object
 * @param options.relPath - artifact path for messages (default `plan`)
 * @param options.requireStatus - when set, plan.status must equal this exactly
 *   (scope:complete uses `completed`). When omitted, any completed-folder
 *   terminal status (completed|failed) is accepted.
 */
export function evaluateCompletedPlanConsistency(
  plan: Record<string, unknown>,
  options: { relPath?: string; requireStatus?: string } = {},
): CompletedConsistencyResult {
  const relPath = options.relPath ?? "plan";
  const rawStatus = plan.status;
  const planStatus =
    typeof rawStatus === "string" && rawStatus.trim().length > 0 ? rawStatus.trim() : "(empty)";

  const findings: CompletedConsistencyFinding[] = [];

  const statusOk =
    options.requireStatus !== undefined
      ? planStatus === options.requireStatus
      : COMPLETED_FOLDER_PLAN_STATUSES.has(planStatus);

  if (!statusOk) {
    const expected =
      options.requireStatus !== undefined
        ? options.requireStatus
        : [...COMPLETED_FOLDER_PLAN_STATUSES].sort().join("|");
    findings.push({
      relPath,
      planStatus,
      folder: "completed",
      kind: "status_mismatch",
      detail:
        `${relPath}: folder=completed plan.status=${planStatus} ` + `expected=${expected} (#3242)`,
    });
  }

  const openItems = collectOpenPlanItems(plan.items);
  if (openItems.length > 0) {
    const itemLines = openItems.map((h) => `${h.path} "${h.title}" status=${h.status}`).join("; ");
    findings.push({
      relPath,
      planStatus,
      folder: "completed",
      kind: "open_items",
      detail:
        `${relPath}: folder=completed plan.status=${planStatus} has ` +
        `${openItems.length} non-terminal plan.items: ${itemLines} (#3242)`,
      openItems,
    });
  }

  if (findings.length === 0) {
    return {
      ok: true,
      findings: [],
      message:
        `Completed lifecycle consistency OK (#3242): ${relPath} ` +
        `folder=completed plan.status=${planStatus} items=terminal`,
    };
  }

  return {
    ok: false,
    findings,
    message: formatCompletedConsistencyFailure(findings),
  };
}

/** Format fail-closed doctor/complete message with exact paths and statuses. */
export function formatCompletedConsistencyFailure(
  findings: readonly CompletedConsistencyFinding[],
): string {
  const lines = findings.map((f) => `  - ${f.detail}`);
  return (
    `Completed lifecycle consistency failed (#3242). ` +
    `${findings.length} finding(s):\n${lines.join("\n")}\n` +
    `Rule: completed/ requires plan.status in ` +
    `[${[...COMPLETED_FOLDER_PLAN_STATUSES].sort().join("|")}] and every ` +
    `plan.items entry terminal (not pending|proposed|running).`
  );
}

type RootProbe =
  | { kind: "dir"; absRoot: string; dirName: string }
  | { kind: "unreadable"; dirName: string; detail: string };

/**
 * Lifecycle inventory roots that may host completed/ artifacts.
 * Scans both canonical xbrief/ and read-accepted legacy vbrief/ when present
 * (mixed roots must not green-skip retained legacy completed corpus).
 * Existing roots that cannot be inspected produce unreadable findings (fail closed).
 */
function listConsistencyLifecycleRoots(projectRoot: string): readonly RootProbe[] {
  const root = resolve(projectRoot);
  const ordered: RootProbe[] = [];
  const seen = new Set<string>();

  const consider = (absRoot: string, dirName: string): void => {
    const key = absRoot.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    let exists: boolean;
    try {
      exists = existsSync(absRoot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ordered.push({
        kind: "unreadable",
        dirName,
        detail: `lifecycle root existsSync failed: ${msg}`,
      });
      return;
    }
    if (!exists) return;

    try {
      if (!statSync(absRoot).isDirectory()) return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ordered.push({
        kind: "unreadable",
        dirName,
        detail: `lifecycle root unreadable (stat failed): ${msg}`,
      });
      return;
    }
    ordered.push({ kind: "dir", absRoot, dirName });
  };

  // Always probe both layout dirs so mixed roots cannot green-skip legacy completed/.
  consider(join(root, MIGRATED_ARTIFACT_DIR), MIGRATED_ARTIFACT_DIR);
  consider(join(root, LEGACY_ARTIFACT_DIR), LEGACY_ARTIFACT_DIR);
  return ordered;
}

function unreadableFinding(relPath: string, detail: string): CompletedConsistencyFinding {
  return {
    relPath,
    planStatus: "(unreadable)",
    folder: "completed",
    kind: "unreadable",
    detail: `${relPath}: ${detail} (#3242)`,
  };
}

function scanCompletedDir(
  completedDir: string,
  pathPrefix: string,
): { findings: CompletedConsistencyFinding[]; scanned: number; completedPresent: boolean } {
  let completedPresent = false;
  try {
    if (!existsSync(completedDir)) {
      return { findings: [], scanned: 0, completedPresent: false };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      findings: [
        unreadableFinding(
          `${pathPrefix}/completed`,
          `completed/ existsSync failed (cannot inventory): ${msg}`,
        ),
      ],
      scanned: 0,
      completedPresent: true,
    };
  }

  try {
    if (!statSync(completedDir).isDirectory()) {
      return { findings: [], scanned: 0, completedPresent: false };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      findings: [
        unreadableFinding(
          `${pathPrefix}/completed`,
          `completed/ unreadable (stat failed): ${msg}`,
        ),
      ],
      scanned: 0,
      completedPresent: true,
    };
  }
  completedPresent = true;

  let names: string[];
  try {
    names = readdirSync(completedDir)
      .filter((n) => hasArtifactSuffix(n))
      .sort();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      findings: [
        unreadableFinding(
          `${pathPrefix}/completed`,
          `completed/ readdir failed (cannot inventory): ${msg}`,
        ),
      ],
      scanned: 0,
      completedPresent: true,
    };
  }

  const findings: CompletedConsistencyFinding[] = [];
  for (const name of names) {
    const relPath = `${pathPrefix}/completed/${name}`;
    const abs = join(completedDir, name);
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(abs, "utf8")) as unknown;
    } catch {
      findings.push(
        unreadableFinding(relPath, "malformed JSON under completed/ (cannot verify status/items)"),
      );
      continue;
    }
    const root = asRecord(data);
    if (root === null) {
      findings.push(
        unreadableFinding(relPath, "non-object root under completed/ (cannot verify status/items)"),
      );
      continue;
    }
    const plan = asRecord(root.plan);
    if (plan === null) {
      findings.push(unreadableFinding(relPath, "missing or non-object plan under completed/"));
      continue;
    }
    const result = evaluateCompletedPlanConsistency(plan, { relPath });
    findings.push(...result.findings);
  }
  return { findings, scanned: names.length, completedPresent };
}

/**
 * Scan `xbrief/completed/` and/or legacy `vbrief/completed/` for Q4 mismatches.
 * Offline / filesystem only. Missing completed/ is green (nothing to check).
 * Malformed completed artifacts and unreadable roots fail closed (no silent skip).
 * Mixed roots scan both.
 */
export function scanCompletedLifecycleConsistency(projectRoot: string): CompletedConsistencyResult {
  const roots = listConsistencyLifecycleRoots(projectRoot);
  if (roots.length === 0) {
    return {
      ok: true,
      findings: [],
      message: "Completed lifecycle consistency OK (#3242): no lifecycle root",
    };
  }

  const findings: CompletedConsistencyFinding[] = [];
  let scanned = 0;
  let anyCompletedPresent = false;

  for (const probe of roots) {
    if (probe.kind === "unreadable") {
      findings.push(unreadableFinding(probe.dirName, probe.detail));
      continue;
    }
    const completedDir = join(probe.absRoot, "completed");
    // Always prefix with layout dir so mixed roots and exact paths are unambiguous.
    const part = scanCompletedDir(completedDir, probe.dirName);
    if (part.completedPresent) {
      anyCompletedPresent = true;
    }
    findings.push(...part.findings);
    scanned += part.scanned;
  }

  if (!anyCompletedPresent && findings.length === 0) {
    return {
      ok: true,
      findings: [],
      message: "Completed lifecycle consistency OK (#3242): completed/ absent",
    };
  }

  if (findings.length === 0) {
    return {
      ok: true,
      findings: [],
      message:
        `Completed lifecycle consistency OK (#3242): scanned ${scanned} ` +
        `completed/ artifact(s)`,
    };
  }

  return {
    ok: false,
    findings,
    message: formatCompletedConsistencyFailure(findings),
  };
}
