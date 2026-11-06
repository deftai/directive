export { waitMergeableAndMerge } from "./cascade.js";
export { classifyMonitorOutcome, parseMonitorPayload } from "./classify.js";
export {
  EXIT_CONFIG_ERROR,
  EXIT_MERGED,
  EXIT_TIMEOUT_OR_ESCALATION,
  FIRST_HOTFIX_BOOTSTRAP_RECOVERY,
  HOTFIX_LABEL,
  HOTFIX_SHAPE_A_RE,
  HOTFIX_SHAPE_B_ISSUE_REPO,
  HOTFIX_SHAPE_B_RE,
  MERGE_GATE_TASK_CHECK_NAME,
  OUTCOME_FIRST_HOTFIX_BOOTSTRAP,
  OUTCOME_HOTFIX_ACTOR_DENIED,
  OUTCOME_HOTFIX_SHAPE_INVALID,
  OUTCOME_MASTER_MERGE_GATE_RED,
  OUTCOME_UNSANCTIONED_TEST_SKIP,
} from "./constants.js";
export { cmdPrWaitMergeable, parseWaitMergeableArgs, runWaitMergeable } from "./main.js";
export { makeResult, toResultDict } from "./result.js";
export {
  evaluateAlwaysOnNamedMergeGate,
  evaluateHotfixAdmission,
  evaluateNamedMergeGateFromRuns,
  evaluateNonCascadeCandidateGreen,
  evaluateSemanticGreen,
  parseHotfixShape,
  selectNamedMergeGateRun,
} from "./semantic-green.js";
export type {
  MergeFn,
  MonitorFn,
  ProtectedCheckFn,
  SubprocessTriple,
  WaitMergeableResult,
} from "./types.js";
export {
  captureExec,
  runGhMerge,
  runMonitor,
  runProtectedCheck,
} from "./wrappers.js";
