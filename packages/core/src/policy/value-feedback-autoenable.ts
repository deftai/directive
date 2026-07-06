import { inferRepoFromGit } from "../triage/queue/repo.js";

/**
 * Company-owned GitHub orgs whose repos auto-enable LOCAL value-feedback
 * collection (#2376). Org membership is the consent for local, no-egress
 * collection; network/upstream surfaces stay opt-in regardless.
 */
export const DEFAULT_AUTOENABLE_ORGS: readonly string[] = ["deftai"];

/** Optional comma-separated env override that EXTENDS the built-in trusted-org set. */
export const AUTOENABLE_ORGS_ENV = "DEFT_VALUE_AUTOENABLE_ORGS";

/** Built-in trusted orgs plus any from the env override, normalized to lowercase. */
export function resolveTrustedOrgs(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const orgs = new Set<string>(DEFAULT_AUTOENABLE_ORGS.map((o) => o.toLowerCase()));
  const raw = env[AUTOENABLE_ORGS_ENV];
  if (typeof raw === "string") {
    for (const part of raw.split(",")) {
      const trimmed = part.trim().toLowerCase();
      if (trimmed.length > 0) {
        orgs.add(trimmed);
      }
    }
  }
  return orgs;
}

const originOrgCache = new Map<string, string | null>();

/** Test/hygiene hook: drop the memoized origin-org lookups. */
export function clearOriginOrgCache(): void {
  originOrgCache.clear();
}

export interface OriginOrgOptions {
  /** Test seam for origin-repo resolution; defaults to `inferRepoFromGit`. */
  readonly repoResolver?: (projectRoot: string) => string | null;
  /** Override caching; defaults to caching only when no custom resolver is supplied. */
  readonly useCache?: boolean;
}

/**
 * Lowercased owner of the origin remote for `projectRoot`, or null when there is
 * no remote / not a git checkout. Memoized per projectRoot (the org does not
 * change within a session) to keep the resolver off the hot emit path.
 */
export function detectOriginOrg(
  projectRoot: string,
  options: OriginOrgOptions = {},
): string | null {
  const useCache = options.useCache ?? options.repoResolver === undefined;
  if (useCache && originOrgCache.has(projectRoot)) {
    return originOrgCache.get(projectRoot) ?? null;
  }
  const resolver = options.repoResolver ?? inferRepoFromGit;
  let org: string | null = null;
  try {
    const repo = resolver(projectRoot);
    if (typeof repo === "string") {
      const owner = repo.split("/")[0]?.trim().toLowerCase() ?? "";
      org = owner.length > 0 ? owner : null;
    }
  } catch {
    org = null;
  }
  if (useCache) {
    originOrgCache.set(projectRoot, org);
  }
  return org;
}

export interface OrgAutoEnableOptions extends OriginOrgOptions {
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * True when `projectRoot`'s origin org is in the trusted-org set (#2376).
 * Fail-safe: any resolution failure (no remote, non-GitHub, git absent) is false.
 */
export function isTrustedOrgAutoEnable(
  projectRoot: string,
  options: OrgAutoEnableOptions = {},
): boolean {
  const org = detectOriginOrg(projectRoot, options);
  if (org === null) {
    return false;
  }
  return resolveTrustedOrgs(options.env).has(org);
}
