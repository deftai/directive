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
import { referenceTypeMatches } from "@deftai/directive-types";
import {
  briefOwnsIssue,
  isResidualPlanId,
  issueOriginFromRepoSlug,
} from "../intake/residual-identity.js";
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
import { extractPlanId } from "../scope/parent-lineage.js";
import { defaultGitRunner, type GitRunner, showBlobsBatch } from "../session/git.js";
import { CACHE_DIR_NAME, CACHE_SOURCE_GITHUB_ISSUE } from "../triage/queue/constants.js";
import { resolveRepo } from "../triage/queue/repo.js";
import { parseGithubIssueUri } from "../triage/reconcile/parse-uri.js";

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
  /** Local lifecycle briefs with a parseable plan (#4426). */
  readonly briefsScanned?: number;
  /** Distinct forge origins resolved from those briefs and the tip (#4426). */
  readonly originsResolved?: number;
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

interface IssueStatePayload {
  readonly state: "open" | "closed";
  readonly stateReason: string | null;
}

function normalizeStateReason(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  return raw.trim().toLowerCase();
}

function payloadFromRaw(raw: Record<string, unknown>): IssueStatePayload | null {
  const state = typeof raw.state === "string" ? raw.state.toLowerCase() : "";
  if (state !== "closed" && state !== "open") {
    return null;
  }
  return { state, stateReason: normalizeStateReason(raw.state_reason) };
}

function readCachedIssuePayload(projectRoot: string, ref: IssueRef): IssueStatePayload | null {
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
  return payloadFromRaw(raw);
}

function fetchIssuePayloadLive(ref: IssueRef, runGh: RunGhFn): IssueStatePayload | null {
  const path = `repos/${ref.repo}/issues/${ref.number}`;
  const result = runGh(["gh", "api", path]);
  if (result.returncode !== 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return payloadFromRaw(parsed as Record<string, unknown>);
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
  const cached = readCachedIssuePayload(projectRoot, ref);
  // Closed cache is fail-closed evidence (safe to trust without live).
  if (cached?.state === "closed") {
    return "closed";
  }
  if (skipGh) {
    // Offline / fixture mode: honor cache open|null as-is.
    return cached?.state ?? null;
  }
  // Prefer live when network is allowed. Stale open cache must not suppress a
  // later close when live succeeds (#3264 Greptile P1). When live fails, do
  // NOT fall back to cached open — treat as unknown so we fail closed only on
  // positive closed evidence (cached closed above, or live closed).
  const live = fetchIssuePayloadLive(ref, runGh);
  if (live !== null) {
    return live.state;
  }
  return null;
}

/**
 * Closed reasons that are abandon/supersede, not shipped Tracking close (#5126).
 * Matches reconcile cancelled destinations (NOT_PLANNED / DUPLICATE).
 */
export const ABANDON_CLOSE_REASONS = new Set(["not_planned", "duplicate"]);

/** Close kind for the shipped-origin cancel refuse (#5126). */
export type IssueCloseKind = "open" | "shipped-closed" | "abandoned-closed" | "unknown";

function closeKindFromPayload(payload: IssueStatePayload | null): IssueCloseKind {
  if (payload === null) {
    return "unknown";
  }
  if (payload.state === "open") {
    return "open";
  }
  if (payload.stateReason !== null && ABANDON_CLOSE_REASONS.has(payload.stateReason)) {
    return "abandoned-closed";
  }
  // completed, null, or other non-abandon reason → shipped-closed equivalent.
  return "shipped-closed";
}

/**
 * Close-kind resolution for the #5126 cancel refuse.
 *
 * Cached shipped-closed is fail-closed evidence (safe to trust without live).
 * Cached abandoned-closed (`not_planned`/`duplicate`) and cached open are NOT —
 * a reopen then completed close (or open→completed with stale open cache) must
 * not skip the tip-twin refuse (#5126 Greptile P1). Prefer live REST whenever
 * network is allowed; when live fails, do not green cancel on stale open or
 * abandon cache (treat as unknown).
 */
export function resolveIssueCloseKind(
  ref: IssueRef,
  projectRoot: string,
  runGh: RunGhFn,
  skipGh: boolean,
): IssueCloseKind {
  const cached = readCachedIssuePayload(projectRoot, ref);
  const cachedKind = closeKindFromPayload(cached);
  if (skipGh) {
    return cachedKind;
  }
  // Prefer live for every cache kind. Stale cached completed must not block
  // abandon after a later reopen / not_planned close (#5126 Greptile P1).
  // Stale open / abandon must not authorize cancel after a later completed close.
  const live = fetchIssuePayloadLive(ref, runGh);
  if (live !== null) {
    return closeKindFromPayload(live);
  }
  // Live failed: trust cached shipped-closed (fail-closed refuse). Do not trust
  // cached open or abandon as permission to cancel.
  if (cachedKind === "shipped-closed") {
    return "shipped-closed";
  }
  return "unknown";
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

function scanLocalOrigins(
  projectRoot: string,
  defaultRepo: string | null,
): { hits: OriginHit[]; briefsScanned: number } {
  const hits: OriginHit[] = [];
  let briefsScanned = 0;
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
        briefsScanned += 1;
        collectIssuesFromPlan(plan, defaultRepo, relPath(path, projectRoot), hits);
      }
    }
  }
  return { hits, briefsScanned };
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

/** Completed-only tip prefixes for Tracking ship-path twin (#5126). */
function completedOnlyPrefixes(): string[] {
  const out: string[] = [];
  for (const root of [MIGRATED_ARTIFACT_DIR, LEGACY_ARTIFACT_DIR]) {
    out.push(`${root}/completed`);
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

function planIdsFromBlobBodies(
  paths: readonly string[],
  bodies: ReadonlyMap<string, string | null>,
): Set<string> {
  const ids = new Set<string>();
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
    const id = extractPlanId(parsed as Record<string, unknown>);
    if (id !== null && id.trim().length > 0) {
      ids.add(id.trim());
    }
  }
  return ids;
}

/** Local residual plan.ids that must land before predecessor completed can certify (#5177). */
function scanLocalResidualPlanIds(
  projectRoot: string,
  issueNumber: number,
  repoSlug: string | null,
): { readonly planIds: readonly string[]; readonly origins: readonly string[] } {
  const ownershipTarget = issueOriginFromRepoSlug(repoSlug, issueNumber) ?? issueNumber;
  const planIds: string[] = [];
  const origins: string[] = [];
  const roots: string[] = [];
  try {
    roots.push(resolveLifecycleRoot(projectRoot));
  } catch {
    // no xbrief layout
  }
  const legacyRoot = join(projectRoot, LEGACY_ARTIFACT_DIR);
  if (existsSync(legacyRoot) && !roots.includes(legacyRoot)) {
    roots.push(legacyRoot);
  }
  const migrated = join(projectRoot, MIGRATED_ARTIFACT_DIR);
  if (existsSync(migrated) && !roots.includes(migrated)) {
    roots.push(migrated);
  }
  // cancelled/ is abandon-only — do not treat it as residual land debt or evidence.
  const residualFolders = ["proposed", "pending", "active", "completed"] as const;
  for (const root of roots) {
    for (const folder of residualFolders) {
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
        const data = readJson(path);
        if (data === null || !briefOwnsIssue(data, ownershipTarget)) {
          continue;
        }
        const id = extractPlanId(data);
        if (id === null || !isResidualPlanId(id)) {
          continue;
        }
        planIds.push(id);
        origins.push(relPath(path, projectRoot));
      }
    }
  }
  return { planIds, origins };
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
  const issueNums = missing.map((item) => item.issue.number).join(",");
  const lines = [
    `verify:completed-tracked: ${missing.length} closed scoped issue${
      missing.length === 1 ? "" : "s"
    } lack a tracked xbrief/completed/ or xbrief/cancelled/ artifact on delivery tip ${tip} (project_root=${projectRoot}).`,
    "  Remediation: task swarm:finalize-cohort -- --pr <n>[,<n>...] or --stories <ids|paths> (or open a lifecycle PR that lands the completed/cancelled xBRIEFs).",
    `  Example: task swarm:finalize-cohort -- --stories ${issueNums}`,
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

  const localScan = scanLocalOrigins(root, defaultRepo);
  const localHits = localScan.hits;
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
  // Residual land evidence is completed-only — cancelled/ must not certify (#5177).
  const tipCompletedPaths = tipTerminalPaths.filter((path) => {
    const normalized = path.replace(/\\/g, "/");
    return (
      normalized.includes(`${MIGRATED_ARTIFACT_DIR}/completed/`) ||
      normalized.includes(`${LEGACY_ARTIFACT_DIR}/completed/`)
    );
  });
  const tipCompletedPlanIds = planIdsFromBlobBodies(tipCompletedPaths, tipBodies);

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
      return {
        code: 0,
        message: "",
        stream: "none",
        missing: [],
        tip,
        briefsScanned: localScan.briefsScanned,
        originsResolved: 0,
      };
    }
    const briefNoun = localScan.briefsScanned === 1 ? "brief" : "briefs";
    return {
      code: 0,
      message:
        `verify:completed-tracked: scanned ${localScan.briefsScanned} ${briefNoun}, ` +
        "resolved 0 origins; nothing to check.",
      stream: "stdout",
      missing: [],
      tip,
      briefsScanned: localScan.briefsScanned,
      originsResolved: 0,
    };
  }

  const missing: MissingCompletedLand[] = [];
  for (const [key, entry] of originMap) {
    const residual = scanLocalResidualPlanIds(root, entry.issue.number, entry.issue.repo);
    // Every current residual identity must appear on completed tip — an earlier
    // residual landing must not certify a later lean reopen (#5177).
    const residualLanded =
      residual.planIds.length === 0 || residual.planIds.every((id) => tipCompletedPlanIds.has(id));
    if (landedKeys.has(key) && residualLanded) {
      continue;
    }
    // Predecessor completed on tip is not enough when a residual identity exists (#5177).
    // Drive-to DONE (--issue N) must fail closed on unknown GitHub state here — do not
    // treat null/unresolved as "not orphaned" success (SLizard premature-success class;
    // locked by residual-unknown --skip-gh test). This path does not reuse
    // assessOrphanSignature; unknown under --issue or live lookup is terminal debt.
    if (landedKeys.has(key) && !residualLanded) {
      const stateWhenResidual = resolveState(entry.issue);
      // Named --issue still fails residual debt while open (#4714 R6).
      if (stateWhenResidual === "open" && issueFilter === null) {
        continue;
      }
      const unknownIsTerminalResidual = !skipGh || issueFilter !== null;
      if (
        issueFilter !== null ||
        stateWhenResidual === "closed" ||
        (stateWhenResidual === null && unknownIsTerminalResidual)
      ) {
        missing.push({
          issue: entry.issue,
          origins: [
            ...entry.origins,
            ...residual.origins.map((p) => `residual:${p}`),
            `residual-plan-id:${residual.planIds.join(",")}`,
          ],
        });
      }
      continue;
    }
    const state = resolveState(entry.issue);
    // #4714 R6: --issue N close proof requires a terminal artifact on the
    // fetched delivery tip independent of GitHub open/closed state. The open
    // green-skip remains for unscoped corpus scans only.
    if (state === "open" && issueFilter === null) {
      continue;
    }
    // Closed: always fail.
    //
    // Named --issue: fail when unlanded regardless of open/closed (#4714 R6).
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
    if (issueFilter !== null || state === "closed" || (state === null && unknownIsTerminal)) {
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
      briefsScanned: localScan.briefsScanned,
      originsResolved: originMap.size,
    };
  }

  if (quiet) {
    return {
      code: 0,
      message: "",
      stream: "none",
      missing: [],
      tip,
      briefsScanned: localScan.briefsScanned,
      originsResolved: originMap.size,
    };
  }

  return {
    code: 0,
    message:
      `verify:completed-tracked: all closed scoped issues have tracked completed/cancelled ` +
      `on tip ${tip} (scanned ${localScan.briefsScanned} briefs, scoped origins checked: ${originMap.size}).`,
    stream: "stdout",
    missing: [],
    tip,
    briefsScanned: localScan.briefsScanned,
    originsResolved: originMap.size,
  };
}

export interface CompletedTipTwinResult {
  readonly found: boolean;
  readonly tip: string | null;
  readonly error: string | null;
}

/**
 * Delivery-tip scan for a completed/ twin citing the issue (#5126).
 * Completed-only — cancelled tip twins do not satisfy the ship-path refuse.
 */
export function hasCompletedTipTwinForIssue(
  projectRoot: string,
  issue: IssueRef,
  options: {
    readonly tip?: string | null;
    readonly runGit?: GitRunner;
  } = {},
): CompletedTipTwinResult {
  const root = resolve(projectRoot);
  const runGit = options.runGit ?? defaultGitRunner;
  const { tip, error } = resolveDeliveryTip(root, options.tip, runGit);
  if (tip === null) {
    return { found: false, tip: null, error: error ?? "could not resolve delivery tip" };
  }
  const paths = listTreePaths(root, tip, completedOnlyPrefixes(), runGit);
  if (paths.length === 0) {
    return { found: false, tip, error: null };
  }
  const bodies = showBlobsBatch(root, tip, paths, runGit);
  const hits = issuesFromBlobBodies(paths, bodies, issue.repo, `tip:${tip}`);
  const key = issueKey(issue);
  const found = hits.some((hit) => issueKey(hit.issue) === key);
  return { found, tip, error: null };
}

export interface CancelShippedOriginRefuseOptions {
  readonly runGh?: RunGhFn;
  readonly skipGh?: boolean;
  readonly runGit?: GitRunner;
  readonly tip?: string | null;
  readonly repo?: string | null;
  /** Active brief path being cancelled — printed into runnable remediation. */
  readonly briefPath?: string | null;
  readonly resolveCloseKind?: (ref: IssueRef) => IssueCloseKind;
  readonly hasCompletedTwin?: (ref: IssueRef) => CompletedTipTwinResult;
}

export type CancelShippedOriginRefuseResult =
  | { readonly refuse: false }
  | { readonly refuse: true; readonly message: string };

function formatBriefRemediationPath(
  projectRoot: string,
  briefPath: string | null | undefined,
): string {
  if (briefPath === null || briefPath === undefined || briefPath.trim().length === 0) {
    return "xbrief/active/<file>.xbrief.json";
  }
  const rel = relative(resolve(projectRoot), resolve(briefPath)).replace(/\\/g, "/");
  if (rel.length === 0 || rel.startsWith("..")) {
    return briefPath.replace(/\\/g, "/");
  }
  return rel;
}

function formatCancelShippedOriginRefuse(
  issue: IssueRef,
  tip: string | null,
  detail: string,
  briefPath: string,
): string {
  const tipLabel = tip ?? "origin/<deliveryBranch>";
  return [
    `scope:cancel: refused for shipped-closed origin ${formatIssue(issue)} without a completed tip twin on ${tipLabel} (${detail}).`,
    `  Remediation: leftover-complete via task scope:complete -- ${briefPath} (optional --merge-commit <sha> --pr <n>), or task swarm:finalize-cohort -- --pr <n> / --stories ${issue.number}.`,
  ].join("\n");
}

/**
 * Own-origin issue refs for the #5126 cancel refuse.
 *
 * Uses plan.references github-issue entries. Does not treat
 * x-tracking.decomposition_origin as a cancel gate — a closed related /
 * decomposition parent without a tip twin must not block abandoning an
 * open-origin brief (#5126 Greptile P1). Falls back to x-tracking.parent_issue
 * only when references named no origin. Bare numbers / unresolved repo set unresolvedBareOrigin (refuse even when
 * other full-URL origins resolved). parent_issue may be a GitHub URL.
 */
export function collectCancelOwnOriginIssues(
  plan: Record<string, unknown>,
  defaultRepo: string | null,
): { issues: IssueRef[]; unresolvedBareOrigin: boolean } {
  const issues: IssueRef[] = [];
  const seen = new Set<string>();
  let unresolvedBareOrigin = false;

  const add = (repo: string | null, number: number | null): void => {
    if (number === null) {
      return;
    }
    const resolved = repo ?? defaultRepo;
    if (resolved === null || resolved.length === 0) {
      unresolvedBareOrigin = true;
      return;
    }
    const key = `${resolved}:${number}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    issues.push({ repo: resolved, number });
  };

  const parseTrackingOrigin = (value: unknown): { repo: string | null; number: number | null } => {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return { repo: null, number: value };
    }
    if (typeof value !== "string") {
      return { repo: null, number: null };
    }
    const [repoFromUri, numberFromUri] = parseGithubIssueUri(value);
    if (numberFromUri !== null) {
      return { repo: repoFromUri, number: numberFromUri };
    }
    const match = value.match(/#(\d+)/);
    return match ? { repo: null, number: Number(match[1]) } : { repo: null, number: null };
  };

  const refs = plan.references;
  if (Array.isArray(refs)) {
    for (const ref of refs) {
      if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
        continue;
      }
      const typed = ref as Record<string, unknown>;
      const type = String(typed.type ?? "");
      if (!referenceTypeMatches(type, "github-issue")) {
        continue;
      }
      const [repo, number] = parseGithubIssueUri(typed.uri);
      add(repo, number);
    }
  }

  let parentOrigin: { repo: string | null; number: number | null } = {
    repo: null,
    number: null,
  };
  let decompOrigin: { repo: string | null; number: number | null } = {
    repo: null,
    number: null,
  };
  const metadata = plan.metadata;
  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    const tracking = (metadata as Record<string, unknown>)["x-tracking"];
    if (typeof tracking === "object" && tracking !== null && !Array.isArray(tracking)) {
      const t = tracking as Record<string, unknown>;
      parentOrigin = parseTrackingOrigin(t.parent_issue);
      decompOrigin = parseTrackingOrigin(t.decomposition_origin);
    }
  }

  if (issues.length === 0 && parentOrigin.number !== null) {
    add(parentOrigin.repo, parentOrigin.number);
  } else if (
    issues.length === 0 &&
    parentOrigin.number === null &&
    decompOrigin.number !== null &&
    defaultRepo === null &&
    decompOrigin.repo === null
  ) {
    unresolvedBareOrigin = true;
  }

  return { issues, unresolvedBareOrigin };
}

/**
 * Fail-closed cancel refuse for shipped Tracking/Refs close without completed
 * tip twin (#5126). True abandon stays open when origin is open or abandoned-closed.
 */
export function evaluateCancelShippedOriginRefuse(
  projectRoot: string,
  plan: Record<string, unknown>,
  options: CancelShippedOriginRefuseOptions = {},
): CancelShippedOriginRefuseResult {
  const root = resolve(projectRoot);
  const skipGh = options.skipGh ?? false;
  const runGh = options.runGh ?? defaultRunGh;
  const runGit = options.runGit ?? defaultGitRunner;
  const defaultRepo = resolveRepo(options.repo, root);
  const briefPath = formatBriefRemediationPath(root, options.briefPath);
  const { issues, unresolvedBareOrigin } = collectCancelOwnOriginIssues(plan, defaultRepo);
  if (unresolvedBareOrigin) {
    return {
      refuse: true,
      message: [
        "scope:cancel: refused — brief cites a bare origin issue number but no resolvable GitHub repo (origin remote / --repo).",
        `  Remediation: set origin remote or pass repo, then leftover-complete via task scope:complete -- ${briefPath} or task swarm:finalize-cohort -- --pr <n> / --stories <N>.`,
      ].join("\n"),
    };
  }
  if (issues.length === 0) {
    return { refuse: false };
  }

  const resolveKind =
    options.resolveCloseKind ??
    ((ref: IssueRef) => resolveIssueCloseKind(ref, root, runGh, skipGh));
  const twinOf =
    options.hasCompletedTwin ??
    ((ref: IssueRef) => hasCompletedTipTwinForIssue(root, ref, { tip: options.tip, runGit }));

  for (const issue of issues) {
    const kind = resolveKind(issue);
    if (kind === "open" || kind === "abandoned-closed") {
      continue;
    }
    if (kind === "unknown") {
      return {
        refuse: true,
        message: formatCancelShippedOriginRefuse(
          issue,
          null,
          "could not resolve closed state",
          briefPath,
        ),
      };
    }
    // shipped-closed
    const twin = twinOf(issue);
    if (twin.error !== null) {
      return {
        refuse: true,
        message: formatCancelShippedOriginRefuse(issue, twin.tip, twin.error, briefPath),
      };
    }
    if (!twin.found) {
      return {
        refuse: true,
        message: formatCancelShippedOriginRefuse(
          issue,
          twin.tip,
          "no xbrief/completed/ (or vbrief/completed/) citing the origin",
          briefPath,
        ),
      };
    }
  }
  return { refuse: false };
}
