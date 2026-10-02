/**
 * Warn-first discovery of shipped-closed issues lacking tip-tree origin (#3495).
 *
 * Bound composition: hybrid Prefer-A 5957635125 + E1/W1 Recut Prefer-A 5959952355.
 * Day-one enforce debt = merged-closing-pr + unresolved/incomplete. app-claimed-origin
 * and none stay report-only (none until #4713). Off task check.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  hasArtifactSuffix,
  LEGACY_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_DIR,
} from "../layout/resolve.js";
import { collectGithubRefs } from "../orphan-active/refs.js";
import { isPublishable, latestPublishableTag } from "../platform/resolve-version.js";
import { defaultRunGh, fetchClosingIssuesReferences } from "../pr-protected-issues/gh.js";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import {
  type ClosedPullWalkOutcome,
  GhRestError,
  type GhRestSeams,
  REST_MAX_PER_PAGE,
  REST_SHARED_ROW_BUDGET,
  type RunGhApiFn,
  restIssueListPaginated,
  restWalkClosedPullsUpdatedDesc,
} from "../scm/gh-rest.js";
import { defaultGitRunner, type GitRunner, showBlobsBatch } from "../session/git.js";
import { resolveRepo } from "../triage/queue/repo.js";
import { type ResolvedIgnores, resolveScopeIgnores } from "../triage/scope/resolve.js";
import {
  extractAuthor,
  extractLabels,
  extractMilestone,
} from "../triage/scope-drift/cache-walker.js";
import {
  ABANDON_CLOSE_REASONS,
  type IssueCloseKind,
  LOCAL_ORIGIN_FOLDERS,
  type OutputStream,
  resolveDeliveryTip,
} from "./completed-tracked-on-delivery.js";

export type CloseEvidenceFacet = "merged-closing-pr" | "app-claimed-origin" | "none" | "unresolved";

export type DiscoveryExemptReason = "abandoned-closed" | "label" | "milestone" | "author";

export interface DiscoveryExemptLine {
  readonly issue: number;
  readonly reason: DiscoveryExemptReason;
  readonly matchedRule: string;
}

export interface DiscoveryCandidate {
  readonly issue: number;
  readonly facet: CloseEvidenceFacet;
  readonly closedAt: string | null;
}

export type WindowResolutionStatus = "ok" | "failed";

export interface DiscoveryWindow {
  readonly status: WindowResolutionStatus;
  readonly tag: string | null;
  readonly dateField: "taggerdate" | "creatordate" | "fallback-30d" | null;
  readonly startUtc: string | null;
  readonly endUtc: string | null;
  readonly tipSha: string | null;
  readonly tagListCardinality: number;
  readonly publishableCount: number;
  readonly note: string | null;
  readonly failureReason: string | null;
}

export interface EvaluateShippedClosedDiscoveryOptions {
  readonly quiet?: boolean;
  readonly repo?: string | null;
  readonly tip?: string | null;
  /** Fail closed on merged-closing-pr debt and unresolved/incomplete (#3495). */
  readonly enforce?: boolean;
  readonly runGh?: RunGhFn;
  readonly skipGh?: boolean;
  readonly runGit?: GitRunner;
  readonly runGhApiFn?: RunGhApiFn;
  readonly now?: () => Date;
  /** Test seam: override tip-tree origin issue numbers. */
  readonly tipOriginNumbers?: ReadonlySet<number>;
  /** Test seam: override scope ignores. */
  readonly scopeIgnores?: ResolvedIgnores;
}

export interface EvaluateShippedClosedDiscoveryResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
  readonly window: DiscoveryWindow;
  readonly candidates: readonly DiscoveryCandidate[];
  readonly exempt: readonly DiscoveryExemptLine[];
  readonly counts: {
    readonly candidate: number;
    readonly exempt: number;
    readonly missingDebt: number;
    readonly reportOnly: number;
    readonly unresolved: number;
  };
  readonly issueWalk: {
    readonly raw: number;
    readonly kept: number;
    readonly hitReviewTrigger: boolean;
  };
  readonly pullWalk: {
    readonly outcome: ClosedPullWalkOutcome | "skipped";
    readonly raw: number;
    readonly kept: number;
    readonly hitReviewTrigger: boolean;
    readonly incomplete: boolean;
  };
  readonly tip: string | null;
}

/** N=30d fallback as ms (Bound #3495). Product of literals — not a numeric-const fact. */
const FALLBACK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function planOf(data: Record<string, unknown> | null): Record<string, unknown> | null {
  const plan = data?.plan;
  return typeof plan === "object" && plan !== null && !Array.isArray(plan)
    ? (plan as Record<string, unknown>)
    : null;
}

function closeKindFromIssueRow(row: Record<string, unknown>): IssueCloseKind {
  const state = typeof row.state === "string" ? row.state : null;
  if (state === null) {
    return "unknown";
  }
  if (state === "open") {
    return "open";
  }
  const reasonRaw = row.state_reason;
  const reason = typeof reasonRaw === "string" ? reasonRaw : null;
  if (reason !== null && ABANDON_CLOSE_REASONS.has(reason)) {
    return "abandoned-closed";
  }
  return "shipped-closed";
}

function issueNumberOf(row: Record<string, unknown>): number | null {
  const n = row.number;
  if (typeof n === "number" && Number.isInteger(n) && n > 0) {
    return n;
  }
  if (typeof n === "string" && /^\d+$/.test(n)) {
    return Number(n);
  }
  return null;
}

function toUtcIso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseIsoOrNull(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim().length === 0) {
    return null;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** [bot] + case-fold compare for triageScopeIgnores authors (#3495 S2). */
export function authorMatchesIgnore(issueAuthor: string, ignored: ReadonlySet<string>): boolean {
  const a = issueAuthor.trim().toLowerCase();
  if (a.length === 0) {
    return false;
  }
  const aBare = a.endsWith("[bot]") ? a.slice(0, -5) : a;
  for (const raw of ignored) {
    const b = raw.trim().toLowerCase();
    if (b.length === 0) {
      continue;
    }
    const bBare = b.endsWith("[bot]") ? b.slice(0, -5) : b;
    if (a === b || aBare === bBare) {
      return true;
    }
  }
  return false;
}

export function matchScopeIgnoreAttribution(
  row: Record<string, unknown>,
  ignores: ResolvedIgnores,
): DiscoveryExemptLine | null {
  const number = issueNumberOf(row);
  if (number === null) {
    return null;
  }
  const author = extractAuthor(row);
  if (ignores.authors.size > 0 && authorMatchesIgnore(author, ignores.authors)) {
    return { issue: number, reason: "author", matchedRule: author || "(author)" };
  }
  if (ignores.labels.size > 0) {
    for (const label of extractLabels(row)) {
      for (const ignored of ignores.labels) {
        if (label.toLowerCase() === ignored.toLowerCase()) {
          return { issue: number, reason: "label", matchedRule: label };
        }
      }
    }
  }
  if (ignores.milestones.size > 0) {
    const milestone = extractMilestone(row);
    if (milestone.length > 0) {
      for (const ignored of ignores.milestones) {
        if (milestone.toLowerCase() === ignored.toLowerCase()) {
          return { issue: number, reason: "milestone", matchedRule: milestone };
        }
      }
    }
  }
  return null;
}

function fiveFolderPrefixes(): string[] {
  const out: string[] = [];
  for (const root of [MIGRATED_ARTIFACT_DIR, LEGACY_ARTIFACT_DIR]) {
    for (const folder of LOCAL_ORIGIN_FOLDERS) {
      out.push(`${root}/${folder}`);
    }
  }
  return out;
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

function collectTipOriginNumbers(
  projectRoot: string,
  tip: string,
  defaultRepo: string | null,
  runGit: GitRunner,
): Set<number> {
  const paths = listTreePaths(projectRoot, tip, fiveFolderPrefixes(), runGit);
  const bodies = showBlobsBatch(projectRoot, tip, paths, runGit);
  const out = new Set<number>();
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
    const { issues } = collectGithubRefs(plan, defaultRepo);
    for (const issue of issues) {
      // Keep repo identity: a foreign same-number must not hide local debt (#3495 review).
      if (defaultRepo === null) {
        continue;
      }
      if (issue.repo.toLowerCase() !== defaultRepo.toLowerCase()) {
        continue;
      }
      out.add(issue.number);
    }
  }
  return out;
}

function readTagDateField(
  projectRoot: string,
  tag: string,
  field: "taggerdate" | "creatordate",
  runGit: GitRunner,
): string | null {
  const result = runGit(projectRoot, [
    "for-each-ref",
    `refs/tags/${tag}`,
    `--format=%(${field}:iso-strict)`,
  ]);
  if (result.code !== 0) {
    return null;
  }
  const line = result.stdout.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 0 ? line : null;
}

/**
 * Resolve discovery window from inspected-repo publishable tags (#3495 W1/D1).
 */
export function resolveDiscoveryWindow(
  projectRoot: string,
  tip: string,
  runGit: GitRunner,
  now: () => Date = () => new Date(),
): DiscoveryWindow {
  const tipShaResult = runGit(projectRoot, ["rev-parse", tip]);
  const tipSha =
    tipShaResult.code === 0 && tipShaResult.stdout.trim().length > 0
      ? tipShaResult.stdout.trim()
      : null;

  const gitProbe = runGit(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (gitProbe.code !== 0) {
    return {
      status: "failed",
      tag: null,
      dateField: null,
      startUtc: null,
      endUtc: null,
      tipSha,
      tagListCardinality: 0,
      publishableCount: 0,
      note: null,
      failureReason: "not-a-git-root",
    };
  }

  const tagList = runGit(projectRoot, ["tag", "--list"]);
  if (tagList.code !== 0) {
    return {
      status: "failed",
      tag: null,
      dateField: null,
      startUtc: null,
      endUtc: null,
      tipSha,
      tagListCardinality: 0,
      publishableCount: 0,
      note: null,
      failureReason: `git-tag-list-failed:exit=${tagList.code}`,
    };
  }

  const tags = tagList.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const publishable = latestPublishableTag(tags);
  const publishableCount = tags.filter((t) => {
    try {
      return isPublishable(t);
    } catch {
      return false;
    }
  }).length;
  const end = now();
  const endUtc = toUtcIso(end);

  if (publishable === null) {
    const start = new Date(end.getTime() - FALLBACK_WINDOW_MS);
    return {
      status: "ok",
      tag: null,
      dateField: "fallback-30d",
      startUtc: toUtcIso(start),
      endUtc,
      tipSha,
      tagListCardinality: tags.length,
      publishableCount,
      note: "tag-list: empty-or-no-publishable (unfetched-or-no-releases indistinguishable)",
      failureReason: null,
    };
  }

  const tagger = readTagDateField(projectRoot, publishable, "taggerdate", runGit);
  const creator =
    tagger === null ? readTagDateField(projectRoot, publishable, "creatordate", runGit) : null;
  const chosenField: "taggerdate" | "creatordate" | null =
    tagger !== null ? "taggerdate" : creator !== null ? "creatordate" : null;
  const rawDate = tagger ?? creator;
  const startMs = parseIsoOrNull(rawDate);
  if (chosenField === null || startMs === null) {
    return {
      status: "failed",
      tag: publishable,
      dateField: null,
      startUtc: null,
      endUtc,
      tipSha,
      tagListCardinality: tags.length,
      publishableCount,
      note: null,
      failureReason: "empty-dates-on-resolved-tag",
    };
  }

  return {
    status: "ok",
    tag: publishable,
    dateField: chosenField,
    startUtc: toUtcIso(new Date(startMs)),
    endUtc,
    tipSha,
    tagListCardinality: tags.length,
    publishableCount,
    note: null,
    failureReason: null,
  };
}

function walkClosedIssuesInWindow(
  repo: string,
  windowStartIso: string,
  windowEndIso: string,
  remainingBudget: number,
  seams: GhRestSeams,
): {
  rows: Record<string, unknown>[];
  raw: number;
  kept: number;
  hitReviewTrigger: boolean;
  error: string | null;
} {
  const windowStartMs = Date.parse(windowStartIso);
  const windowEndMs = Date.parse(windowEndIso);
  const limit = Math.max(0, remainingBudget);
  try {
    // scm restIssueListPaginated (not cache twin). Shared 10k budget via limit.
    const listed = restIssueListPaginated(
      repo,
      {
        state: "closed",
        excludePulls: true,
        perPage: REST_MAX_PER_PAGE,
        limit: limit > 0 ? limit : 1,
      },
      seams,
    );
    // When budget is 0 we still need a distinguishable cap signal.
    if (remainingBudget <= 0) {
      return {
        rows: [],
        raw: 0,
        kept: 0,
        hitReviewTrigger: true,
        error: null,
      };
    }
    const raw = listed.length;
    const hitReviewTrigger = raw >= remainingBudget || raw >= REST_SHARED_ROW_BUDGET;
    const keptRows: Record<string, unknown>[] = [];
    for (const row of listed) {
      const closedAt = typeof row.closed_at === "string" ? row.closed_at : null;
      const closedMs = parseIsoOrNull(closedAt);
      if (
        closedMs !== null &&
        Number.isFinite(windowStartMs) &&
        Number.isFinite(windowEndMs) &&
        closedMs >= windowStartMs &&
        closedMs <= windowEndMs
      ) {
        keptRows.push(row);
      }
    }
    return {
      rows: keptRows,
      raw,
      kept: keptRows.length,
      hitReviewTrigger,
      error: null,
    };
  } catch (caught: unknown) {
    const message =
      caught instanceof GhRestError
        ? caught.message
        : caught instanceof Error
          ? caught.message
          : String(caught);
    // Cap throw from paginated helper → treat as review-trigger incomplete raw.
    const isCap = message.includes("REST_PAGINATION_MAX_PAGES");
    return {
      rows: [],
      raw: isCap ? REST_SHARED_ROW_BUDGET : 0,
      kept: 0,
      hitReviewTrigger: isCap,
      error: isCap ? null : message,
    };
  }
}

function buildMergedClosingIndex(
  repo: string,
  windowStartIso: string,
  windowEndIso: string,
  remainingBudget: number,
  runGh: RunGhFn,
  seams: GhRestSeams,
): {
  issueToPr: Map<number, number>;
  outcome: ClosedPullWalkOutcome;
  raw: number;
  kept: number;
  hitReviewTrigger: boolean;
  incomplete: boolean;
  unresolvedReason: string | null;
} {
  const walk = restWalkClosedPullsUpdatedDesc(
    repo,
    {
      windowStartIso,
      windowEndIso,
      remainingBudget,
    },
    seams,
  );
  const incomplete = walk.outcome === "cap" || walk.outcome === "error";
  const issueToPr = new Map<number, number>();
  let unresolvedReason: string | null =
    walk.outcome === "error" ? (walk.errorMessage ?? "pull-walk-error") : null;

  if (!incomplete) {
    for (const pr of walk.mergedInWindow) {
      const prNumber = issueNumberOf(pr);
      if (prNumber === null) {
        unresolvedReason = "merged-pr-missing-number";
        return {
          issueToPr,
          outcome: walk.outcome,
          raw: walk.rawRows,
          kept: walk.keptMergedInWindow,
          hitReviewTrigger: walk.hitReviewTrigger,
          incomplete: true,
          unresolvedReason,
        };
      }
      const refs = fetchClosingIssuesReferences(prNumber, repo, runGh);
      if (refs === null) {
        unresolvedReason = `closingIssuesReferences-failed:pr=${prNumber}`;
        return {
          issueToPr,
          outcome: walk.outcome,
          raw: walk.rawRows,
          kept: walk.keptMergedInWindow,
          hitReviewTrigger: walk.hitReviewTrigger,
          incomplete: true,
          unresolvedReason,
        };
      }
      for (const issueNumber of refs) {
        if (!issueToPr.has(issueNumber)) {
          issueToPr.set(issueNumber, prNumber);
        }
      }
    }
  }

  return {
    issueToPr,
    outcome: walk.outcome,
    raw: walk.rawRows,
    kept: walk.keptMergedInWindow,
    hitReviewTrigger: walk.hitReviewTrigger,
    incomplete,
    unresolvedReason,
  };
}

function formatPullOutcomeLine(outcome: ClosedPullWalkOutcome | "skipped"): string {
  if (outcome === "list-exhausted") {
    return `pull-walk: outcome=${outcome} (list end before window stop; ordering race accepted)`;
  }
  if (outcome === "window-exhausted") {
    return `pull-walk: outcome=${outcome} (stable-ordering assumed; ordering race accepted)`;
  }
  return `pull-walk: outcome=${outcome}`;
}

function formatDiscoveryMessage(args: {
  readonly tip: string;
  readonly window: DiscoveryWindow;
  readonly issueWalk: EvaluateShippedClosedDiscoveryResult["issueWalk"];
  readonly pullWalk: EvaluateShippedClosedDiscoveryResult["pullWalk"];
  readonly counts: EvaluateShippedClosedDiscoveryResult["counts"];
  readonly candidates: readonly DiscoveryCandidate[];
  readonly exempt: readonly DiscoveryExemptLine[];
  readonly enforce: boolean;
  readonly debtFail: boolean;
}): string {
  const lines: string[] = [];
  lines.push("verify:completed-tracked discovery (#3495):");
  const w = args.window;
  lines.push(
    `  window-resolution: ${w.status}` +
      (w.failureReason ? ` reason=${w.failureReason}` : "") +
      ` tag-list-cardinality=${w.tagListCardinality}` +
      ` publishable-count=${w.publishableCount}` +
      (w.tag ? ` tag=${w.tag}` : "") +
      (w.dateField ? ` date-field=${w.dateField}` : "") +
      (w.startUtc && w.endUtc ? ` bounds=${w.startUtc}..${w.endUtc}` : "") +
      (w.tipSha ? ` tip-sha=${w.tipSha}` : "") +
      (w.note ? ` note=${w.note}` : ""),
  );
  lines.push(
    `  issue-walk: raw=${args.issueWalk.raw} kept=${args.issueWalk.kept}` +
      (args.issueWalk.hitReviewTrigger ? " review-trigger=shared-10k-budget" : ""),
  );
  lines.push(
    `  ${formatPullOutcomeLine(args.pullWalk.outcome)}` +
      ` raw=${args.pullWalk.raw} kept-merged=${args.pullWalk.kept}` +
      (args.pullWalk.hitReviewTrigger ? " review-trigger=shared-10k-budget" : "") +
      (args.pullWalk.incomplete ? " incomplete=true" : ""),
  );
  lines.push(
    `  counts: candidate=${args.counts.candidate} exempt=${args.counts.exempt}` +
      ` missing-debt=${args.counts.missingDebt} report-only=${args.counts.reportOnly}` +
      ` unresolved=${args.counts.unresolved}`,
  );
  for (const ex of args.exempt) {
    lines.push(`  exempt: #${ex.issue} reason=${ex.reason} matched=${ex.matchedRule}`);
  }
  for (const c of args.candidates) {
    const debt =
      c.facet === "merged-closing-pr" || c.facet === "unresolved" ? "debt" : "report-only";
    lines.push(`  candidate: #${c.issue} facet=${c.facet} class=${debt}`);
  }
  if (args.debtFail) {
    lines.push(
      `  enforce: FAIL tip=${args.tip} — remediate via task swarm:finalize-cohort` +
        " or a lifecycle PR (merged-closing-pr / unresolved).",
    );
  } else if (args.enforce) {
    lines.push(`  enforce: OK tip=${args.tip}`);
  } else {
    lines.push(
      `  warn-only tip=${args.tip} (pass --enforce for cohort-close / release fail-closed).`,
    );
  }
  return lines.join("\n");
}

/**
 * Enumerate in-window shipped-closed issues with no five-folder tip-tree origin.
 */
export function evaluateShippedClosedDiscovery(
  projectRoot: string,
  options: EvaluateShippedClosedDiscoveryOptions = {},
): EvaluateShippedClosedDiscoveryResult {
  const root = resolve(projectRoot);
  const quiet = options.quiet ?? false;
  const enforce = options.enforce ?? false;
  const skipGh = options.skipGh ?? false;
  const runGh = options.runGh ?? defaultRunGh;
  const runGit = options.runGit ?? defaultGitRunner;
  const now = options.now ?? (() => new Date());
  const defaultRepo = resolveRepo(options.repo, root);
  const emptyWindow: DiscoveryWindow = {
    status: "failed",
    tag: null,
    dateField: null,
    startUtc: null,
    endUtc: null,
    tipSha: null,
    tagListCardinality: 0,
    publishableCount: 0,
    note: null,
    failureReason: "not-started",
  };
  const emptyCounts = {
    candidate: 0,
    exempt: 0,
    missingDebt: 0,
    reportOnly: 0,
    unresolved: 0,
  };

  if (!existsSync(root)) {
    return {
      code: 2,
      message: `verify:completed-tracked discovery: project root does not exist: ${root}`,
      stream: "stderr",
      window: emptyWindow,
      candidates: [],
      exempt: [],
      counts: emptyCounts,
      issueWalk: { raw: 0, kept: 0, hitReviewTrigger: false },
      pullWalk: {
        outcome: "skipped",
        raw: 0,
        kept: 0,
        hitReviewTrigger: false,
        incomplete: true,
      },
      tip: null,
    };
  }

  if (defaultRepo === null) {
    // Warn-default soft-skips when no repo is resolvable (fixture / greenfield).
    // --enforce (cohort-close / release) fails closed — forge walk needs a repo.
    const message = "verify:completed-tracked discovery: skipped (no --repo / origin remote).";
    return {
      code: enforce ? 2 : 0,
      message: quiet ? "" : message,
      stream: quiet ? "none" : enforce ? "stderr" : "stdout",
      window: emptyWindow,
      candidates: [],
      exempt: [],
      counts: emptyCounts,
      issueWalk: { raw: 0, kept: 0, hitReviewTrigger: false },
      pullWalk: {
        outcome: "skipped",
        raw: 0,
        kept: 0,
        hitReviewTrigger: false,
        incomplete: true,
      },
      tip: null,
    };
  }

  const { tip, error: tipError } = resolveDeliveryTip(root, options.tip, runGit);
  if (tip === null) {
    return {
      code: 2,
      message: `verify:completed-tracked discovery: ${tipError ?? "could not resolve delivery tip"}`,
      stream: "stderr",
      window: emptyWindow,
      candidates: [],
      exempt: [],
      counts: emptyCounts,
      issueWalk: { raw: 0, kept: 0, hitReviewTrigger: false },
      pullWalk: {
        outcome: "skipped",
        raw: 0,
        kept: 0,
        hitReviewTrigger: false,
        incomplete: true,
      },
      tip: null,
    };
  }

  const window = resolveDiscoveryWindow(root, tip, runGit, now);
  if (window.status === "failed") {
    const message = formatDiscoveryMessage({
      tip,
      window,
      issueWalk: { raw: 0, kept: 0, hitReviewTrigger: false },
      pullWalk: {
        outcome: "skipped",
        raw: 0,
        kept: 0,
        hitReviewTrigger: false,
        incomplete: true,
      },
      counts: emptyCounts,
      candidates: [],
      exempt: [],
      enforce,
      debtFail: enforce,
    });
    return {
      code: enforce ? 1 : 0,
      message: quiet ? "" : message,
      stream: quiet ? "none" : enforce ? "stderr" : "stdout",
      window,
      candidates: [],
      exempt: [],
      counts: emptyCounts,
      issueWalk: { raw: 0, kept: 0, hitReviewTrigger: false },
      pullWalk: {
        outcome: "skipped",
        raw: 0,
        kept: 0,
        hitReviewTrigger: false,
        incomplete: true,
      },
      tip,
    };
  }

  if (skipGh) {
    // Represent scan-level skip-gh as unresolved count without inventing a fake issue.
    const counts = {
      candidate: 0,
      exempt: 0,
      missingDebt: 0,
      reportOnly: 0,
      unresolved: 1,
    };
    const message = [
      formatDiscoveryMessage({
        tip,
        window,
        issueWalk: { raw: 0, kept: 0, hitReviewTrigger: false },
        pullWalk: {
          outcome: "skipped",
          raw: 0,
          kept: 0,
          hitReviewTrigger: false,
          incomplete: true,
        },
        counts,
        candidates: [],
        exempt: [],
        enforce,
        debtFail: enforce,
      }),
      "  unresolved: skip-gh (forge evidence unavailable)",
    ].join("\n");
    return {
      code: enforce ? 1 : 0,
      message: quiet ? "" : message,
      stream: quiet ? "none" : enforce ? "stderr" : "stdout",
      window,
      candidates: [],
      exempt: [],
      counts,
      issueWalk: { raw: 0, kept: 0, hitReviewTrigger: false },
      pullWalk: {
        outcome: "skipped",
        raw: 0,
        kept: 0,
        hitReviewTrigger: false,
        incomplete: true,
      },
      tip,
    };
  }

  const seams: GhRestSeams = { runGhApiFn: options.runGhApiFn };
  const tipOrigins =
    options.tipOriginNumbers ?? collectTipOriginNumbers(root, tip, defaultRepo, runGit);
  const ignores = options.scopeIgnores ?? resolveScopeIgnores(root);

  const issueWalk = walkClosedIssuesInWindow(
    defaultRepo,
    window.startUtc!,
    window.endUtc!,
    REST_SHARED_ROW_BUDGET,
    seams,
  );

  if (issueWalk.error !== null) {
    const counts = {
      candidate: 0,
      exempt: 0,
      missingDebt: 0,
      reportOnly: 0,
      unresolved: 1,
    };
    const message = [
      formatDiscoveryMessage({
        tip,
        window,
        issueWalk: {
          raw: issueWalk.raw,
          kept: issueWalk.kept,
          hitReviewTrigger: issueWalk.hitReviewTrigger,
        },
        pullWalk: {
          outcome: "skipped",
          raw: 0,
          kept: 0,
          hitReviewTrigger: false,
          incomplete: true,
        },
        counts,
        candidates: [],
        exempt: [],
        enforce,
        debtFail: enforce,
      }),
      `  unresolved: issue-walk-error ${issueWalk.error}`,
    ].join("\n");
    return {
      code: enforce ? 1 : 0,
      message: quiet ? "" : message,
      stream: quiet ? "none" : enforce ? "stderr" : "stdout",
      window,
      candidates: [],
      exempt: [],
      counts,
      issueWalk: {
        raw: issueWalk.raw,
        kept: issueWalk.kept,
        hitReviewTrigger: issueWalk.hitReviewTrigger,
      },
      pullWalk: {
        outcome: "skipped",
        raw: 0,
        kept: 0,
        hitReviewTrigger: false,
        incomplete: true,
      },
      tip,
    };
  }

  const remainingBudget = Math.max(0, REST_SHARED_ROW_BUDGET - issueWalk.raw);
  const index = buildMergedClosingIndex(
    defaultRepo,
    window.startUtc!,
    window.endUtc!,
    remainingBudget,
    runGh,
    seams,
  );

  const exempt: DiscoveryExemptLine[] = [];
  const candidates: DiscoveryCandidate[] = [];
  let scanUnresolved = index.incomplete;

  for (const row of issueWalk.rows) {
    const number = issueNumberOf(row);
    if (number === null) {
      scanUnresolved = true;
      continue;
    }
    const kind = closeKindFromIssueRow(row);
    if (kind === "open") {
      continue;
    }
    if (kind === "abandoned-closed") {
      exempt.push({
        issue: number,
        reason: "abandoned-closed",
        matchedRule: String(row.state_reason ?? "abandoned"),
      });
      continue;
    }
    if (kind === "unknown") {
      scanUnresolved = true;
      candidates.push({
        issue: number,
        facet: "unresolved",
        closedAt: typeof row.closed_at === "string" ? row.closed_at : null,
      });
      continue;
    }
    // shipped-closed
    if (tipOrigins.has(number)) {
      continue;
    }
    const ignoreHit = matchScopeIgnoreAttribution(row, ignores);
    if (ignoreHit !== null) {
      exempt.push(ignoreHit);
      continue;
    }
    if (index.incomplete) {
      candidates.push({
        issue: number,
        facet: "unresolved",
        closedAt: typeof row.closed_at === "string" ? row.closed_at : null,
      });
      continue;
    }
    if (index.issueToPr.has(number)) {
      candidates.push({
        issue: number,
        facet: "merged-closing-pr",
        closedAt: typeof row.closed_at === "string" ? row.closed_at : null,
      });
      continue;
    }
    // app-claimed-origin has no day-one readable forge record — report-only none until #4713.
    candidates.push({
      issue: number,
      facet: "none",
      closedAt: typeof row.closed_at === "string" ? row.closed_at : null,
    });
  }

  candidates.sort((a, b) => a.issue - b.issue);
  exempt.sort((a, b) => a.issue - b.issue);

  const missingDebt = candidates.filter((c) => c.facet === "merged-closing-pr").length;
  const unresolved =
    candidates.filter((c) => c.facet === "unresolved").length +
    (scanUnresolved && candidates.every((c) => c.facet !== "unresolved") && index.incomplete
      ? 1
      : 0);
  const reportOnly = candidates.filter(
    (c) => c.facet === "none" || c.facet === "app-claimed-origin",
  ).length;
  const counts = {
    candidate: candidates.length,
    exempt: exempt.length,
    missingDebt,
    reportOnly,
    unresolved:
      unresolved +
      (index.incomplete && unresolved === 0 && missingDebt === 0 && candidates.length === 0
        ? 1
        : 0),
  };

  // Enforce debt = merged-closing-pr + nonzero unresolved/incomplete.
  const debtFail = enforce && (missingDebt > 0 || counts.unresolved > 0 || index.incomplete);
  const message = formatDiscoveryMessage({
    tip,
    window,
    issueWalk: {
      raw: issueWalk.raw,
      kept: issueWalk.kept,
      hitReviewTrigger: issueWalk.hitReviewTrigger,
    },
    pullWalk: {
      outcome: index.outcome,
      raw: index.raw,
      kept: index.kept,
      hitReviewTrigger: index.hitReviewTrigger,
      incomplete: index.incomplete,
    },
    counts,
    candidates,
    exempt,
    enforce,
    debtFail,
  });

  return {
    code: debtFail ? 1 : 0,
    message: quiet ? "" : message,
    stream: quiet ? "none" : debtFail ? "stderr" : "stdout",
    window,
    candidates,
    exempt,
    counts,
    issueWalk: {
      raw: issueWalk.raw,
      kept: issueWalk.kept,
      hitReviewTrigger: issueWalk.hitReviewTrigger,
    },
    pullWalk: {
      outcome: index.outcome,
      raw: index.raw,
      kept: index.kept,
      hitReviewTrigger: index.hitReviewTrigger,
      incomplete: index.incomplete,
    },
    tip,
  };
}
