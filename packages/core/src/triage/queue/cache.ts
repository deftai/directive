import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CACHE_DIR_NAME,
  CACHE_SOURCE_GITHUB_ISSUE,
  DEFAULT_SLICES_LOG_REL_PATH,
} from "./constants.js";
import { blockedByIssueNumber, rankByIssueNumber } from "./scope-walk.js";
import type { CachedIssue } from "./types.js";

function cachedState(issue: { readonly state?: string } | undefined): string {
  if (issue === undefined) {
    return "";
  }
  const state = issue.state;
  return typeof state === "string" ? state.toLowerCase() : "";
}

/** Read slices.jsonl records. */
export function resolveSlicesLogPath(
  options: { readonly slicesLogPath?: string | null; readonly frameworkRoot?: string | null } = {},
): string {
  if (options.slicesLogPath !== null && options.slicesLogPath !== undefined) {
    return resolve(options.slicesLogPath);
  }
  const envRoot = process.env.DEFT_ROOT?.trim() ?? "";
  const root =
    options.frameworkRoot !== null && options.frameworkRoot !== undefined
      ? resolve(options.frameworkRoot)
      : envRoot.length > 0
        ? resolve(envRoot)
        : process.cwd();
  return join(root, DEFAULT_SLICES_LOG_REL_PATH);
}

/** Read slices.jsonl records. */
export function loadSliceRecords(
  options: { readonly slicesLogPath?: string | null; readonly frameworkRoot?: string | null } = {},
): readonly Record<string, unknown>[] {
  const path = resolveSlicesLogPath(options);
  if (!existsSync(path)) {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  const raw = readFileSync(path, { encoding: "utf8" });
  for (const line of raw.split("\n")) {
    const stripped = line.trim();
    if (stripped.length === 0) {
      continue;
    }
    try {
      const obj: unknown = JSON.parse(stripped);
      if (typeof obj === "object" && obj !== null) {
        out.push(obj as Record<string, unknown>);
      }
    } catch {
      // skip malformed slice rows
    }
  }
  return out;
}

/** Return orphan child issue numbers (open child + closed umbrella). */
export function collectOrphanIssueNumbers(
  sliceRecords: readonly Record<string, unknown>[],
  issuesByNumber: ReadonlyMap<number, CachedIssue | Record<string, unknown>>,
): ReadonlySet<number> {
  const out = new Set<number>();
  for (const record of sliceRecords) {
    const umbrella = record.umbrella;
    if (typeof umbrella !== "number") {
      continue;
    }
    const umbrellaIssue = issuesByNumber.get(umbrella);
    if (cachedState(umbrellaIssue as { state?: string } | undefined) !== "closed") {
      continue;
    }
    const children = record.children;
    if (!Array.isArray(children)) {
      continue;
    }
    for (const child of children) {
      if (typeof child !== "object" || child === null) {
        continue;
      }
      const n = (child as Record<string, unknown>).n;
      if (typeof n !== "number") {
        continue;
      }
      const childIssue = issuesByNumber.get(n);
      if (cachedState(childIssue as { state?: string } | undefined) === "open") {
        out.add(n);
      }
    }
  }
  return out;
}

function parseLabels(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const labels: string[] = [];
  for (const item of raw) {
    if (typeof item === "object" && item !== null) {
      const name = (item as Record<string, unknown>).name;
      if (typeof name === "string") {
        labels.push(name);
      }
    } else if (typeof item === "string") {
      labels.push(item);
    }
  }
  return labels;
}

/** Walk the cache and return one CachedIssue per cached issue. */
export function loadCachedIssues(
  repo: string,
  options: {
    readonly projectRoot: string;
    readonly source?: string;
    readonly includeClosed?: boolean;
  },
): readonly CachedIssue[] {
  if (!repo.includes("/")) {
    throw new Error(`repo must be 'owner/name'; got '${repo}'`);
  }
  const parts = repo.split("/", 2);
  const owner = parts[0];
  const name = parts[1];
  if (owner === undefined || name === undefined || owner.length === 0 || name.length === 0) {
    throw new Error(`repo must be 'owner/name'; got '${repo}'`);
  }
  const root = resolve(options.projectRoot);
  const source = options.source ?? CACHE_SOURCE_GITHUB_ISSUE;
  const base = join(root, CACHE_DIR_NAME, source, owner, name);
  if (!existsSync(base)) {
    return [];
  }

  const rankMap = rankByIssueNumber(root);
  const blockedSet = blockedByIssueNumber(root);
  const issues: CachedIssue[] = [];

  for (const entryName of readdirSync(base)) {
    if (!/^\d+$/.test(entryName)) {
      continue;
    }
    const entryDir = join(base, entryName);
    const rawPath = join(entryDir, "raw.json");
    if (!existsSync(rawPath)) {
      continue;
    }
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(readFileSync(rawPath, { encoding: "utf8" }));
      if (typeof parsed !== "object" || parsed === null) {
        continue;
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    let n = payload.number;
    if (typeof n !== "number") {
      const parsed = Number.parseInt(entryName, 10);
      n = Number.isFinite(parsed) ? parsed : undefined;
    }
    if (typeof n !== "number") {
      continue;
    }

    const stateRaw = payload.state ?? "open";
    const state = typeof stateRaw === "string" ? stateRaw.toLowerCase() : "open";
    if (state !== "open" && !options.includeClosed) {
      continue;
    }

    issues.push({
      number: n,
      title: typeof payload.title === "string" ? payload.title : "",
      state,
      labels: parseLabels(payload.labels),
      updatedAt: typeof payload.updated_at === "string" ? payload.updated_at : "",
      createdAt: typeof payload.created_at === "string" ? payload.created_at : "",
      metadataRank: rankMap.get(n) ?? null,
      continuation: false,
      continuationOrder: "",
      bucketDeficit: null,
      blocked: blockedSet.has(n),
    });
  }
  return issues;
}
