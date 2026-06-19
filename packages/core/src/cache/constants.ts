/** Default on-disk cache root (mirrors `scripts/cache.py`). */
export const DEFAULT_CACHE_ROOT = ".deft-cache";

export const AUDIT_LOG_NAME = "quarantine-audit.jsonl";

/** Hard-coded TTLs per source type (v1 ships github-issue only). */
export const SOURCE_TTL_SECONDS: Readonly<Record<string, number>> = {
  "github-issue": 7 * 24 * 60 * 60,
};

export const ALLOWED_SOURCES = Object.freeze(Object.keys(SOURCE_TTL_SECONDS)) as readonly string[];

export const GH_KEY_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)\/(\d+)$/;

export const REPO_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;

export const DEFAULT_BATCH_SIZE = 10;
export const DEFAULT_DELAY_MS = 0;
export const DEFAULT_PRUNE_OLDER_THAN_DAYS = 30;
