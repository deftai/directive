/**
 * verify:intent-constraint (#4541 / #4813).
 *
 * Merge-base snapshot of throw/reject/abort sites and new numeric consts in
 * changed production .ts/.js. Authority is git show merge-base only.
 * Tests and in-scope paths are not authority. P2 is not first-ship.
 *
 * Mint selection: --plan-id, DEFT_ACTIVE_SCOPE, or dest unique running xBRIEF.
 * Multiple merge-base mints without that pin fail closed. Do not take
 * records[0] by ls-tree/Map order.
 *
 * Default origin (#4813): do not use evaluator-surface resolveDefaultBaseRef
 * (origin/HEAD then origin/main/origin/master) when a typed dest exists.
 * Local canonical check uses dest the same way orphan-active already does.
 * In Actions, GITHUB_BASE_REF is the PR-target channel. Typed baseBranch is
 * not dest. Explicit --origin-ref stays the diagnostic override.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveDefaultBaseRef as resolveForgeDefaultBaseRef } from "../evaluator-surface/evaluate.js";
import { normalizePath } from "../orchestration/pathspec.js";
import { resolveCandidateBaseRef } from "../orphan-active/candidate-scope.js";
import { resolveDeliveryBranch } from "../policy/delivery-branch.js";
import { resolveDefaultBaseRef as resolvePrAwareBaseRef } from "../scope-provenance/evaluate.js";
import { defaultGitRunner } from "../session/git.js";
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

export type IntentConstraintOriginMode = "explicit" | "pr-target" | "dest" | "forge-default";

export interface IntentConstraintOrigin {
  readonly origin: string;
  readonly mode: IntentConstraintOriginMode;
}

export const CANDIDATE_COMMITTED = "committed HEAD versus origin";
export const CANDIDATE_COMMITTED_ONLY = "committed HEAD versus origin only; unstaged not assessed";
export const CANDIDATE_WORKING_TREE = "working-tree (unstaged/untracked production)";
export const CANDIDATE_STAGED = "staged";
export const CANDIDATE_INJECTED = "injected";

export interface EvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
  readonly skipped?: boolean;
  readonly findings?: readonly IntentConstraintFinding[];
  readonly origin?: string;
  readonly originMode?: IntentConstraintOriginMode;
  readonly candidateMode?: string;
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

function envPrTargetCandidates(): string[] {
  const out: string[] = [];
  const deft = process.env.DEFT_BASE_REF?.trim();
  if (deft !== undefined && deft.length > 0) out.push(deft);
  const github = process.env.GITHUB_BASE_REF?.trim();
  if (github !== undefined && github.length > 0) {
    out.push(`origin/${github}`);
    out.push(github);
  }
  return out;
}

function resolvePrTargetOrigin(projectRoot: string): string | null {
  const env = envPrTargetCandidates();
  if (env.length === 0) return null;
  const resolved = resolvePrAwareBaseRef(projectRoot);
  if (resolved !== null && env.includes(resolved)) return resolved;
  return null;
}

/**
 * Silent origin for canonical verify:intent-constraint (#4813).
 * Explicit --origin-ref wins. Actions uses the existing GITHUB_BASE_REF
 * channel. Typed dest uses resolveCandidateBaseRef. Else forge default.
 */
export function resolveIntentConstraintOrigin(
  projectRoot: string,
  originRef?: string,
): IntentConstraintOrigin | { error: string } {
  const explicit = originRef?.trim() ?? "";
  if (explicit.length > 0) {
    return { origin: explicit, mode: "explicit" };
  }

  const prTarget = resolvePrTargetOrigin(projectRoot);
  if (prTarget !== null) {
    return { origin: prTarget, mode: "pr-target" };
  }

  const dest = resolveDeliveryBranch(projectRoot);
  if (dest.source === "typed") {
    const candidate = resolveCandidateBaseRef(projectRoot, null, defaultGitRunner);
    if (candidate !== null && candidate.length > 0) {
      return { origin: candidate, mode: "dest" };
    }
    return {
      error: `typed dest '${dest.branch}' has no origin/${dest.branch} or local branch`,
    };
  }

  const forge = resolveForgeDefaultBaseRef(projectRoot);
  if (typeof forge !== "string") return forge;
  return { origin: forge, mode: "forge-default" };
}

export function resolveMergeBase(
  projectRoot: string,
  originRef?: string,
): string | { error: string } {
  const origin = resolveIntentConstraintOrigin(projectRoot, originRef);
  if ("error" in origin) return origin;
  const mb = runGit(projectRoot, ["merge-base", "HEAD", origin.origin]);
  if (mb === null || mb.length === 0) {
    return { error: `could not compute merge-base of HEAD and ${origin.origin}` };
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

function readWorkingTreeBytes(projectRoot: string, relPath: string): string | null {
  const abs = join(projectRoot, relPath);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function refsPointToSameCommit(projectRoot: string, a: string, b: string): boolean {
  const left = runGit(projectRoot, ["rev-parse", `${a}^{commit}`]);
  const right = runGit(projectRoot, ["rev-parse", `${b}^{commit}`]);
  return left !== null && right !== null && left.length > 0 && left === right;
}

function listWorkingTreeEdits(projectRoot: string): string[] | { error: string } {
  const unstaged = gitNameOnlyDiff(projectRoot, []);
  if (!Array.isArray(unstaged)) return unstaged;
  const extra = runGit(projectRoot, ["ls-files", "--others", "--exclude-standard"]);
  const untracked =
    extra === null || extra.length === 0
      ? []
      : extra
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map(normalizePath);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of [...unstaged, ...untracked]) {
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function unionPaths(base: readonly string[], extra: readonly string[]): string[] {
  const seen = new Set(base);
  const out = [...base];
  for (const path of extra) {
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function formatOriginReport(
  origin: IntentConstraintOrigin | undefined,
  candidateMode: string,
): string {
  const originRef = origin?.origin ?? "N/A";
  const originMode = origin?.mode ?? "N/A";
  return `origin=${originRef} origin-mode=${originMode} candidates=${candidateMode}`;
}

function attach(
  result: EvaluateResult,
  origin: IntentConstraintOrigin | undefined,
  candidateMode: string,
  quiet: boolean,
): EvaluateResult {
  const report = formatOriginReport(origin, candidateMode);
  const message =
    quiet || result.message.length === 0 ? result.message : `${result.message} ${report}`;
  return {
    ...result,
    message,
    origin: origin?.origin,
    originMode: origin?.mode,
    candidateMode,
  };
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
  const quiet = options.quiet === true;
  let origin: IntentConstraintOrigin | undefined;
  const explicit = options.originRef?.trim() ?? "";
  if (explicit.length > 0) {
    origin = { origin: explicit, mode: "explicit" };
  }

  let mergeBase = options.mergeBase;
  const computedOrigin = mergeBase === undefined || mergeBase.length === 0;
  if (computedOrigin) {
    const resolvedOrigin = resolveIntentConstraintOrigin(projectRoot, options.originRef);
    if ("error" in resolvedOrigin) {
      return attach(config(resolvedOrigin.error), undefined, "N/A", quiet);
    }
    origin = resolvedOrigin;
    const resolved = runGit(projectRoot, ["merge-base", "HEAD", origin.origin]);
    if (resolved === null || resolved.length === 0) {
      return attach(
        config(`could not compute merge-base of HEAD and ${origin.origin}`),
        origin,
        "N/A",
        quiet,
      );
    }
    mergeBase = resolved;
  }
  if (mergeBase === undefined || mergeBase.length === 0) {
    return attach(config("could not compute merge-base"), origin, "N/A", quiet);
  }
  const mergeBaseSha = mergeBase;

  let changed: string[];
  let candidateMode: string;
  let workingTreePaths: ReadonlySet<string> | undefined;
  if (options.changedFiles !== undefined) {
    changed = options.changedFiles.map(normalizePath);
    candidateMode = CANDIDATE_INJECTED;
  } else if (options.staged === true) {
    const collected = gitNameOnlyDiff(projectRoot, ["--cached"]);
    if (!Array.isArray(collected)) {
      return attach(config(collected.error), origin, CANDIDATE_STAGED, quiet);
    }
    changed = collected;
    candidateMode = CANDIDATE_STAGED;
  } else {
    const collected = gitNameOnlyDiff(projectRoot, [mergeBaseSha, "HEAD"]);
    if (!Array.isArray(collected)) {
      return attach(config(collected.error), origin, CANDIDATE_COMMITTED, quiet);
    }
    changed = collected;
    candidateMode = CANDIDATE_COMMITTED;
    const liveOrigin = origin?.origin;
    if (
      computedOrigin &&
      liveOrigin !== undefined &&
      refsPointToSameCommit(projectRoot, "HEAD", liveOrigin)
    ) {
      const edits = listWorkingTreeEdits(projectRoot);
      if (!Array.isArray(edits)) {
        return attach(config(edits.error), origin, CANDIDATE_COMMITTED_ONLY, quiet);
      }
      const productionEdits = edits.filter((path) => {
        const posix = path.replace(/\\/g, "/");
        if (/(^|\/)node_modules(\/|$)/.test(posix)) return false;
        return isProductionSourcePath(path);
      });
      if (productionEdits.length > 0) {
        changed = unionPaths(changed, productionEdits);
        workingTreePaths = new Set(productionEdits);
        candidateMode = CANDIDATE_WORKING_TREE;
      } else {
        candidateMode = CANDIDATE_COMMITTED_ONLY;
      }
    }
  }

  const production = changed.filter((p) => isProductionSourcePath(p));
  if (production.length === 0) {
    return attach(
      ok("verify:intent-constraint: N/A — no changed production .ts/.js files.", true, quiet),
      origin,
      candidateMode,
      quiet,
    );
  }

  const recordRewrites = changed.filter((p) => p.startsWith(`${INTENT_CONSTRAINT_DIR}/`));
  if (recordRewrites.length > 0) {
    return attach(
      fail(
        "verify:intent-constraint: same-PR rewrite of the intent-constraint mint record is not a contract.",
      ),
      origin,
      candidateMode,
      quiet,
    );
  }

  const readBase = options.readAtBase ?? ((rel: string) => gitShow(projectRoot, mergeBaseSha, rel));
  const readHead =
    options.readAtHead ??
    ((rel: string) =>
      workingTreePaths?.has(rel) === true
        ? readWorkingTreeBytes(projectRoot, rel)
        : readCandidateBytes(projectRoot, rel, options.staged === true));

  const baseSurfaces = extractSurfaces(production, readBase, projectRoot);
  if (!Array.isArray(baseSurfaces)) return attach(baseSurfaces, origin, candidateMode, quiet);
  const headSurfaces = extractSurfaces(production, readHead, projectRoot);
  if (!Array.isArray(headSurfaces)) return attach(headSurfaces, origin, candidateMode, quiet);

  const deltas = newFacts(baseSurfaces, headSurfaces);
  if (deltas.length === 0) {
    return attach(
      ok(
        `verify:intent-constraint: no new throw/reject/abort sites or numeric consts in ${String(production.length)} production file(s).`,
        false,
        quiet,
      ),
      origin,
      candidateMode,
      quiet,
    );
  }

  const baseRecords = listBaseRecords(options, projectRoot, mergeBaseSha);
  if (baseRecords.size === 0) {
    const listed = deltas
      .slice(0, 8)
      .map((d) => `${d.path} ${d.fact.kind}${d.fact.value !== undefined ? `=${d.fact.value}` : ""}`)
      .join("; ");
    return attach(
      fail(`verify:intent-constraint: unapproved constraint or rejection scope in ${listed}.`),
      origin,
      candidateMode,
      quiet,
    );
  }

  const parsedRecords: IntentConstraintRecord[] = [];
  for (const [rel, text] of baseRecords) {
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (err: unknown) {
      return attach(
        config(`${rel} is not valid JSON: ${String(err)}`),
        origin,
        candidateMode,
        quiet,
      );
    }
    const parsed = parseIntentConstraintRecord(raw);
    if ("error" in parsed) {
      return attach(config(`${rel}: ${parsed.error}`), origin, candidateMode, quiet);
    }
    parsedRecords.push(parsed);
  }

  const running = listRunningPlanIds(projectRoot);
  const resolved = resolveCurrentPlanId(projectRoot, options.planId);
  if (resolved.kind === "invalid-pin") {
    return attach(
      config(
        "DEFT_ACTIVE_SCOPE is set but is not a running xBRIEF; pass --plan-id (do not fall back to another plan's mint)",
      ),
      origin,
      candidateMode,
      quiet,
    );
  }
  const planId = resolved.kind === "id" ? resolved.id : undefined;
  let candidates = parsedRecords;
  if (planId !== undefined && planId.length > 0) {
    candidates = parsedRecords.filter((r) => r.planId === planId);
    if (candidates.length === 0) {
      return attach(
        fail(`verify:intent-constraint: no merge-base mint record for planId ${planId}.`),
        origin,
        candidateMode,
        quiet,
      );
    }
  } else if (parsedRecords.length > 1 || running.length > 1) {
    return attach(
      config(
        "multiple running stories or merge-base mint records; pass --plan-id or pin DEFT_ACTIVE_SCOPE to the current story (old mints must not authorize new work)",
      ),
      origin,
      candidateMode,
      quiet,
    );
  }
  const mint = soleRecord(candidates);
  if (mint === undefined) {
    if (candidates.length > 1) {
      return attach(
        config(
          "multiple merge-base mint records share a planId; constraints cannot be pooled across mints",
        ),
        origin,
        candidateMode,
        quiet,
      );
    }
    return attach(
      fail(
        "verify:intent-constraint: unapproved constraint or rejection scope without a merge-base mint.",
      ),
      origin,
      candidateMode,
      quiet,
    );
  }

  const leftover = uncoveredDeltas(deltas, mint.constraints);
  if (leftover.length > 0) {
    const listed = leftover
      .slice(0, 8)
      .map((d) => `${d.path} ${d.fact.kind}${d.fact.value !== undefined ? `=${d.fact.value}` : ""}`)
      .join("; ");
    return attach(
      fail(`verify:intent-constraint: unapproved constraint or rejection scope (${listed}).`),
      origin,
      candidateMode,
      quiet,
    );
  }

  return attach(
    ok(
      `verify:intent-constraint: merge-base mint covers ${String(deltas.length)} new fact(s) in ${String(production.length)} production file(s).`,
      false,
      quiet,
    ),
    origin,
    candidateMode,
    quiet,
  );
}

export { intentConstraintRecordRel };
