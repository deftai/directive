import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { containedWrite } from "../../fs/contained-write.js";
import { resolveLifecycleFolder } from "../../layout/resolve.js";
import { resolveCandidatesLogPath } from "../cache-path.js";
import { auditKey, existingAuditRefs, scanLifecycleRefs } from "./audit.js";
import {
  BACKFILL_FOLDERS,
  RECONCILE_ACTOR,
  type ReconcileItem,
  type ReconcileResult,
} from "./types.js";

const GIT_ORIGIN_RE =
  /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com[:/])([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?\/?\s*$/;

export function inferRepoFromGit(cwd: string): string | null {
  try {
    const stdout = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const url = stdout.trim();
    if (!url) return null;
    const m = GIT_ORIGIN_RE.exec(url);
    if (!m) return null;
    return `${m[1]}/${m[2]}`;
  } catch {
    return null;
  }
}

function utcIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function newDecisionId(): string {
  return randomUUID();
}

export interface FindReconcilableOptions {
  readonly defaultRepo?: string | null;
  readonly auditLogPath?: string;
}

export function findReconcilable(
  projectRoot: string,
  options: FindReconcilableOptions = {},
): ReconcileItem[] {
  const root = resolve(projectRoot);
  const auditPath = options.auditLogPath ?? resolveCandidatesLogPath(root);
  const existing = existingAuditRefs(auditPath);
  const defaultRepo = options.defaultRepo ?? null;
  const items: ReconcileItem[] = [];
  const seen = new Set<string>();

  for (const folderName of BACKFILL_FOLDERS) {
    let folderPath: string;
    try {
      folderPath = resolveLifecycleFolder(root, folderName);
    } catch {
      continue; // No xbrief/ layout; skip this folder.
    }
    for (const [refRepo, number, path] of scanLifecycleRefs(folderPath)) {
      const effectiveRepo = refRepo ?? defaultRepo;
      if (effectiveRepo === null) continue;
      const key = auditKey(effectiveRepo, number);
      if (existing.has(key) || seen.has(key)) continue;
      seen.add(key);
      items.push({
        repo: effectiveRepo,
        issueNumber: number,
        folder: folderName,
        path,
      });
    }
  }
  return items;
}

function countSkippedExisting(
  projectRoot: string,
  defaultRepo: string | null,
  auditPath: string,
): number {
  const existing = existingAuditRefs(auditPath);
  const counted = new Set<string>();
  let count = 0;
  const root = resolve(projectRoot);
  for (const folderName of BACKFILL_FOLDERS) {
    let folderPath: string;
    try {
      folderPath = resolveLifecycleFolder(root, folderName);
    } catch {
      continue; // No xbrief/ layout; skip this folder.
    }
    for (const [refRepo, number] of scanLifecycleRefs(folderPath)) {
      const effectiveRepo = refRepo ?? defaultRepo;
      if (effectiveRepo === null) continue;
      const key = auditKey(effectiveRepo, number);
      if (existing.has(key) && !counted.has(key)) {
        counted.add(key);
        count += 1;
      }
    }
  }
  return count;
}

function countNoRepo(projectRoot: string, defaultRepo: string | null, auditPath: string): number {
  const existingNumbers = new Set<number>();
  for (const key of existingAuditRefs(auditPath)) {
    const num = Number(key.split(":")[1]);
    if (!Number.isNaN(num)) existingNumbers.add(num);
  }
  let count = 0;
  const root = resolve(projectRoot);
  for (const folderName of BACKFILL_FOLDERS) {
    let folderPath: string;
    try {
      folderPath = resolveLifecycleFolder(root, folderName);
    } catch {
      continue; // No xbrief/ layout; skip this folder.
    }
    for (const [refRepo, number] of scanLifecycleRefs(folderPath)) {
      if ((refRepo ?? defaultRepo) === null && !existingNumbers.has(number)) count += 1;
    }
  }
  return count;
}

function buildReconcileEntry(
  repo: string,
  issueNumber: number,
  sourceFolder: string,
): Record<string, unknown> {
  return {
    decision_id: newDecisionId(),
    timestamp: utcIso(),
    repo,
    issue_number: issueNumber,
    decision: "accept",
    actor: RECONCILE_ACTOR,
    reason:
      `reconcile backfill (#1468): vBRIEF present in vbrief/${sourceFolder}/ ` +
      "with a github-issue reference but no prior decision in the audit log",
  };
}

/**
 * Containment root for reconcile audit appends (#3288 / #3245).
 * Prefer project root when the log is nested under it; otherwise parent dir.
 */
function containmentRootForAudit(projectRoot: string, auditPath: string): string {
  const rootAbs = resolve(projectRoot);
  const logAbs = resolve(auditPath);
  const parent = dirname(logAbs);
  mkdirSync(parent, { recursive: true });
  const rel = relative(rootAbs, logAbs);
  if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) {
    return rootAbs;
  }
  return resolve(parent);
}

/** #3288 / #3245 / #2980: product append refuses leaf symlink follow. */
function appendAuditEntry(
  projectRoot: string,
  auditPath: string,
  entry: Record<string, unknown>,
): void {
  const root = containmentRootForAudit(projectRoot, auditPath);
  containedWrite({
    root,
    target: auditPath,
    data: `${JSON.stringify(entry)}\n`,
    mode: "append",
  });
}

export interface ReconcileOptions {
  readonly repo?: string | null;
  readonly auditLogPath?: string;
  readonly dryRun?: boolean;
}

export function reconcile(projectRoot: string, options: ReconcileOptions = {}): ReconcileResult {
  const root = resolve(projectRoot);
  let defaultRepo = options.repo ?? null;
  if (defaultRepo === null) {
    defaultRepo = inferRepoFromGit(root);
  }
  const auditPath = options.auditLogPath ?? resolveCandidatesLogPath(root);
  const dryRun = options.dryRun ?? false;

  const result: ReconcileResult = {
    projectRoot: root,
    defaultRepo,
    restored: 0,
    skippedExisting: countSkippedExisting(root, defaultRepo, auditPath),
    skippedNoRepo: countNoRepo(root, defaultRepo, auditPath),
    dryRun,
    items: [],
    error: null,
    exitCode: 0,
  };

  const items = findReconcilable(root, { defaultRepo, auditLogPath: auditPath });
  if (dryRun) {
    return { ...result, items, restored: items.length };
  }

  let restored = 0;
  for (const item of items) {
    const entry = buildReconcileEntry(item.repo, item.issueNumber, item.folder);
    try {
      appendAuditEntry(root, auditPath, entry);
    } catch (err) {
      return {
        ...result,
        error: `${err instanceof Error ? err.constructor.name : "Error"}: ${String(err)}`,
        restored,
        items: items.slice(0, restored),
        exitCode: 1,
      };
    }
    restored += 1;
  }
  return { ...result, restored, items };
}

export function countReconcilable(
  projectRoot: string,
  options: FindReconcilableOptions & {
    readonly restrictTo?: Iterable<[string, number]>;
  } = {},
): number {
  const items = findReconcilable(projectRoot, options);
  let keys = new Set(items.map((i) => auditKey(i.repo, i.issueNumber)));
  if (options.restrictTo) {
    const restrict = new Set([...options.restrictTo].map(([repo, num]) => auditKey(repo, num)));
    keys = new Set([...keys].filter((k) => restrict.has(k)));
  }
  return keys.size;
}
