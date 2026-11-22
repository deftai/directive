/**
 * Activation-PR carry of human-minted scope records (#6937).
 *
 * An activation PR may carry `.deft/observable-scope/<f>.json` and
 * `.deft/intent-constraint/<f>.json` and stay brief-land shaped only when each
 * record parses, names a nonremoved brief the same PR adds or changes, that
 * brief's `plan.id` equals the record's `planId`, `<f>` is the sanitized plan
 * id, and the record's `changeKind` and contract digest equal the brief's
 * contract. Anything else leaves the PR not brief-land shaped, as before.
 *
 * This is a shape check, not authentication: CI cannot tell a mint from a file
 * an agent wrote, so the record's control is the merge that lands it.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  computeContractDigest as computeIntentContractDigest,
  extractIntentConstraintFromPlan,
  intentConstraintSafePlanId,
  parseIntentConstraintContract,
  parseIntentConstraintRecord,
} from "../intent-constraint/mint.js";
import {
  computeContractDigest as computeObservableContractDigest,
  extractObservableChangeFromPlan,
  observableScopeSafePlanId,
  parseObservableChangeContract,
  parseObservableScopeRecord,
} from "../observable-scope/mint.js";

/** Reads a PR-head file by repo-relative path; null when absent or unreadable. */
export type ReadHeadFileFn = (relPath: string) => string | null;

export interface BriefLandRecordDiffPath {
  readonly status: string;
  readonly path: string;
  readonly previousFilename?: string;
}

const RECORD_PATH_RE = /^\.deft\/(observable-scope|intent-constraint)\/([^/]+)\.json$/;
const NONTERMINAL_BRIEF_RE = /^(xbrief|vbrief)\/(proposed|pending|active)\//;

function norm(path: string): string {
  return path.replace(/\\/g, "/");
}

/** True for a path in one of the two human-minted scope record folders. */
export function isScopeRecordPath(path: string): boolean {
  return RECORD_PATH_RE.test(norm(path));
}

/** Reader over a checkout root; refuses absolute and escaping paths. */
export function briefLandHeadReader(root: string): ReadHeadFileFn {
  const base = resolve(root);
  return (relPath: string) => {
    const rel = norm(relPath);
    if (rel.length === 0 || isAbsolute(rel) || rel.split("/").includes("..")) return null;
    const full = join(base, ...rel.split("/"));
    try {
      return existsSync(full) ? readFileSync(full, "utf8") : null;
    } catch {
      return null;
    }
  };
}

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function planOf(payload: unknown): Record<string, unknown> | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const plan = (payload as Record<string, unknown>).plan;
  return plan !== null && typeof plan === "object" && !Array.isArray(plan)
    ? (plan as Record<string, unknown>)
    : null;
}

/**
 * Whether one record path in a PR diff matches a brief that PR adds or changes.
 * `files` is the whole PR diff; `readHeadFile` reads PR-head bytes.
 */
export function evaluateBriefLandScopeRecord(args: {
  readonly file: BriefLandRecordDiffPath;
  readonly files: readonly BriefLandRecordDiffPath[];
  readonly readHeadFile?: ReadHeadFileFn;
}): { ok: true } | { ok: false; reason: string } {
  const path = norm(args.file.path);
  const match = RECORD_PATH_RE.exec(path);
  if (match === null) return { ok: false, reason: `${path} is not a scope record path` };
  const kind = match[1] as "observable-scope" | "intent-constraint";
  const stem = match[2] ?? "";
  const status = args.file.status.toLowerCase();
  if (status !== "added" && status !== "modified") {
    return { ok: false, reason: `${path} is ${status}; only an added or changed record rides` };
  }
  if (typeof args.file.previousFilename === "string" && args.file.previousFilename.length > 0) {
    return { ok: false, reason: `${path} is a rename` };
  }
  if (args.readHeadFile === undefined) {
    return { ok: false, reason: `${path} cannot be read to match a brief` };
  }
  const raw = parseJson(args.readHeadFile(path));
  const record =
    kind === "observable-scope"
      ? parseObservableScopeRecord(raw)
      : parseIntentConstraintRecord(raw);
  if ("error" in record) return { ok: false, reason: `${path} does not parse: ${record.error}` };
  const safe =
    kind === "observable-scope"
      ? observableScopeSafePlanId(record.planId)
      : intentConstraintSafePlanId(record.planId);
  if (stem !== safe) {
    return { ok: false, reason: `${path} is not named for plan id ${record.planId}` };
  }
  const briefPath = norm(record.xbriefRelPath);
  const brief = args.files.find(
    (f) => norm(f.path) === briefPath && f.status.toLowerCase() !== "removed",
  );
  if (brief === undefined || !NONTERMINAL_BRIEF_RE.test(briefPath)) {
    return {
      ok: false,
      reason: `${path} names ${briefPath}, which this PR does not add or change`,
    };
  }
  const payload = parseJson(args.readHeadFile(briefPath));
  const plan = planOf(payload);
  const planId = typeof plan?.id === "string" ? plan.id.trim() : "";
  if (planId !== record.planId) {
    return { ok: false, reason: `${path} plan id does not match ${briefPath}` };
  }
  if (kind === "observable-scope") {
    const contract = parseObservableChangeContract(extractObservableChangeFromPlan(payload));
    if ("error" in contract) return { ok: false, reason: `${briefPath}: ${contract.error}` };
    if (!("changeKind" in record) || contract.changeKind !== record.changeKind) {
      return { ok: false, reason: `${path} changeKind does not match ${briefPath}` };
    }
    const digest = computeObservableContractDigest({
      allowedChanges: contract.allowedChanges,
      mustPreserve: contract.mustPreserve,
    });
    if (digest !== record.contractDigest) {
      return { ok: false, reason: `${path} contract does not match ${briefPath}` };
    }
    return { ok: true };
  }
  const contract = parseIntentConstraintContract(extractIntentConstraintFromPlan(payload));
  if ("error" in contract) return { ok: false, reason: `${briefPath}: ${contract.error}` };
  if (computeIntentContractDigest(contract.constraints) !== record.contractDigest) {
    return { ok: false, reason: `${path} contract does not match ${briefPath}` };
  }
  return { ok: true };
}
