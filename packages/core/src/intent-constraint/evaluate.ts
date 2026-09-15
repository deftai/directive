/**
 * verify:intent-constraint (#4541).
 *
 * Merge-base snapshot of throw/reject/abort sites and new numeric consts in
 * changed production .ts/.js. Authority is git show merge-base only.
 * Tests and in-scope paths are not authority. P2 is not first-ship.
 *
 * Mint selection: --plan-id, DEFT_ACTIVE_SCOPE, or dest unique running xBRIEF.
 * Multiple merge-base mints without that pin fail closed. Do not take
 * records[0] by ls-tree/Map order.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveDefaultBaseRef } from "../evaluator-surface/evaluate.js";
import { normalizePath } from "../orchestration/pathspec.js";
import { newFacts, uncoveredDeltas } from "./diff.js";
import { extractConstraintFacts, isProductionSourcePath, surfaceSnapshot } from "./extract.js";
import { intentConstraintRecordRel, parseIntentConstraintRecord } from "./mint.js";
import {
  INTENT_CONSTRAINT_DIR,
  INTENT_CONSTRAINT_REMEDIATION,
  type IntentConstraintFinding,
  type IntentConstraintRecord,
  type SurfaceSnapshot,
} from "./types.js";

export type OutputStream = "stdout" | "stderr" | "none";

export interface EvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
  readonly skipped?: boolean;
  readonly findings?: readonly IntentConstraintFinding[];
}

export interface EvaluateOptions {
  readonly projectRoot?: string;
  readonly originRef?: string;
  readonly staged?: boolean;
  readonly quiet?: boolean;
  readonly changedFiles?: readonly string[];
  readonly recordTextsAtBase?: ReadonlyMap<string, string>;
  readonly readAtBase?: (relPath: string) => string | null;
  readonly readAtHead?: (relPath: string) => string | null;
  readonly mergeBase?: string;
  readonly planId?: string;
}

function runGit(projectRoot: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", ["-C", projectRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

export function resolveMergeBase(
  projectRoot: string,
  originRef?: string,
): string | { error: string } {
  let base = originRef;
  if (base === undefined || base.length === 0) {
    const resolved = resolveDefaultBaseRef(projectRoot);
    if (typeof resolved !== "string") return resolved;
    base = resolved;
  }
  const mb = runGit(projectRoot, ["merge-base", "HEAD", base]);
  if (mb === null || mb.length === 0) {
    return { error: `could not compute merge-base of HEAD and ${base}` };
  }
  return mb;
}

function gitNameOnlyDiff(projectRoot: string, args: string[]): string[] | { error: string } {
  try {
    const stdout = execFileSync("git", ["-C", projectRoot, "diff", "--name-only", ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(normalizePath);
  } catch (err: unknown) {
    return { error: String(err) };
  }
}

function gitShow(projectRoot: string, rev: string, relPath: string): string | null {
  try {
    return execFileSync("git", ["-C", projectRoot, "show", `${rev}:${relPath}`], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function gitShowIndex(projectRoot: string, relPath: string): string | null {
  try {
    return execFileSync("git", ["-C", projectRoot, "show", `:${relPath}`], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function readCandidateBytes(projectRoot: string, relPath: string, staged: boolean): string | null {
  return staged ? gitShowIndex(projectRoot, relPath) : gitShow(projectRoot, "HEAD", relPath);
}

function planIdFromXbriefText(text: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const plan = (raw as Record<string, unknown>).plan;
    if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return undefined;
    const rec = plan as Record<string, unknown>;
    if (rec.status !== "running") return undefined;
    return typeof rec.id === "string" && rec.id.trim().length > 0 ? rec.id.trim() : undefined;
  } catch {
    return undefined;
  }
}

function listRunningPlanIds(projectRoot: string): string[] {
  const activeDir = join(resolve(projectRoot), "xbrief", "active");
  if (!existsSync(activeDir)) return [];
  const ids: string[] = [];
  for (const name of readdirSync(activeDir)) {
    if (!name.endsWith(".xbrief.json")) continue;
    try {
      const text = readFileSync(join(activeDir, name), "utf8");
      const id = planIdFromXbriefText(text);
      if (id !== undefined) ids.push(id);
    } catch {
      // skip unreadable active xBRIEF
    }
  }
  return ids;
}

type PlanIdResolution =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "invalid-pin" }
  | { readonly kind: "none" };

function soleRecord<T>(records: readonly T[]): T | undefined {
  let found: T | undefined;
  for (const rec of records) {
    if (found !== undefined) return undefined;
    found = rec;
  }
  return found;
}

function resolveCurrentPlanId(projectRoot: string, explicit: string | undefined): PlanIdResolution {
  if (explicit !== undefined && explicit.length > 0) return { kind: "id", id: explicit };
  const pin = process.env.DEFT_ACTIVE_SCOPE;
  if (pin !== undefined && pin.length > 0) {
    const rel = pin.replace(/\\/g, "/");
    try {
      const text = readFileSync(join(resolve(projectRoot), ...rel.split("/")), "utf8");
      const id = planIdFromXbriefText(text);
      if (id !== undefined) return { kind: "id", id };
    } catch {
      return { kind: "invalid-pin" };
    }
    return { kind: "invalid-pin" };
  }
  const only = soleRecord(listRunningPlanIds(projectRoot));
  if (only !== undefined) return { kind: "id", id: only };
  return { kind: "none" };
}

function fail(message: string): EvaluateResult {
  return { code: 1, message: `${message} ${INTENT_CONSTRAINT_REMEDIATION}`, stream: "stderr" };
}

function config(message: string): EvaluateResult {
  return { code: 2, message: `verify:intent-constraint: ${message}`, stream: "stderr" };
}

function ok(message: string, skipped = false, quiet = false): EvaluateResult {
  return { code: 0, message: quiet ? "" : message, stream: "stdout", skipped };
}

function listBaseRecords(
  options: EvaluateOptions,
  projectRoot: string,
  mergeBase: string,
): Map<string, string> {
  if (options.recordTextsAtBase !== undefined) return new Map(options.recordTextsAtBase);
  const out = new Map<string, string>();
  const ls = runGit(projectRoot, [
    "ls-tree",
    "-r",
    "--name-only",
    mergeBase,
    INTENT_CONSTRAINT_DIR,
  ]);
  if (ls === null || ls.length === 0) return out;
  const reader = options.readAtBase ?? ((rel: string) => gitShow(projectRoot, mergeBase, rel));
  for (const rel of ls
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)) {
    const text = reader(rel);
    if (text !== null) out.set(normalizePath(rel), text);
  }
  return out;
}

function extractSurfaces(
  paths: readonly string[],
  read: (rel: string) => string | null,
  projectRoot: string,
): SurfaceSnapshot[] | EvaluateResult {
  const surfaces: SurfaceSnapshot[] = [];
  for (const path of paths) {
    const text = read(path) ?? "";
    const extracted = extractConstraintFacts(text, path, { projectRoot });
    if (!extracted.ok) return config(extracted.message);
    surfaces.push(surfaceSnapshot(path, extracted.facts));
  }
  return surfaces;
}

export function evaluateIntentConstraint(options: EvaluateOptions = {}): EvaluateResult {
  const projectRoot = resolve(options.projectRoot ?? ".");
  let mergeBase = options.mergeBase;
  if (mergeBase === undefined || mergeBase.length === 0) {
    const resolved = resolveMergeBase(projectRoot, options.originRef);
    if (typeof resolved !== "string") return config(resolved.error);
    mergeBase = resolved;
  }

  let changed: string[];
  if (options.changedFiles !== undefined) {
    changed = options.changedFiles.map(normalizePath);
  } else if (options.staged === true) {
    const collected = gitNameOnlyDiff(projectRoot, ["--cached"]);
    if (!Array.isArray(collected)) return config(collected.error);
    changed = collected;
  } else {
    const collected = gitNameOnlyDiff(projectRoot, [mergeBase, "HEAD"]);
    if (!Array.isArray(collected)) return config(collected.error);
    changed = collected;
  }

  const production = changed.filter((p) => isProductionSourcePath(p));
  if (production.length === 0) {
    return ok(
      "verify:intent-constraint: N/A — no changed production .ts/.js files.",
      true,
      options.quiet === true,
    );
  }

  const recordRewrites = changed.filter((p) => p.startsWith(`${INTENT_CONSTRAINT_DIR}/`));
  if (recordRewrites.length > 0) {
    return fail(
      "verify:intent-constraint: same-PR rewrite of the intent-constraint mint record is not a contract.",
    );
  }

  const readBase = options.readAtBase ?? ((rel: string) => gitShow(projectRoot, mergeBase, rel));
  const readHead =
    options.readAtHead ??
    ((rel: string) => readCandidateBytes(projectRoot, rel, options.staged === true));

  const baseSurfaces = extractSurfaces(production, readBase, projectRoot);
  if (!Array.isArray(baseSurfaces)) return baseSurfaces;
  const headSurfaces = extractSurfaces(production, readHead, projectRoot);
  if (!Array.isArray(headSurfaces)) return headSurfaces;

  const deltas = newFacts(baseSurfaces, headSurfaces);
  if (deltas.length === 0) {
    return ok(
      `verify:intent-constraint: no new throw/reject/abort sites or numeric consts in ${String(production.length)} production file(s).`,
      false,
      options.quiet === true,
    );
  }

  const baseRecords = listBaseRecords(options, projectRoot, mergeBase);
  if (baseRecords.size === 0) {
    const listed = deltas
      .slice(0, 8)
      .map((d) => `${d.path} ${d.fact.kind}${d.fact.value !== undefined ? `=${d.fact.value}` : ""}`)
      .join("; ");
    return fail(`verify:intent-constraint: unapproved constraint or rejection scope in ${listed}.`);
  }

  const parsedRecords: IntentConstraintRecord[] = [];
  for (const [rel, text] of baseRecords) {
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (err: unknown) {
      return config(`${rel} is not valid JSON: ${String(err)}`);
    }
    const parsed = parseIntentConstraintRecord(raw);
    if ("error" in parsed) return config(`${rel}: ${parsed.error}`);
    parsedRecords.push(parsed);
  }

  const running = listRunningPlanIds(projectRoot);
  const resolved = resolveCurrentPlanId(projectRoot, options.planId);
  if (resolved.kind === "invalid-pin") {
    return config(
      "DEFT_ACTIVE_SCOPE is set but is not a running xBRIEF; pass --plan-id (do not fall back to another plan's mint)",
    );
  }
  const planId = resolved.kind === "id" ? resolved.id : undefined;
  let candidates = parsedRecords;
  if (planId !== undefined && planId.length > 0) {
    candidates = parsedRecords.filter((r) => r.planId === planId);
    if (candidates.length === 0) {
      return fail(`verify:intent-constraint: no merge-base mint record for planId ${planId}.`);
    }
  } else if (parsedRecords.length > 1 || running.length > 1) {
    return config(
      "multiple running stories or merge-base mint records; pass --plan-id or pin DEFT_ACTIVE_SCOPE to the current story (old mints must not authorize new work)",
    );
  }
  const mint = soleRecord(candidates);
  if (mint === undefined) {
    if (candidates.length > 1) {
      return config(
        "multiple merge-base mint records share a planId; constraints cannot be pooled across mints",
      );
    }
    return fail(
      "verify:intent-constraint: unapproved constraint or rejection scope without a merge-base mint.",
    );
  }

  const leftover = uncoveredDeltas(deltas, mint.constraints);
  if (leftover.length > 0) {
    const listed = leftover
      .slice(0, 8)
      .map((d) => `${d.path} ${d.fact.kind}${d.fact.value !== undefined ? `=${d.fact.value}` : ""}`)
      .join("; ");
    return fail(`verify:intent-constraint: unapproved constraint or rejection scope (${listed}).`);
  }

  return ok(
    `verify:intent-constraint: merge-base mint covers ${String(deltas.length)} new fact(s) in ${String(production.length)} production file(s).`,
    false,
    options.quiet === true,
  );
}

export { intentConstraintRecordRel };
