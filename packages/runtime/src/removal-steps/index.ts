/**
 * Shared removal steps + layout strategies (WAVE3-V2).
 * Runtime owns fs primitives so uninstall and upgrade share one substrate.
 * Launcher stays dep-free (AC3.1); cli registry only names convert-via-removals.
 */
export {
  pruneEmptyAncestors,
  removeSoleAuthorHusks,
  runStep,
  type RemovalStepId,
  type StepContext,
  type StepResult,
} from "./steps.js";
export {
  STRATEGIES,
  strategyForShape,
  type LayoutStrategy,
  type StrategyShapeId,
} from "./strategies.js";
