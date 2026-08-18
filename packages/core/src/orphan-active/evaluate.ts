import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { hasArtifactSuffix, resolveLifecycleRoot } from "../layout/resolve.js";
import { defaultRunGh } from "../pr-protected-issues/gh.js";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import { CACHE_DIR_NAME, CACHE_SOURCE_GITHUB_ISSUE } from "../triage/queue/constants.js";
import { resolveRepo } from "../triage/queue/repo.js";
import { collectGithubRefs, type IssueRef, type PrRef } from "./refs.js";

export type OutputStream = "stdout" | "stderr" | "none";

export type OrphanKind = "shipped" | "unresolved";

export interface OrphanActiveBrief {
  readonly path: string;
  readonly reason: string;
  readonly kind: OrphanKind;
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

interface OrphanAssessment {
  readonly orphaned: boolean;
  readonly reason: string | null;
  readonly kind: OrphanKind | null;
}

const PASS: OrphanAssessment = { orphaned: false, reason: null, kind: null };

function shipped(reason: string): OrphanAssessment {
  return { orphaned: true, reason, kind: "shipped" };
}

function unresolved(reason: string): OrphanAssessment {
  return { orphaned: true, reason, kind: "unresolved" };
}

function assessOrphanSignature(
  issueRefs: readonly IssueRef[],
  prRefs: readonly PrRef[],
  projectRoot: string,
  runGh: RunGhFn,
  skipGh: boolean,
  selectedIssue: number | null,
): OrphanAssessment {
  if (selectedIssue !== null) {
    // Confirmed closed origin is shipped even if a linked PR lookup fails.
    const selectedRef = issueRefs.find((ref) => ref.number === selectedIssue);
    const selectedState =
      selectedRef === undefined ? null : resolveIssueState(selectedRef, projectRoot, runGh, skipGh);
    if (selectedState === "closed") {
      return shipped(`issue #${selectedIssue} is closed`);
    }
    for (const pr of prRefs) {
      if (skipGh) {
        return unresolved(`linked PR #${pr.number} state could not be resolved`);
      }
      const merged = fetchPrMerged(pr, runGh);
      if (merged === true) {
        return shipped(`linked PR #${pr.number} is merged`);
      }
      if (merged === null) {
        return unresolved(`linked PR #${pr.number} state could not be resolved`);
      }
    }
    // --issue N is one origin: sibling open/unknown must not mask it (#3429).
    if (selectedRef !== undefined) {
      if (selectedState === null) {
        return unresolved(`issue #${selectedIssue} state could not be resolved`);
      }
      return PASS;
    }
    const issueStates = issueRefs.map((ref) => ({
      ref,
      state: resolveIssueState(ref, projectRoot, runGh, skipGh),
    }));
    const unknownIssue = issueStates.find((row) => row.state === null);
    if (unknownIssue !== undefined) {
      return unresolved(`issue #${unknownIssue.ref.number} state could not be resolved`);
    }
    if (issueStates.some((row) => row.state === "closed")) {
      return shipped("all referenced issues are closed");
    }
    if (prRefs.length > 0 && skipGh) {
      return unresolved(`linked PR #${prRefs[0]?.number} state could not be resolved`);
    }
    return PASS;
  }

  for (const pr of prRefs) {
    if (skipGh) {
      continue;
    }
    const merged = fetchPrMerged(pr, runGh);
    if (merged === true) {
      return shipped(`linked PR #${pr.number} is merged`);
    }
  }

  if (issueRefs.length === 0) {
    return PASS;
  }

  let resolved = 0;
  for (const ref of issueRefs) {
    const state = resolveIssueState(ref, projectRoot, runGh, skipGh);
    if (state === null) {
      return PASS;
    }
    resolved += 1;
    if (state !== "closed") {
      return PASS;
    }
  }

  if (resolved > 0) {
    return shipped("all referenced issues are closed");
  }
  return PASS;
}

function briefReferencesIssue(issues: readonly IssueRef[], issue: number): boolean {
  return issues.some((ref) => ref.number === issue);
}

function formatRefusal(
  orphans: readonly OrphanActiveBrief[],
  projectRoot: string,
  issueFilter: number | null,
): string {
  const shippedOrphans = orphans.filter((orphan) => orphan.kind === "shipped");
  const unresolvedOrphans = orphans.filter((orphan) => orphan.kind === "unresolved");
  const noun = orphans.length === 1 ? "" : "s";
  let headline: string;
  if (unresolvedOrphans.length > 0 && shippedOrphans.length === 0) {
    headline = `verify:orphan-active: ${unresolvedOrphans.length} active/running xBRIEF${
      unresolvedOrphans.length === 1 ? "" : "s"
    } have unresolved GitHub state (cannot confirm shipped) (project_root=${projectRoot}).`;
  } else if (shippedOrphans.length > 0 && unresolvedOrphans.length === 0) {
    headline = `verify:orphan-active: ${shippedOrphans.length} active/running xBRIEF${
      shippedOrphans.length === 1 ? "" : "s"
    } look shipped but still consume WIP (project_root=${projectRoot}).`;
  } else {
    headline = `verify:orphan-active: ${orphans.length} active/running xBRIEF${noun} failed the after-merge check (project_root=${projectRoot}).`;
  }
  const lines = [headline];
  if (shippedOrphans.length > 0) {
    lines.push(
      "  Remediation: move each confirmed-shipped brief out of active/ with lifecycle ownership:",
    );
    for (const orphan of shippedOrphans) {
      lines.push(`    task scope:complete -- ${orphan.path}`);
    }
    lines.push(
      "    task scope:cancel -- xbrief/active/<file>.xbrief.json   # when abandoning",
      "  For stop-at:pr-open workers the orchestrator owns post-merge complete/cancel;",
      "  for drive-to:merge-ready workers scope:complete is part of the worker unit (#2321 / #3429).",
      "  Or run task swarm:finalize-cohort / task swarm:complete-cohort after cohort merge.",
    );
  }
  if (unresolvedOrphans.length > 0) {
    const retry =
      issueFilter === null
        ? "task verify:orphan-active"
        : `task verify:orphan-active -- --issue ${issueFilter}`;
    lines.push(
      "  Remediation: retry the GitHub lookup (auth, rate-limit, network, skipGh) then re-run:",
      `    ${retry}`,
      "  Do not run task scope:complete until the origin is confirmed closed or the linked PR is confirmed merged.",
    );
  }
  lines.push("  Offending briefs:");
  for (const orphan of orphans) {
    lines.push(`    - ${orphan.path} (${orphan.reason})`);
  }
  return lines.join("\n");
}

/**
 * Pure evaluator for orphaned active/running xBRIEF detection (#2321 / #3429).
 * Fails when active/ briefs with plan.status==running reference only closed
 * issues and/or a merged PR — the stop-at:pr-open orphan signature.
 * Pass `issue` to scan one origin after merge. Confirmed shipped prints
 * scope:complete; unresolved lookup still exits 1 with a retry remediation.
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
    // --issue N is one origin: briefs that name that issue. PR-only briefs stay on the unscoped scan (#3429).
    if (issueFilter !== null && !briefReferencesIssue(issues, issueFilter)) {
      continue;
    }
    if (issues.length === 0 && prs.length === 0) {
      continue;
    }
    const assessment = assessOrphanSignature(issues, prs, root, runGh, skipGh, issueFilter);
    if (assessment.orphaned && assessment.reason !== null && assessment.kind !== null) {
      orphans.push({
        path: relBriefPath(brief.path, root),
        reason: assessment.reason,
        kind: assessment.kind,
      });
    }
  }

  if (orphans.length > 0) {
    return {
      code: 1,
      message: formatRefusal(orphans, root, issueFilter),
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
