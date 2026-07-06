import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readCorePackageVersion } from "../engine-version.js";
import { inferRepoFromGit } from "../triage/queue/repo.js";

/** Record-shape version for attribution ledger entries (#2376). Bump on shape changes. */
export const ATTRIBUTION_SCHEMA_VERSION = 1 as const;

/** Project-local, gitignored install-identity file. */
export const INSTALL_ID_REL = join(".deft-cache", "install-id");

/** Identity + provenance fields stamped onto every attribution record (#2376). */
export interface AttributionEnrichment {
  /** Normalized `owner/name` of the origin remote, or null when unavailable. */
  readonly repo: string | null;
  /** directive engine version at emit time. */
  readonly directive_version: string;
  /** Stable per-checkout uuid, or null when it cannot be read/created. */
  readonly install_id: string | null;
  /** Attribution record-shape version. */
  readonly schema_version: number;
}

/**
 * Read-or-create a stable per-checkout install id in `.deft-cache/install-id`.
 * Best-effort: returns null (never throws) if the file cannot be read or written.
 */
export function resolveInstallId(projectRoot: string): string | null {
  const path = resolve(projectRoot, INSTALL_ID_REL);
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, "utf8").trim();
      if (existing.length > 0) {
        return existing;
      }
    }
  } catch {
    // fall through and try to (re)create
  }
  try {
    const id = randomUUID();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${id}\n`, "utf8");
    return id;
  } catch {
    return null;
  }
}

export interface BuildAttributionEnrichmentOptions {
  /** Test seam for origin-repo resolution; defaults to `inferRepoFromGit`. */
  readonly repoResolver?: (projectRoot: string) => string | null;
}

/**
 * Build the identity/provenance enrichment stamped on attribution records (#2376).
 * Every field degrades gracefully; this function never throws.
 */
export function buildAttributionEnrichment(
  projectRoot: string,
  options: BuildAttributionEnrichmentOptions = {},
): AttributionEnrichment {
  const resolver = options.repoResolver ?? inferRepoFromGit;
  let repo: string | null = null;
  try {
    repo = resolver(projectRoot);
  } catch {
    repo = null;
  }
  return {
    repo,
    directive_version: readCorePackageVersion(),
    install_id: resolveInstallId(projectRoot),
    schema_version: ATTRIBUTION_SCHEMA_VERSION,
  };
}
