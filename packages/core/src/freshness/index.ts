/**
 * Host-agnostic freshness contract (#3117).
 *
 * Monotonic generation on deposit apply, session bind of that generation, and
 * bound-vs-live reports with current | stale_soft | stale_hard states.
 */

export * from "./bind.js";
export * from "./cli.js";
export * from "./compare.js";
export * from "./generation.js";
export * from "./report.js";
export * from "./types.js";
