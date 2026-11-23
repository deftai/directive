/**
 * Skip PR-context and change-set checks on a GitHub `merge_group` run
 * (#6295 item 2, #6296 item 6, #7147).
 *
 * `task check:merge` runs on PRs and on the merge queue's group commit. Five
 * checks skip themselves on the group commit; every other check in
 * `check:merge` still runs there.
 *
 * PR-context checks (closing keywords, scope provenance, intent constraint)
 * need a PR number and body, which a `merge_group` run does not carry. They run
 * on the PR head and body at the PR's last CI run, which is the same assurance
 * a direct merge of an up-to-date PR has.
 *
 * Change-set checks (`verify:changelog-unreleased` #6296, `verify:class-checks`
 * #7147) judge one PR's own change set against the merge base. On a group
 * commit that change set also holds every PR queued ahead, so a pure protected
 * landing queued behind product (or product behind a mint) would fail class 4
 * although its own diff passed on its head. They run on the PR head instead.
 *
 * What is given up on the queue commit:
 * - nothing re-checks the changelog; the entry requirement and the release
 *   rule were judged on the PR at its last CI run;
 * - nothing re-runs class checks, so a PR whose last CI predates newer
 *   class-check code or defaults on master is not judged against them
 *   (`strict: false`), and a file that becomes a class-1 or class-3 hit only
 *   when two queued PRs both edit it is not caught there.
 * This matches what a direct merge of a PR that is not up to date had before
 * the queue.
 *
 * The skip key is the `GITHUB_EVENT_NAME` the caller supplies. It is trusted
 * caller input, not proof that the check ran anywhere.
 *
 * Re-entry trigger (#7147): if another gate that is not PR-context needs a
 * `merge_group` carve-out, replace the change-set skips with one shared
 * per-entry base (`merge_group.base_sha`, checked as an ancestor of HEAD,
 * passed through the existing `--base-ref`), not another skip.
 */

/** GitHub Actions event name for merge-queue group runs. */
export const MERGE_GROUP_EVENT = "merge_group" as const;

/** Checks skipped on `merge_group`: three PR-context, then two change-set. */
export const MERGE_GROUP_SKIPPED_CHECKS = [
  "verify:closing-keywords",
  "verify:scope-provenance",
  "verify:intent-constraint",
  "verify:changelog-unreleased",
  "verify:class-checks",
] as const;

export type MergeGroupSkippedCheck = (typeof MERGE_GROUP_SKIPPED_CHECKS)[number];

/** Skipped checks that judge a change set, not PR context (#7147). */
export const MERGE_GROUP_CHANGE_SET_CHECKS: readonly MergeGroupSkippedCheck[] = [
  "verify:changelog-unreleased",
  "verify:class-checks",
];

/** True when this process runs inside a GitHub Actions `merge_group` workflow. */
export function isMergeGroupEvent(env: Readonly<Record<string, string | undefined>>): boolean {
  return (env.GITHUB_EVENT_NAME ?? "").trim() === MERGE_GROUP_EVENT;
}

/** One-line notice printed instead of running the check. */
export function mergeGroupSkipNotice(check: MergeGroupSkippedCheck): string {
  if (MERGE_GROUP_CHANGE_SET_CHECKS.includes(check)) {
    return (
      `${check}: skipped on merge_group (#7147) -- change-set check; ` +
      "on a group commit the change set holds every PR queued ahead, " +
      "so this check runs on the PR head instead."
    );
  }
  return (
    `${check}: skipped on merge_group (#6295) -- PR-context check; ` +
    "it ran on the PR head and body at the PR's last CI run."
  );
}

/**
 * Return the skip notice when `check` should be skipped for this env, else null.
 * Callers print the notice and exit 0.
 */
export function mergeGroupSkip(
  check: MergeGroupSkippedCheck,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  return isMergeGroupEvent(env) ? mergeGroupSkipNotice(check) : null;
}
