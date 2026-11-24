/**
 * Cohort approved-scope mint for scope:record-approved-scope --manifest (#7083).
 *
 * One typed `mint` writes an approved-scope record pair for each distinct
 * planId. Rows may share one `worktree_path` (#7256) or name per-story
 * worktrees. Every pair is built and frozen before the prompt with the same
 * builder the single-brief mint uses: the duplicate-key-rejecting parser, the
 * intent extract, `buildApprovedScopeRecord` and the brief's auth-hash v1. Each
 * record is the per-brief record the one-PR mint level admits; `cohortDigest`
 * is display metadata, never authority. Plan ids stay unique across the set.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { containedWrite, scopeProvenance, slice } from "@deftai/directive-core";

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
  isHumanApprovalStamp,
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

/**
 * Acceptance lines a record binds: the `plan.acceptance.clauses` texts when
 * present, else each item's Acceptance (or title); then every stated command,
 * as a string or as `{ command }`.
 */
export function acceptanceLines(payload: unknown): string[] {
  const out: string[] = [];
  const plan = (payload as { plan?: unknown }).plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return out;
  const p = plan as Record<string, unknown>;
  const acceptance = (p.acceptance ?? {}) as Record<string, unknown>;
  const clauses = Array.isArray(acceptance.clauses) ? acceptance.clauses : [];
  for (const clause of clauses) {
    if (clause === null || typeof clause !== "object" || Array.isArray(clause)) continue;
    const c = clause as Record<string, unknown>;
    if (typeof c.text !== "string" || c.text.trim().length === 0) continue;
    const id =
      typeof c.id === "number" || typeof c.id === "string" ? `clause ${String(c.id)}: ` : "";
    out.push(`${id}${c.text.trim()}`);
  }
  const items = out.length === 0 && Array.isArray(p.items) ? p.items : [];
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
  if (Array.isArray(acceptance.commands)) {
    for (const cmd of acceptance.commands) {
      const text =
        typeof cmd === "string"
          ? cmd
          : cmd !== null && typeof cmd === "object" && typeof cmd.command === "string"
            ? cmd.command
            : "";
      if (text.trim().length > 0) out.push(`command: ${text.trim()}`);
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

/**
 * True when an existing record binds the same brief, scope, intent and auth-hash
 * and carries a valid human stamp; anything else is a differing pair.
 */
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
    if (!isHumanApprovalStamp(a.humanApproval as Parameters<typeof isHumanApprovalStamp>[0])) {
      return false;
    }
    if (JSON.stringify(a.fileScope ?? null) !== JSON.stringify(b.fileScope ?? null)) return false;
    return keys.every((k) => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null));
  } catch {
    return false;
  }
}

/**
 * Read, parse, build and freeze every pair (#7083). Any refusal refuses the whole
 * set: an unreadable or duplicate-key brief, a glob `file_scope` entry, a missing
 * plan id, a repeated plan id, or an existing pair that is half present or
 * differs from the pair this run would write. Shared worktree paths are allowed
 * when plan ids differ (#7256).
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
  for (const entry of input.entries) {
    const worktree = resolve(input.projectRoot, entry.worktreePath);
    const label = `${entry.xbriefPath} @ ${worktree}`;
    if (!existsSync(worktree)) {
      errors.push(`${label}: worktree not found`);
      continue;
    }
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

/**
 * Write seams for tests: a failure or a concurrent create mid-run. `create` makes
 * the empty file by exclusive create; `fill` writes its bytes; `remove` undoes a
 * file this run created.
 */
export interface CohortWriteSeams {
  readonly create?: (root: string, target: string) => void;
  readonly fill?: (root: string, target: string, data: string) => void;
  readonly remove?: (root: string, target: string) => void;
}

export type CohortWriteResult =
  | { readonly ok: true; readonly written: string[] }
  | { readonly ok: false; readonly error: string; readonly removed: string[] };

/**
 * Remove a file this run created, inside the same containment checks as the
 * write: a symlinked leaf, or a real parent outside the worktree, is left alone.
 */
function removeOwnFile(root: string, target: string): void {
  try {
    if (!lstatSync(target).isFile()) return;
    if (lexicalRel(realpathSync(root), realpathSync(dirname(target))) === null) return;
  } catch {
    return;
  }
  rmSync(target, { force: true });
}

/**
 * Write each new pair, intent first. Each file is first made empty by exclusive
 * create, which is the only point at which this run owns it, then filled. On any
 * failure, remove only files this run created; a file someone else created is
 * never touched.
 */
export function writeCohortPairs(
  stories: readonly CohortStory[],
  seams: CohortWriteSeams = {},
): CohortWriteResult {
  const create =
    seams.create ??
    ((root: string, target: string) => {
      containedWrite({ root, target, data: "", mode: "create" });
    });
  const fill =
    seams.fill ??
    ((root: string, target: string, data: string) => {
      containedWrite({ root, target, data, mode: "replace" });
    });
  const remove = seams.remove ?? removeOwnFile;
  const created: { root: string; target: string }[] = [];
  for (const story of stories) {
    if (story.existing === "identical") continue;
    for (const [target, data] of [
      [story.intentPath, story.intentData],
      [story.recordPath, story.recordData],
    ] as const) {
      try {
        create(story.worktree, target);
        created.push({ root: story.worktree, target });
        fill(story.worktree, target, data);
      } catch (err: unknown) {
        const removed: string[] = [];
        for (const own of created.reverse()) {
          remove(own.root, own.target);
          removed.push(own.target);
        }
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `${story.planId}: ${message}`, removed };
      }
    }
  }
  return { ok: true, written: created.map((own) => own.target) };
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
    "  Next: commit each brief and its record pair on that story's branch " +
      "(git add -f .deft/approved-scope/...), push it, then run swarm:launch with a worktree " +
      "map whose rows name each story's branch as base_branch (#7083 / #7256).",
  );
  return `${lines.join("\n")}\n`;
}
