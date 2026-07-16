import { resolveRepo } from "../triage/queue/repo.js";

export interface RepoMutateGuardOptions {
  readonly allowCrossRepo?: boolean;
  readonly allowlist?: readonly string[];
  readonly explicitRepo?: string | null;
}

/** Normalize owner/name slugs for case-insensitive comparison. */
export function normalizeRepoSlug(repo: string): string {
  return repo.trim().toLowerCase();
}

/**
 * Fail-closed gate before SCM label/comment mutations (#2601).
 * Cross-repo targets are refused unless explicitly opted in or allowlisted.
 */
export function isRepoMutationAllowed(
  targetRepo: string,
  projectRoot: string,
  options: RepoMutateGuardOptions = {},
): { readonly allowed: boolean; readonly projectRepo: string | null; readonly reason?: string } {
  const projectRepo = resolveRepo(options.explicitRepo ?? null, projectRoot);
  if (options.allowCrossRepo) {
    return { allowed: true, projectRepo };
  }
  const normalizedTarget = normalizeRepoSlug(targetRepo);
  for (const entry of options.allowlist ?? []) {
    if (normalizeRepoSlug(entry) === normalizedTarget) {
      return { allowed: true, projectRepo };
    }
  }
  if (projectRepo !== null && normalizeRepoSlug(projectRepo) === normalizedTarget) {
    return { allowed: true, projectRepo };
  }
  const hint =
    projectRepo !== null
      ? `(project repo: ${projectRepo})`
      : "(project repo unknown — set --repo or git remote origin)";
  return {
    allowed: false,
    projectRepo,
    reason: `refusing cross-repo mutation on ${targetRepo} ${hint}`,
  };
}
