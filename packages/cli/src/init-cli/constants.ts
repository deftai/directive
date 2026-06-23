/** Canonical headless install argv (#1339 / #1409 / getting-started.md). */
export const CANONICAL_INIT_ARGV = ["--yes", "--repo-root", ".", "--json"] as const;

/** Canonical headless upgrade argv (#1339 / #1409). */
export const CANONICAL_UPDATE_ARGV = ["--yes", "--upgrade", "--repo-root", ".", "--json"] as const;
