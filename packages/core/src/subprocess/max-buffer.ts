/**
 * Shared stdout ceiling for subprocess captures of `gh` / git output.
 *
 * Node's `spawnSync` / `execFileSync` default to a 1 MB stdout buffer. A
 * `gh api --paginate` response that concatenates every page (e.g. a repo's
 * full release or issue list) routinely exceeds 1 MB. When it does, the
 * capture aborts with `error.code === "ENOBUFS"`, a `null` status, truncated
 * stdout, and an EMPTY stderr -- surfacing downstream as a failure with no
 * detail (#1867: `task release:publish` / `release:rollback` and consumer
 * `task triage:scope -- --diff-from-upstream`).
 *
 * Every `gh` / git capture site MUST pass this ceiling so large responses
 * succeed, and MUST surface `result.error.message` when stderr is empty so an
 * overflow is never silent again.
 */
export const GH_MAX_BUFFER = 64 * 1024 * 1024;
