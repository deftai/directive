import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Lifecycle folders scanned for reconcilable vBRIEFs (#1468). */
export const BACKFILL_FOLDERS = ["proposed", "pending", "active"] as const;

export const CANDIDATES_LOG_REL_PATH = "vbrief/.eval/candidates.jsonl";

function parseGithubIssueUri(uri: unknown): [string | null, number | null] {
  if (typeof uri !== "string" || uri.length === 0) {
    return [null, null];
  }
  const match = /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i.exec(uri);
  if (match !== null) {
    const owner = match[1];
    const name = match[2];
    const number = Number.parseInt(match[3] ?? "", 10);
    if (owner !== undefined && name !== undefined && Number.isFinite(number)) {
      return [`${owner}/${name}`, number];
    }
  }
  const bare = /\/issues\/(\d+)/i.exec(uri);
  if (bare !== null) {
    const number = Number.parseInt(bare[1] ?? "", 10);
    if (Number.isFinite(number)) {
      return [null, number];
    }
  }
  return [null, null];
}

function extractIssueRef(data: Record<string, unknown>): [string | null, number | null] {
  const refs = data["x-vbrief"];
  if (!Array.isArray(refs)) {
    return [null, null];
  }
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
      continue;
    }
    const obj = ref as Record<string, unknown>;
    if (obj.type !== "x-vbrief/github-issue") {
      continue;
    }
    const [repo, number] = parseGithubIssueUri(obj.uri);
    if (number !== null) {
      return [repo, number];
    }
  }
  return [null, null];
}

function existingAuditRefs(auditPath: string): Set<string> {
  const seen = new Set<string>();
  if (!existsSync(auditPath)) {
    return seen;
  }
  let text: string;
  try {
    text = readFileSync(auditPath, { encoding: "utf8" });
  } catch {
    return seen;
  }
  for (const raw of text.split("\n")) {
    const stripped = raw.trim();
    if (stripped.length === 0) {
      continue;
    }
    try {
      const entry = JSON.parse(stripped) as unknown;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        continue;
      }
      const obj = entry as Record<string, unknown>;
      const repo = obj.repo;
      const issueNumber = obj.issue_number;
      if (
        typeof repo === "string" &&
        typeof issueNumber === "number" &&
        Number.isInteger(issueNumber)
      ) {
        seen.add(`${repo}\0${issueNumber}`);
      }
    } catch {
      // tolerate malformed lines
    }
  }
  return seen;
}

function auditKey(repo: string, issueNumber: number): string {
  return `${repo}\0${issueNumber}`;
}

/**
 * Count reconcilable issues (#1468) — mirrors `triage_reconcile.count_reconcilable`.
 */
export function countReconcilable(
  projectRoot: string,
  options: {
    defaultRepo?: string | null;
    auditLogPath?: string;
    restrictTo?: ReadonlyArray<readonly [string, number]>;
  } = {},
): number {
  try {
    const auditPath = options.auditLogPath ?? join(projectRoot, CANDIDATES_LOG_REL_PATH);
    const existing = existingAuditRefs(auditPath);
    const defaultRepo = options.defaultRepo ?? null;
    const keys = new Set<string>();
    const vbriefRoot = join(projectRoot, "vbrief");

    for (const folderName of BACKFILL_FOLDERS) {
      const folder = join(vbriefRoot, folderName);
      if (!existsSync(folder)) {
        continue;
      }
      const entries = readdirSync(folder, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".vbrief.json")) {
          continue;
        }
        const path = join(folder, entry.name);
        let data: unknown;
        try {
          data = JSON.parse(readFileSync(path, { encoding: "utf8" }));
        } catch {
          continue;
        }
        if (typeof data !== "object" || data === null || Array.isArray(data)) {
          continue;
        }
        const [refRepo, number] = extractIssueRef(data as Record<string, unknown>);
        if (number === null) {
          continue;
        }
        const effectiveRepo = refRepo ?? defaultRepo;
        if (effectiveRepo === null) {
          continue;
        }
        const key = auditKey(effectiveRepo, number);
        if (existing.has(key) || keys.has(key)) {
          continue;
        }
        keys.add(key);
      }
    }

    if (options.restrictTo !== undefined) {
      const restricted = new Set(options.restrictTo.map(([repo, n]) => auditKey(repo, n)));
      let count = 0;
      for (const key of keys) {
        if (restricted.has(key)) {
          count += 1;
        }
      }
      return count;
    }
    return keys.size;
  } catch {
    return 0;
  }
}
