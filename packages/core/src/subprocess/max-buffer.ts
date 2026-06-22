/**
 * Shared stdout ceiling for subprocess captures whose output can be large.
 *
 * Node's `spawnSync` / `execFileSync` default to a 1 MB stdout buffer. A
 * `gh api --paginate` response that concatenates every page (e.g. a repo's
 * full release or issue list), and other potentially large captures (a
 * `uv run python` gate, a spawned Node helper), routinely exceed 1 MB. When
 * they do, the capture aborts with `error.code === "ENOBUFS"`, a `null`
 * status, truncated stdout, and an EMPTY stderr -- surfacing downstream as a
 * failure with no detail (#1867: `task release:publish` / `release:rollback`
 * and consumer `task triage:scope -- --diff-from-upstream`).
 *
 * Every subprocess capture site that may produce a large response MUST pass
 * this ceiling, and MUST surface `result.error.message` when stderr is empty
 * so an overflow is never silent again.
 */
export const SUBPROCESS_MAX_BUFFER = 64 * 1024 * 1024;
