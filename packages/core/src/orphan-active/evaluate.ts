import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  isVBriefReferenceType,
  KNOWN_REFERENCE_TYPES,
  referenceTypeMatches,
} from "@deftai/directive-types";
import { resolveLifecycleRoot } from "../layout/resolve.js";
import { resolveDeliveryTip } from "../lifecycle/completed-tracked-on-delivery.js";
import {
  listTipLandsWithProductBriefs,
  type ProveLandsWithProductFn,
  proveLandsWithProductCompletion,
} from "../lifecycle/lands-with-product-proof.js";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import { ScmStubError } from "../scm/errors.js";
import {
  defaultMergeTimeForge,
  type ForgePage,
  type MergeTimeForge,
  PR_FILES_LISTING_CAP,
  type PrFileEntry,
} from "../scope/delivery-evidence.js";
import { defaultGitRunner, type GitRunner } from "../session/git.js";
import { resolveRepo } from "../triage/queue/repo.js";
import {
  type CandidateScope,
  normalizeScopePath,
  resolveCandidateScope,
} from "./candidate-scope.js";
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
import { collectGithubRefs, fetchPrMerged, type IssueRef, type PrRef } from "./refs.js";
import { listActiveRunningBriefs } from "./running-briefs.js";

export type OutputStream = "stdout" | "stderr" | "none";

/**
 * `lands-with-product-unproven` (#6277 Bound 5): a completed brief on the
 * delivery tip, stamped `lands-with-product`, whose close proof fails.
 */
export type OrphanKind = "shipped" | "unresolved" | "dropped-ref" | "lands-with-product-unproven";

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
  /** Running briefs this run actually evaluated (after `--changed-only` skip). */
  readonly scanned: number;
  /**
   * Evaluated briefs whose `collectGithubRefs` returned zero issues and zero
   * PRs and that were not classified as dropped-ref (#4426 / #4697). Reporting
   * only — does not change the two unknown policies.
   */
  readonly noOrigin: number;
}

/** What merge-chokepoint scoping decided for this run (#3893). */
export interface OrphanActiveScopeSummary {
  readonly kind: "diff" | "sweep";
  /** Ref the candidate diff was taken against; null on a sweep. */
  readonly baseRef: string | null;
  /** Why the run stayed repo-wide; null on a candidate diff. */
  readonly reason: string | null;
  /** Running briefs left unevaluated because this candidate does not own them. */
  readonly skipped: number;
}

export interface EvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
  readonly orphans: readonly OrphanActiveBrief[];
  readonly basis: OrphanActiveBasis;
  /** Null unless `changedOnly` was requested. */
  readonly scope: OrphanActiveScopeSummary | null;
  /** Shipped briefs reported pending while their lifecycle PR is open (#6645). */
  readonly pending?: readonly PendingLifecycleBrief[];
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
  /**
   * Merge-chokepoint scoping (#3893): evaluate only active/running briefs the
   * candidate's own diff touches. Ignored with `issue`, which is already one
   * origin. Falls back to the repo-wide sweep when the base ref is unresolvable.
   */
  readonly changedOnly?: boolean;
  /** Base ref for `changedOnly`; defaults to `origin/<deliveryBranch>`. */
  readonly baseRef?: string | null;
  readonly runGit?: GitRunner;
  /** Delivery tip for the lands-with-product scan (#6277); defaults to origin/<deliveryBranch>. */
  readonly tip?: string | null;
  /** Close proof for lands-with-product briefs (#6277); defaults to the forge-backed join. */
  readonly proveLandsWithProduct?: ProveLandsWithProductFn;
  /** Test seam: open-PR and changed-file reads for the pending lifecycle check (#6645). */
  readonly lifecycleForge?: LifecycleForge;
}

/** Forge reads for the pending lifecycle check (#6645 P3). */
export type LifecycleForge = Pick<MergeTimeForge, "listOpenPrsPage" | "fetchPrFilesPage">;

/** A shipped brief whose lifecycle PR is open (#6645 P3). */
export interface PendingLifecycleBrief {
  readonly path: string;
  readonly pr: number;
}

function relBriefPath(path: string, projectRoot: string): string {
  try {
    return relative(resolve(projectRoot), resolve(path)).replace(/\\/g, "/");
  } catch {
    return path.replace(/\\/g, "/");
  }
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

const KNOWN_REFERENCE_TYPE_SET: ReadonlySet<string> = new Set(KNOWN_REFERENCE_TYPES);

/**
 * Sibling walk of plan.references at the empty-collect site (#4697).
 * collectGithubRefs stays {issues, prs} only — this does not recut it.
 */
function droppedRefReason(plan: Record<string, unknown>): string | null {
  const refs = plan.references;
  if (!Array.isArray(refs)) {
    return null;
  }
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
      continue;
    }
    const type = String((ref as Record<string, unknown>).type ?? "");
    if (type.length === 0) {
      continue;
    }
    if (referenceTypeMatches(type, "github-issue") || referenceTypeMatches(type, "github-pr")) {
      return `${type} did not collect (unparseable URI or missing defaultRepo)`;
    }
    if (isVBriefReferenceType(type) && !KNOWN_REFERENCE_TYPE_SET.has(type)) {
      return `unknown reserved reference type ${type} is not collectable`;
    }
  }
  return null;
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

export interface UnmarkedFinalizeAdmit {
  readonly productPr: number;
  readonly issue: number;
  readonly detail: string;
}

/**
 * Unmarked finalize admit (#3791 P3 / #5122).
 * This ship has no positive unmarked PR-to-origin carrier: same-repo plus
 * `merged_at` is not delivery identity. Always returns null. Marked briefs
 * use `productPullRequestFromPlan` and never enter this derive. Empty-prRefs
 * and cross-repo pairing stay null. A later ship may admit a uniquely
 * evidenced pair; `firstMergedPrRef` remains merge-state only.
 */
export function deriveUnmarkedFinalizeAdmit(
  plan: Record<string, unknown>,
  defaultRepo: string,
  runGh: RunGhFn,
): UnmarkedFinalizeAdmit | null {
  void plan;
  void defaultRepo;
  void runGh;
  return null;
}

/** Basis, ghx caveat, and budget lines shared by the pass and refusal messages (#3767). */
function basisLines(tally: BasisTally, basis: OrphanActiveBasis): string[] {
  const lines = [`  Basis: ${tally.summary()}.`];
  const briefNoun = basis.scanned === 1 ? "brief" : "briefs";
  lines.push(
    `  Origins: ${basis.noOrigin} of ${basis.scanned} scanned ${briefNoun} resolved zero forge origins.`,
  );
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

/** Keep an operator-supplied ref (or a reason quoting one) on a single line. */
function oneLine(text: string): string {
  return text.replace(/\r?\n/g, " ");
}

/** One operator-visible line naming what this run was allowed to look at (#3893). */
function scopeLines(scope: CandidateScope | null, skipped: number): string[] {
  if (scope === null) {
    return [];
  }
  if (scope.kind === "sweep") {
    return [`  Scope: repo-wide sweep -- ${oneLine(scope.reason)} (#3893).`];
  }
  const noun = skipped === 1 ? "brief" : "briefs";
  const verb = skipped === 1 ? "was" : "were";
  return [
    `  Scope: candidate diff against ${oneLine(scope.baseRef)}; ${skipped} running ${noun} outside ` +
      `this branch's diff ${verb} not evaluated (#3893).`,
  ];
}

function summarizeScope(
  scope: CandidateScope | null,
  skipped: number,
): OrphanActiveScopeSummary | null {
  if (scope === null) {
    return null;
  }
  return scope.kind === "sweep"
    ? { kind: "sweep", baseRef: null, reason: scope.reason, skipped }
    : { kind: "diff", baseRef: scope.baseRef, reason: null, skipped };
}

function formatRefusal(
  orphans: readonly OrphanActiveBrief[],
  projectRoot: string,
  issueFilter: number | null,
  tally: BasisTally,
  basis: OrphanActiveBasis,
  scope: CandidateScope | null,
  skipped: number,
): string {
  const shippedOrphans = orphans.filter((orphan) => orphan.kind === "shipped");
  const unresolvedOrphans = orphans.filter((orphan) => orphan.kind === "unresolved");
  const droppedOrphans = orphans.filter((orphan) => orphan.kind === "dropped-ref");
  const landedOrphans = orphans.filter((orphan) => orphan.kind === "lands-with-product-unproven");
  const noun = orphans.length === 1 ? "" : "s";
  let headline: string;
  if (landedOrphans.length === orphans.length) {
    headline = `verify:orphan-active: ${landedOrphans.length} lands-with-product xBRIEF${
      landedOrphans.length === 1 ? "" : "s"
    } on the delivery tip failed the close proof (#6277) (project_root=${projectRoot}).`;
  } else if (
    droppedOrphans.length > 0 &&
    shippedOrphans.length === 0 &&
    unresolvedOrphans.length === 0
  ) {
    headline = `verify:orphan-active: ${droppedOrphans.length} active/running xBRIEF${
      droppedOrphans.length === 1 ? "" : "s"
    } have dropped forge origin references (cannot collect) (project_root=${projectRoot}).`;
  } else if (
    unresolvedOrphans.length > 0 &&
    shippedOrphans.length === 0 &&
    droppedOrphans.length === 0
  ) {
    headline = `verify:orphan-active: ${unresolvedOrphans.length} active/running xBRIEF${
      unresolvedOrphans.length === 1 ? "" : "s"
    } have unresolved GitHub state (cannot confirm shipped) (project_root=${projectRoot}).`;
  } else if (
    shippedOrphans.length > 0 &&
    unresolvedOrphans.length === 0 &&
    droppedOrphans.length === 0
  ) {
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
      "    task scope:cancel -- xbrief/active/<file>.xbrief.json   # abandon-only; refused when shipped-closed without completed tip twin (#5126)",
      "  Shipped-closed Tracking/Refs: leftover-complete via printed scope:complete / swarm:finalize-cohort -- --pr <n> — cancel is not a ship exit (#5126).",
      "  For stop-at:pr-open workers the orchestrator owns post-merge leftover-complete;",
      "  for drive-to:merge-ready workers scope:complete is part of the worker unit (#2321 / #3429).",
      "  Or run task swarm:finalize-cohort -- --pr <n> / --stories <ids|paths> after cohort merge.",
    );
  }
  if (unresolvedOrphans.length > 0) {
    // Only the scoped `--issue N` arm can report unresolved, so the retry never
    // needs a --changed-only form (the sweep arm fails open on unknown).
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
  if (droppedOrphans.length > 0) {
    lines.push(
      "  Remediation: make the origin collectable (canonical x-xbrief/github-issue or x-xbrief/github-pr, or companion #4698 at write time).",
      "  Do not run task scope:complete. Do not retry the GitHub lookup.",
    );
  }
  if (landedOrphans.length > 0) {
    lines.push(
      "  Remediation: each lands-with-product brief names its failed join; complete the story",
      "  through the post-merge path (task scope:complete -- <active-path> --pr <n> --merge-commit <sha>) (#6277 / #6303).",
    );
  }
  lines.push("  Offending briefs:");
  for (const orphan of orphans) {
    lines.push(`    - ${orphan.path} (${orphan.reason})`);
  }
  lines.push(...basisLines(tally, basis), ...scopeLines(scope, skipped));
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
    scanned: 0,
    noOrigin: 0,
  };
}

/**
 * Every page of one forge listing; a failed page or a stuck cursor fails closed
 * (#6645). `admit` runs before each page request; when it returns false no
 * request starts and the result is a cut (#6899).
 */
function collectLifecyclePages<T>(
  fetchPage: (after: string | null) => ForgePage<T>,
  label: string,
  admit: () => boolean,
): { ok: true; nodes: T[] } | { ok: false; error: string; cut?: true } {
  const nodes: T[] = [];
  let after: string | null = null;
  for (;;) {
    if (!admit()) {
      return { ok: false, error: `${label}: cut short at the run deadline`, cut: true };
    }
    let page: ForgePage<T>;
    try {
      page = fetchPage(after);
    } catch (err: unknown) {
      return { ok: false, error: `${label}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!page.ok) {
      return { ok: false, error: `${label}: ${page.error}` };
    }
    nodes.push(...page.nodes);
    if (!page.hasNextPage) {
      return { ok: true, nodes };
    }
    const next = page.endCursor?.trim() ?? "";
    if (next.length === 0 || next === after) {
      return { ok: false, error: `${label}: incomplete page (hasNextPage without a new cursor)` };
    }
    after = next;
  }
}

/**
 * True when the diff moves exactly `<root>/active/<file>` to
 * `<root>/completed/<file>`: a rename, or a removal of the active path beside
 * an add of the completed path (#6645 P3).
 */
export function diffMovesBriefToCompleted(
  files: readonly PrFileEntry[],
  activePath: string,
): boolean {
  const normalized = activePath.replace(/\\/g, "/");
  const match = /^((?:.*\/)?(?:xbrief|vbrief))\/active\/([^/]+)$/.exec(normalized);
  if (match === null) {
    return false;
  }
  const completedPath = `${match[1]}/completed/${match[2]}`;
  if (files.some((f) => f.filename === completedPath && f.previousFilename === normalized)) {
    return true;
  }
  const removed = files.some((f) => f.filename === normalized && f.status === "removed");
  const added = files.some((f) => f.filename === completedPath && f.status === "added");
  return removed && added;
}

/**
 * Pending lifecycle check (#6645 P3). Lists every open PR on `repo` (paged)
 * and keeps those whose head repository is `repo` (fork heads never match).
 * A shipped brief is pending when one of them moves that exact brief from
 * `active/` to `completed/`. The issue number in a PR body is not the
 * selector. Any failed, unparseable or incomplete read fails the whole check,
 * so the caller keeps every shipped verdict.
 *
 * Run deadline (#6899): before each forge request (each open-PR list page and
 * each changed-files page) the scan reads `nowMs()`. Once `nowMs() >= deadlineMs`
 * it starts no new request and fails with `cutShort`, so the caller keeps every
 * shipped verdict, including one whose lifecycle PR was already found. The
 * guarantee is only that: a request already running may end after the deadline,
 * and the reads before and after the scan are not bounded here.
 */
export function findPendingLifecyclePrs(input: {
  readonly repo: string;
  readonly shippedPaths: readonly string[];
  readonly forge: LifecycleForge;
  /** The run's deadline: its start time plus its `budgetMs`. */
  readonly deadlineMs: number;
  /** The run's budget, named in the cut-short error. */
  readonly budgetMs: number;
  /** The run's clock. */
  readonly nowMs: () => number;
}):
  | { ok: true; pending: Map<string, number> }
  | { ok: false; error: string; cutShort?: { readInFull: number } } {
  const { repo, forge, deadlineMs, nowMs } = input;
  const listOpen = forge.listOpenPrsPage;
  if (listOpen === undefined) {
    return { ok: false, error: "open-PR list is unavailable" };
  }
  const admit = (): boolean => nowMs() < deadlineMs;
  let readInFull = 0;
  const cutShort = () => ({
    ok: false as const,
    error:
      `cut short at the run deadline (${formatAge(input.budgetMs)} budget) after ` +
      `${readInFull} same-repository open PR(s) read in full`,
    cutShort: { readInFull },
  });
  const open = collectLifecyclePages((after) => listOpen(repo, after), "open-PR list", admit);
  if (!open.ok) {
    return open.cut === true ? cutShort() : { ok: false, error: open.error };
  }
  const pending = new Map<string, number>();
  const wanted = input.shippedPaths.map((p) => p.replace(/\\/g, "/"));
  for (const node of open.nodes) {
    if (pending.size === wanted.length) break;
    if (node.headRepository === null || node.headRepository.toLowerCase() !== repo.toLowerCase()) {
      continue;
    }
    const files = collectLifecyclePages(
      (after) => forge.fetchPrFilesPage(repo, node.number, after),
      `PR #${node.number} changed files`,
      admit,
    );
    if (!files.ok) {
      return files.cut === true ? cutShort() : { ok: false, error: files.error };
    }
    if (files.nodes.length >= PR_FILES_LISTING_CAP) {
      return {
        ok: false,
        error: `PR #${node.number} changed files: listing truncated at the ${PR_FILES_LISTING_CAP}-file cap`,
      };
    }
    readInFull += 1;
    for (const path of wanted) {
      if (!pending.has(path) && diffMovesBriefToCompleted(files.nodes, path)) {
        pending.set(path, node.number);
      }
    }
  }
  return { ok: true, pending };
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
 *
 * `changedOnly` is the merge-chokepoint form (#3893): only briefs the
 * candidate's own diff touches are evaluated, so a brief stranded by another
 * merge cannot fail this candidate. It falls back to the repo-wide sweep at
 * the delivery tip and whenever the base ref is unresolvable.
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
      scope: null,
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
        scope: null,
      };
    }
    return {
      code: 2,
      message: `verify:orphan-active: ${message}`,
      stream: "stderr",
      orphans: [],
      basis: emptyBasis(budgetMs),
      scope: null,
    };
  }

  if (!existsSync(lifecycleRoot)) {
    return {
      code: 0,
      message: quiet ? "" : "verify:orphan-active: no xbrief/ lifecycle root; nothing to scan.",
      stream: quiet ? "none" : "stdout",
      orphans: [],
      basis: emptyBasis(budgetMs),
      scope: null,
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
    const briefs = listActiveRunningBriefs(root);
    // Merge-chokepoint scoping (#3893). `--issue N` is already one origin, and
    // an empty active/ has nothing to scope, so neither pays for the git reads.
    const scope =
      options.changedOnly === true && issueFilter === null && briefs.length > 0
        ? resolveCandidateScope(root, join(lifecycleRoot, "active"), {
            baseRef: options.baseRef,
            runGit: options.runGit,
          })
        : null;
    const orphans: OrphanActiveBrief[] = [];
    let scanned = 0;
    let skipped = 0;
    let noOrigin = 0;
    for (const brief of briefs) {
      if (scope?.kind === "diff" && !scope.paths.has(normalizeScopePath(brief.path))) {
        skipped += 1;
        continue;
      }
      const { issues, prs } = collectGithubRefs(brief.plan, defaultRepo);
      // --issue N is one origin: briefs that name that issue. Count scanned /
      // noOrigin only after that filter so a scoped verdict does not mix in
      // unrelated or originless briefs (#4426). PR-only briefs stay on the
      // unscoped scan (#3429).
      if (issueFilter !== null && !briefReferencesIssue(issues, issueFilter)) {
        continue;
      }
      scanned += 1;
      if (issues.length === 0 && prs.length === 0) {
        const dropped = droppedRefReason(brief.plan);
        if (dropped !== null) {
          orphans.push({
            path: relBriefPath(brief.path, root),
            reason: dropped,
            kind: "dropped-ref",
          });
          continue;
        }
        noOrigin += 1;
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

    // #6645 P3: a shipped brief whose lifecycle PR (same repository, open)
    // moves it to completed/ is pending, not failing. Any failed read, or reads
    // through the ghx cache, keep every shipped verdict.
    const pending: PendingLifecycleBrief[] = [];
    let pendingNote: string | null = null;
    const shippedPaths = orphans.filter((o) => o.kind === "shipped").map((o) => o.path);
    if (shippedPaths.length > 0 && !skipGh && defaultRepo !== null) {
      if (options.lifecycleForge === undefined && runner?.proxied === true) {
        pendingNote =
          "pending lifecycle check skipped: reads go through the ghx cache; shipped verdicts kept";
      } else {
        // #6899: the scan starts no new request once the run deadline is reached.
        const found = findPendingLifecyclePrs({
          repo: defaultRepo,
          shippedPaths,
          forge: options.lifecycleForge ?? defaultMergeTimeForge(runGh),
          deadlineMs: startedMs + budgetMs,
          budgetMs,
          nowMs: clock,
        });
        if (found.ok) {
          const kept = orphans.filter((o) => {
            const pr = o.kind === "shipped" ? found.pending.get(o.path) : undefined;
            if (pr === undefined) return true;
            pending.push({ path: o.path, pr });
            return false;
          });
          orphans.length = 0;
          orphans.push(...kept);
        } else if (found.cutShort !== undefined) {
          pendingNote =
            `pending lifecycle check cut short at the run deadline, shipped verdicts kept: ` +
            `${formatAge(budgetMs)} budget, ${found.cutShort.readInFull} same-repository open PR(s) read in full`;
        } else {
          pendingNote = `pending lifecycle check failed, shipped verdicts kept: ${found.error}`;
        }
      }
    }
    const pendingLines = [
      ...pending.map((p) => `verify:orphan-active: ${p.path}: pending lifecycle PR #${p.pr}`),
      ...(pendingNote === null ? [] : [`verify:orphan-active: ${pendingNote}`]),
    ];
    const pendingField = pending.length > 0 ? { pending } : {};

    // #6277 Bound 5: a lands-with-product brief on the delivery tip whose close
    // proof fails is listed, so a failed in-PR completion cannot hide outside
    // active/. Only the scoped `--issue N` form (the after-merge close proof)
    // runs it: each proof is a forge identity join, too costly to repeat for every
    // landed story on each repo-wide sweep. Offline runs skip it.
    const scanLanded =
      issueFilter !== null && (!skipGh || options.proveLandsWithProduct !== undefined);
    if (scanLanded) {
      const runGit = options.runGit ?? defaultGitRunner;
      const { tip } = resolveDeliveryTip(root, options.tip, runGit);
      if (tip !== null) {
        const prove = options.proveLandsWithProduct ?? proveLandsWithProductCompletion;
        for (const brief of listTipLandsWithProductBriefs(root, tip, runGit)) {
          const { issues } = collectGithubRefs(brief.plan, defaultRepo);
          if (issueFilter !== null && !briefReferencesIssue(issues, issueFilter)) {
            continue;
          }
          const proof = prove({
            projectRoot: root,
            tip,
            briefRel: brief.rel,
            plan: brief.plan,
            runGit,
            runGh,
          });
          if (!proof.ok) {
            orphans.push({
              path: brief.rel,
              reason: proof.message,
              kind: "lands-with-product-unproven",
            });
          }
        }
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
      scanned,
      noOrigin,
    };

    const scopeSummary = summarizeScope(scope, skipped);

    if (orphans.length > 0) {
      return {
        code: 1,
        message: [
          formatRefusal(orphans, root, issueFilter, tally, basis, scope, skipped),
          ...pendingLines,
        ].join("\n"),
        stream: "stderr",
        orphans,
        basis,
        scope: scopeSummary,
        ...pendingField,
      };
    }

    if (quiet) {
      return {
        code: 0,
        message: "",
        stream: "none",
        orphans: [],
        basis,
        scope: scopeSummary,
        ...pendingField,
      };
    }

    const issueNote = issueFilter === null ? "" : ` for issue #${issueFilter}`;
    const headline =
      `verify:orphan-active: no orphaned active/running xBRIEFs${issueNote} ` +
      `(scanned ${scanned} running brief${scanned === 1 ? "" : "s"} in active/).`;
    return {
      code: 0,
      message: [
        headline,
        ...pendingLines,
        ...basisLines(tally, basis),
        ...scopeLines(scope, skipped),
      ].join("\n"),
      stream: "stdout",
      orphans: [],
      basis,
      scope: scopeSummary,
      ...pendingField,
    };
  } catch (err: unknown) {
    if (err instanceof ScmStubError) {
      return {
        code: 2,
        message: `verify:orphan-active: ${err.message}`,
        stream: "stderr",
        orphans: [],
        basis: emptyBasis(budgetMs),
        scope: null,
      };
    }
    throw err;
  }
}
