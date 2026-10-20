/**
 * Shared removal steps + layout strategies (WAVE3-V2).
 * Runtime owns fs primitives so uninstall and upgrade share one substrate.
 * Launcher stays dep-free (AC3.1); cli registry only names convert-via-removals.
 */
export {
  clearOwnedHookEntries,
  isUnsafeSubmoduleGitlink,
  normalizeGitmodules,
  pruneEmptyAncestors,
  RemovalStepError,
  type RemovalStepId,
  removeCopiedCore,
  removeDeftFrameworkTree,
  removeOrphanDeftVersion,
  removeOwnedSkillPointers,
  removeSoleAuthorHusks,
  runStep,
  type StepContext,
  type StepResult,
  stripLegacyLauncherPin,
} from "./steps.js";
export {
  isConvertStrategyFrom,
  type LayoutStrategy,
  runStrategy,
  STRATEGIES,
  type StrategyResult,
  type StrategyShapeId,
  strategyForShape,
} from "./strategies.js";
