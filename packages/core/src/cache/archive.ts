/**
 * Reversible archive for closed github-issue cache entries (#1137).
 *
 * Distinct from `cachePrune` (TTL / expires_at hard-delete). This module moves
 * closed-and-aged live entries under `.deft-cache/archived/github-issue/...`
 * with `archive-meta.json`, and can list/restore them. Operator-invoked only;
 * never wired into check / session-start / sync.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  assertProjectionContained,
  ProjectionContainmentError,
} from "../fs/projection-containment.js";
import { hasArtifactSuffix, resolveLifecycleRoot } from "../layout/resolve.js";
import { issueNumbersFromPlan } from "../triage/queue/scope-walk.js";
import { DEFAULT_PRUNE_OLDER_THAN_DAYS, GH_KEY_RE, REPO_RE } from "./constants.js";
import { CacheError } from "./errors.js";
import { appendAudit, atomicWriteText } from "./io.js";
import { entryDir, validateKey } from "./paths.js";
import { type Clock, parseIso, systemClock, utcIso } from "./time.js";

export { ProjectionContainmentError as CacheArchiveContainmentError };

/** Archive age default matches TTL prune window but is a separate concept (#1137). */
export const DEFAULT_ARCHIVE_OLDER_THAN_DAYS = DEFAULT_PRUNE_OLDER_THAN_DAYS;

export const ARCHIVE_SOURCE_GITHUB_ISSUE = "github-issue";
export const ARCHIVED_ROOT_SEGMENT = "archived";
export const ARCHIVE_META_FILENAME = "archive-meta.json";

const OPEN_LIFECYCLE_FOLDERS = ["proposed", "pending", "active"] as const;
const TERMINAL_DECISIONS = new Set(["reject", "mark-duplicate"]);

export interface ArchiveMeta {
  archived_at: string;
  reason: string;
  source_path: string;
  key: string;
  source: string;
  pre_archive_decision?: string | null;
  closed_at?: string | null;
  age_basis?: string;
}

export type ArchiveSkipReason =
  | "not-closed"
  | "too-recent"
  | "open-lifecycle-scope"
  | "non-terminal-decision"
  | "missing-raw"
  | "invalid-key"
  | "already-archived";

export interface ArchiveCandidate {
  source: string;
  key: string;
  liveDir: string;
  archiveDir: string;
  closedAt: string | null;
  ageBasis: string;
  ageMs: number;
  preArchiveDecision: string | null;
}

export interface ArchiveSkip {
  source: string;
  key: string;
  reason: ArchiveSkipReason;
  detail?: string;
}

export interface ArchiveClosedResult {
  dryRun: boolean;
  olderThanDays: number;
  source: string;
  repo: string | null;
  archived: ArchiveCandidate[];
  skipped: ArchiveSkip[];
  archivedCount: number;
  skippedCount: number;
}

export interface ArchivedEntry {
  source: string;
  key: string;
  archiveDir: string;
  archivedAt: string;
  meta: ArchiveMeta;
}

export interface ArchiveListResult {
  entries: ArchivedEntry[];
  count: number;
  source: string;
  repo: string | null;
}

export interface RestoreResult {
  source: string;
  key: string;
  status: "restored" | "already-live" | "missing" | "conflict";
  liveDir: string;
  archiveDir: string;
  detail?: string;
}

function assertWritableCachePath(cacheRoot: string, ...segments: string[]): string {
  const cacheAbs = resolve(cacheRoot);
  const projectDir = dirname(cacheAbs);
  const target = segments.length > 0 ? join(cacheAbs, ...segments) : cacheAbs;
  assertProjectionContained(projectDir, target);
  return target;
}

/** Live entry dir for a github-issue key. */
export function liveEntryDir(source: string, key: string, cacheRoot: string): string {
  return entryDir(source, key, cacheRoot);
}

/** Archived entry dir: `.deft-cache/archived/<source>/<owner>/<repo>/<N>/`. */
export function archivedEntryDir(source: string, key: string, cacheRoot: string): string {
  if (source !== ARCHIVE_SOURCE_GITHUB_ISSUE) {
    throw new CacheError(
      `archive source '${source}' not supported in v1 (supports: ${ARCHIVE_SOURCE_GITHUB_ISSUE} only)`,
    );
  }
  validateKey(source, key);
  return join(cacheRoot, ARCHIVED_ROOT_SEGMENT, source, ...key.split("/"));
}

function loadPlan(path: string): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(readFileSync(path, { encoding: "utf8" }));
    if (typeof data !== "object" || data === null) return null;
    const plan = (data as Record<string, unknown>).plan;
    return typeof plan === "object" && plan !== null ? (plan as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Issue numbers referenced by open lifecycle scopes in
 * `xbrief/{proposed,pending,active}/` (#1137 eligibility gate).
 */
export function openLifecycleReferencedIssueNumbers(projectRoot: string): ReadonlySet<number> {
  const out = new Set<number>();
  let base: string;
  try {
    base = resolveLifecycleRoot(projectRoot);
  } catch {
    return out;
  }
  for (const folder of OPEN_LIFECYCLE_FOLDERS) {
    const folderDir = join(base, folder);
    if (!existsSync(folderDir)) continue;
    for (const name of readdirSync(folderDir)
      .filter((entry) => hasArtifactSuffix(entry))
      .sort()) {
      const plan = loadPlan(join(folderDir, name));
      if (plan === null) continue;
      for (const n of issueNumbersFromPlan(plan)) {
        out.add(n);
      }
    }
  }
  return out;
}

function collectLiveMetaPaths(srcRoot: string): string[] {
  const found: string[] = [];
  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else if (name.name === "meta.json") found.push(full);
    }
  }
  walk(srcRoot);
  return found;
}

function keyFromLiveMetaPath(metaPath: string, srcRoot: string): string {
  const parent = dirname(metaPath);
  const rel = relative(srcRoot, parent);
  return rel.split(/[/\\]/).join("/");
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

function issueNumberFromKey(key: string): number | null {
  const m = GH_KEY_RE.exec(key);
  if (!m) return null;
  return Number.parseInt(m[3] ?? "", 10);
}

function repoFromKey(key: string): string | null {
  const m = GH_KEY_RE.exec(key);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Resolve closed age basis: `closed_at` from raw, else `meta.fetched_at`, else
 * meta.json mtime (#1137).
 */
export function resolveClosedAge(
  raw: Record<string, unknown>,
  meta: Record<string, unknown> | null,
  metaPath: string,
  now: Date,
): { closedAt: string | null; ageBasis: string; ageMs: number } {
  const closedRaw = raw.closed_at;
  if (typeof closedRaw === "string" && closedRaw.trim().length > 0) {
    try {
      const dt = parseIso(closedRaw);
      if (!Number.isNaN(dt.getTime())) {
        return {
          closedAt: closedRaw,
          ageBasis: "closed_at",
          ageMs: Math.max(0, now.getTime() - dt.getTime()),
        };
      }
    } catch {
      /* fall through */
    }
  }
  const fetched = meta && typeof meta.fetched_at === "string" ? meta.fetched_at : null;
  if (fetched) {
    try {
      const dt = parseIso(fetched);
      if (!Number.isNaN(dt.getTime())) {
        return {
          closedAt: null,
          ageBasis: "fetched_at",
          ageMs: Math.max(0, now.getTime() - dt.getTime()),
        };
      }
    } catch {
      /* fall through */
    }
  }
  const mtime = fileMtimeMs(metaPath);
  return {
    closedAt: null,
    ageBasis: "mtime",
    ageMs: mtime > 0 ? Math.max(0, now.getTime() - mtime) : 0,
  };
}

export interface ArchiveClosedOptions {
  olderThanDays?: number;
  source?: string;
  repo?: string | null;
  dryRun?: boolean;
  cacheRoot?: string;
  projectRoot?: string;
  /** Optional map of `owner/repo#N` or `N` → latest decision string. */
  latestDecisions?: ReadonlyMap<string, string> | null;
  /** When true, only archive reject / mark-duplicate latest decisions. */
  terminalDecisionOnly?: boolean;
  /** Override protected issue set (tests); default scans open lifecycle. */
  protectedIssueNumbers?: ReadonlySet<number> | null;
  reason?: string;
  clock?: Clock;
}

function decisionKey(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

/**
 * Archive closed github-issue cache entries older than the threshold.
 * Skips (does not half-move) entries still referenced by open lifecycle scopes.
 */
export function archiveClosedEntries(options: ArchiveClosedOptions = {}): ArchiveClosedResult {
  const clock = options.clock ?? systemClock;
  const olderThanDays = options.olderThanDays ?? DEFAULT_ARCHIVE_OLDER_THAN_DAYS;
  if (olderThanDays < 0 || !Number.isFinite(olderThanDays)) {
    throw new CacheError(`--older-than-days must be >= 0 (got ${JSON.stringify(olderThanDays)})`);
  }
  const source = options.source ?? ARCHIVE_SOURCE_GITHUB_ISSUE;
  if (source !== ARCHIVE_SOURCE_GITHUB_ISSUE) {
    throw new CacheError(
      `archive source '${source}' not supported in v1 (supports: ${ARCHIVE_SOURCE_GITHUB_ISSUE} only)`,
    );
  }
  if (options.repo != null && options.repo !== "" && !REPO_RE.test(options.repo)) {
    throw new CacheError(
      `invalid --repo '${options.repo}': expected 'owner/repo' (alphanumerics, '.', '_', '-' only)`,
    );
  }
  const cacheRoot = options.cacheRoot ?? ".deft-cache";
  assertWritableCachePath(cacheRoot);
  const projectRoot = options.projectRoot ?? dirname(resolve(cacheRoot));
  const dryRun = options.dryRun === true;
  const thresholdMs = olderThanDays * 24 * 60 * 60 * 1000;
  const now = clock.now();

  const protectedIssues =
    options.protectedIssueNumbers ?? openLifecycleReferencedIssueNumbers(projectRoot);

  const archived: ArchiveCandidate[] = [];
  const skipped: ArchiveSkip[] = [];

  const srcRoot = join(cacheRoot, source);
  if (!existsSync(srcRoot)) {
    return {
      dryRun,
      olderThanDays,
      source,
      repo: options.repo ?? null,
      archived,
      skipped,
      archivedCount: 0,
      skippedCount: 0,
    };
  }

  for (const metaPath of collectLiveMetaPaths(srcRoot)) {
    const key = keyFromLiveMetaPath(metaPath, srcRoot);
    if (!GH_KEY_RE.test(key)) {
      skipped.push({ source, key, reason: "invalid-key" });
      continue;
    }
    if (options.repo) {
      const keyRepo = repoFromKey(key);
      if (keyRepo !== options.repo) continue;
    }

    const liveDir = dirname(metaPath);
    const archiveDir = archivedEntryDir(source, key, cacheRoot);
    if (existsSync(archiveDir) && !existsSync(liveDir)) {
      skipped.push({ source, key, reason: "already-archived" });
      continue;
    }

    const rawPath = join(liveDir, "raw.json");
    if (!existsSync(rawPath)) {
      skipped.push({ source, key, reason: "missing-raw" });
      continue;
    }
    const raw = readJsonObject(rawPath);
    if (raw === null) {
      skipped.push({ source, key, reason: "missing-raw", detail: "unreadable raw.json" });
      continue;
    }
    if (raw.state !== "closed") {
      skipped.push({ source, key, reason: "not-closed" });
      continue;
    }

    const meta = readJsonObject(metaPath);
    const age = resolveClosedAge(raw, meta, metaPath, now);
    if (age.ageMs < thresholdMs) {
      skipped.push({
        source,
        key,
        reason: "too-recent",
        detail: `age_days=${(age.ageMs / 86400000).toFixed(2)} basis=${age.ageBasis}`,
      });
      continue;
    }

    const issueNum = issueNumberFromKey(key);
    if (issueNum !== null && protectedIssues.has(issueNum)) {
      skipped.push({
        source,
        key,
        reason: "open-lifecycle-scope",
        detail: `issue #${issueNum} referenced in proposed/pending/active`,
      });
      continue;
    }

    let preArchiveDecision: string | null = null;
    if (options.latestDecisions && issueNum !== null) {
      const keyRepo = repoFromKey(key) ?? "";
      preArchiveDecision =
        options.latestDecisions.get(decisionKey(keyRepo, issueNum)) ??
        options.latestDecisions.get(String(issueNum)) ??
        null;
    }
    if (options.terminalDecisionOnly) {
      if (preArchiveDecision === null || !TERMINAL_DECISIONS.has(preArchiveDecision)) {
        skipped.push({
          source,
          key,
          reason: "non-terminal-decision",
          detail: preArchiveDecision ?? "none",
        });
        continue;
      }
    }

    const candidate: ArchiveCandidate = {
      source,
      key,
      liveDir,
      archiveDir,
      closedAt: age.closedAt,
      ageBasis: age.ageBasis,
      ageMs: age.ageMs,
      preArchiveDecision,
    };

    if (!dryRun) {
      assertWritableCachePath(cacheRoot, ARCHIVED_ROOT_SEGMENT, source, ...key.split("/"));
      assertWritableCachePath(cacheRoot, source, ...key.split("/"));
      mkdirSync(dirname(archiveDir), { recursive: true });
      if (existsSync(archiveDir)) {
        // Prefer live overwrite of stale archive only when operator re-archives;
        // refuse silently by skipping to avoid data loss of archived tree.
        skipped.push({
          source,
          key,
          reason: "already-archived",
          detail: "archive path exists; remove or restore first",
        });
        continue;
      }
      renameSync(liveDir, archiveDir);
      const archiveMeta: ArchiveMeta = {
        archived_at: utcIso(clock),
        reason: options.reason ?? "closed-age-archive",
        source_path: liveDir.split(/[/\\]/).join("/"),
        key,
        source,
        pre_archive_decision: preArchiveDecision,
        closed_at: age.closedAt,
        age_basis: age.ageBasis,
      };
      const projectDir = dirname(resolve(cacheRoot));
      atomicWriteText(
        join(archiveDir, ARCHIVE_META_FILENAME),
        `${JSON.stringify(archiveMeta, null, 2)}\n`,
        { projectRoot: projectDir },
      );
      appendAudit(
        {
          event: "cache:archive",
          source,
          key,
          timestamp: utcIso(clock),
          reason: archiveMeta.reason,
          archive_dir: archiveDir.split(/[/\\]/).join("/"),
          closed_at: age.closedAt,
          age_basis: age.ageBasis,
          pre_archive_decision: preArchiveDecision,
        },
        cacheRoot,
      );
    }

    archived.push(candidate);
  }

  return {
    dryRun,
    olderThanDays,
    source,
    repo: options.repo ?? null,
    archived,
    skipped,
    archivedCount: archived.length,
    skippedCount: skipped.length,
  };
}

export interface ArchiveListOptions {
  source?: string;
  repo?: string | null;
  since?: string | null;
  limit?: number | null;
  cacheRoot?: string;
}

/** List archived entries newest `archived_at` first. */
export function listArchivedEntries(options: ArchiveListOptions = {}): ArchiveListResult {
  const source = options.source ?? ARCHIVE_SOURCE_GITHUB_ISSUE;
  if (source !== ARCHIVE_SOURCE_GITHUB_ISSUE) {
    throw new CacheError(
      `archive source '${source}' not supported in v1 (supports: ${ARCHIVE_SOURCE_GITHUB_ISSUE} only)`,
    );
  }
  if (options.repo != null && options.repo !== "" && !REPO_RE.test(options.repo)) {
    throw new CacheError(
      `invalid --repo '${options.repo}': expected 'owner/repo' (alphanumerics, '.', '_', '-' only)`,
    );
  }
  const cacheRoot = options.cacheRoot ?? ".deft-cache";
  assertWritableCachePath(cacheRoot);
  const archRoot = join(cacheRoot, ARCHIVED_ROOT_SEGMENT, source);
  const entries: ArchivedEntry[] = [];

  if (existsSync(archRoot)) {
    for (const metaPath of collectLiveMetaPaths(archRoot)) {
      // meta.json under archived tree; archive-meta is sibling
      const entryDirPath = dirname(metaPath);
      const key = keyFromLiveMetaPath(metaPath, archRoot);
      if (!GH_KEY_RE.test(key)) continue;
      if (options.repo) {
        const keyRepo = repoFromKey(key);
        if (keyRepo !== options.repo) continue;
      }
      const archiveMetaPath = join(entryDirPath, ARCHIVE_META_FILENAME);
      let meta: ArchiveMeta;
      if (existsSync(archiveMetaPath)) {
        const parsed = readJsonObject(archiveMetaPath);
        meta = {
          archived_at:
            typeof parsed?.archived_at === "string"
              ? parsed.archived_at
              : utcIso(systemClock, new Date(fileMtimeMs(archiveMetaPath))),
          reason: typeof parsed?.reason === "string" ? parsed.reason : "unknown",
          source_path: typeof parsed?.source_path === "string" ? parsed.source_path : "",
          key: typeof parsed?.key === "string" ? parsed.key : key,
          source: typeof parsed?.source === "string" ? parsed.source : source,
          pre_archive_decision:
            typeof parsed?.pre_archive_decision === "string" ? parsed.pre_archive_decision : null,
          closed_at: typeof parsed?.closed_at === "string" ? parsed.closed_at : null,
          age_basis: typeof parsed?.age_basis === "string" ? parsed.age_basis : undefined,
        };
      } else {
        meta = {
          archived_at: utcIso(systemClock, new Date(fileMtimeMs(entryDirPath))),
          reason: "unknown",
          source_path: "",
          key,
          source,
        };
      }
      if (options.since) {
        try {
          const sinceDt = parseIso(options.since);
          const archivedDt = parseIso(meta.archived_at);
          if (archivedDt < sinceDt) continue;
        } catch {
          /* ignore bad since filter for this entry */
        }
      }
      entries.push({
        source,
        key,
        archiveDir: entryDirPath,
        archivedAt: meta.archived_at,
        meta,
      });
    }
  }

  entries.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  const limit =
    options.limit !== undefined && options.limit !== null && options.limit > 0
      ? options.limit
      : null;
  const sliced = limit !== null ? entries.slice(0, limit) : entries;

  return {
    entries: sliced,
    count: sliced.length,
    source,
    repo: options.repo ?? null,
  };
}

export interface RestoreFromArchiveOptions {
  source?: string;
  key?: string;
  issue?: number;
  repo?: string | null;
  force?: boolean;
  cacheRoot?: string;
  clock?: Clock;
}

function filesEqual(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * Move an archived entry back to the live cache path.
 * Idempotent no-op when already live with identical raw.json.
 * Refuse when live exists with different content unless force.
 */
export function restoreFromArchive(options: RestoreFromArchiveOptions = {}): RestoreResult {
  const clock = options.clock ?? systemClock;
  const source = options.source ?? ARCHIVE_SOURCE_GITHUB_ISSUE;
  if (source !== ARCHIVE_SOURCE_GITHUB_ISSUE) {
    throw new CacheError(
      `archive source '${source}' not supported in v1 (supports: ${ARCHIVE_SOURCE_GITHUB_ISSUE} only)`,
    );
  }
  const cacheRoot = options.cacheRoot ?? ".deft-cache";
  assertWritableCachePath(cacheRoot);

  let key = options.key ?? "";
  if (!key) {
    if (options.issue === undefined || options.issue === null) {
      throw new CacheError("restore requires --issue N or --key owner/repo/N");
    }
    if (!options.repo || !REPO_RE.test(options.repo)) {
      throw new CacheError(
        `restore with --issue requires --repo owner/name (got ${JSON.stringify(options.repo)})`,
      );
    }
    key = `${options.repo}/${options.issue}`;
  }
  validateKey(source, key);

  const liveDir = liveEntryDir(source, key, cacheRoot);
  const archiveDir = archivedEntryDir(source, key, cacheRoot);

  if (!existsSync(archiveDir)) {
    if (existsSync(liveDir)) {
      return {
        source,
        key,
        status: "already-live",
        liveDir,
        archiveDir,
        detail: "archive missing; live entry present (idempotent)",
      };
    }
    return {
      source,
      key,
      status: "missing",
      liveDir,
      archiveDir,
      detail: "no archived entry and no live entry",
    };
  }

  if (existsSync(liveDir)) {
    const liveRaw = join(liveDir, "raw.json");
    const archRaw = join(archiveDir, "raw.json");
    if (existsSync(liveRaw) && existsSync(archRaw) && filesEqual(liveRaw, archRaw)) {
      // Identical content — remove archive tree as completed restore cleanup? keep both for safety:
      // idempotent: report already-live without deleting archive unless force wants clean.
      return {
        source,
        key,
        status: "already-live",
        liveDir,
        archiveDir,
        detail: "live entry matches archived raw.json",
      };
    }
    if (!options.force) {
      return {
        source,
        key,
        status: "conflict",
        liveDir,
        archiveDir,
        detail: "live path exists with different content; pass --force to replace",
      };
    }
    assertWritableCachePath(cacheRoot, source, ...key.split("/"));
    rmSync(liveDir, { recursive: true, force: true });
  }

  assertWritableCachePath(cacheRoot, source, ...key.split("/"));
  assertWritableCachePath(cacheRoot, ARCHIVED_ROOT_SEGMENT, source, ...key.split("/"));
  mkdirSync(dirname(liveDir), { recursive: true });
  renameSync(archiveDir, liveDir);
  // Drop archive-meta from live tree so walkers see a normal entry.
  const liveArchiveMeta = join(liveDir, ARCHIVE_META_FILENAME);
  if (existsSync(liveArchiveMeta)) {
    try {
      rmSync(liveArchiveMeta, { force: true });
    } catch {
      /* best-effort */
    }
  }
  appendAudit(
    {
      event: "cache:restore-from-archive",
      source,
      key,
      timestamp: utcIso(clock),
      live_dir: liveDir.split(/[/\\]/).join("/"),
      force: options.force === true,
    },
    cacheRoot,
  );

  return {
    source,
    key,
    status: "restored",
    liveDir,
    archiveDir,
  };
}
