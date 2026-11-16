/**
 * Close proof for in-PR completion (#6277 Bound 4 / 5).
 *
 * A `completed/` brief stamped `lands-with-product` carries no delivered
 * provenance. Its completion proof is the human product merge plus today's
 * identity join, run on the commit that landed the brief on the delivery tip:
 * find that commit, resolve the pull request whose merge commit it is, and run
 * `verifyStoryPrMergeIdentity` with that commit as the merge commit. A failed
 * join, or a landing commit with no pull request (a direct commit), fails.
 */
import { defaultRunGh } from "../pr-protected-issues/gh.js";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import {
  defaultFetchPrChangedFiles,
  defaultFetchPrPayload,
  defaultMergeTimeForge,
  type FetchPrChangedFilesFn,
  type FetchPrPayloadFn,
  type MergeTimeForge,
  resolvePlanGithubIssueRef,
  type StoryPrIdentityBasis,
  verifyStoryPrMergeIdentity,
} from "../scope/delivery-evidence.js";
import { isLandsWithProductPlan } from "../scope/lifecycle-write.js";
import { defaultGitRunner, type GitRunner, showBlobsBatch } from "../session/git.js";

/** Recovery named by a failed lands-with-product close proof. */
export const LANDS_WITH_PRODUCT_RECOVERY =
  "Recovery: complete the story through the post-merge path instead: restore the brief to " +
  "active/ in a lifecycle PR, then run `task scope:complete -- <active-path> --pr <n> " +
  "--merge-commit <sha>` (or `task swarm:finalize-cohort`) and land it (#6277 / #6303).";

/** Resolve merged PRs whose merge commit is `sha`; null on lookup failure. */
export type ResolveLandingPullRequestsFn = (sha: string, repository: string) => number[] | null;

export interface LandsWithProductProofInput {
  readonly projectRoot: string;
  /** Delivery tip ref (e.g. origin/master). */
  readonly tip: string;
  /** Repo-relative path of the completed brief on the tip. */
  readonly briefRel: string;
  readonly plan: Record<string, unknown>;
  readonly runGit?: GitRunner;
  readonly runGh?: RunGhFn;
  readonly resolveLandingPullRequests?: ResolveLandingPullRequestsFn;
  readonly fetchPrPayload?: FetchPrPayloadFn;
  readonly fetchPrChangedFiles?: FetchPrChangedFilesFn;
  readonly mergeTimeForge?: MergeTimeForge;
}

export type LandsWithProductProof =
  | {
      readonly ok: true;
      readonly landingCommit: string;
      readonly prNumber: number;
      readonly identityBasis: StoryPrIdentityBasis | undefined;
    }
  | { readonly ok: false; readonly message: string };

/** Pluggable proof, so callers and tests can inject the forge-backed join. */
export type ProveLandsWithProductFn = (input: LandsWithProductProofInput) => LandsWithProductProof;

/**
 * The commit that added `briefRel` on the delivery tip's first-parent history
 * (a merge is diffed against its first parent; renames count as adds).
 */
export function findLandingCommit(
  projectRoot: string,
  tip: string,
  briefRel: string,
  runGit: GitRunner = defaultGitRunner,
): string | null {
  const result = runGit(projectRoot, [
    "log",
    tip,
    "--first-parent",
    "-m",
    "--no-renames",
    "--diff-filter=A",
    "--format=%H",
    "-1",
    "--",
    briefRel,
  ]);
  if (result.code !== 0) return null;
  const sha = result.stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
  return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null;
}

/** Merged PRs whose `merge_commit_sha` is `sha` (REST `commits/{sha}/pulls`). */
export function defaultResolveLandingPullRequests(
  sha: string,
  repository: string,
  runGh: RunGhFn = defaultRunGh,
): number[] | null {
  const [owner, name] = repository.split("/");
  if (owner === undefined || name === undefined || owner === "" || name === "") return null;
  let result: ReturnType<RunGhFn>;
  try {
    result = runGh([
      "gh",
      "api",
      `repos/${owner}/${name}/commits/${sha}/pulls`,
      "--jq",
      `.[] | select(.merged_at != null and .merge_commit_sha == "${sha}") | .number`,
    ]);
  } catch {
    return null;
  }
  if (result.returncode !== 0) return null;
  const out: number[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const n = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

function fail(briefRel: string, reason: string): LandsWithProductProof {
  return {
    ok: false,
    message:
      `lands-with-product brief ${briefRel} failed its close proof (#6277): ${reason}. ` +
      LANDS_WITH_PRODUCT_RECOVERY,
  };
}

/**
 * Bound 4: prove a `lands-with-product` completion from the commit that landed
 * the brief on the delivery tip.
 */
export function proveLandsWithProductCompletion(
  input: LandsWithProductProofInput,
): LandsWithProductProof {
  const runGit = input.runGit ?? defaultGitRunner;
  const runGh = input.runGh ?? defaultRunGh;
  const issue = resolvePlanGithubIssueRef(input.plan);
  if (issue === null) {
    return fail(input.briefRel, "the brief has no GitHub issue reference");
  }
  const landing = findLandingCommit(input.projectRoot, input.tip, input.briefRel, runGit);
  if (landing === null) {
    return fail(input.briefRel, `no commit on ${input.tip} adds ${input.briefRel}`);
  }
  const resolvePrs =
    input.resolveLandingPullRequests ??
    ((sha: string, repository: string) =>
      defaultResolveLandingPullRequests(sha, repository, runGh));
  const prs = resolvePrs(landing, issue.repository);
  if (prs === null) {
    return fail(input.briefRel, `could not resolve the pull request of landing commit ${landing}`);
  }
  if (prs.length !== 1) {
    return fail(
      input.briefRel,
      prs.length === 0
        ? `landing commit ${landing} is not the merge commit of any pull request (direct commit)`
        : `landing commit ${landing} is the merge commit of several pull requests (${prs.join(", ")})`,
    );
  }
  const prNumber = prs[0] as number;
  const injected = input.fetchPrPayload !== undefined;
  const identity = verifyStoryPrMergeIdentity({
    plan: input.plan,
    evidence: { prNumber, repository: issue.repository },
    mergeCommit: landing,
    fetchPrPayload:
      input.fetchPrPayload ??
      ((n: number, repository: string) => defaultFetchPrPayload(n, repository, runGh)),
    mergeTimeForge: input.mergeTimeForge ?? (injected ? undefined : defaultMergeTimeForge(runGh)),
    briefBasename: input.briefRel.split("/").pop() ?? "",
    fetchPrChangedFiles:
      input.fetchPrChangedFiles ??
      (injected
        ? undefined
        : (n: number, repository: string) => defaultFetchPrChangedFiles(n, repository, runGh)),
  });
  if (!identity.ok) {
    return fail(input.briefRel, `PR #${String(prNumber)}: ${identity.message}`);
  }
  return { ok: true, landingCommit: landing, prNumber, identityBasis: identity.identityBasis };
}

/** A lands-with-product brief read from the delivery tip. */
export interface TipLandsWithProductBrief {
  readonly rel: string;
  readonly plan: Record<string, unknown>;
}

function parsePlan(raw: string | null | undefined): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try {
    const data = JSON.parse(raw) as unknown;
    const plan = (data as { plan?: unknown } | null)?.plan;
    return typeof plan === "object" && plan !== null && !Array.isArray(plan)
      ? (plan as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Lands-with-product briefs among already-read tip blobs. */
export function landsWithProductBriefsFromBlobs(
  paths: readonly string[],
  bodies: ReadonlyMap<string, string | null>,
): TipLandsWithProductBrief[] {
  const out: TipLandsWithProductBrief[] = [];
  for (const rel of paths) {
    if (!/^(?:xbrief|vbrief)\/completed\/[^/]+$/.test(rel)) continue;
    const plan = parsePlan(bodies.get(rel));
    if (plan !== null && isLandsWithProductPlan(plan)) {
      out.push({ rel, plan });
    }
  }
  return out;
}

/** List lands-with-product briefs under `completed/` on the delivery tip. */
export function listTipLandsWithProductBriefs(
  projectRoot: string,
  tip: string,
  runGit: GitRunner = defaultGitRunner,
): TipLandsWithProductBrief[] {
  const listed = runGit(projectRoot, [
    "ls-tree",
    "-r",
    "--name-only",
    tip,
    "--",
    "xbrief/completed",
    "vbrief/completed",
  ]);
  if (listed.code !== 0) return [];
  const paths = listed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, "/"))
    .filter((line) => line.endsWith(".xbrief.json") || line.endsWith(".vbrief.json"));
  if (paths.length === 0) return [];
  return landsWithProductBriefsFromBlobs(paths, showBlobsBatch(projectRoot, tip, paths, runGit));
}
