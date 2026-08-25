/**
 * Fail-closed land check (#3264 / #1358 recurrence).
 *
 * Rule: if a GitHub issue is closed and Directive has a known lifecycle
 * xBRIEF origin for it, the delivery branch tip must contain a *tracked*
 * artifact under xbrief/completed/ or xbrief/cancelled/ that references
 * that issue. Else fail with a single remediation path
 * (`task swarm:finalize-cohort` or a lifecycle PR).
 *
 * Complements verify:orphan-active (#2321), which watches active/running
 * residue — not completed-but-untracked laptop residue.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  hasArtifactSuffix,
  LEGACY_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_DIR,
  resolveLifecycleRoot,
} from "../layout/resolve.js";
import { collectGithubRefs, type IssueRef } from "../orphan-active/refs.js";
import { resolveDeliveryBranch } from "../policy/delivery-branch.js";
import { defaultRunGh } from "../pr-protected-issues/gh.js";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import { defaultGitRunner, type GitRunner, showBlobsBatch } from "../session/git.js";
import { CACHE_DIR_NAME, CACHE_SOURCE_GITHUB_ISSUE } from "../triage/queue/constants.js";
import { resolveRepo } from "../triage/queue/repo.js";

export type OutputStream = "stdout" | "stderr" | "none";

/** Lifecycle folders scanned for local "known origin" xBRIEFs. */
export const LOCAL_ORIGIN_FOLDERS = [
  "proposed",
  "pending",
  "active",
  "completed",
  "cancelled",
] as const;

/** Non-terminal tip folders: closed issues still here need completed land. */
export const TIP_NONTERMINAL_FOLDERS = ["proposed", "pending", "active"] as const;

/** Terminal tip folders that satisfy the land rule. */
export const TIP_TERMINAL_FOLDERS = ["completed", "cancelled"] as const;

export interface MissingCompletedLand {
  readonly issue: IssueRef;
  /** Where the detector learned about this scoped issue (local and/or tip paths). */
  readonly origins: readonly string[];
}

export interface EvaluateCompletedTrackedResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
  readonly missing: readonly MissingCompletedLand[];
  readonly tip: string | null;
}

export interface EvaluateCompletedTrackedOptions {
  readonly quiet?: boolean;
  readonly repo?: string | null;
  /** Explicit delivery tip ref (e.g. origin/master). Overrides policy/git default. */
  readonly tip?: string | null;
  /**
   * When set, check only this issue number (#3476 drive-to DONE).
   * Sibling unlanded closed issues do not fail the per-issue scan.
   */
  readonly issue?: number | null;
  readonly runGh?: RunGhFn;
  readonly skipGh?: boolean;
  readonly runGit?: GitRunner;
  /** Test seam: override issue state resolution. */
  readonly resolveIssueState?: (ref: IssueRef) => "open" | "closed" | null;
  /**
   * Progress hook (#3673). Fired after tip listing and after the batch
   * blob read so a CLI can announce an up-front count only when elapsed
   * time crosses a measured threshold.
   */
  readonly onProgress?: (event: CompletedTrackedProgress) => void;
  /** Test seam: override wall clock for progress elapsedMs. */
  readonly now?: () => number;
}

/** Default silence window so a ~2s batch read does not emit progress noise. */
export const COMPLETED_TRACKED_PROGRESS_THRESHOLD_MS = 3_000;

/**
 * Up-front count floor (#3673 Greptile P2). Listing is cheap; the batch
 * read is the remaining stall. Announce the blob count after listing
 * (before `cat-file --batch`) when the corpus is large enough that a
 * silent wait is the old DONE-path failure mode. Fixture-sized runs stay
 * quiet unless the duration threshold is also crossed.
 */
export const COMPLETED_TRACKED_PROGRESS_MIN_BLOBS = 32;

export interface CompletedTrackedProgress {
  readonly phase: "listed" | "read";
  readonly terminalCount: number;
  readonly nonterminalCount: number;
  readonly elapsedMs: number;
}

export function shouldAnnounceProgress(
  elapsedMs: number,
  thresholdMs: number = COMPLETED_TRACKED_PROGRESS_THRESHOLD_MS,
): boolean {
  return elapsedMs >= thresholdMs;
}

export function shouldAnnounceUpFrontCount(
  terminalCount: number,
  nonterminalCount: number,
  minBlobs: number = COMPLETED_TRACKED_PROGRESS_MIN_BLOBS,
): boolean {
  return terminalCount + nonterminalCount >= minBlobs;
}

interface OriginHit {
  readonly issue: IssueRef;
  readonly originPath: string;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function planOf(data: Record<string, unknown> | null): Record<string, unknown> | null {
  const plan = data?.plan;
  return typeof plan === "object" && plan !== null && !Array.isArray(plan)
    ? (plan as Record<string, unknown>)
    : null;
}

function issueKey(ref: IssueRef): string {
  return `${ref.repo}#${ref.number}`;
}

function formatIssue(ref: IssueRef): string {
  return `${ref.repo}#${ref.number}`;
}

function relPath(path: string, projectRoot: string): string {
  try {
    return relative(resolve(projectRoot), resolve(path)).replace(/\\/g, "/");
  } catch {
    return path.replace(/\\/g, "/");
  }
}

function readCachedIssueState(projectRoot: string, ref: IssueRef): "open" | "closed" | null {
  const [owner, name] = ref.repo.split("/", 2);
  if (!owner || !name) {
    return null;
  }
  const rawPath = join(
    projectRoot,
    CACHE_DIR_NAME,
    CACHE_SOURCE_GITHUB_ISSUE,
    owner,
    name,
    String(ref.number),
    "raw.json",
  );
  if (!existsSync(rawPath)) {
    return null;
  }
  const raw = readJson(rawPath);
  if (raw === null) {
    return null;
  }
  const state = typeof raw.state === "string" ? raw.state.toLowerCase() : "";
  if (state === "closed" || state === "open") {
    return state;
  }
  return null;
}

function fetchIssueStateLive(ref: IssueRef, runGh: RunGhFn): "open" | "closed" | null {
  const path = `repos/${ref.repo}/issues/${ref.number}`;
  const result = runGh(["gh", "api", path]);
  if (result.returncode !== 0) {
    return null;
  }
  try {
    const payload = JSON.parse(result.stdout) as unknown;
    if (payload === null || typeof payload !== "object") {
      return null;
    }
    const state = (payload as Record<string, unknown>).state;
    if (state === "closed" || state === "open") {
      return state;
    }
    return null;
  } catch {
    return null;
  }
}

function defaultResolveIssueState(
  ref: IssueRef,
  projectRoot: string,
  runGh: RunGhFn,
  skipGh: boolean,
): "open" | "closed" | null {
  const cached = readCachedIssueState(projectRoot, ref);
  // Closed cache is fail-closed evidence (safe to trust without live).
  if (cached === "closed") {
    return "closed";
  }
  if (skipGh) {
    // Offline / fixture mode: honor cache open|null as-is.
    return cached;
  }
  // Prefer live when network is allowed. Stale open cache must not suppress a
  // later close when live succeeds (#3264 Greptile P1). When live fails, do
  // NOT fall back to cached open — treat as unknown so we fail closed only on
  // positive closed evidence (cached closed above, or live closed).
  const live = fetchIssueStateLive(ref, runGh);
  if (live !== null) {
    return live;
  }
  return null;
}

function collectIssuesFromPlan(
  plan: Record<string, unknown>,
  defaultRepo: string | null,
  originPath: string,
  out: OriginHit[],
): void {
  const { issues } = collectGithubRefs(plan, defaultRepo);
  for (const issue of issues) {
    out.push({ issue, originPath });
  }
}

function scanLocalOrigins(projectRoot: string, defaultRepo: string | null): OriginHit[] {
  const hits: OriginHit[] = [];
  const roots: string[] = [];
  try {
    roots.push(resolveLifecycleRoot(projectRoot));
  } catch {
    // no xbrief layout
  }
  // Read-accepted legacy vbrief/ root when present (same class as #3242 scans).
  const legacyRoot = join(projectRoot, LEGACY_ARTIFACT_DIR);
  if (existsSync(legacyRoot) && !roots.includes(legacyRoot)) {
    roots.push(legacyRoot);
  }
  // Canonical path even when resolveLifecycleRoot fell back elsewhere.
  const migrated = join(projectRoot, MIGRATED_ARTIFACT_DIR);
  if (existsSync(migrated) && !roots.includes(migrated)) {
    roots.push(migrated);
  }

  for (const root of roots) {
    for (const folder of LOCAL_ORIGIN_FOLDERS) {
      const dir = join(root, folder);
      if (!existsSync(dir)) {
        continue;
      }
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries.sort()) {
        if (!hasArtifactSuffix(name)) {
          continue;
        }
        const path = join(dir, name);
        const plan = planOf(readJson(path));
        if (plan === null) {
          continue;
        }
        collectIssuesFromPlan(plan, defaultRepo, relPath(path, projectRoot), hits);
      }
    }
  }
  return hits;
}

function refExists(projectRoot: string, ref: string, runGit: GitRunner): boolean {
  const result = runGit(projectRoot, ["rev-parse", "--verify", "-q", ref]);
  return result.code === 0;
}

/**
 * Resolve the git tip to inspect for tracked completed/cancelled land.
 * Prefers origin/<deliveryBranch> when present.
 */
export function resolveDeliveryTip(
  projectRoot: string,
  tipOverride: string | null | undefined,
  runGit: GitRunner,
): { tip: string | null; error: string | null } {
  if (tipOverride !== null && tipOverride !== undefined && tipOverride.trim().length > 0) {
    const tip = tipOverride.trim();
    if (!refExists(projectRoot, tip, runGit)) {
      return { tip: null, error: `delivery tip ref not found: ${tip}` };
    }
    return { tip, error: null };
  }

  const delivery = resolveDeliveryBranch(projectRoot, runGit);
  const branch = delivery.branch;
  for (const candidate of [`origin/${branch}`, branch]) {
    if (refExists(projectRoot, candidate, runGit)) {
      return { tip: candidate, error: null };
    }
  }
  // ⊗ HEAD fallback (#3478 review). This gate exists to prove an artifact landed
  // on the delivery tip rather than on feature-worktree HEAD; falling back to
  // HEAD when the delivery ref is missing (shallow clone, unfetched worktree,
  // fetch-depth:1 checkout) checks the very branch whose land is in question and
  // silently passes. Unresolvable delivery tip must fail closed -- pass an
  // explicit --tip (e.g. --tip HEAD for an in-flight land PR) to opt in.
  return {
    tip: null,
    error:
      `could not resolve delivery tip for branch '${branch}' (no origin/${branch} or ${branch}); ` +
      "fetch the delivery branch or pass an explicit --tip",
  };
}

function listTreePaths(
  projectRoot: string,
  tip: string,
  prefixes: readonly string[],
  runGit: GitRunner,
): string[] {
  if (prefixes.length === 0) {
    return [];
  }
  const result = runGit(projectRoot, ["ls-tree", "-r", "--name-only", tip, "--", ...prefixes]);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim().replace(/\\/g, "/"))
    .filter((line) => line.length > 0 && hasArtifactSuffix(line));
}

function terminalPrefixes(): string[] {
  const out: string[] = [];
  for (const root of [MIGRATED_ARTIFACT_DIR, LEGACY_ARTIFACT_DIR]) {
    for (const folder of TIP_TERMINAL_FOLDERS) {
      out.push(`${root}/${folder}`);
    }
  }
  return out;
}

function nonterminalPrefixes(): string[] {
  const out: string[] = [];
  for (const root of [MIGRATED_ARTIFACT_DIR, LEGACY_ARTIFACT_DIR]) {
    for (const folder of TIP_NONTERMINAL_FOLDERS) {
      out.push(`${root}/${folder}`);
    }
  }
  return out;
}

function issuesFromBlobBodies(
  paths: readonly string[],
  bodies: ReadonlyMap<string, string | null>,
  defaultRepo: string | null,
  originPrefix: string,
): OriginHit[] {
  const hits: OriginHit[] = [];
  for (const path of paths) {
    const body = bodies.get(path);
    if (body === undefined || body === null) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      continue;
    }
    const plan = planOf(parsed as Record<string, unknown>);
    if (plan === null) {
      continue;
    }
    collectIssuesFromPlan(plan, defaultRepo, `${originPrefix}:${path}`, hits);
  }
  return hits;
}

/**
 * Narrow the origin map to the requested issue.
 *
 * Matching is repo-scoped when the caller's repo is known (#3478 review): a
 * corpus entry for another repository's same-numbered issue must NOT survive
 * this filter. Letting it through leaves `originMap` non-empty, which suppresses
 * the synthesis below and makes the gate resolve the wrong `repo#number` --
 * a foreign open issue then green-skips an unlanded local one.
 */
function filterOriginsByIssue(
  originMap: Map<string, MissingCompletedLand>,
  issue: number,
  repo: string | null,
): Map<string, MissingCompletedLand> {
  const out = new Map<string, MissingCompletedLand>();
  for (const [key, entry] of originMap) {
    if (entry.issue.number !== issue) {
      continue;
    }
    if (repo !== null && entry.issue.repo !== repo) {
      continue;
    }
    out.set(key, entry);
  }
  return out;
}

function mergeOrigins(hits: readonly OriginHit[]): Map<string, MissingCompletedLand> {
  const map = new Map<string, { issue: IssueRef; origins: Set<string> }>();
  for (const hit of hits) {
    const key = issueKey(hit.issue);
    let entry = map.get(key);
    if (entry === undefined) {
      entry = { issue: hit.issue, origins: new Set() };
      map.set(key, entry);
    }
    entry.origins.add(hit.originPath);
  }
  const out = new Map<string, MissingCompletedLand>();
  for (const [key, value] of map) {
    out.set(key, {
      issue: value.issue,
      origins: [...value.origins].sort(),
    });
  }
  return out;
}

function formatRefusal(
  missing: readonly MissingCompletedLand[],
  projectRoot: string,
  tip: string,
): string {
  const lines = [
    `verify:completed-tracked: ${missing.length} closed scoped issue${
      missing.length === 1 ? "" : "s"
    } lack a tracked xbrief/completed/ or xbrief/cancelled/ artifact on delivery tip ${tip} (project_root=${projectRoot}).`,
    "  Remediation: task swarm:finalize-cohort (or open a lifecycle PR that lands the completed/cancelled xBRIEFs).",
    "  Missing:",
  ];
  for (const item of missing) {
    const originSample = item.origins.slice(0, 3).join(", ");
    const more =
      item.origins.length > 3 ? ` (+${item.origins.length - 3} more origin path(s))` : "";
    lines.push(`    - ${formatIssue(item.issue)} (origin: ${originSample}${more})`);
  }
  return lines.join("\n");
}

/**
 * Pure evaluator: closed scoped issues must have tracked completed/cancelled
 * on the delivery tip (#3264).
 */
export function evaluateCompletedTracked(
  projectRoot: string,
  options: EvaluateCompletedTrackedOptions = {},
): EvaluateCompletedTrackedResult {
  const root = resolve(projectRoot);
  const quiet = options.quiet ?? false;
  const skipGh = options.skipGh ?? false;
  const runGh = options.runGh ?? defaultRunGh;
  const runGit = options.runGit ?? defaultGitRunner;
  const defaultRepo = resolveRepo(options.repo, root);
  const resolveState =
    options.resolveIssueState ??
    ((ref: IssueRef) => defaultResolveIssueState(ref, root, runGh, skipGh));

  if (!existsSync(root)) {
    return {
      code: 2,
      message: `verify:completed-tracked: project root does not exist: ${root}`,
      stream: "stderr",
      missing: [],
      tip: null,
    };
  }

  // Not a git worktree → nothing to assert about tracked tip (greenfield /
  // temp consumer fixtures). Soft-skip like orphan-active's empty-root path.
  const gitProbe = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (gitProbe.code !== 0) {
    if (quiet) {
      return { code: 0, message: "", stream: "none", missing: [], tip: null };
    }
    return {
      code: 0,
      message: `verify:completed-tracked: not a git worktree; skip tracked-land check (${root}).`,
      stream: "stdout",
      missing: [],
      tip: null,
    };
  }

  const { tip, error: tipError } = resolveDeliveryTip(root, options.tip, runGit);
  if (tip === null) {
    return {
      code: 2,
      message: `verify:completed-tracked: ${tipError ?? "could not resolve delivery tip"}`,
      stream: "stderr",
      missing: [],
      tip: null,
    };
  }

  const startedAt = (options.now ?? Date.now)();
  const emitProgress = (
    phase: CompletedTrackedProgress["phase"],
    terminalCount: number,
    nonterminalCount: number,
  ) => {
    options.onProgress?.({
      phase,
      terminalCount,
      nonterminalCount,
      elapsedMs: (options.now ?? Date.now)() - startedAt,
    });
  };

  const localHits = scanLocalOrigins(root, defaultRepo);
  const tipNonterminalPaths = listTreePaths(root, tip, nonterminalPrefixes(), runGit);
  // Delivery tip only — the land invariant is post-merge tip truth (#3264 AC).
  // Lifecycle PRs that commit completed/ on a feature branch are not expected
  // to satisfy this gate until merge; run the verb with --tip HEAD when
  // validating an in-flight land PR. The gate is a standalone verify verb
  // (not wired into check:consumer) so product PRs are not deadlocked.
  const tipTerminalPaths = listTreePaths(root, tip, terminalPrefixes(), runGit);
  emitProgress("listed", tipTerminalPaths.length, tipNonterminalPaths.length);

  // One process for every tip artifact. Issue identity still comes from
  // parsed plan.references / plan.metadata["x-tracking"] — never the path.
  const tipBodies = showBlobsBatch(
    root,
    tip,
    [...tipNonterminalPaths, ...tipTerminalPaths],
    runGit,
  );
  emitProgress("read", tipTerminalPaths.length, tipNonterminalPaths.length);

  const tipNonterminalHits = issuesFromBlobBodies(
    tipNonterminalPaths,
    tipBodies,
    defaultRepo,
    `tip:${tip}`,
  );
  let originMap = mergeOrigins([...localHits, ...tipNonterminalHits]);
  const tipTerminalHits = issuesFromBlobBodies(
    tipTerminalPaths,
    tipBodies,
    defaultRepo,
    `tip:${tip}`,
  );
  const landedKeys = new Set(tipTerminalHits.map((h) => issueKey(h.issue)));

  const issueFilter = options.issue ?? null;
  if (issueFilter !== null) {
    if (!Number.isInteger(issueFilter) || issueFilter <= 0) {
      return {
        code: 2,
        message: `verify:completed-tracked: --issue must be a positive integer (got ${issueFilter})`,
        stream: "stderr",
        missing: [],
        tip,
      };
    }
    originMap = filterOriginsByIssue(originMap, issueFilter, defaultRepo);
    // Drive-to DONE must not green-skip a named origin with no local brief
    // (#3476). Synthesize the requested issue so closed+unlanded fails.
    if (originMap.size === 0) {
      if (defaultRepo === null) {
        return {
          code: 2,
          message:
            `verify:completed-tracked: --issue ${issueFilter} requires --repo or a resolvable ` +
            "origin remote when no scoped xBRIEF origin is present.",
          stream: "stderr",
          missing: [],
          tip,
        };
      }
      const synthetic: MissingCompletedLand = {
        issue: { repo: defaultRepo, number: issueFilter },
        origins: [`--issue ${issueFilter}`],
      };
      originMap.set(issueKey(synthetic.issue), synthetic);
    }
  }

  if (originMap.size === 0) {
    if (quiet) {
      return { code: 0, message: "", stream: "none", missing: [], tip };
    }
    return {
      code: 0,
      message: "verify:completed-tracked: no scoped lifecycle origins found; nothing to check.",
      stream: "stdout",
      missing: [],
      tip,
    };
  }

  const missing: MissingCompletedLand[] = [];
  for (const [key, entry] of originMap) {
    if (landedKeys.has(key)) {
      continue;
    }
    const state = resolveState(entry.issue);
    if (state === "open") {
      continue;
    }
    // Closed: always fail.
    //
    // Unknown: fail when live lookup was expected (!skipGh) -- cannot prove the
    // issue is still open, so do not green-skip land debt (#3264 Greptile
    // residual on live lookup failure).
    //
    // Unknown also fails for an explicitly named --issue even under --skip-gh
    // (#3478 review): that is the drive-to DONE form, where the caller asserts
    // this specific issue is done. An uncached issue must not exit 0 there --
    // otherwise --skip-gh silently turns the DONE gate into a no-op. The
    // unscoped corpus scan keeps the offline allowance, since a cold cache
    // legitimately knows nothing about most scoped issues.
    const unknownIsTerminal = !skipGh || issueFilter !== null;
    if (state === "closed" || (state === null && unknownIsTerminal)) {
      missing.push(entry);
    }
  }
  missing.sort((a, b) => issueKey(a.issue).localeCompare(issueKey(b.issue)));

  if (missing.length > 0) {
    return {
      code: 1,
      message: formatRefusal(missing, root, tip),
      stream: "stderr",
      missing,
      tip,
    };
  }

  if (quiet) {
    return { code: 0, message: "", stream: "none", missing: [], tip };
  }

  return {
    code: 0,
    message:
      `verify:completed-tracked: all closed scoped issues have tracked completed/cancelled ` +
      `on tip ${tip} (scoped origins checked: ${originMap.size}).`,
    stream: "stdout",
    missing: [],
    tip,
  };
}
