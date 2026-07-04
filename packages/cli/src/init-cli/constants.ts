/** Canonical headless install argv (#1339 / #1409 / getting-started.md). */
export const CANONICAL_INIT_ARGV = ["--yes", "--repo-root", ".", "--json"] as const;

/** Canonical headless upgrade argv (#1339 / #1409). */
export const CANONICAL_UPDATE_ARGV = ["--yes", "--upgrade", "--repo-root", ".", "--json"] as const;

/**
 * Flags that make `directive update` classify + print its plan without executing
 * the refresh (#2266). Recognised in the USER argv (never part of the canonical
 * always-applied argv above, which must stay a real refresh).
 */
export const UPDATE_DRY_RUN_FLAGS = ["--dry-run", "--plan"] as const;

/**
 * Flags that make `directive init` classify + print the dispatch plan without
 * executing any deposit/refresh/migrate (#2265). Mirrors {@link UPDATE_DRY_RUN_FLAGS};
 * recognised in the USER argv, never part of the canonical always-applied argv
 * above (which must stay a real adoption dispatch).
 */
export const INIT_DRY_RUN_FLAGS = ["--dry-run", "--plan"] as const;

/**
 * Flags that switch `directive init` into headless manifest-emit mode (#2268):
 * serialise the merged keystone `plan()` into a `{ version, files }` manifest
 * with ALL execution side effects suppressed. Recognised in the USER argv; NOT
 * part of the canonical always-applied argv above (which must stay a real,
 * executing adoption dispatch — a headless flag there would silently suppress
 * every install's side effects).
 */
export const INIT_HEADLESS_FLAGS = ["--headless", "/headless"] as const;

/**
 * Flag naming the manifest output target for `--headless` (#2268). Accepts the
 * `--output=<path>` and `--output <path>` forms; when absent the manifest is
 * written to stdout. Writing this file is the ONLY filesystem side effect the
 * headless path is permitted to perform.
 */
export const INIT_OUTPUT_FLAGS = ["--output", "/output"] as const;

/** Canonical migrate argv: defaults to cwd, human-readable unless --json (#1941). */
export const CANONICAL_MIGRATE_ARGV = ["--repo-root", "."] as const;

/**
 * Subcommand flag selecting the vendored→hybrid `.deft/core` un-commit (#2269).
 * `migrate --untrack-core` dispatches to the destructive un-track path; bare
 * `migrate` keeps its non-destructive provenance-stamp behavior.
 */
export const MIGRATE_UNTRACK_CORE_FLAG = "--untrack-core";
