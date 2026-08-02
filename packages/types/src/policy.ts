/**
 * Typed `plan.policy` surface — known fields mirror directive engine inspectors (#746 / #1148).
 * Additional keys use the vBRIEF#12 extension namespace (`x-*`).
 */
export interface TriageScopeRule {
  readonly rule: string;
  readonly [key: string]: unknown;
}

/**
 * Typed hotfix eligibility thresholds (#1193 / Wave 2 of #2948).
 * Agent may propose `hotfix-candidate` only; a human promotes to `hotfix`.
 */
export interface HotfixCriteria {
  /** Max changed lines for a small fix (default 10). */
  readonly maxLines?: number;
  /** Max changed files for a small fix (default 2). */
  readonly maxFiles?: number;
  /** Paths that never qualify as hotfix (default includes deploy/CI/migrations). */
  readonly forbiddenPathGlobs?: readonly string[];
}

export interface PlanPolicy {
  readonly allowDirectCommitsToMaster?: boolean;
  readonly wipCap?: number;
  readonly sessionRitualStalenessHours?: number | null;
  /**
   * Engine-vs-pin skew tolerance for the three-band skew policy (#2264).
   *
   * Pre-1.0 the window is measured in minor versions (default 3); post-1.0 it
   * collapses to "same major". `engine > pin` beyond this window fails closed
   * unless `--accept-engine-jump` / `DEFT_ACCEPT_ENGINE_SKEW=1` is supplied.
   */
  readonly engineSkewWindow?: number | null;
  readonly triageScope?: readonly TriageScopeRule[];
  readonly triageScopeIgnores?: readonly unknown[];
  readonly triageRankingLabels?: readonly string[];
  readonly triageAutoClassify?: readonly unknown[];
  readonly triageHoldMarkers?: readonly string[];
  readonly swarmSubagentBackend?: string | null;
  readonly projectionProviders?: Record<string, ProjectionProviderPolicy>;
  /** Per-host Directive hook deposit toggles (#2752). Default: all true. */
  readonly hostHooks?: Partial<Record<"claude" | "cursor" | "grok" | "codex", boolean>>;
  /**
   * Per-host native slash command deposit toggles (#3054 / epic #55 L6).
   * Default: all true for hosts with real emitters (claude, cursor, grok, codex).
   */
  readonly hostSlashCommands?: Partial<Record<"claude" | "cursor" | "grok" | "codex", boolean>>;
  /**
   * Per-host multi-host skill discovery deposit toggles (#75 residual).
   * Default: all true. Distinct from hostHooks and from #55 slash deposit.
   */
  readonly hostSkillDiscovery?: Partial<Record<"claude" | "cursor" | "codex" | "github", boolean>>;
  /**
   * When true, agents may open PRs but must not merge (#1193). Defaults true
   * when `autoDeployOnMerge` is also true. Override: `policy:allow-bot-merge`
   * or `DEFT_ALLOW_BOT_MERGE=1`.
   */
  readonly requireHumanMerge?: boolean;
  /**
   * When true, merges to the default branch auto-deploy to production.
   * Couples with requireHumanMerge defaulting (#1193 Shadowlogic profile).
   */
  readonly autoDeployOnMerge?: boolean;
  /** Structural hotfix eligibility thresholds (#1193). */
  readonly hotfixCriteria?: HotfixCriteria;
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
  "plan.policy.engineSkewWindow",
  "plan.policy.requireHumanMerge",
  "plan.policy.hotfixCriteria",
  "plan.policy.autoDeployOnMerge",
] as const;
