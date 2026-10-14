/**
 * WAVE3-V2 layout strategies — fixed table of ordered removal step ids.
 * Bookends dispatch detect → strategy; bulk logic stays in steps (smell test).
 */
import {
  RemovalStepError,
  runStep,
  type RemovalStepId,
} from "./steps.js";

/** Shape ids that have a convert-via-removals strategy (survey + L0). */
export type StrategyShapeId =
  | "ovpr-runtime-pin"
  | "npm-hybrid-pin-copied-core"
  | "vendored-core-go"
  | "go-tarball-deft-root"
  | "submodule-deft"
  | "dual-layout-deft-and-core"
  | "orphan-deft-version";

export interface LayoutStrategy {
  readonly shapeId: StrategyShapeId;
  readonly steps: readonly RemovalStepId[];
  /** After steps, ensure exact @deftai/directive-runtime pin via PM. */
  readonly needsRuntimePin: boolean;
}

export interface StrategyResult {
  readonly shapeId: StrategyShapeId;
  readonly removed: readonly string[];
  readonly modified: readonly string[];
  readonly ok: boolean;
  readonly message?: string;
}

const CONVERT_SHAPE_IDS = new Set<string>([
  "vendored-core-go",
  "go-tarball-deft-root",
  "submodule-deft",
  "dual-layout-deft-and-core",
  "orphan-deft-version",
  // L0 hybrid also listed for completeness when setup is told from=old-style separately.
  "npm-hybrid-pin-copied-core",
]);

/** True when `from` is a WAVE3-V2 convert shape id (not old-style / none / semver). */
export function isConvertStrategyFrom(from: string): from is StrategyShapeId {
  return CONVERT_SHAPE_IDS.has(from);
}

/**
 * Target strategies after WAVE3-V2. L0 rows are documentation anchors
 * (existing bookend paths); L2 rows drive convert-via-removals.
 */
export const STRATEGIES: Readonly<Record<StrategyShapeId, LayoutStrategy>> = {
  "ovpr-runtime-pin": {
    shapeId: "ovpr-runtime-pin",
    steps: [],
    needsRuntimePin: false,
  },
  "npm-hybrid-pin-copied-core": {
    shapeId: "npm-hybrid-pin-copied-core",
    steps: [
      "clearOwnedHookEntries",
      "stripLegacyLauncherPin",
      "removeCopiedCore",
      "pruneEmptyAncestors",
      "removeSoleAuthorHusks",
    ],
    needsRuntimePin: true,
  },
  "vendored-core-go": {
    shapeId: "vendored-core-go",
    steps: [
      "clearOwnedHookEntries",
      "removeOwnedSkillPointers",
      "removeCopiedCore",
      "pruneEmptyAncestors",
      "removeSoleAuthorHusks",
    ],
    needsRuntimePin: true,
  },
  "go-tarball-deft-root": {
    shapeId: "go-tarball-deft-root",
    steps: [
      "clearOwnedHookEntries",
      "removeOwnedSkillPointers",
      "removeDeftFrameworkTree",
      "pruneEmptyAncestors",
      "removeSoleAuthorHusks",
    ],
    needsRuntimePin: true,
  },
  "submodule-deft": {
    shapeId: "submodule-deft",
    steps: [
      "clearOwnedHookEntries",
      "removeOwnedSkillPointers",
      "removeDeftFrameworkTree",
      "normalizeGitmodules",
      "pruneEmptyAncestors",
      "removeSoleAuthorHusks",
    ],
    needsRuntimePin: true,
  },
  "dual-layout-deft-and-core": {
    shapeId: "dual-layout-deft-and-core",
    steps: [
      "clearOwnedHookEntries",
      "removeOwnedSkillPointers",
      "removeDeftFrameworkTree",
      "removeCopiedCore",
      "pruneEmptyAncestors",
      "removeSoleAuthorHusks",
    ],
    needsRuntimePin: true,
  },
  "orphan-deft-version": {
    shapeId: "orphan-deft-version",
    steps: ["removeOrphanDeftVersion", "pruneEmptyAncestors"],
    needsRuntimePin: true,
  },
};

export function strategyForShape(shapeId: StrategyShapeId): LayoutStrategy {
  return STRATEGIES[shapeId];
}

/**
 * Run ordered removal steps for a layout. Accumulates removed paths for prune.
 * Fail-closed steps (e.g. unsafe submodule gitlink) return ok:false.
 */
export function runStrategy(shapeId: StrategyShapeId, root: string): StrategyResult {
  const strategy = strategyForShape(shapeId);
  const removed: string[] = [];
  const modified: string[] = [];
  for (const stepId of strategy.steps) {
    try {
      const result = runStep(stepId, {
        root,
        priorRemoved: removed,
        shapeId,
      });
      removed.push(...result.removed);
      modified.push(...result.modified);
    } catch (err) {
      if (err instanceof RemovalStepError) {
        return {
          shapeId,
          removed,
          modified,
          ok: false,
          message: err.message,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { shapeId, removed, modified, ok: false, message };
    }
  }
  return { shapeId, removed, modified, ok: true };
}
