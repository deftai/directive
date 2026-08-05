/**
 * Bound vs live freshness comparison (#3117).
 */

import { differingSurfaces } from "./generation.js";
import {
  type BoundGeneration,
  type FreshnessReport,
  type FreshnessState,
  type FreshnessSurface,
  HARD_SURFACES,
  type LiveGeneration,
  SOFT_SURFACES,
} from "./types.js";

export const REBIND_GUIDANCE =
  "Rebind without restarting the shared host runtime: re-load payload surfaces " +
  "(skills, rituals, templates, commands) into the session context, then run " +
  "`deft freshness:bind` (or `task freshness:bind`). Prefer `deft session:start --rearm` " +
  "or `deft session:ready` when ritual state is still valid on this worktree.";

export const MID_MISSION_SAFETY =
  "Mid-mission safety: park and hand off in-flight work before a hard refresh/rebind. " +
  "An empty session after refresh is not work complete — resume from the handoff, " +
  "not from a blank context.";

export const UNBOUND_GUIDANCE =
  "No session bind recorded. Load payload surfaces into the session and run " +
  "`deft freshness:bind` (session:start binds automatically on mutation posture). " +
  "Disk-only version probes are insufficient for session readiness.";

function partitionDiffs(diffs: readonly FreshnessSurface[]): {
  hard: FreshnessSurface[];
  soft: FreshnessSurface[];
} {
  const hardSet = new Set<string>(HARD_SURFACES);
  const softSet = new Set<string>(SOFT_SURFACES);
  const hard: FreshnessSurface[] = [];
  const soft: FreshnessSurface[] = [];
  for (const s of diffs) {
    if (hardSet.has(s)) {
      hard.push(s);
    } else if (softSet.has(s)) {
      soft.push(s);
    } else {
      // Unknown surface: treat as hard (fail closed for trust).
      hard.push(s);
    }
  }
  return { hard, soft };
}

/**
 * Compare bound vs live generation and surface fingerprints.
 *
 * Ready only when state is `current` (bound matches live for used surfaces).
 */
export function compareFreshness(
  bound: BoundGeneration | null,
  live: LiveGeneration | null,
): FreshnessReport {
  if (bound === null) {
    return {
      boundGeneration: null,
      liveGeneration: live?.generation ?? null,
      boundContentVersion: null,
      liveContentVersion: live?.contentVersion ?? null,
      state: "unbound",
      differingSurfaces: [],
      hardDiffs: [],
      softDiffs: [],
      ready: false,
      rebindGuidance: UNBOUND_GUIDANCE,
      midMissionSafety: MID_MISSION_SAFETY,
      live,
      bound: null,
    };
  }

  if (live === null) {
    return {
      boundGeneration: bound.boundGeneration,
      liveGeneration: null,
      boundContentVersion: bound.contentVersion,
      liveContentVersion: null,
      state: "stale_hard",
      differingSurfaces: ["payload", "version"],
      hardDiffs: ["payload", "version"],
      softDiffs: [],
      ready: false,
      rebindGuidance:
        "Live generation token missing. Run `directive update` / `deft update` to stamp " +
        "the deposit, then rebind. " +
        REBIND_GUIDANCE,
      midMissionSafety: MID_MISSION_SAFETY,
      live: null,
      bound,
    };
  }

  const diffs = differingSurfaces(bound.surfaces, live.surfaces);
  const { hard, soft } = partitionDiffs(diffs);
  const generationMismatch = bound.boundGeneration !== live.generation;

  let state: FreshnessState;
  if (!generationMismatch && diffs.length === 0) {
    state = "current";
  } else if (hard.length > 0 || generationMismatch) {
    // Generation advance without hard surface proof still means payload re-apply.
    if (
      generationMismatch &&
      hard.length === 0 &&
      soft.length > 0 &&
      diffs.length === soft.length
    ) {
      state = "stale_soft";
    } else if (generationMismatch && hard.length === 0 && diffs.length === 0) {
      // Generation bumped with identical fingerprints (rare) — treat as hard.
      state = "stale_hard";
    } else if (hard.length > 0) {
      state = "stale_hard";
    } else {
      state = "stale_hard";
    }
  } else {
    state = "stale_soft";
  }

  // Clarify generation-only mismatch with no surface info on bound: hard.
  if (generationMismatch && Object.keys(bound.surfaces).length === 0) {
    state = "stale_hard";
  }

  const ready = state === "current";
  const rebindGuidance =
    state === "current"
      ? "Session is current: bound generation matches live for used surfaces."
      : state === "stale_soft"
        ? `Advisory drift (${soft.join(", ") || "soft surfaces"}). Continue with caution; ` +
          `rebind when convenient. ${REBIND_GUIDANCE}`
        : `Hard drift (generation and/or ${hard.join(", ") || "payload surfaces"}). ` +
          `Rebind before trusted work. ${REBIND_GUIDANCE}`;

  return {
    boundGeneration: bound.boundGeneration,
    liveGeneration: live.generation,
    boundContentVersion: bound.contentVersion,
    liveContentVersion: live.contentVersion,
    state,
    differingSurfaces: diffs,
    hardDiffs: hard,
    softDiffs: soft,
    ready,
    rebindGuidance,
    midMissionSafety: MID_MISSION_SAFETY,
    live,
    bound,
  };
}
