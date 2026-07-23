export type { CheckOrchestratorOptions, CheckOrchestratorSeams } from "./orchestrator.js";
export {
  dispatchTaskCheck,
  isFrameworkRepoRoot,
  isFrameworkSourceContext,
  resolveCheckTarget,
} from "./orchestrator.js";
export { dispatchCachedTaskCheck } from "./cached-orchestrator.js";
export { CONSUMER_CHECK_GATES, FRAMEWORK_CHECK_GATES, gatesForCheckTarget } from "./gate-lists.js";
export {
  detectTestRunner,
  runnerDetectionTable,
  type RunnerDetectResult,
  type TestRunnerKind,
} from "./runner-detect.js";
