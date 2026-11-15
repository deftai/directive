/**
 * Skip PR-context checks on a GitHub `merge_group` run (#6295 item 2).
 *
 * `task check:merge` runs on PRs and on the merge queue's group commit. The
 * PR-context checks (closing keywords, scope provenance, intent constraint)
 * need a PR number and body, which a `merge_group` run does not carry. They
 * already ran on the PR head and body at the PR's last CI run, which is the
 * same assurance a direct merge of an up-to-date PR has. Every other check in
 * `check:merge` still runs on the group commit.
 */

/** GitHub Actions event name for merge-queue group runs. */
export const MERGE_GROUP_EVENT = "merge_group" as const;

/** PR-context checks skipped on `merge_group` (item 2). */
export const MERGE_GROUP_SKIPPED_CHECKS = [
  "verify:closing-keywords",
  "verify:scope-provenance",
  "verify:intent-constraint",
] as const;

export type MergeGroupSkippedCheck = (typeof MERGE_GROUP_SKIPPED_CHECKS)[number];

/** True when this process runs inside a GitHub Actions `merge_group` workflow. */
export function isMergeGroupEvent(env: Readonly<Record<string, string | undefined>>): boolean {
  return (env.GITHUB_EVENT_NAME ?? "").trim() === MERGE_GROUP_EVENT;
}

/** One-line notice printed instead of running the check. */
export function mergeGroupSkipNotice(check: MergeGroupSkippedCheck): string {
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
