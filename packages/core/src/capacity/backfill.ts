import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sortedStringifyCompact } from "../codebase/json.js";
import {
  classifyBucket,
  loadBucketMatchers,
  resolveCapacityAllocation,
  SOURCE_MATCH,
} from "../policy/capacity.js";

export const COMPLETED_FOLDER = "completed";
export const CACHE_RELPATH = [".deft-cache", "github-issue"] as const;

export interface BackfillItem {
  readonly rel_path: string;
  readonly issue_number: number | null;
  readonly bucket: string;
  readonly source: string;
  readonly set_bucket: boolean;
  readonly set_completed_at: boolean;
}

export interface BackfillResult {
  project_root: string;
  dry_run: boolean;
  scanned: number;
  stamped_bucket: number;
  stamped_completed_at: number;
  already_classified: number;
  matched: number;
  defaulted: number;
  fetched: number;
  skipped_out_of_window: number;
  skipped_unreadable: number;
  window_only: boolean;
  window_days: number;
  items: BackfillItem[];
  low_confidence: BackfillItem[];
  error: string | null;
  exit_code: number;
}

function parseIso(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  let text = value.trim();
  if (text.endsWith("Z")) {
    text = `${text.slice(0, -1)}+00:00`;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function toIsoZ(dt: Date): string {
  return `${dt.toISOString().replace(/\.\d{3}Z$/, "Z")}`;
}

export function extractIssueRef(plan: Record<string, unknown>): [string | null, number | null] {
  const refs = plan.references;
  if (!Array.isArray(refs)) {
    return [null, null];
  }
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
      continue;
    }
    const rec = ref as Record<string, unknown>;
    if (rec.type !== "x-vbrief/github-issue") {
      continue;
    }
    const uri = rec.uri;
    if (typeof uri !== "string") {
      continue;
    }
    const cleaned = uri.trim().replace(/\/$/, "");
    const parts =
      cleaned
        .split("://")
        .pop()
        ?.split("/")
        .filter((p) => p.length > 0) ?? [];
    if (
      parts.length >= 4 &&
      parts[parts.length - 2] === "issues" &&
      /^\d+$/.test(parts[parts.length - 1] ?? "")
    ) {
      return [
        `${parts[parts.length - 4]}/${parts[parts.length - 3]}`,
        Number(parts[parts.length - 1]),
      ];
    }
  }
  return [null, null];
}

export function cachedIssueLabels(
  projectRoot: string,
  repo: string,
  issueNumber: number,
  cacheDir?: string,
): Set<string> | null {
  const base = cacheDir ?? join(resolve(projectRoot), ...CACHE_RELPATH);
  const rawPath = join(base, repo, String(issueNumber), "raw.json");
  if (!existsSync(rawPath)) {
    return null;
  }
  try {
    const data = JSON.parse(readFileSync(rawPath, { encoding: "utf8" })) as unknown;
    const labels =
      typeof data === "object" && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>).labels
        : null;
    if (!Array.isArray(labels)) {
      return new Set();
    }
    const out = new Set<string>();
    for (const label of labels) {
      if (typeof label === "string" && label.length > 0) {
        out.add(label);
      } else if (typeof label === "object" && label !== null && !Array.isArray(label)) {
        const name = (label as Record<string, unknown>).name;
        if (typeof name === "string" && name.length > 0) {
          out.add(name);
        }
      }
    }
    return out;
  } catch {
    return null;
  }
}

export function gitLandingTime(repoRelPath: string, projectRoot: string): string | null {
  try {
    const stdout = execFileSync("git", ["log", "-1", "--format=%cI", "--", repoRelPath], {
      cwd: resolve(projectRoot),
      encoding: "utf8",
    });
    const parsed = parseIso(stdout.trim());
    return parsed !== null ? toIsoZ(parsed) : null;
  } catch {
    return null;
  }
}

export async function fetchIssueLabels(
  repo: string,
  issueNumber: number,
): Promise<Set<string> | null> {
  try {
    const { restIssueView } = await import("../scm/gh-rest.js");
    const issue = restIssueView(repo, issueNumber);
    const labels = issue.labels;
    if (!Array.isArray(labels)) {
      return new Set();
    }
    const out = new Set<string>();
    for (const label of labels) {
      if (typeof label === "string" && label.length > 0) {
        out.add(label);
      } else if (typeof label === "object" && label !== null && !Array.isArray(label)) {
        const name = (label as Record<string, unknown>).name;
        if (typeof name === "string" && name.length > 0) {
          out.add(name);
        }
      }
    }
    return out;
  } catch {
    return null;
  }
}

function inWindow(completedAt: string | null | undefined, windowDays: number, now: Date): boolean {
  const parsed = parseIso(completedAt);
  if (parsed === null) {
    return false;
  }
  const ageDays = (now.getTime() - parsed.getTime()) / (86400 * 1000);
  return ageDays >= 0 && ageDays <= windowDays;
}

function writeMetadata(
  path: string,
  data: Record<string, unknown>,
  plan: Record<string, unknown>,
  metadata: Record<string, unknown>,
  options: { bucket?: string; source?: string; completedAt?: string },
): void {
  if (typeof plan.metadata !== "object" || plan.metadata === null || Array.isArray(plan.metadata)) {
    plan.metadata = metadata;
  }
  if (options.completedAt !== undefined) {
    metadata.completedAt = options.completedAt;
  }
  if (options.bucket !== undefined) {
    metadata.capacityBucket = options.bucket;
    if (options.source !== undefined) {
      metadata.capacityBucketSource = options.source;
    }
  }
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8" });
}

export interface BackfillOptions {
  cacheDir?: string;
  dryRun?: boolean;
  windowOnly?: boolean;
  fetch?: boolean;
  now?: Date;
}

/** Backfill capacityBucket / completedAt on completed vBRIEFs. */
export async function backfill(
  projectRoot: string,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const nowDt = options.now ?? new Date();
  const allocation = resolveCapacityAllocation(projectRoot);
  const result: BackfillResult = {
    project_root: resolve(projectRoot),
    dry_run: options.dryRun ?? true,
    scanned: 0,
    stamped_bucket: 0,
    stamped_completed_at: 0,
    already_classified: 0,
    matched: 0,
    defaulted: 0,
    fetched: 0,
    skipped_out_of_window: 0,
    skipped_unreadable: 0,
    window_only: options.windowOnly ?? false,
    window_days: allocation.window_days,
    items: [],
    low_confidence: [],
    error: null,
    exit_code: 0,
  };

  if (!allocation.configured) {
    result.error =
      "plan.policy.capacityAllocation is not configured -- configure buckets before backfilling (see #1419 / task capacity:show)";
    result.exit_code = 2;
    return result;
  }

  const { matchers, default_bucket: defaultBucket } = loadBucketMatchers(projectRoot);
  if (!defaultBucket) {
    result.error =
      "capacityAllocation.defaultBucket is required for backfill (unmatched completions must have a fallback bucket)";
    result.exit_code = 2;
    return result;
  }

  const completedDir = join(resolve(projectRoot), "vbrief", COMPLETED_FOLDER);
  if (!existsSync(completedDir)) {
    return result;
  }

  let paths: string[];
  try {
    paths = readdirSync(completedDir)
      .filter((name) => name.endsWith(".vbrief.json"))
      .sort();
  } catch {
    return result;
  }

  for (const name of paths) {
    const path = join(completedDir, name);
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(path, { encoding: "utf8" })) as Record<string, unknown>;
    } catch {
      result.skipped_unreadable += 1;
      continue;
    }
    const plan = data.plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
      continue;
    }
    const planRec = plan as Record<string, unknown>;
    result.scanned += 1;
    const relPath = `${COMPLETED_FOLDER}/${name}`;
    const gitRelPath = `vbrief/${relPath}`;

    const metadata =
      typeof planRec.metadata === "object" &&
      planRec.metadata !== null &&
      !Array.isArray(planRec.metadata)
        ? (planRec.metadata as Record<string, unknown>)
        : {};

    const existingBucket = metadata.capacityBucket;
    const hasBucket = typeof existingBucket === "string" && existingBucket.trim().length > 0;
    const existingCompletedAt = metadata.completedAt;
    const hasCompletedAt =
      typeof existingCompletedAt === "string" && existingCompletedAt.trim().length > 0;

    let effectiveCompletedAt = hasCompletedAt ? existingCompletedAt : null;
    let gitCompletedAt: string | null = null;
    if (!hasCompletedAt) {
      gitCompletedAt = gitLandingTime(gitRelPath, projectRoot);
      effectiveCompletedAt = gitCompletedAt;
    }

    if (options.windowOnly && !inWindow(effectiveCompletedAt, allocation.window_days, nowDt)) {
      result.skipped_out_of_window += 1;
      continue;
    }

    const [repo, issueNumber] = extractIssueRef(planRec);
    let bucket: string;
    let source: string;
    if (hasBucket) {
      result.already_classified += 1;
      bucket = (existingBucket as string).trim();
      source = "preserved";
    } else {
      let labels: Set<string> | null = null;
      if (repo && issueNumber !== null) {
        labels = cachedIssueLabels(projectRoot, repo, issueNumber, options.cacheDir);
        if (labels === null && options.fetch) {
          labels = await fetchIssueLabels(repo, issueNumber);
          if (labels !== null) {
            result.fetched += 1;
          }
        }
      }
      [bucket, source] = classifyBucket(labels ?? new Set(), matchers, defaultBucket);
    }

    const setBucket = !hasBucket;
    const setCompletedAt = !hasCompletedAt && gitCompletedAt !== null;

    const item: BackfillItem = {
      rel_path: relPath,
      issue_number: issueNumber,
      bucket,
      source,
      set_bucket: setBucket,
      set_completed_at: setCompletedAt,
    };
    result.items.push(item);

    if (!result.dry_run && (setBucket || setCompletedAt)) {
      try {
        writeMetadata(path, data, planRec, metadata, {
          bucket: setBucket ? bucket : undefined,
          source: setBucket ? source : undefined,
          completedAt: setCompletedAt ? (gitCompletedAt ?? undefined) : undefined,
        });
      } catch (err) {
        result.error = `${err instanceof Error ? err.name : "Error"}: ${String(err)} (${relPath})`;
        result.exit_code = 1;
        return result;
      }
    }

    if (setBucket) {
      result.stamped_bucket += 1;
      if (source === SOURCE_MATCH) {
        result.matched += 1;
      } else {
        result.defaulted += 1;
        result.low_confidence.push(item);
      }
    }
    if (setCompletedAt) {
      result.stamped_completed_at += 1;
    }
  }

  return result;
}

export function renderBackfillSummary(result: BackfillResult): string {
  const verb = result.dry_run ? "would stamp" : "stamped";
  const mark = result.exit_code === 0 ? "✓" : "✗";
  const lines = ["", "Capacity backfill recap:"];
  lines.push(
    `  ${mark} scanned ${result.scanned} completed vBRIEF(s); ${verb} capacityBucket on ${result.stamped_bucket} (matched ${result.matched}, defaulted ${result.defaulted}); ${verb} completedAt on ${result.stamped_completed_at}; ${result.already_classified} already classified`,
  );
  if (result.fetched > 0) {
    lines.push(`      fetched labels for ${result.fetched} uncached issue(s) via REST`);
  }
  if (result.window_only) {
    lines.push(
      `      window-only: skipped ${result.skipped_out_of_window} completion(s) outside the trailing ${result.window_days}d window`,
    );
  }
  if (result.skipped_unreadable > 0) {
    lines.push(
      `      skipped ${result.skipped_unreadable} unreadable/malformed completed vBRIEF file(s) (not counted in scanned)`,
    );
  }
  if (result.error) {
    lines.push(`      error: ${result.error}`);
  }
  if (result.low_confidence.length > 0) {
    lines.push("");
    lines.push(
      `  Low-confidence batch (${result.low_confidence.length}) -- no label match, fell to defaultBucket; review + re-bucket as needed:`,
    );
    for (const item of result.low_confidence) {
      const issue = item.issue_number !== null ? `#${item.issue_number}` : "(no issue ref)";
      lines.push(`    ${issue} -> ${item.bucket}  [${item.rel_path}]`);
    }
  }
  if (result.dry_run && result.exit_code === 0) {
    lines.push("");
    lines.push("  Dry-run -- re-run with --apply to write these changes.");
  }
  return lines.join("\n");
}

export function emitBackfillJson(result: BackfillResult): string {
  const payload = {
    project_root: result.project_root,
    dry_run: result.dry_run,
    scanned: result.scanned,
    stamped_bucket: result.stamped_bucket,
    stamped_completed_at: result.stamped_completed_at,
    already_classified: result.already_classified,
    matched: result.matched,
    defaulted: result.defaulted,
    fetched: result.fetched,
    skipped_out_of_window: result.skipped_out_of_window,
    skipped_unreadable: result.skipped_unreadable,
    window_only: result.window_only,
    window_days: result.window_days,
    exit_code: result.exit_code,
    error: result.error,
    low_confidence: result.low_confidence.map((it) => ({
      issue_number: it.issue_number,
      bucket: it.bucket,
      rel_path: it.rel_path,
    })),
  };
  return sortedStringifyCompact(payload);
}

export interface CapacityBackfillCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** CLI entry point. */
export async function runCapacityBackfillCli(argv: string[]): Promise<CapacityBackfillCliResult> {
  let projectRoot = process.env.DEFT_PROJECT_ROOT ?? ".";
  let apply = false;
  let windowOnly = false;
  let fetch = false;
  let cacheDir: string | undefined;
  let emitJson = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--window-only") {
      windowOnly = true;
    } else if (arg === "--fetch") {
      fetch = true;
    } else if (arg === "--json") {
      emitJson = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "argument --project-root: expected one argument\n",
        };
      }
      projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--cache-dir") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { exitCode: 2, stdout: "", stderr: "argument --cache-dir: expected one argument\n" };
      }
      cacheDir = value;
      i += 1;
    } else if (arg?.startsWith("--cache-dir=")) {
      cacheDir = arg.slice("--cache-dir=".length);
    }
  }

  const root = resolve(projectRoot);
  if (!existsSync(root)) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `❌ capacity:backfill: --project-root ${root} does not exist or is not a directory.\n`,
    };
  }

  const result = await backfill(root, {
    cacheDir: cacheDir !== undefined ? resolve(cacheDir) : undefined,
    dryRun: !apply,
    windowOnly,
    fetch,
  });

  if (emitJson) {
    return { exitCode: result.exit_code, stdout: `${emitBackfillJson(result)}\n`, stderr: "" };
  }

  const summary = renderBackfillSummary(result);
  if (result.exit_code === 0) {
    return { exitCode: 0, stdout: `${summary}\n`, stderr: "" };
  }
  return { exitCode: result.exit_code, stdout: "", stderr: `${summary}\n` };
}
