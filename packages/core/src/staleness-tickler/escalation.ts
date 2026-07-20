import type {
  DriftInputs,
  DriftScoreResult,
  StalenessTicklerPolicy,
  StalenessTicklerState,
  StalenessTicklerTier,
  XbriefSchemaDistance,
} from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Compute a weighted drift score from independent axes (#2489). */
export function scoreDrift(inputs: DriftInputs, policy: StalenessTicklerPolicy): number {
  const { weights } = policy;
  let score = 0;
  if (inputs.directive.stale) {
    if (inputs.directive.majorBehind) {
      score += weights.directiveMajor;
    }
    score += inputs.directive.minorDistance * weights.directiveMinor;
    score += inputs.directive.patchDistance * weights.directivePatch;
  }
  if (inputs.xbrief.stale) {
    if (inputs.xbrief.distance === "behind-major") {
      score += weights.schemaMajor;
    } else if (inputs.xbrief.distance === "behind-minor") {
      score += weights.schemaMinor;
    }
  }
  score += (inputs.ageMs / MS_PER_DAY) * weights.agePerDay;
  score += inputs.deferralCount * weights.deferral;
  return score;
}

function baseTierFromInputs(
  inputs: DriftInputs,
  policy: StalenessTicklerPolicy,
): StalenessTicklerTier {
  const { tiers } = policy;
  if (
    inputs.directive.majorBehind ||
    inputs.xbrief.distance === "behind-major" ||
    inputs.ageMs >= tiers.strongAgeMs
  ) {
    return "strong";
  }
  if (
    inputs.directive.minorDistance >= tiers.noticeMinorThreshold ||
    inputs.xbrief.distance === "behind-minor"
  ) {
    return "notice";
  }
  return "quiet";
}

/** Map drift inputs to an escalation tier using typed thresholds. */
export function resolveTier(
  inputs: DriftInputs,
  policy: StalenessTicklerPolicy,
): StalenessTicklerTier {
  const base = baseTierFromInputs(inputs, policy);
  if (base === "strong" && inputs.deferralCount >= policy.tiers.assertDeferralCap) {
    return "assert";
  }
  return base;
}

/** Hold the last known tier when detection is unverified (#2489 monotonicity). */
export function holdTierOnUnverified(
  computedTier: StalenessTicklerTier,
  computedScore: number,
  state: StalenessTicklerState,
  directiveUnverified: boolean,
): DriftScoreResult {
  if (!directiveUnverified || state.lastTier === undefined) {
    return { score: computedScore, tier: computedTier };
  }
  const heldTier = state.lastTier;
  const heldScore = state.lastScore ?? computedScore;
  const tierRank = (tier: StalenessTicklerTier): number =>
    tier === "quiet" ? 0 : tier === "notice" ? 1 : tier === "strong" ? 2 : 3;
  if (tierRank(heldTier) > tierRank(computedTier)) {
    return { score: heldScore, tier: heldTier };
  }
  return { score: computedScore, tier: computedTier };
}

function baseSnoozeMs(tier: StalenessTicklerTier, policy: StalenessTicklerPolicy): number {
  switch (tier) {
    case "quiet":
      return policy.snooze.quietMs;
    case "notice":
      return policy.snooze.noticeMs;
    case "strong":
      return policy.snooze.strongMs;
    case "assert":
      return policy.snooze.strongMs;
    default:
      return policy.snooze.noticeMs;
  }
}

/** Snooze window widens with deferrals up to `maxWidenMultiplier`. */
export function snoozeWindowMs(
  tier: StalenessTicklerTier,
  deferralCount: number,
  policy: StalenessTicklerPolicy,
): number {
  const base = baseSnoozeMs(tier, policy);
  const multiplier = Math.min(1 + deferralCount, Math.max(1, policy.snooze.maxWidenMultiplier));
  if (tier === "assert") {
    return Math.min(base, policy.snooze.strongMs);
  }
  return Math.round(base * multiplier);
}

export function isSnoozeActive(state: StalenessTicklerState, now: Date): boolean {
  if (!state.snoozedUntil) {
    return false;
  }
  const until = Date.parse(state.snoozedUntil);
  return Number.isFinite(until) && now.getTime() < until;
}

/** Assert tier re-prompts at idle even when a plain snooze would still be active. */
export function shouldPromptDespiteSnooze(
  tier: StalenessTicklerTier,
  state: StalenessTicklerState,
): boolean {
  if (tier !== "assert") {
    return false;
  }
  if (state.remindAfterNextRelease) {
    return false;
  }
  return true;
}

export function mergeHeldXbriefDistance(
  current: XbriefSchemaDistance,
  held: XbriefSchemaDistance | undefined,
): XbriefSchemaDistance {
  if (held === undefined) {
    return current;
  }
  const rank = (distance: XbriefSchemaDistance): number =>
    distance === "current" ? 0 : distance === "behind-minor" ? 1 : 2;
  return rank(held) > rank(current) ? held : current;
}
