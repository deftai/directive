/**
 * Result types for the in-sync check (R2).
 *
 * Doctor and setup call this module later (AC2.3). Hooks use the cheap form (AC2.4).
 */

/** One AC2.1 predicate outcome. */
export interface PredicateResult {
  readonly ok: boolean;
  /** Observed version when applicable; null when absent/unreadable. */
  readonly version: string | null;
  /** Short machine-oriented reason when not ok. */
  readonly reason: string | null;
}

/**
 * Minimal GENERATION.json shape accepted by 1a.
 *
 * Requires `runtimeVersion` (setup recorded for V). 1b owns the permanent
 * ownership/removal + PM schema (AC11.10 / AC13.2). Extra fields are ignored
 * here so 1b can extend without breaking this check.
 */
export interface MinimalGenerationSetup {
  readonly runtimeVersion: string;
  /** Extension point for 1b (packageManager, ownership fingerprints, …). */
  readonly [key: string]: unknown;
}

/** Doctor-ish signals that must NOT flip inSync (AC2.2). */
export interface SeparateSyncSignals {
  /** True when project xbrief schema is behind the runtime's current schema. */
  readonly xbriefSchemaBehind: boolean;
  /** Remedy when behind; null otherwise. */
  readonly xbriefRemedy: "directive upgrade" | null;
}

export interface FullInSyncOptions {
  /**
   * Current xbrief schema version expected by this runtime.
   * When set, older project data is reported via separateSignals only (AC2.2).
   */
  readonly currentXbriefSchema?: string;
}

export interface FullInSyncResult {
  /** True only when all AC2.1 predicates pass. */
  readonly inSync: boolean;
  /** Agreed version V when pin is exact; null when pin missing/invalid. */
  readonly version: string | null;
  /**
   * Pin≠installed identity failure (AC2.6): fail closed, no setup/policy.
   * Distinct from ordinary out-of-sync (missing readiness, stale generation, …).
   */
  readonly failClosed: boolean;
  /** False when failClosed; callers must not start setup. */
  readonly allowSetup: boolean;
  /** AC9.7 guidance when failClosed or other install recovery is needed. */
  readonly recoveryGuidance: string | null;
  readonly predicates: {
    readonly pin: PredicateResult;
    readonly lockfile: PredicateResult;
    readonly installed: PredicateResult;
    readonly generation: PredicateResult;
    readonly wiring: PredicateResult;
    readonly readiness: PredicateResult;
  };
  readonly separateSignals: SeparateSyncSignals;
}

export interface CheapInSyncResult {
  /** Pin/installed identity match AND readiness valid. */
  readonly ok: boolean;
  readonly pinVersion: string | null;
  readonly installedVersion: string | null;
  readonly identityMatch: boolean;
  readonly readinessValid: boolean;
  readonly failClosed: boolean;
  readonly allowSetup: boolean;
  readonly recoveryGuidance: string | null;
}
