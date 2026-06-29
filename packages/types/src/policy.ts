/**
 * Typed `plan.policy` surface — known fields mirror directive engine inspectors (#746 / #1148).
 * Additional keys use the vBRIEF#12 extension namespace (`x-*`).
 */
export interface TriageScopeRule {
  readonly rule: string;
  readonly [key: string]: unknown;
}

export interface PlanPolicy {
  readonly allowDirectCommitsToMaster?: boolean;
  readonly wipCap?: number;
  readonly sessionRitualStalenessHours?: number | null;
  readonly triageScope?: readonly TriageScopeRule[];
  readonly triageScopeIgnores?: readonly unknown[];
  readonly triageRankingLabels?: readonly string[];
  readonly triageAutoClassify?: readonly unknown[];
  readonly triageHoldMarkers?: readonly string[];
  readonly swarmSubagentBackend?: string | null;
  readonly projectionProviders?: Record<string, ProjectionProviderPolicy>;
  readonly [key: `x-${string}`]: unknown;
}

export interface ProjectionProviderExpectation {
  readonly provider?: string | Record<string, unknown>;
  readonly name?: string;
  readonly version?: string;
  readonly providerVersion?: string;
  readonly [key: `x-${string}`]: unknown;
}

export interface ProjectionProviderPolicy {
  readonly artifactPath: string;
  readonly expect?: ProjectionProviderExpectation;
  readonly [key: `x-${string}`]: unknown;
}

/** Canonical dotted policy field names registered by the directive engine. */
export const REGISTERED_POLICY_FIELD_NAMES = [
  "plan.policy.allowDirectCommitsToMaster",
  "plan.policy.wipCap",
  "plan.policy.sessionRitualStalenessHours",
  "plan.policy.triageScope",
  "plan.policy.triageScopeIgnores",
  "plan.policy.triageRankingLabels",
  "plan.policy.triageAutoClassify",
  "plan.policy.triageHoldMarkers",
  "plan.policy.swarmSubagentBackend",
] as const;
