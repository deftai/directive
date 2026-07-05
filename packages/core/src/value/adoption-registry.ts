import {
  isValueFeedbackPathAllowed,
  type ValueFeedbackResolved,
} from "../policy/value-feedback.js";

/** Canonical directive capabilities tracked for underutilization nudges (#1709). */
export type CapabilityId =
  | "planning"
  | "cost"
  | "decompose"
  | "swarm"
  | "pre-pr"
  | "debug"
  | "glossary"
  | "lessons";

/** How downstream instrumentation knows a capability was exercised. */
export type UsageSignalSource =
  | "command:/deft:directive:run:interview"
  | "command:/deft:directive:run:speckit"
  | "command:task capacity:show"
  | "command:split-to-prs"
  | "command:task swarm:launch"
  | "skill:deft-directive-pre-pr"
  | "skill:debug-mode"
  | "command:/deft:glossary"
  | "command:deft packs:slice";

export interface CapabilityRecord {
  readonly id: CapabilityId;
  readonly label: string;
  readonly description: string;
  readonly usageSignals: readonly UsageSignalSource[];
  readonly nudgeHint: string;
}

/** Work snapshot supplied by callers when evaluating adoption heuristics. */
export interface WorkContext {
  readonly filesTouched: number;
  /** Distinct module globs from the codebase map (parallelizability proxy). */
  readonly distinctModuleGlobs: number;
  readonly usedCapabilities: readonly CapabilityId[];
  readonly isBuildIntent?: boolean;
  readonly isPrOpening?: boolean;
}

export interface ApplicabilityVerdict {
  readonly applicable: boolean;
  readonly reason: string;
}

export interface AdoptionSignal {
  readonly signalClass: "adoption";
  readonly event: string;
  readonly capabilityId: CapabilityId;
  readonly message: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

/** Conservative thresholds — adoption nudges fire only above these bars (#1709). */
export const ADOPTION_THRESHOLDS = {
  smallWorkMaxFiles: 2,
  planningMinFiles: 4,
  costMinFiles: 3,
  largeMultiFileMinFiles: 5,
  largeMultiFileMinModules: 2,
  swarmMinFiles: 8,
  swarmMinModules: 3,
  glossaryMinFiles: 6,
  lessonsMinFiles: 5,
} as const;

export const ADOPTION_SIGNAL_CLASS = "adoption" as const;

const CAPABILITY_CATALOG: readonly CapabilityRecord[] = [
  {
    id: "planning",
    label: "Planning",
    description: "Structured spec interview or speckit planning before implementation.",
    usageSignals: ["command:/deft:directive:run:interview", "command:/deft:directive:run:speckit"],
    nudgeHint:
      "Consider `/deft:directive:run:interview` or `/deft:directive:run:speckit` before a multi-file build.",
  },
  {
    id: "cost",
    label: "Cost awareness",
    description: "Capacity/cost phase before committing to a build.",
    usageSignals: ["command:task capacity:show"],
    nudgeHint: "Run `task capacity:show` before a build to surface allocation targets.",
  },
  {
    id: "decompose",
    label: "Decompose",
    description: "Split large multi-file work into reviewable PRs.",
    usageSignals: ["command:split-to-prs"],
    nudgeHint: "Large multi-file work may benefit from split-to-prs decomposition.",
  },
  {
    id: "swarm",
    label: "Swarm",
    description: "Parallel agent dispatch for disjoint multi-story cohorts.",
    usageSignals: ["command:task swarm:launch"],
    nudgeHint: "Disjoint multi-story work may benefit from `task swarm:launch`.",
  },
  {
    id: "pre-pr",
    label: "Pre-PR loop",
    description: "Iterative pre-PR quality loop before opening a pull request.",
    usageSignals: ["skill:deft-directive-pre-pr"],
    nudgeHint: "Run the deft-directive-pre-pr skill before opening a PR.",
  },
  {
    id: "debug",
    label: "Debug mode",
    description: "Systematic debug workflow for failures and regressions.",
    usageSignals: ["skill:debug-mode"],
    nudgeHint: "Switch to debug mode when chasing a failure systematically.",
  },
  {
    id: "glossary",
    label: "Glossary",
    description: "Project glossary for unfamiliar domain terms.",
    usageSignals: ["command:/deft:glossary"],
    nudgeHint: "Consult `/deft:glossary` when domain terms are ambiguous.",
  },
  {
    id: "lessons",
    label: "Lessons packs",
    description: "Prior-art slices from directive content packs.",
    usageSignals: ["command:deft packs:slice"],
    nudgeHint: "Load a lessons pack slice before improvising on a novel problem.",
  },
] as const;

type ApplicabilityRule = (ctx: WorkContext) => ApplicabilityVerdict;

function usedSet(ctx: WorkContext): Set<CapabilityId> {
  return new Set(ctx.usedCapabilities);
}

function verdict(applicable: boolean, reason: string): ApplicabilityVerdict {
  return { applicable, reason };
}

const APPLICABILITY_RULES: Record<CapabilityId, ApplicabilityRule> = {
  planning(ctx) {
    if (ctx.isPrOpening) {
      return verdict(false, "at PR-open boundary — planning phase is past");
    }
    if (ctx.filesTouched < ADOPTION_THRESHOLDS.planningMinFiles) {
      return verdict(false, "scope below planning threshold");
    }
    return verdict(true, "multi-file scope without a planning pass");
  },
  cost(ctx) {
    if (!ctx.isBuildIntent) {
      return verdict(false, "not a build-intent session");
    }
    if (ctx.filesTouched < ADOPTION_THRESHOLDS.costMinFiles) {
      return verdict(false, "build scope below cost threshold");
    }
    return verdict(true, "build intent without a cost phase");
  },
  decompose(ctx) {
    if (ctx.filesTouched < ADOPTION_THRESHOLDS.largeMultiFileMinFiles) {
      return verdict(false, "file count below large multi-file threshold");
    }
    if (ctx.distinctModuleGlobs < ADOPTION_THRESHOLDS.largeMultiFileMinModules) {
      return verdict(false, "work is not parallelizable across modules");
    }
    return verdict(true, "large multi-file parallelizable work");
  },
  swarm(ctx) {
    if (ctx.filesTouched < ADOPTION_THRESHOLDS.swarmMinFiles) {
      return verdict(false, "file count below swarm threshold");
    }
    if (ctx.distinctModuleGlobs < ADOPTION_THRESHOLDS.swarmMinModules) {
      return verdict(false, "insufficient module breadth for swarm cohort");
    }
    return verdict(true, "broad parallelizable cohort scope");
  },
  "pre-pr"(ctx) {
    if (!ctx.isPrOpening) {
      return verdict(false, "not at PR-open boundary");
    }
    return verdict(true, "PR opening without pre-PR loop");
  },
  debug(_ctx) {
    return verdict(false, "debug nudges require an explicit failure signal");
  },
  glossary(ctx) {
    if (ctx.filesTouched < ADOPTION_THRESHOLDS.glossaryMinFiles) {
      return verdict(false, "scope below glossary threshold");
    }
    return verdict(true, "broad unfamiliar scope");
  },
  lessons(ctx) {
    if (ctx.filesTouched < ADOPTION_THRESHOLDS.lessonsMinFiles) {
      return verdict(false, "scope below lessons threshold");
    }
    return verdict(true, "novel multi-file scope");
  },
};

/** Return the full capability catalog (#1709-adoption-registry-a1). */
function listCapabilities(): readonly CapabilityRecord[] {
  return CAPABILITY_CATALOG;
}

/** Lookup a single catalog entry by id. */
function getCapability(id: CapabilityId): CapabilityRecord | undefined {
  return CAPABILITY_CATALOG.find((entry) => entry.id === id);
}

/** Event name for the attribution ledger (`adoption:<capability>`). */
export function formatAdoptionEventName(id: CapabilityId): string {
  return `${ADOPTION_SIGNAL_CLASS}:${id}`;
}

/** True when work is too small for any adoption nudge (#1709-adoption-registry-a3). */
export function isWorkTooSmallForAdoptionNudges(ctx: WorkContext): boolean {
  return ctx.filesTouched <= ADOPTION_THRESHOLDS.smallWorkMaxFiles;
}

/** Evaluate whether a capability's conservative heuristic applies to the work snapshot. */
export function evaluateApplicability(id: CapabilityId, ctx: WorkContext): ApplicabilityVerdict {
  if (isWorkTooSmallForAdoptionNudges(ctx)) {
    return verdict(false, "small work — adoption nudges suppressed");
  }
  return APPLICABILITY_RULES[id](ctx);
}

function buildAdoptionSignal(
  id: CapabilityId,
  ctx: WorkContext,
  applicability: ApplicabilityVerdict,
): AdoptionSignal | null {
  const record = getCapability(id);
  if (record === undefined) {
    return null;
  }
  return {
    signalClass: ADOPTION_SIGNAL_CLASS,
    event: formatAdoptionEventName(record.id),
    capabilityId: record.id,
    message: record.nudgeHint,
    evidence: {
      filesTouched: ctx.filesTouched,
      distinctModuleGlobs: ctx.distinctModuleGlobs,
      usageSignals: record.usageSignals,
      applicabilityReason: applicability.reason,
    },
  };
}

/**
 * Detect applicable-but-unused capabilities (#1709-adoption-registry-a2).
 * Does not consult the value-feedback policy — use `detectApplicableButUnusedGated`.
 */
export function detectApplicableButUnused(ctx: WorkContext): AdoptionSignal[] {
  if (isWorkTooSmallForAdoptionNudges(ctx)) {
    return [];
  }

  const used = usedSet(ctx);
  const signals: AdoptionSignal[] = [];
  for (const record of listCapabilities()) {
    if (used.has(record.id)) {
      continue;
    }
    const applicability = evaluateApplicability(record.id, ctx);
    if (!applicability.applicable) {
      continue;
    }
    const signal = buildAdoptionSignal(record.id, ctx, applicability);
    if (signal !== null) {
      signals.push(signal);
    }
  }
  return signals;
}

/**
 * Policy-gated adoption detection — returns signals only when value feedback
 * is enabled and the emitEvents path is allowed (#1709 opt-in gate).
 */
export function detectApplicableButUnusedGated(
  ctx: WorkContext,
  policy: ValueFeedbackResolved,
): AdoptionSignal[] {
  if (!isValueFeedbackPathAllowed("emitEvents", policy)) {
    return [];
  }
  return detectApplicableButUnused(ctx);
}
