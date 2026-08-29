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

/**
 * Reason text for a failed capture, so an overflow is never blank (#1867 / #3903).
 *
 * A spawn-level failure (ENOBUFS past the ceiling, timeout kill, missing
 * binary) reports no exit status and empty stderr, whether it arrives as a
 * `spawnSync` result or as a thrown `execFileSync` error. Only then does the
 * error message stand in for stderr: a process that exited with a status and
 * chose to say nothing keeps its empty stderr.
 */
export function resolveCaptureFailureStderr(capture: {
  readonly captured: string;
  readonly status: number | null | undefined;
  readonly message: string | undefined;
}): string {
  if (capture.captured.trim().length > 0 || typeof capture.status === "number") {
    return capture.captured;
  }
  return capture.message ?? capture.captured;
}
