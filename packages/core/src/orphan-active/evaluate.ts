import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { hasArtifactSuffix, resolveLifecycleRoot } from "../layout/resolve.js";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import { ScmStubError } from "../scm/errors.js";
import { resolveRepo } from "../triage/queue/repo.js";
import {
  AGGREGATE_LATENCY_BUDGET_MS,
  formatAge,
  type GateRunner,
  type IssueState,
  makeGateRunner,
  OpenIssueInventory,
  type ResolveContext,
  resolveIssueStateAggregate,
  resolveIssueStateScoped,
  SCOPED_LATENCY_BUDGET_MS,
  type StateResolution,
} from "./issue-state.js";
import { collectGithubRefs, type IssueRef, type PrRef } from "./refs.js";

export type OutputStream = "stdout" | "stderr" | "none";

export type OrphanKind = "shipped" | "unresolved";

export interface OrphanActiveBrief {
  readonly path: string;
  readonly reason: string;
  readonly kind: OrphanKind;
}

/**
 * How the run's issue-state verdicts were reached (#3767). A pass with
 * `unverified > 0` is not evidence that the tree is clean.
 */
export interface OrphanActiveBasis {
  readonly inventory: number;
  readonly live: number;
  readonly cache: number;
  readonly unverified: number;
  /** Oldest cache entry that produced a verdict, in ms. */
  readonly maxCacheAgeMs: number | null;
  /** True when reads resolved through `ghx`, a cached GET proxy. */
  readonly proxied: boolean;
  readonly elapsedMs: number;
  readonly budgetMs: number;
}

export interface EvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
  readonly orphans: readonly OrphanActiveBrief[];
  readonly basis: OrphanActiveBasis;
}

export interface EvaluateOptions {
  readonly quiet?: boolean;
  readonly repo?: string | null;
  readonly runGh?: RunGhFn;
  readonly skipGh?: boolean;
  /** When set, scan only active/running briefs that reference this issue (#3429). */
  readonly issue?: number | null;
  /** Monotonic clock seam so basis ages and budget checks are testable. */
  readonly nowMs?: () => number;
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

/**
 * Records how each verdict was reached so the summary can distinguish a
 * verified pass from an unverified one (#3767).
 */
class BasisTally {
  inventory = 0;
  live = 0;
  cache = 0;
  maxCacheAgeMs = 0;
  readonly unverifiedReasons: string[] = [];

  record(ref: IssueRef, resolution: StateResolution): void {
    switch (resolution.basis) {
      case "inventory":
        this.inventory += 1;
        break;
      case "live":
        this.live += 1;
        break;
      case "cache":
        this.cache += 1;
        this.maxCacheAgeMs = Math.max(this.maxCacheAgeMs, resolution.cacheAgeMs);
        break;
      default: {
        const line = `#${ref.number} (${resolution.detail})`;
        if (!this.unverifiedReasons.includes(line)) {
          this.unverifiedReasons.push(line);
        }
      }
    }
  }

  get unverified(): number {
    return this.unverifiedReasons.length;
  }

  summary(): string {
    const parts: string[] = [];
    if (this.inventory > 0) {
      parts.push(`inventory ${this.inventory}`);
    }
    if (this.live > 0) {
      parts.push(`live ${this.live}`);
    }
    if (this.cache > 0) {
      parts.push(`cache ${this.cache} (max age ${formatAge(this.maxCacheAgeMs)})`);
    }
    if (this.unverified > 0) {
      parts.push(`unverified ${this.unverified}`);
    }
    return parts.length === 0 ? "no GitHub lookups" : parts.join(", ");
  }
}

function resolveIssueState(
  ref: IssueRef,
  ctx: ResolveContext,
  scoped: boolean,
  tally: BasisTally,
): IssueState | null {
  const resolution = scoped
    ? resolveIssueStateScoped(ref, ctx)
    : resolveIssueStateAggregate(ref, ctx);
  tally.record(ref, resolution);
  return resolution.state;
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
  ctx: ResolveContext,
  selectedIssue: number | null,
  tally: BasisTally,
): OrphanAssessment {
  const runGh = ctx.runGh;
  const skipGh = ctx.skipGh;
  const scoped = selectedIssue !== null;
  if (selectedIssue !== null) {
    const selectedRef = issueRefs.find((ref) => ref.number === selectedIssue);
    if (selectedRef === undefined) {
      // evaluate() only reaches here for briefs that name the issue.
      return PASS;
    }
    // Confirmed closed origin is shipped even if a linked PR lookup fails.
    const selectedState = resolveIssueState(selectedRef, ctx, scoped, tally);
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
    if (selectedState === null) {
      return unresolved(`issue #${selectedIssue} state could not be resolved`);
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

  for (const ref of issueRefs) {
    const state = resolveIssueState(ref, ctx, scoped, tally);
    // Unknown keeps the sweep fail-open so offline work is not network-authorized;
    // the unverified basis line stops the pass reading as verified evidence (#3767).
    if (state !== "closed") {
      return PASS;
    }
  }
  return shipped("all referenced issues are closed");
}

function briefReferencesIssue(issues: readonly IssueRef[], issue: number): boolean {
  return issues.some((ref) => ref.number === issue);
}

/** Basis, ghx caveat, and budget lines shared by the pass and refusal messages (#3767). */
function basisLines(tally: BasisTally, basis: OrphanActiveBasis): string[] {
  const lines = [`  Basis: ${tally.summary()}.`];
  if (tally.unverified > 0) {
    lines.push(
      "  UNVERIFIED: state could not be established for the references below, so this run is",
      "  not evidence that they are unshipped:",
    );
    for (const reason of tally.unverifiedReasons) {
      lines.push(`    - ${reason}`);
    }
  }
  if (basis.proxied) {
    lines.push(
      "  Note: reads resolved through `ghx`, a cached GET proxy; freshness is bounded by that",
      "  proxy, which this gate cannot inspect (#3737).",
    );
  }
  if (basis.elapsedMs > basis.budgetMs) {
    lines.push(
      `  Budget: took ${formatAge(basis.elapsedMs)} against a ${formatAge(basis.budgetMs)} budget (#3767).`,
    );
  }
  return lines;
}

function formatRefusal(
  orphans: readonly OrphanActiveBrief[],
  projectRoot: string,
  issueFilter: number | null,
  tally: BasisTally,
  basis: OrphanActiveBasis,
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
  lines.push(...basisLines(tally, basis));
  return lines.join("\n");
}

function emptyBasis(budgetMs: number): OrphanActiveBasis {
  return {
    inventory: 0,
    live: 0,
    cache: 0,
    unverified: 0,
    maxCacheAgeMs: null,
    proxied: false,
    elapsedMs: 0,
    budgetMs,
  };
}

/**
 * Pure evaluator for orphaned active/running xBRIEF detection (#2321 / #3429).
 * Fails when active/ briefs with plan.status==running reference only closed
 * issues and/or a merged PR — the stop-at:pr-open orphan signature.
 * Pass `issue` to scan one origin after merge. Confirmed shipped prints
 * scope:complete; unresolved lookup still exits 1 with a retry remediation.
 *
 * Issue state resolves by query shape (#3767): scoped `--issue N` takes an
 * authoritative read and stays fail-closed on unknown; the unscoped sweep uses
 * one complete, fail-closed open-issue inventory and stays fail-open on
 * unknown so offline work is not network-authorized. A cache hit is honoured
 * only inside `ISSUE_CACHE_MAX_AGE_MS`, and every verdict reports its basis.
 */
export function evaluate(projectRoot: string, options: EvaluateOptions = {}): EvaluateResult {
  const root = resolve(projectRoot);
  const quiet = options.quiet ?? false;
  const skipGh = options.skipGh ?? false;
  const issueFilter = options.issue ?? null;
  const budgetMs = issueFilter === null ? AGGREGATE_LATENCY_BUDGET_MS : SCOPED_LATENCY_BUDGET_MS;
  const clock = options.nowMs ?? Date.now;
  const startedMs = clock();

  if (!existsSync(root)) {
    return {
      code: 2,
      message: `verify:orphan-active: project root does not exist: ${root}`,
      stream: "stderr",
      orphans: [],
      basis: emptyBasis(budgetMs),
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
      return {
        code: 0,
        message: quiet ? "" : "verify:orphan-active: no xbrief/ lifecycle root; nothing to scan.",
        stream: quiet ? "none" : "stdout",
        orphans: [],
        basis: emptyBasis(budgetMs),
      };
    }
    return {
      code: 2,
      message: `verify:orphan-active: ${message}`,
      stream: "stderr",
      orphans: [],
      basis: emptyBasis(budgetMs),
    };
  }

  if (!existsSync(lifecycleRoot)) {
    return {
      code: 0,
      message: quiet ? "" : "verify:orphan-active: no xbrief/ lifecycle root; nothing to scan.",
      stream: quiet ? "none" : "stdout",
      orphans: [],
      basis: emptyBasis(budgetMs),
    };
  }

  const defaultRepo = resolveRepo(options.repo, root);
  // Resolve the SCM binary lazily: an offline `--skip-gh` run or an empty
  // active/ must not pay for (or fail on) binary resolution it never uses.
  let runner: GateRunner | null =
    options.runGh === undefined ? null : { runGh: options.runGh, proxied: false };
  const runGh: RunGhFn = (cmd) => {
    runner ??= makeGateRunner();
    return runner.runGh(cmd);
  };
  const tally = new BasisTally();
  const ctx: ResolveContext = {
    projectRoot: root,
    runGh,
    skipGh,
    nowMs: clock(),
    inventory: new OpenIssueInventory(runGh),
  };

  try {
    // #3774: missing gh/ghx is config (code 2), not an uncaught throw.
    const orphans: OrphanActiveBrief[] = [];
    let scanned = 0;
    for (const brief of listActiveRunningBriefs(root)) {
      scanned += 1;
      const { issues, prs } = collectGithubRefs(brief.plan, defaultRepo);
      // --issue N is one origin: briefs that name that issue. PR-only briefs stay on the unscoped scan (#3429).
      if (issueFilter !== null && !briefReferencesIssue(issues, issueFilter)) {
        continue;
      }
      if (issues.length === 0 && prs.length === 0) {
        continue;
      }
      const assessment = assessOrphanSignature(issues, prs, ctx, issueFilter, tally);
      if (assessment.orphaned && assessment.reason !== null && assessment.kind !== null) {
        orphans.push({
          path: relBriefPath(brief.path, root),
          reason: assessment.reason,
          kind: assessment.kind,
        });
      }
    }

    const basis: OrphanActiveBasis = {
      inventory: tally.inventory,
      live: tally.live,
      cache: tally.cache,
      unverified: tally.unverified,
      maxCacheAgeMs: tally.cache > 0 ? tally.maxCacheAgeMs : null,
      proxied: runner?.proxied ?? false,
      elapsedMs: Math.max(0, clock() - startedMs),
      budgetMs,
    };

    if (orphans.length > 0) {
      return {
        code: 1,
        message: formatRefusal(orphans, root, issueFilter, tally, basis),
        stream: "stderr",
        orphans,
        basis,
      };
    }

    if (quiet) {
      return { code: 0, message: "", stream: "none", orphans: [], basis };
    }

    const issueNote = issueFilter === null ? "" : ` for issue #${issueFilter}`;
    const headline =
      `verify:orphan-active: no orphaned active/running xBRIEFs${issueNote} ` +
      `(scanned ${scanned} running brief${scanned === 1 ? "" : "s"} in active/).`;
    return {
      code: 0,
      message: [headline, ...basisLines(tally, basis)].join("\n"),
      stream: "stdout",
      orphans: [],
      basis,
    };
  } catch (err: unknown) {
    if (err instanceof ScmStubError) {
      return {
        code: 2,
        message: `verify:orphan-active: ${err.message}`,
        stream: "stderr",
        orphans: [],
        basis: emptyBasis(budgetMs),
      };
    }
    throw err;
  }
}
