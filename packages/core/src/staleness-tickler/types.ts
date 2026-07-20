import type { ReleaseAvailabilityResult } from "../doctor/release-availability.js";

/** Escalation tiers for the staleness tickler (#2489). */
export const STALENESS_TICKLER_TIERS = ["quiet", "notice", "strong", "assert"] as const;
export type StalenessTicklerTier = (typeof STALENESS_TICKLER_TIERS)[number];

/** xBRIEF schema distance relative to the installed framework schema. */
export const XBRIEF_SCHEMA_DISTANCES = ["current", "behind-minor", "behind-major"] as const;
export type XbriefSchemaDistance = (typeof XBRIEF_SCHEMA_DISTANCES)[number];

export interface ParsedSemverCore {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface DirectiveDrift {
  readonly availability: ReleaseAvailabilityResult;
  readonly majorBehind: boolean;
  readonly minorDistance: number;
  readonly patchDistance: number;
  readonly stale: boolean;
}

export interface XbriefDrift {
  readonly declaredVersion: string | null;
  readonly targetVersion: string;
  readonly distance: XbriefSchemaDistance;
  readonly stale: boolean;
}

export interface DriftInputs {
  readonly directive: DirectiveDrift;
  readonly xbrief: XbriefDrift;
  readonly ageMs: number;
  readonly deferralCount: number;
}

export interface DriftScoreResult {
  readonly score: number;
  readonly tier: StalenessTicklerTier;
}

export interface StalenessTicklerState {
  readonly firstDetectedAt?: string;
  readonly lastTier?: StalenessTicklerTier;
  readonly lastScore?: number;
  readonly lastPromptAt?: string;
  readonly deferralCount?: number;
  readonly snoozedUntil?: string;
  readonly heldDirectiveLatest?: string | null;
  readonly heldXbriefDistance?: XbriefSchemaDistance;
  readonly remindAfterNextRelease?: boolean;
}

export interface StalenessTicklerWeights {
  readonly directiveMajor: number;
  readonly directiveMinor: number;
  readonly directivePatch: number;
  readonly schemaMajor: number;
  readonly schemaMinor: number;
  readonly agePerDay: number;
  readonly deferral: number;
}

export interface StalenessTicklerTierThresholds {
  readonly noticeMinorThreshold: number;
  readonly strongAgeMs: number;
  readonly assertDeferralCap: number;
}

export interface StalenessTicklerSnoozePolicy {
  readonly quietMs: number;
  readonly noticeMs: number;
  readonly strongMs: number;
  readonly maxWidenMultiplier: number;
}

export interface StalenessTicklerPolicy {
  readonly enabled: boolean;
  readonly optOut: boolean;
  readonly weights: StalenessTicklerWeights;
  readonly tiers: StalenessTicklerTierThresholds;
  readonly snooze: StalenessTicklerSnoozePolicy;
}

export interface StalenessProbeResult {
  readonly directive: DirectiveDrift;
  readonly xbrief: XbriefDrift;
  readonly anyStale: boolean;
  readonly directiveRegistryDisclosure?: string;
}

export interface StalenessTicklerRunResult {
  readonly lines: readonly string[];
  readonly prompted: boolean;
  readonly skippedReason?: string;
}
