import { formatFrameworkCommand } from "../render/framework-commands.js";

const CACHE_FETCH_SOURCE = "github-issue";

/**
 * Format a consumer-runnable `deft cache fetch-all` recovery command (#2574).
 *
 * Uses the space-separated CLI surface (not the colon task alias) and always
 * includes required `--source` / `--repo` flags so following the hint literally
 * reaches the handler instead of `unknown verb 'cache:fetch-all'`.
 */
export function formatCacheFetchAllRecoveryCommand(
  repo: string | null,
  options: { force?: boolean } = {},
): string {
  const repoSlug = repo ?? "OWNER/NAME";
  const args = ["cache", "fetch-all", "--source", CACHE_FETCH_SOURCE, "--repo", repoSlug];
  if (options.force) {
    args.push("--force");
  }
  return formatFrameworkCommand(args);
}

/**
 * Branch-aware recovery hint (#1953 Option 3, #2574 argv fix).
 * Age-stale (or age+drift mixed) → --force bypasses TTL; drift-only → plain refetch.
 */
export function recoveryHintForStaleFailure(
  causes: Readonly<{ ageStale: boolean; driftDetected: boolean }>,
  repo: string | null = null,
): string {
  const command = formatCacheFetchAllRecoveryCommand(repo, { force: causes.ageStale });
  return `  Recovery: run \`${command}\` to refresh and reconcile upstream state.`;
}
