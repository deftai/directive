import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { hasArtifactSuffix, resolveLifecycleRoot } from "../layout/resolve.js";
import { defaultRunGh } from "../pr-protected-issues/gh.js";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import { CACHE_DIR_NAME, CACHE_SOURCE_GITHUB_ISSUE } from "../triage/queue/constants.js";
import { resolveRepo } from "../triage/queue/repo.js";
import { collectGithubRefs, type IssueRef, type PrRef } from "./refs.js";

export type OutputStream = "stdout" | "stderr" | "none";

export interface OrphanActiveBrief {
  readonly path: string;
  readonly reason: string;
}

export interface EvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
  readonly orphans: readonly OrphanActiveBrief[];
}

export interface EvaluateOptions {
  readonly quiet?: boolean;
  readonly repo?: string | null;
  readonly runGh?: RunGhFn;
  readonly skipGh?: boolean;
  /** When set, scan only active/running briefs that reference this issue (#3429). */
  readonly issue?: number | null;
}

interface ActiveBrief {
  readonly path: string;
  readonly plan: Record<string, unknown>;
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

function relBriefPath(path: string, projectRoot: string): string {
  try {
    return relative(resolve(projectRoot), resolve(path)).replace(/\\/g, "/");
  } catch {
    return path.replace(/\\/g, "/");
  }
}

function listActiveRunningBriefs(projectRoot: string): ActiveBrief[] {
  let lifecycleRoot: string;
  try {
    lifecycleRoot = resolveLifecycleRoot(projectRoot);
  } catch {
    return [];
  }
  const activeDir = join(lifecycleRoot, "active");
  if (!existsSync(activeDir)) {
    return [];
  }

  const out: ActiveBrief[] = [];
  for (const entry of readdirSync(activeDir, { withFileTypes: true })) {
    if (!entry.isFile() || !hasArtifactSuffix(entry.name)) {
      continue;
    }
    const path = join(activeDir, entry.name);
    const data = readJson(path);
    const plan = planOf(data);
    if (plan === null) {
      continue;
    }
    if (String(plan.status ?? "").toLowerCase() !== "running") {
      continue;
    }
    out.push({ path, plan });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
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
  if (state === "closed") {
    return "closed";
  }
  if (state === "open") {
    return "open";
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
    if (state === "closed") {
      return "closed";
    }
    if (state === "open") {
      return "open";
    }
    return null;
  } catch {
    return null;
  }
}

function resolveIssueState(
  ref: IssueRef,
  projectRoot: string,
  runGh: RunGhFn,
  skipGh: boolean,
): "open" | "closed" | null {
  const cached = readCachedIssueState(projectRoot, ref);
  if (cached !== null) {
    return cached;
  }
  if (skipGh) {
    return null;
  }
  return fetchIssueStateLive(ref, runGh);
}

function fetchPrMerged(ref: PrRef, runGh: RunGhFn): boolean | null {
  const path = `repos/${ref.repo}/pulls/${ref.number}`;
  const result = runGh(["gh", "api", path]);
  if (result.returncode !== 0) {
    return null;
  }
  try {
    const payload = JSON.parse(result.stdout) as unknown;
    if (payload === null || typeof payload !== "object") {
      return null;
    }
    const mergedAt = (payload as Record<string, unknown>).merged_at;
    if (mergedAt === null) {
      return false;
    }
    return typeof mergedAt === "string" && mergedAt.length > 0;
  } catch {
    return null;
  }
}

function assessOrphanSignature(
  issueRefs: readonly IssueRef[],
  prRefs: readonly PrRef[],
  projectRoot: string,
  runGh: RunGhFn,
  skipGh: boolean,
): { orphaned: boolean; reason: string | null } {
  for (const pr of prRefs) {
    if (skipGh) {
      continue;
    }
    const merged = fetchPrMerged(pr, runGh);
    if (merged === true) {
      return { orphaned: true, reason: `linked PR #${pr.number} is merged` };
    }
  }

  if (issueRefs.length === 0) {
    return { orphaned: false, reason: null };
  }

  let resolved = 0;
  for (const ref of issueRefs) {
    const state = resolveIssueState(ref, projectRoot, runGh, skipGh);
    if (state === null) {
      return { orphaned: false, reason: null };
    }
    resolved += 1;
    if (state !== "closed") {
      return { orphaned: false, reason: null };
    }
  }

  if (resolved > 0) {
    return { orphaned: true, reason: "all referenced issues are closed" };
  }
  return { orphaned: false, reason: null };
}

function briefReferencesIssue(issues: readonly IssueRef[], issue: number): boolean {
  return issues.some((ref) => ref.number === issue);
}

function formatRefusal(orphans: readonly OrphanActiveBrief[], projectRoot: string): string {
  const lines = [
    `verify:orphan-active: ${orphans.length} active/running xBRIEF${
      orphans.length === 1 ? "" : "s"
    } look shipped but still consume WIP (project_root=${projectRoot}).`,
    "  Remediation: move each brief out of active/ with lifecycle ownership:",
  ];
  for (const orphan of orphans) {
    lines.push(`    task scope:complete -- ${orphan.path}`);
  }
  lines.push(
    "    task scope:cancel -- xbrief/active/<file>.xbrief.json   # when abandoning",
    "  For stop-at:pr-open workers the orchestrator owns post-merge complete/cancel;",
    "  for drive-to:merge-ready workers scope:complete is part of the worker unit (#2321 / #3429).",
    "  Or run task swarm:finalize-cohort / task swarm:complete-cohort after cohort merge.",
    "  Offending briefs:",
  );
  for (const orphan of orphans) {
    lines.push(`    - ${orphan.path} (${orphan.reason})`);
  }
  return lines.join("\n");
}

/**
 * Pure evaluator for orphaned active/running xBRIEF detection (#2321 / #3429).
 * Fails when active/ briefs with plan.status==running reference only closed
 * issues and/or a merged PR — the stop-at:pr-open orphan signature.
 * Pass `issue` to scan one origin after merge.
 */
export function evaluate(projectRoot: string, options: EvaluateOptions = {}): EvaluateResult {
  const root = resolve(projectRoot);
  const quiet = options.quiet ?? false;
  const skipGh = options.skipGh ?? false;
  const runGh = options.runGh ?? defaultRunGh;
  const defaultRepo = resolveRepo(options.repo, root);

  if (!existsSync(root)) {
    return {
      code: 2,
      message: `verify:orphan-active: project root does not exist: ${root}`,
      stream: "stderr",
      orphans: [],
    };
  }

  let lifecycleRoot: string;
  try {
    lifecycleRoot = resolveLifecycleRoot(root);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Consumer/greenfield fixtures may still use legacy vbrief/ only (#2112).
    // Orphan detection applies only to xbrief/active/ — skip cleanly, not config fail.
    if (message.includes("No xbrief/ layout found")) {
      if (quiet) {
        return { code: 0, message: "", stream: "none", orphans: [] };
      }
      return {
        code: 0,
        message: "verify:orphan-active: no xbrief/ lifecycle root; nothing to scan.",
        stream: "stdout",
        orphans: [],
      };
    }
    return {
      code: 2,
      message: `verify:orphan-active: ${message}`,
      stream: "stderr",
      orphans: [],
    };
  }

  if (!existsSync(lifecycleRoot)) {
    if (quiet) {
      return { code: 0, message: "", stream: "none", orphans: [] };
    }
    return {
      code: 0,
      message: "verify:orphan-active: no xbrief/ lifecycle root; nothing to scan.",
      stream: "stdout",
      orphans: [],
    };
  }

  const issueFilter = options.issue ?? null;
  const orphans: OrphanActiveBrief[] = [];
  for (const brief of listActiveRunningBriefs(root)) {
    const { issues, prs } = collectGithubRefs(brief.plan, defaultRepo);
    if (issueFilter !== null && !briefReferencesIssue(issues, issueFilter)) {
      continue;
    }
    if (issues.length === 0 && prs.length === 0) {
      continue;
    }
    const assessment = assessOrphanSignature(issues, prs, root, runGh, skipGh);
    if (assessment.orphaned && assessment.reason !== null) {
      orphans.push({
        path: relBriefPath(brief.path, root),
        reason: assessment.reason,
      });
    }
  }

  if (orphans.length > 0) {
    return {
      code: 1,
      message: formatRefusal(orphans, root),
      stream: "stderr",
      orphans,
    };
  }

  if (quiet) {
    return { code: 0, message: "", stream: "none", orphans: [] };
  }

  const scanned = listActiveRunningBriefs(root).length;
  const issueNote = issueFilter === null ? "" : ` for issue #${issueFilter}`;
  return {
    code: 0,
    message:
      `verify:orphan-active: no orphaned active/running xBRIEFs${issueNote} ` +
      `(scanned ${scanned} running brief${scanned === 1 ? "" : "s"} in active/).`,
    stream: "stdout",
    orphans: [],
  };
}
