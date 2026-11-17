/**
 * One story, one line (#6468). The story issue of a brief is the issue the
 * completion identity join anchors on (`resolvePlanGithubIssueRef`). The
 * closing-keywords story-line check and `--write-story-line` ask for one line,
 * for that issue, and check it against the owner list the plan-id adopter uses.
 */
import { relative, resolve } from "node:path";
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
