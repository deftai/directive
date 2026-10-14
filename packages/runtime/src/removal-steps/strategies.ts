/**
 * WAVE3-V2 layout strategies — fixed table of ordered removal step ids.
 * Bookends dispatch detect → strategy; bulk logic stays in steps (smell test).
 */
import type { RemovalStepId } from "./steps.js";

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
