/**
 * One story, one line (#6468). The story issue of a brief is the issue the
 * completion identity join anchors on (`resolvePlanGithubIssueRef`). The
 * closing-keywords story-line check and `--write-story-line` ask for one line,
 * for that issue, and check it against the owner list the plan-id adopter uses.
 * `findSharedStoryIssues` warns, before dispatch, when open story briefs share
 * that issue (#6934).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { referenceTypeMatches } from "@deftai/directive-types";
import { briefOwnsIssue, issueOriginFromRepoSlug } from "../intake/residual-identity.js";
import { listActiveBriefEntries } from "../intent-constraint/plan-id-adopter.js";

type ActiveBriefEntry = ReturnType<typeof listActiveBriefEntries>[number];

import { collectGithubRefs } from "../orphan-active/refs.js";
import type { ActiveRunningBrief } from "../orphan-active/running-briefs.js";
import { resolvePlanGithubIssueRef } from "../scope/delivery-evidence.js";

/** Story issue numbers a brief names: github-issue references, else the plan-id origin. */
export function storyIssuesOfBrief(plan: Record<string, unknown>, repo: string): number[] {
  // References only: x-tracking parent/decomposition issues are umbrellas, not the story.
  const { issues } = collectGithubRefs({ references: plan.references }, repo);
  const out = issues
    .filter((ref) => ref.repo.toLowerCase() === repo.toLowerCase())
    .map((ref) => ref.number);
  if (out.length > 0) {
    return [...new Set(out)].sort((a, b) => a - b);
  }
  const metadata = plan.metadata;
  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    const binding = (metadata as Record<string, unknown>)["x-directive/plan-id"];
    if (typeof binding === "object" && binding !== null && !Array.isArray(binding)) {
      const origin = (binding as Record<string, unknown>).origin;
      const m = typeof origin === "string" ? /^([^/#\s]+\/[^/#\s]+)#(\d+)$/.exec(origin) : null;
      if (m !== null && (m[1] ?? "").toLowerCase() === repo.toLowerCase()) {
        return [Number(m[2])];
      }
    }
  }
  return [];
}

/**
 * Bound item 1: the issue the completion identity join anchors on, when it is an
 * issue of `repo`. Null when the brief has no GitHub issue reference, or its
 * anchor is in another repository; those briefs keep today's per-issue rule.
 */
export function storyIssueOfBrief(plan: Record<string, unknown>, repo: string): number | null {
  const anchor = resolvePlanGithubIssueRef(plan);
  if (anchor === null || anchor.repository.toLowerCase() !== repo.toLowerCase()) {
    return null;
  }
  return anchor.issueNumber;
}

/** True when a running brief is the brief for issue N (ownership or github-issue reference). */
export function briefIsForIssue(
  brief: { readonly plan: Record<string, unknown> },
  repo: string,
  issue: number,
): boolean {
  const origin = issueOriginFromRepoSlug(repo, issue);
  if (origin !== null && briefOwnsIssue({ plan: brief.plan }, origin)) {
    return true;
  }
  return storyIssuesOfBrief(brief.plan, repo).includes(issue);
}

/** Repository-relative, forward-slash path of a brief. */
export function briefRelPath(path: string, projectRoot: string): string {
  try {
    return relative(resolve(projectRoot), resolve(path)).replace(/\\/g, "/");
  } catch {
    return path.replace(/\\/g, "/");
  }
}

/** What one running brief asks of a PR body (#6468). */
export type BriefStoryDemand =
  /** One line, for the brief's story issue; `others` are the brief's issues that need none. */
  | {
      readonly kind: "line";
      readonly issue: number;
      readonly others: readonly number[];
      readonly rel: string;
    }
  /** No same-repository anchor: today's rule, one line per listed issue. */
  | { readonly kind: "today"; readonly issues: readonly number[]; readonly rel: string }
  /** Case A or case B of Bound item 2: no line can serve this brief. */
  | {
      readonly kind: "blocked";
      readonly issue: number;
      readonly message: string;
      readonly rel: string;
    };

/**
 * Bound item 2. Reads the plan-id adopter's owner list for the story issue: every
 * parseable brief in `xbrief/active`, whatever its status, that `briefOwnsIssue`
 * matches for the repository-scoped issue. Returns a message in two cases only.
 */
export function storyIssueIdentityMessage(args: {
  readonly projectRoot: string;
  readonly repo: string;
  readonly rel: string;
  readonly plan: Record<string, unknown>;
  readonly issue: number;
  /** The adopter's `xbrief/active` scan, read once per check or writer call. */
  readonly entries?: readonly ActiveBriefEntry[];
}): string | null {
  const origin = issueOriginFromRepoSlug(args.repo, args.issue);
  if (origin === null) {
    return null;
  }
  const entries = args.entries ?? listActiveBriefEntries(args.projectRoot);
  const owners = entries.filter((e) => briefOwnsIssue(e.data, origin));
  const others = owners.filter((e) => e.relPath !== args.rel);
  const n = `#${String(args.issue)}`;
  if (others.length > 0) {
    // Case A: the one line would select, or collide with, a different brief.
    const list = others.map((e) => `${e.relPath} (status: ${e.status ?? "unknown"})`).join(", ");
    const lookup =
      owners.length > 1
        ? "matches multiple xbrief/active briefs and cannot adopt a plan id"
        : `selects ${others[0]?.relPath ?? "that brief"}, not this brief`;
    return (
      `FAIL: running brief ${args.rel} anchors on ${n} (its first GitHub issue reference), ` +
      `but xbrief/active lists another owner of ${n}: ${list} (#6468). ` +
      `The plan-id lookup for \`deft-story: ${String(args.issue)}\` ${lookup}, so no story line ` +
      `can serve this brief. Settle which brief owns ${n}, or make this brief's first GitHub ` +
      "issue reference an issue it owns."
    );
  }
  if (owners.length > 0) {
    return null;
  }
  // Case B: nobody owns the anchor, but this brief owns another of its own references.
  const own = entries.find((e) => e.relPath === args.rel)?.data ?? { plan: args.plan };
  const owned = storyIssuesOfBrief(args.plan, args.repo).filter((m) => {
    if (m === args.issue) return false;
    const o = issueOriginFromRepoSlug(args.repo, m);
    return o !== null && briefOwnsIssue(own, o);
  });
  if (owned.length === 0) {
    return null;
  }
  const ownedList = owned.map((m) => `#${String(m)}`).join(", ");
  return (
    `FAIL: running brief ${args.rel} anchors on ${n} (its first GitHub issue reference), ` +
    `but it owns ${ownedList} and no brief owns ${n} (#6468). Its references are in the wrong ` +
    `order. Repair: make the owned issue (${ownedList}) the first GitHub issue reference of the ` +
    "brief, then write the story line for it."
  );
}

/**
 * Bound items 1-3: what a running brief asks of the body. `fallback` is the list
 * today's rule asks for when the brief has no same-repository anchor.
 */
export function demandForBrief(args: {
  readonly projectRoot: string;
  readonly repo: string;
  readonly brief: ActiveRunningBrief;
  readonly fallback: readonly number[];
}): BriefStoryDemand {
  return storyDemandResolver(args.projectRoot, args.repo)(args.brief, args.fallback);
}

/**
 * `demandForBrief` for one check or writer call: the adopter's `xbrief/active` scan
 * runs at most once, and each brief's identity verdict is computed once.
 */
export function storyDemandResolver(
  projectRoot: string,
  repo: string,
): (brief: ActiveRunningBrief, fallback: readonly number[]) => BriefStoryDemand {
  let entries: readonly ActiveBriefEntry[] | null = null;
  const verdicts = new Map<string, string | null>();
  return (brief, fallback) => {
    const rel = briefRelPath(brief.path, projectRoot);
    const issue = storyIssueOfBrief(brief.plan, repo);
    if (issue === null) {
      return { kind: "today", issues: fallback, rel };
    }
    let message = verdicts.get(rel);
    if (message === undefined) {
      entries ??= listActiveBriefEntries(projectRoot);
      message = storyIssueIdentityMessage({
        projectRoot,
        repo,
        rel,
        plan: brief.plan,
        issue,
        entries,
      });
      verdicts.set(rel, message);
    }
    return demandFromVerdict(brief, repo, rel, issue, message);
  };
}

function demandFromVerdict(
  brief: ActiveRunningBrief,
  repo: string,
  rel: string,
  issue: number,
  message: string | null,
): BriefStoryDemand {
  if (message !== null) {
    return { kind: "blocked", issue, message, rel };
  }
  const others = storyIssuesOfBrief(brief.plan, repo).filter((m) => m !== issue);
  return { kind: "line", issue, others, rel };
}

/**
 * Bound item 3 for a body reference to N: the running brief anchored on N, else the
 * one running brief that names N. Several naming briefs and no anchor keep today's
 * rule for N (`"today"`); no brief gives null.
 */
export function briefForBodyRef(
  running: readonly ActiveRunningBrief[],
  repo: string,
  issue: number,
): ActiveRunningBrief | "today" | null {
  const anchored = running.find((b) => storyIssueOfBrief(b.plan, repo) === issue);
  if (anchored !== undefined) {
    return anchored;
  }
  const naming = running.filter((b) => briefIsForIssue(b, repo, issue));
  if (naming.length === 1) {
    return naming[0] ?? null;
  }
  return naming.length > 1 ? "today" : null;
}

/** Lifecycle folders the shared-issue check reads: open stories only (#6934). */
const SHARED_ISSUE_FOLDERS = ["pending", "active"] as const;
/** Brief roots: `xbrief/`, then legacy `vbrief/` (read-accepted). */
const SHARED_ISSUE_ROOTS = ["xbrief", "vbrief"] as const;

/** One open story brief the shared-issue check reads (#6934). */
interface OpenStoryBrief {
  readonly abs: string;
  readonly rel: string;
  readonly key: string;
  readonly repository: string;
  readonly issue: number;
}

/** A completion issue that more than one open story brief anchors on (#6934). */
export interface SharedStoryIssue {
  readonly repository: string;
  readonly issue: number;
  /** The story brief the check ran for. */
  readonly rel: string;
  /** The other open story briefs with the same completion issue, sorted. */
  readonly others: readonly string[];
}

function planRecordOf(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const plan = (data as Record<string, unknown>).plan;
  return typeof plan === "object" && plan !== null && !Array.isArray(plan)
    ? (plan as Record<string, unknown>)
    : null;
}

/**
 * Epic and phase briefs are not stories: an explicit `metadata.kind` of `epic` or
 * `phase`, or child plan references (the epic shape `swarm:readiness` reads).
 */
function isEpicOrPhaseBrief(plan: Record<string, unknown>): boolean {
  const metadata = plan.metadata;
  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    const kind = (metadata as Record<string, unknown>).kind;
    if (kind === "epic" || kind === "phase") return true;
    if (kind === "story") return false;
  }
  const refs = plan.references;
  return (
    Array.isArray(refs) &&
    refs.some(
      (ref) =>
        typeof ref === "object" &&
        ref !== null &&
        !Array.isArray(ref) &&
        referenceTypeMatches(String((ref as Record<string, unknown>).type ?? ""), "plan"),
    )
  );
}

/** The completion issue of a story brief, or null for epics, phases and unanchored briefs. */
function storyAnchorOf(
  plan: Record<string, unknown>,
): { repository: string; issue: number; key: string } | null {
  if (isEpicOrPhaseBrief(plan)) return null;
  const anchor = resolvePlanGithubIssueRef(plan);
  if (anchor === null) return null;
  return {
    repository: anchor.repository,
    issue: anchor.issueNumber,
    key: `${anchor.repository.toLowerCase()}#${String(anchor.issueNumber)}`,
  };
}

function readPlan(abs: string): Record<string, unknown> | null {
  try {
    return planRecordOf(JSON.parse(readFileSync(abs, "utf8")) as unknown);
  } catch {
    return null;
  }
}

/** Open story briefs (pending/active, xbrief/ and legacy vbrief/) with a completion issue. */
function listOpenStoryBriefs(projectRoot: string): OpenStoryBrief[] {
  const root = resolve(projectRoot);
  const out: OpenStoryBrief[] = [];
  for (const base of SHARED_ISSUE_ROOTS) {
    for (const folder of SHARED_ISSUE_FOLDERS) {
      const dir = join(root, base, folder);
      if (!existsSync(dir)) continue;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names.sort()) {
        if (!name.endsWith(".json")) continue;
        const abs = join(dir, name);
        const plan = readPlan(abs);
        if (plan === null) continue;
        const anchor = storyAnchorOf(plan);
        if (anchor === null) continue;
        out.push({ abs: resolve(abs), rel: `${base}/${folder}/${name}`, ...anchor });
      }
    }
  }
  return out;
}

/**
 * #6934 Bound item 1: for each story brief in `paths`, the other open story briefs
 * (`pending/` and `active/`, legacy `vbrief/` read-accepted) whose first GitHub
 * issue reference (`resolvePlanGithubIssueRef`) names the same repository and
 * issue. Files only, no forge. Epic and phase briefs are not counted, and a
 * subject that is an epic or phase gets no result. One entry per shared issue:
 * a second subject with an issue already reported adds nothing. The #6468 case A
 * ownership check (`storyIssueIdentityMessage`) is separate and unchanged.
 */
export function findSharedStoryIssues(
  projectRoot: string,
  paths: readonly string[],
): SharedStoryIssue[] {
  let open: OpenStoryBrief[] | null = null;
  const seen = new Set<string>();
  const out: SharedStoryIssue[] = [];
  for (const path of paths) {
    const abs = resolve(projectRoot, path);
    const plan = readPlan(abs);
    if (plan === null) continue;
    const anchor = storyAnchorOf(plan);
    if (anchor === null || seen.has(anchor.key)) continue;
    open ??= listOpenStoryBriefs(projectRoot);
    const others = open
      .filter((b) => b.key === anchor.key && b.abs !== abs)
      .map((b) => b.rel)
      .sort();
    if (others.length === 0) continue;
    seen.add(anchor.key);
    out.push({
      repository: anchor.repository,
      issue: anchor.issue,
      rel: briefRelPath(abs, projectRoot),
      others,
    });
  }
  return out;
}

/** #6934 Bound item 2: the warning for one shared completion issue. */
export function formatSharedStoryIssueWarning(shared: SharedStoryIssue): string {
  const n = String(shared.issue);
  return (
    `${shared.rel} shares completion issue ${shared.repository}#${n} (each brief's first ` +
    `GitHub issue reference) with ${shared.others.join(", ")}. Their product PRs would ` +
    `compete for \`deft-story: ${n}\`: only the PR named by \`metadata.productPullRequest\` ` +
    "in its brief on the fetched delivery branch can complete, and an operator attestation " +
    "does not get past another product part. Give each story its own issue as its first " +
    "GitHub issue reference, or carry the work as one story."
  );
}

/** `findSharedStoryIssues` rendered as warning lines, one per shared issue (#6934). */
export function sharedStoryIssueWarnings(projectRoot: string, paths: readonly string[]): string[] {
  return findSharedStoryIssues(projectRoot, paths).map(formatSharedStoryIssueWarning);
}
