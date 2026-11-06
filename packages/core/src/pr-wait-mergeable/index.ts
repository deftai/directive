export { waitMergeableAndMerge } from "./cascade.js";
export { classifyMonitorOutcome, parseMonitorPayload } from "./classify.js";
export {
  EXIT_CONFIG_ERROR,
  EXIT_MERGED,
  EXIT_TIMEOUT_OR_ESCALATION,
} from "./constants.js";
export { cmdPrWaitMergeable, parseWaitMergeableArgs, runWaitMergeable } from "./main.js";
export { makeResult, toResultDict } from "./result.js";
export type {
  MergeFn,
  MonitorFn,
  ProtectedCheckFn,
  SubprocessTriple,
  WaitMergeableResult,
} from "./types.js";
export {
  evaluateHotfixAdmission,
  evaluateNamedMergeGateOnRuns,
  MASTER_MERGE_GATE_CHECK_NAME,
  NAMED_MERGE_GATE_PENDING_TIMEOUT_MS,
  OUTCOME_HOTFIX_SHAPE_INVALID,
  OUTCOME_MASTER_MERGE_GATE_RED,
  OUTCOME_MASTER_MERGE_GATE_UNREADABLE,
  parseHotfixBodyShape,
  readNamedMasterMergeGate,
} from "./semantic-green.js";
export {
  captureExec,
  runGhMerge,
  runMonitor,
  runProtectedCheck,
} from "./wrappers.js";
