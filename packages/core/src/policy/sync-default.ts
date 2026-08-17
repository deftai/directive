/**
 * scm:sync-default (#3391 / #3377 Wave 3).
 *
 * Consumes the shared #3388 detector and #3390 syncMaxFiles. Opens dest-targeted
 * sync PRs. Over the file limit, cut at merge commits when possible so each
 * dest-based leg is at or under the threshold. Each leg is a new branch and a
 * new PR. Never retarget or reuse an oversized PR.
 */

import { defaultGitRunner, type GitRunner, gitIsAncestor } from "../session/git.js";
import {
  type BranchSyncDetection,
  detectBranchSync,
  resolveSyncPolicyFromDestRef,
} from "./branch-sync.js";
import { resolveGitDefaultDeliveryBranch } from "./delivery-branch.js";
import { resolveSyncMaxFiles, type SyncMaxFilesProvenance } from "./sync-max-files.js";

export const SYNC_DEFAULT_VERB = "scm:sync-default";
export const FORBIDDEN_SYNC_PR_RETARGET = "gh pr edit --base";

export type SyncDefaultAction = "noop" | "single" | "staged";
export type SyncDefaultNoopReason =
  | "not-sync"
  | "already-synced"
  | "zero-files"
  | "fetch-failed"
  | "diff-failed";
export type SyncDefaultCutKind = "merge" | "commit" | "tip";

export interface SyncDefaultCommit {
  readonly sha: string;
  readonly isMerge: boolean;
}

export interface SyncDefaultLeg {
  readonly index: number;
  readonly sha: string;
  readonly fileCount: number;
  readonly cutKind: SyncDefaultCutKind;
  readonly branchName: string;
}

export interface SyncDefaultPlan {
  readonly action: SyncDefaultAction;
  readonly noopReason: SyncDefaultNoopReason | null;
  readonly dest: string;
  readonly source: string;
  readonly threshold: number;
  readonly provenance: SyncMaxFilesProvenance;
  readonly totalCount: number | null;
  readonly legs: readonly SyncDefaultLeg[];
  readonly nextLegIndex: number | null;
  readonly message: string;
  readonly detectorReason: BranchSyncDetection["reason"];
}

export interface SyncDefaultOpenPull {
  readonly number: number;
  readonly htmlUrl: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
}

export interface SyncDefaultForge {
  listOpenPulls(repo: string, base: string): readonly SyncDefaultOpenPull[];
  createPull(
    repo: string,
    input: {
      readonly title: string;
      readonly head: string;
      readonly base: string;
      readonly body: string;
    },
  ): { readonly number: number; readonly htmlUrl: string };
}

export interface SyncDefaultOpened {
  readonly leg: SyncDefaultLeg;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly branch: string;
  readonly reusedExisting: boolean;
}

export interface SyncDefaultApplyResult {
  readonly plan: SyncDefaultPlan;
  readonly opened: readonly SyncDefaultOpened[];
  readonly retargeted: false;
}

function shortSha(sha: string): string {
  return sha.length >= 7 ? sha.slice(0, 7) : sha;
}

export function syncDefaultBranchName(
  dest: string,
  source: string,
  index: number,
  sha: string,
): string {
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `sync/${safe(dest)}-from-${safe(source)}/leg-${index}-${shortSha(sha)}`;
}

export function parseGithubOwnerRepo(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/i, "");
  const match = /github\.com[:/]([^/]+)\/([^/]+)$/i.exec(trimmed);
  if (match === null) return null;
  const owner = match[1];
  const repo = match[2];
  if (owner === undefined || repo === undefined || owner.length === 0 || repo.length === 0) {
    return null;
  }
  return `${owner}/${repo}`;
}

export function countChangedFilesOnRange(options: {
  readonly projectRoot: string;
  readonly left: string;
  readonly right: string;
  readonly runGit?: GitRunner;
}): { readonly count: number | null; readonly error: string | null } {
  const left = options.left.trim();
  const right = options.right.trim();
  if (left.length === 0 || right.length === 0) {
    return { count: null, error: "empty diff range" };
  }
  const runGit = options.runGit ?? defaultGitRunner;
  const ranged = `${left}...${right}`;
  const diffed = runGit(options.projectRoot, ["diff", "--name-only", ranged]);
  if (diffed.code !== 0) {
    return { count: null, error: diffed.stderr || `git diff failed for ${ranged}` };
  }
  const files = diffed.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return { count: files.length, error: null };
}

export function listCommitsAfter(options: {
  readonly projectRoot: string;
  readonly dest: string;
  readonly source: string;
  readonly runGit?: GitRunner;
}): { readonly commits: readonly SyncDefaultCommit[]; readonly error: string | null } {
  const runGit = options.runGit ?? defaultGitRunner;
  const logged = runGit(options.projectRoot, [
    "log",
    "--reverse",
    "--format=%H%x09%P",
    `origin/${options.dest}..origin/${options.source}`,
  ]);
  if (logged.code !== 0) {
    return { commits: [], error: logged.stderr || "git log failed" };
  }
  const commits: SyncDefaultCommit[] = [];
  for (const line of logged.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const tab = trimmed.indexOf("\t");
    const sha = tab === -1 ? trimmed : trimmed.slice(0, tab);
    const parents = tab === -1 ? "" : trimmed.slice(tab + 1).trim();
    if (sha.length === 0) continue;
    commits.push({
      sha,
      isMerge: parents.split(/\s+/).filter((part) => part.length > 0).length > 1,
    });
  }
  return { commits, error: null };
}

/**
 * Cut dest..source into dest-targeted legs whose dest-based file count is at
 * or under the threshold when a merge (or other) cut exists.
 */
export function cutSyncLegs(options: {
  readonly dest: string;
  readonly source: string;
  readonly destRef: string;
  readonly sourceSha: string;
  readonly commits: readonly SyncDefaultCommit[];
  readonly threshold: number;
  readonly countFiles: (left: string, right: string) => number | null;
}): { readonly legs: readonly SyncDefaultLeg[]; readonly error: string | null } {
  const { dest, source, destRef, sourceSha, commits, threshold, countFiles } = options;
  const legs: SyncDefaultLeg[] = [];
  let left = destRef;
  let guard = 0;
  while (guard < commits.length + 2) {
    guard += 1;
    const remaining = countFiles(left, sourceSha);
    if (remaining === null) {
      return { legs: [], error: `git diff failed for ${left}...${sourceSha}` };
    }
    if (remaining <= threshold) {
      if (left !== sourceSha && remaining > 0) {
        const tip = commits.find((commit) => commit.sha === sourceSha);
        const cutKind: SyncDefaultCutKind =
          legs.length === 0 ? "tip" : tip?.isMerge === true ? "merge" : "tip";
        const index = legs.length + 1;
        legs.push({
          index,
          sha: sourceSha,
          fileCount: remaining,
          cutKind,
          branchName: syncDefaultBranchName(dest, source, index, sourceSha),
        });
      }
      return { legs, error: null };
    }

    const afterLeft =
      left === destRef
        ? commits
        : commits.filter((commit) => {
            const leftIdx = commits.findIndex((row) => row.sha === left);
            const idx = commits.findIndex((row) => row.sha === commit.sha);
            return leftIdx >= 0 ? idx > leftIdx : true;
          });

    let bestMerge: { sha: string; count: number } | null = null;
    let bestCommit: { sha: string; count: number } | null = null;
    for (const commit of afterLeft) {
      const counted = countFiles(left, commit.sha);
      if (counted === null) {
        return { legs: [], error: `git diff failed for ${left}...${commit.sha}` };
      }
      if (counted <= threshold) {
        bestCommit = { sha: commit.sha, count: counted };
        if (commit.isMerge) bestMerge = { sha: commit.sha, count: counted };
      }
    }

    const chosen =
      bestMerge ??
      bestCommit ??
      (afterLeft[0]
        ? {
            sha: afterLeft[0].sha,
            count: countFiles(left, afterLeft[0].sha),
          }
        : null);
    if (chosen === null || chosen.count === null) {
      return { legs: [], error: "no commit to cut after dest" };
    }
    const cutKind: SyncDefaultCutKind =
      bestMerge !== null && chosen.sha === bestMerge.sha ? "merge" : "commit";
    const index = legs.length + 1;
    legs.push({
      index,
      sha: chosen.sha,
      fileCount: chosen.count,
      cutKind,
      branchName: syncDefaultBranchName(dest, source, index, chosen.sha),
    });
    if (chosen.sha === sourceSha) return { legs, error: null };
    left = chosen.sha;
  }
  return { legs: [], error: "cut loop exceeded commit count" };
}

function formatPlanMessage(plan: Omit<SyncDefaultPlan, "message">): string {
  if (plan.action === "noop") {
    if (plan.noopReason === "not-sync") {
      return `scm:sync-default: no-op (detector=${plan.detectorReason})`;
    }
    if (plan.noopReason === "already-synced") {
      return `scm:sync-default: no-op (origin/${plan.source} already on origin/${plan.dest})`;
    }
    if (plan.noopReason === "zero-files") {
      return `scm:sync-default: no-op (0 files origin/${plan.dest}...origin/${plan.source})`;
    }
    if (plan.noopReason === "fetch-failed") {
      return "scm:sync-default: fetch failed";
    }
    return `scm:sync-default: no-op (${plan.noopReason ?? "unknown"})`;
  }
  if (plan.action === "single") {
    return (
      `scm:sync-default: one new PR origin/${plan.source} -> origin/${plan.dest} ` +
      `(${plan.totalCount ?? "?"} files, syncMaxFiles=${plan.threshold} ${plan.provenance})`
    );
  }
  const next = plan.nextLegIndex ?? 1;
  return (
    `scm:sync-default: staged ${plan.legs.length} new-PR legs; ` +
    `next is leg ${next} (each leg is a new branch + new PR; never ${FORBIDDEN_SYNC_PR_RETARGET})`
  );
}

export function planSyncDefault(options: {
  readonly projectRoot: string;
  readonly maxFiles?: number | null;
  readonly destTipSha?: string;
  readonly runGit?: GitRunner;
}): SyncDefaultPlan {
  const runGit = options.runGit ?? defaultGitRunner;
  const guessedDest = resolveGitDefaultDeliveryBranch(options.projectRoot, runGit);
  const policy = resolveSyncPolicyFromDestRef({
    projectRoot: options.projectRoot,
    prBase: guessedDest,
    runGit,
  });
  const dest = policy.dest;
  const source = policy.source;
  const resolved = resolveSyncMaxFiles(options.projectRoot, options.maxFiles);
  const empty = (
    extra: Partial<SyncDefaultPlan> &
      Pick<SyncDefaultPlan, "action" | "noopReason" | "detectorReason">,
  ): SyncDefaultPlan => {
    const base = {
      dest,
      source,
      threshold: resolved.maxFiles,
      provenance: resolved.provenance,
      totalCount: extra.totalCount ?? null,
      legs: extra.legs ?? [],
      nextLegIndex: extra.nextLegIndex ?? null,
      ...extra,
    };
    return { ...base, message: formatPlanMessage(base) };
  };

  const fetchedSource = runGit(options.projectRoot, ["fetch", "--quiet", "origin", source]);
  if (fetchedSource.code !== 0) {
    return empty({
      action: "noop",
      noopReason: "fetch-failed",
      detectorReason: "fetch-failed",
    });
  }
  const tipParsed = runGit(options.projectRoot, ["rev-parse", "--verify", `origin/${source}`]);
  if (tipParsed.code !== 0 || tipParsed.stdout.trim().length === 0) {
    return empty({
      action: "noop",
      noopReason: "fetch-failed",
      detectorReason: "fetch-failed",
    });
  }
  const sourceSha = tipParsed.stdout.trim();
  const destParsed = runGit(options.projectRoot, ["rev-parse", "--verify", `origin/${dest}`]);
  const destSha = destParsed.code === 0 ? destParsed.stdout.trim() : "";
  const destTip = options.destTipSha ?? destSha;

  const sync = detectBranchSync({
    dest,
    source,
    sourceTyped: policy.sourceTyped,
    prBase: dest,
    headSha: sourceSha,
    projectRoot: options.projectRoot,
    developHint: policy.developHint,
    runGit,
  });
  if (!sync.isSync) {
    return empty({
      action: "noop",
      noopReason: sync.reason === "fetch-failed" ? "fetch-failed" : "not-sync",
      detectorReason: sync.reason,
    });
  }

  if (
    destTip.length > 0 &&
    gitIsAncestor(options.projectRoot, sourceSha, destTip, runGit) === true
  ) {
    return empty({
      action: "noop",
      noopReason: "already-synced",
      detectorReason: "sync",
    });
  }

  const destRef = `origin/${dest}`;
  const total = countChangedFilesOnRange({
    projectRoot: options.projectRoot,
    left: destRef,
    right: `origin/${source}`,
    runGit,
  });
  if (total.count === null) {
    return empty({
      action: "noop",
      noopReason: "diff-failed",
      detectorReason: "sync",
    });
  }
  if (total.count === 0) {
    return empty({
      action: "noop",
      noopReason: "zero-files",
      detectorReason: "sync",
      totalCount: 0,
    });
  }

  const listed = listCommitsAfter({
    projectRoot: options.projectRoot,
    dest,
    source,
    runGit,
  });
  if (listed.error !== null) {
    return empty({
      action: "noop",
      noopReason: "diff-failed",
      detectorReason: "sync",
      totalCount: total.count,
    });
  }

  const cut = cutSyncLegs({
    dest,
    source,
    destRef,
    sourceSha,
    commits: listed.commits,
    threshold: resolved.maxFiles,
    countFiles: (left, right) =>
      countChangedFilesOnRange({
        projectRoot: options.projectRoot,
        left,
        right,
        runGit,
      }).count,
  });
  if (cut.error !== null || cut.legs.length === 0) {
    return empty({
      action: "noop",
      noopReason: "diff-failed",
      detectorReason: "sync",
      totalCount: total.count,
    });
  }

  const next = nextOpenableLeg(cut.legs, destTip, options.projectRoot, runGit);
  const action: SyncDefaultAction = cut.legs.length === 1 ? "single" : "staged";
  return empty({
    action,
    noopReason: null,
    detectorReason: "sync",
    totalCount: total.count,
    legs: cut.legs,
    nextLegIndex: next?.index ?? null,
  });
}

export function nextOpenableLeg(
  legs: readonly SyncDefaultLeg[],
  destTipSha: string,
  projectRoot: string,
  runGit: GitRunner,
): SyncDefaultLeg | null {
  for (const leg of legs) {
    if (destTipSha.length > 0 && gitIsAncestor(projectRoot, leg.sha, destTipSha, runGit) === true) {
      continue;
    }
    return leg;
  }
  return null;
}

function matchingOpenPull(
  pulls: readonly SyncDefaultOpenPull[],
  dest: string,
  leg: SyncDefaultLeg,
): SyncDefaultOpenPull | null {
  for (const pull of pulls) {
    if (pull.baseRef !== dest) continue;
    if (pull.headSha === leg.sha || pull.headRef === leg.branchName) return pull;
  }
  return null;
}

export function applySyncDefault(options: {
  readonly projectRoot: string;
  readonly repo: string;
  readonly plan?: SyncDefaultPlan;
  readonly maxFiles?: number | null;
  readonly destTipSha?: string;
  readonly dryRun?: boolean;
  readonly runGit?: GitRunner;
  readonly forge?: SyncDefaultForge;
}): SyncDefaultApplyResult {
  const runGit = options.runGit ?? defaultGitRunner;
  const plan =
    options.plan ??
    planSyncDefault({
      projectRoot: options.projectRoot,
      maxFiles: options.maxFiles,
      destTipSha: options.destTipSha,
      runGit,
    });
  if (plan.action === "noop" || plan.legs.length === 0) {
    return { plan, opened: [], retargeted: false };
  }
  const destParsed = runGit(options.projectRoot, ["rev-parse", "--verify", `origin/${plan.dest}`]);
  const destTip = options.destTipSha ?? (destParsed.code === 0 ? destParsed.stdout.trim() : "");
  const next = nextOpenableLeg(plan.legs, destTip, options.projectRoot, runGit);
  if (next === null) {
    return { plan, opened: [], retargeted: false };
  }
  if (options.dryRun === true || options.forge === undefined) {
    return { plan, opened: [], retargeted: false };
  }

  const openPulls = options.forge.listOpenPulls(options.repo, plan.dest);
  const existing = matchingOpenPull(openPulls, plan.dest, next);
  if (existing !== null) {
    return {
      plan,
      opened: [
        {
          leg: next,
          prNumber: existing.number,
          prUrl: existing.htmlUrl,
          branch: existing.headRef,
          reusedExisting: true,
        },
      ],
      retargeted: false,
    };
  }

  const pushed = runGit(options.projectRoot, [
    "push",
    "--quiet",
    "origin",
    `${next.sha}:refs/heads/${next.branchName}`,
  ]);
  if (pushed.code !== 0) {
    throw new Error(pushed.stderr || `git push failed for ${next.branchName}`);
  }

  const created = options.forge.createPull(options.repo, {
    title: `sync: ${plan.source} -> ${plan.dest} (leg ${next.index}/${plan.legs.length})`,
    head: next.branchName,
    base: plan.dest,
    body: syncDefaultPrBody(plan, next),
  });
  return {
    plan,
    opened: [
      {
        leg: next,
        prNumber: created.number,
        prUrl: created.htmlUrl,
        branch: next.branchName,
        reusedExisting: false,
      },
    ],
    retargeted: false,
  };
}

export function syncDefaultPrBody(plan: SyncDefaultPlan, leg: SyncDefaultLeg): string {
  return [
    `Staged dest sync via \`${SYNC_DEFAULT_VERB}\`.`,
    "",
    `- Dest: \`${plan.dest}\` (deliveryBranch)`,
    `- Source: \`${plan.source}\` (typed baseBranch)`,
    `- Leg ${leg.index} of ${plan.legs.length} at \`${leg.sha}\` (${leg.fileCount} files, cut=${leg.cutKind})`,
    `- Threshold: syncMaxFiles=${plan.threshold} (${plan.provenance})`,
    "",
    "This PR is new. After it merges, run `task scm:sync-default` again.",
    "The next leg is a new branch and a new PR. Do not retarget or reuse an oversized PR",
    `(\`${FORBIDDEN_SYNC_PR_RETARGET}\` / close-reopen). Each leg must be new when the reviewer first sees it.`,
    "",
    "Required checks stay on. The only exemption is the Wave 1 core-guard sync predicate.",
  ].join("\n");
}

export function formatSyncDefaultHuman(result: SyncDefaultApplyResult): string {
  const lines = [result.plan.message];
  for (const opened of result.opened) {
    const reuse = opened.reusedExisting ? "existing" : "new";
    lines.push(
      `  ${reuse} PR #${opened.prNumber} ${opened.prUrl} (${opened.branch} @ ${shortSha(opened.leg.sha)})`,
    );
  }
  if (result.plan.action === "staged" && result.opened.length > 0) {
    lines.push("  remaining legs open as new PRs after this one merges");
  }
  return `${lines.join("\n")}\n`;
}
