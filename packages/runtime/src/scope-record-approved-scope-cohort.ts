/**
 * Cohort approved-scope mint for scope:record-approved-scope --manifest (#7083).
 *
 * One typed `mint` writes an approved-scope record pair into each story's own
 * worktree. Every pair is built and frozen before the prompt with the same
 * builder the single-brief mint uses: the duplicate-key-rejecting parser, the
 * intent extract, `buildApprovedScopeRecord` and the brief's auth-hash v1. Each
 * record is the per-brief record the one-PR mint level admits; `cohortDigest`
 * is display metadata, never authority.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  ContainedWriteError,
  ContainedWriteErrorCode,
  containedWrite,
  scopeProvenance,
  slice,
} from "@deftai/directive-core";

const {
  approvedScopeIntentPath,
  approvedScopeRecordPath,
  buildApprovedScopeRecord,
  computeAuthHashV1,
  computeIntentDigest,
  extractFileScope,
  extractIntentFromRaw,
  extractPlanId,
  INTENT_DIGEST_ALGO,
  isConcreteFileScopeEntry,
  parseJsonRejectingDuplicateKeys,
} = scopeProvenance;

/** One manifest row: a brief and the worktree its record pair is written into. */
export interface CohortManifestEntry {
  readonly xbriefPath: string;
  readonly worktreePath: string;
}

export type CohortManifestParse =
  | { readonly ok: true; readonly entries: CohortManifestEntry[] }
  | { readonly ok: false; readonly error: string };

/** Parse the `--manifest` JSON: an array of `{ xbrief_path, worktree_path }` rows. */
export function parseCohortManifest(raw: string): CohortManifestParse {
  const parsed = parseJsonRejectingDuplicateKeys(raw);
  if (!parsed.ok) return { ok: false, error: `manifest: ${parsed.error}` };
  if (!Array.isArray(parsed.value) || parsed.value.length === 0) {
    return { ok: false, error: "manifest must be a non-empty JSON array of rows" };
  }
  const entries: CohortManifestEntry[] = [];
  for (const [index, row] of parsed.value.entries()) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      return { ok: false, error: `manifest row #${String(index)} is not an object` };
    }
    const r = row as Record<string, unknown>;
    const xbriefPath = typeof r.xbrief_path === "string" ? r.xbrief_path.trim() : "";
    const worktreePath = typeof r.worktree_path === "string" ? r.worktree_path.trim() : "";
    if (xbriefPath.length === 0 || worktreePath.length === 0) {
      return {
        ok: false,
        error: `manifest row #${String(index)} needs non-empty xbrief_path and worktree_path`,
      };
    }
    entries.push({ xbriefPath, worktreePath });
  }
  return { ok: true, entries };
}

/** One story's frozen pair, ready to write after the typed mint. */
export interface CohortStory {
  readonly planId: string;
  readonly xbriefRelPath: string;
  readonly worktree: string;
  readonly fileScope: readonly string[];
  readonly acceptance: readonly string[];
  readonly intentDigest: string;
  readonly fileScopeDigest: string;
  readonly intentPath: string;
  readonly recordPath: string;
  readonly intentData: string;
  readonly recordData: string;
  /** `identical`: an equal pair is already there and is left untouched. */
  readonly existing: "absent" | "identical";
}

export interface HumanStamp {
  readonly kind: string;
  readonly actor: string;
  readonly mintedAt: string;
  readonly mintedVia: string;
}

export type CohortPrepare =
  | { readonly ok: true; readonly stories: CohortStory[] }
  | { readonly ok: false; readonly errors: string[] };

/** Acceptance lines a record binds: each item's Acceptance (or title), then stated commands. */
export function acceptanceLines(payload: unknown): string[] {
  const out: string[] = [];
  const plan = (payload as { plan?: unknown }).plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return out;
  const p = plan as Record<string, unknown>;
  const items = Array.isArray(p.items) ? p.items : [];
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const it = item as Record<string, unknown>;
    const narrative = (it.narrative ?? {}) as Record<string, unknown>;
    const text =
      typeof narrative.Acceptance === "string" && narrative.Acceptance.trim().length > 0
        ? narrative.Acceptance.trim()
        : typeof it.title === "string"
          ? it.title.trim()
          : "";
    if (text.length === 0) continue;
    const id = typeof it.id === "string" && it.id.length > 0 ? `${it.id}: ` : "";
    out.push(`${id}${text}`);
  }
  const acceptance = (p.acceptance ?? {}) as Record<string, unknown>;
  if (Array.isArray(acceptance.commands)) {
    for (const cmd of acceptance.commands) {
      if (typeof cmd === "string" && cmd.trim().length > 0) out.push(`command: ${cmd.trim()}`);
    }
  }
  return out;
}

/** Lexical posix path of `abs` under `root`, or null when it is not below it. */
function lexicalRel(root: string, abs: string): string | null {
  const r = resolve(root).replace(/\\/g, "/").replace(/\/+$/, "");
  const a = resolve(abs).replace(/\\/g, "/");
  const fold = process.platform === "win32";
  const rc = fold ? r.toLowerCase() : r;
  const ac = fold ? a.toLowerCase() : a;
  if (!ac.startsWith(`${rc}/`)) return null;
  return a.slice(r.length + 1);
}

/**
 * Repo-relative posix path of `abs` under `root`, or null when it escapes,
 * lexically or through a symlink (as the single-brief mint refuses, #3205).
 */
function relUnder(root: string, abs: string): string | null {
  const rel = lexicalRel(root, abs);
  if (rel === null) return null;
  try {
    if (existsSync(abs) && lexicalRel(realpathSync(root), realpathSync(abs)) === null) {
      return null;
    }
  } catch {
    return null;
  }
  return rel;
}

/** True when an existing record binds the same brief, scope, intent and auth-hash. */
function sameBinding(existingRaw: string, builtRaw: string): boolean {
  try {
    const a = JSON.parse(existingRaw) as Record<string, unknown>;
    const b = JSON.parse(builtRaw) as Record<string, unknown>;
    const keys = [
      "planId",
      "xbriefRelPath",
      "fileScopeDigest",
      "intentDigest",
      "digestAlgo",
      "authHashV1",
    ];
    if (a.humanApproval === undefined || a.humanApproval === null) return false;
    return keys.every((k) => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null));
  } catch {
    return false;
  }
}

/**
 * Read, parse, build and freeze every pair (#7083). Any refusal refuses the whole
 * set: an unreadable or duplicate-key brief, a glob `file_scope` entry, a missing
 * plan id, a repeated plan id or worktree, or an existing pair that is half
 * present or differs from the pair this run would write.
 */
export function prepareCohortMint(input: {
  readonly entries: readonly CohortManifestEntry[];
  readonly projectRoot: string;
  readonly stamp: HumanStamp;
  readonly repo: string;
}): CohortPrepare {
  const errors: string[] = [];
  const stories: CohortStory[] = [];
  const seenPlans = new Set<string>();
  const seenWorktrees = new Set<string>();
  for (const entry of input.entries) {
    const worktree = resolve(input.projectRoot, entry.worktreePath);
    const label = `${entry.xbriefPath} @ ${worktree}`;
    if (!existsSync(worktree)) {
      errors.push(`${label}: worktree not found`);
      continue;
    }
    const wtKey = process.platform === "win32" ? worktree.toLowerCase() : worktree;
    if (seenWorktrees.has(wtKey)) {
      errors.push(`${label}: worktree named by more than one row (one worktree per story)`);
      continue;
    }
    seenWorktrees.add(wtKey);
    const briefAbs = resolve(worktree, entry.xbriefPath);
    const rel = relUnder(worktree, briefAbs);
    if (rel === null) {
      errors.push(`${label}: brief path escapes its worktree`);
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(briefAbs, "utf8");
    } catch (err: unknown) {
      errors.push(`${label}: cannot read brief (${String(err)})`);
      continue;
    }
    const parsed = parseJsonRejectingDuplicateKeys(raw);
    if (!parsed.ok) {
      errors.push(`${label}: ${parsed.error}`);
      continue;
    }
    const payload = parsed.value;
    const planId = extractPlanId(payload);
    if (planId === null) {
      errors.push(`${label}: brief has no plan id`);
      continue;
    }
    if (seenPlans.has(planId)) {
      errors.push(`${label}: plan id ${planId} named by more than one row`);
      continue;
    }
    seenPlans.add(planId);
    const scope = extractFileScope(payload);
    const globs = scope.filter((p) => !isConcreteFileScopeEntry(p));
    if (globs.length > 0) {
      errors.push(`${label}: file_scope has glob entries (${globs.join(", ")}); name each file`);
      continue;
    }
    const repoSeed = slice.resolveProjectRepo(
      input.repo.length > 0 ? input.repo : undefined,
      worktree,
    );
    const extracted = extractIntentFromRaw(raw, {
      projectRoot: worktree,
      approvedReposSeed: repoSeed !== null ? [repoSeed] : [],
    });
    if (!extracted.ok) {
      errors.push(`${label}: ${extracted.error}`);
      continue;
    }
    const intentDigest = computeIntentDigest(extracted.preimage);
    const authHashV1 = computeAuthHashV1(payload, rel);
    const record = {
      ...buildApprovedScopeRecord({
        xbriefRelPath: rel,
        payload,
        approvedAt: input.stamp.mintedAt,
        humanApproval: input.stamp,
      }),
      intentDigest,
      digestAlgo: INTENT_DIGEST_ALGO,
      ...(authHashV1 !== null ? { authHashV1 } : {}),
    };
    const intentData = `${JSON.stringify(extracted.preimage, null, 2)}\n`;
    const recordData = `${JSON.stringify(record, null, 2)}\n`;
    const intentPath = approvedScopeIntentPath(worktree, planId);
    const recordPath = approvedScopeRecordPath(worktree, planId);
    const hasIntent = existsSync(intentPath);
    const hasRecord = existsSync(recordPath);
    let existing: CohortStory["existing"] = "absent";
    if (hasIntent !== hasRecord) {
      errors.push(`${label}: half-present approved-scope pair for ${planId}`);
      continue;
    }
    if (hasIntent && hasRecord) {
      const sameIntent = readFileSync(intentPath, "utf8") === intentData;
      if (!sameIntent || !sameBinding(readFileSync(recordPath, "utf8"), recordData)) {
        errors.push(`${label}: an approved-scope pair for ${planId} exists and differs`);
        continue;
      }
      existing = "identical";
    }
    stories.push({
      planId,
      xbriefRelPath: rel,
      worktree,
      fileScope: record.fileScope,
      acceptance: acceptanceLines(payload),
      intentDigest,
      fileScopeDigest: record.fileScopeDigest,
      intentPath,
      recordPath,
      intentData,
      recordData,
      existing,
    });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, stories };
}

/** Display digest over the frozen set. Metadata only, never authority. */
export function cohortDigest(stories: readonly CohortStory[]): string {
  const lines = stories
    .map((s) => `${s.planId}\t${s.fileScopeDigest}\t${s.intentDigest}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(lines, "utf8").digest("hex");
}

/** The per-story review text printed before the typed mint. */
export function formatCohortPlan(stories: readonly CohortStory[]): string {
  const out: string[] = [
    `scope_record_approved_scope: cohort mint of ${String(stories.length)} stories ` +
      `(cohortDigest ${cohortDigest(stories)}; metadata, not authority)`,
  ];
  stories.forEach((s, i) => {
    out.push(
      `[${String(i + 1)}/${String(stories.length)}] planId: ${s.planId}`,
      `  brief: ${s.xbriefRelPath}`,
      `  worktree: ${s.worktree}`,
      `  pair: ${s.existing === "identical" ? "identical pair present; left untouched" : "new"}`,
      `  intentDigest: ${s.intentDigest}`,
      `  fileScopeDigest: ${s.fileScopeDigest}`,
      `  file_scope (${String(s.fileScope.length)}):`,
      ...s.fileScope.map((p) => `    - ${p}`),
      `  acceptance (${String(s.acceptance.length)}):`,
      ...s.acceptance.map((a) => `    - ${a}`),
    );
  });
  return `${out.join("\n")}\n`;
}

/** Write seams for tests: a failure or a concurrent create mid-run. */
export interface CohortWriteSeams {
  readonly write?: (root: string, target: string, data: string) => void;
  readonly remove?: (path: string) => void;
}

export type CohortWriteResult =
  | { readonly ok: true; readonly written: string[] }
  | { readonly ok: false; readonly error: string; readonly removed: string[] };

/**
 * Write each new pair by exclusive create, intent first. On any failure, remove
 * only the files this run created; a file someone else created is never touched.
 */
export function writeCohortPairs(
  stories: readonly CohortStory[],
  seams: CohortWriteSeams = {},
): CohortWriteResult {
  const write =
    seams.write ??
    ((root: string, target: string, data: string) => {
      containedWrite({ root, target, data, mode: "create" });
    });
  const remove = seams.remove ?? ((path: string) => rmSync(path, { force: true }));
  const created: string[] = [];
  for (const story of stories) {
    if (story.existing === "identical") continue;
    for (const [target, data] of [
      [story.intentPath, story.intentData],
      [story.recordPath, story.recordData],
    ] as const) {
      try {
        write(story.worktree, target, data);
        created.push(target);
      } catch (err: unknown) {
        // Exclusive create refused: someone else's file, never touched. Any other
        // failure after the create may leave our own partial file; remove it too.
        const foreign =
          err instanceof ContainedWriteError && err.code === ContainedWriteErrorCode.EXISTS;
        if (!foreign && existsSync(target)) created.push(target);
        const removed: string[] = [];
        for (const path of created.reverse()) {
          remove(path);
          removed.push(path);
        }
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `${story.planId}: ${message}`, removed };
      }
    }
  }
  return { ok: true, written: created };
}

/** Resolve the manifest path and read it. */
export function readCohortManifest(projectRoot: string, manifestPath: string): CohortManifestParse {
  const abs = resolve(projectRoot, manifestPath);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch (err: unknown) {
    return { ok: false, error: `cannot read manifest ${abs} (${String(err)})` };
  }
  return parseCohortManifest(raw);
}

/** Next-step lines after a successful cohort write. */
export function formatCohortNext(
  stories: readonly CohortStory[],
  written: readonly string[],
): string {
  const lines = written.map((p) => `scope_record_approved_scope: wrote ${p}`);
  const untouched = stories.filter((s) => s.existing === "identical").map((s) => s.planId);
  if (untouched.length > 0) lines.push(`  left untouched (identical): ${untouched.join(", ")}`);
  lines.push(
    "  Next: in each worktree, commit its own brief and record pair on that story's branch " +
      "(git add -f .deft/approved-scope/...), push it, then run swarm:launch with a worktree " +
      "map whose rows name each story's branch as base_branch (#7083).",
  );
  return `${lines.join("\n")}\n`;
}
