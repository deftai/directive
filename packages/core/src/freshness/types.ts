/**
 * Host-agnostic freshness contract types (#3117).
 *
 * Bound generation is what a long-lived session loaded; live generation is what
 * the on-disk deposit currently stamps after a successful apply/refresh.
 * Disk-only "up to date" is insufficient for session readiness.
 */

/** Schema version for GENERATION.json and session-bind.json. */
export const FRESHNESS_SCHEMA_VERSION = 1 as const;

/**
 * Freshness state for a session relative to the live deposit.
 *
 * - `current` — bound matches live for used surfaces
 * - `stale_soft` — additive / advisory drift; safe to continue with caution
 * - `stale_hard` — evidence-untrustworthy drift; rebind before trusted work
 * - `unbound` — no session bind recorded (not ready for trusted work)
 */
export const FRESHNESS_STATES = ["current", "stale_soft", "stale_hard", "unbound"] as const;
export type FreshnessState = (typeof FRESHNESS_STATES)[number];

/** Surface ids compared in a freshness report. */
export const FRESHNESS_SURFACES = ["payload", "version", "templates", "skills", "docs"] as const;
export type FreshnessSurface = (typeof FRESHNESS_SURFACES)[number];

/** Hard surfaces: drift means evidence is untrustworthy without rebind. */
export const HARD_SURFACES: readonly FreshnessSurface[] = [
  "payload",
  "version",
  "templates",
  "skills",
] as const;

/** Soft / advisory surfaces: drift is cautionary, not evidence-invalidating alone. */
export const SOFT_SURFACES: readonly FreshnessSurface[] = ["docs"] as const;

/** Fingerprints for each surface at a generation (typically content version tags). */
export type SurfaceFingerprints = Readonly<Partial<Record<FreshnessSurface, string>>>;

/** Live deposit generation token written on successful apply/refresh. */
export interface LiveGeneration {
  readonly schemaVersion: typeof FRESHNESS_SCHEMA_VERSION;
  readonly generation: number;
  readonly contentVersion: string;
  readonly stampedAt: string;
  readonly stampedBy: string;
  readonly surfaces: SurfaceFingerprints;
}

/** Session bind of the generation loaded into runtime context. */
export interface BoundGeneration {
  readonly schemaVersion: typeof FRESHNESS_SCHEMA_VERSION;
  readonly boundGeneration: number;
  readonly boundAt: string;
  readonly contentVersion: string;
  readonly surfaces: SurfaceFingerprints;
  /** Optional host-supplied session identity (host-agnostic; not a host key scheme). */
  readonly sessionId?: string | null;
  /**
   * Host attestation that payload surfaces for this generation were loaded into
   * the session before bind. Required for trusted `current`/`ready`.
   * session:start sets true; bare CLI bind requires `--confirm-payload-loaded`.
   */
  readonly payloadLoaded?: boolean;
}

/** Full freshness report comparing bound vs live. */
export interface FreshnessReport {
  readonly boundGeneration: number | null;
  readonly liveGeneration: number | null;
  readonly boundContentVersion: string | null;
  readonly liveContentVersion: string | null;
  readonly state: FreshnessState;
  readonly differingSurfaces: readonly FreshnessSurface[];
  readonly hardDiffs: readonly FreshnessSurface[];
  readonly softDiffs: readonly FreshnessSurface[];
  readonly ready: boolean;
  readonly rebindGuidance: string;
  readonly midMissionSafety: string;
  readonly live: LiveGeneration | null;
  readonly bound: BoundGeneration | null;
}
