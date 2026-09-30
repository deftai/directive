export { type CachedCheckOptions, dispatchCachedTaskCheck } from "./cached-orchestrator.js";
export {
  allGatesCliDispatchable,
  checkGateCliArgv,
  cliSpawnPlan,
  GLOBAL_CLI_REMEDY,
  isCliNativeGate,
  resolveGateDispatch,
  resolveGlobalCliBin,
} from "./cli-native-gates.js";
export {
  CHECK_GRAPH_REQUIRED_NAMESPACES,
  CONSUMER_GATE_INTEGRITY_RECOVERY,
  type ConsumerGateIntegrityFinding,
  type ConsumerGateIntegrityResult,
  type ConsumerGateIntegritySeams,
  checkGraphOptionalIncludeViolations,
  evaluateConsumerGateIntegrity,
  formatConsumerGateIntegrityFailure,
  gateLocalName,
  gateNamespace,
  includeTaskfileRel,
  parseTaskfileIncludes,
  requiredNamespacesForGates,
  taskDefinedInTaskfileYaml,
} from "./consumer-gate-integrity.js";
export {
  type CheckGateSpec,
  CONSUMER_CHECK_GATES,
  checkGateId,
  checkGateSpawnArgs,
  FRAMEWORK_CHECK_GATES,
  gatesForCheckTarget,
  isFastBeforeSlowOrder,
  isSuiteCheckGate,
  PRODUCT_FIRST_AC_GATE,
  SUITE_CHECK_GATE_IDS,
} from "./gate-lists.js";
export {
  extractGateCause,
  formatDegradedSkipReport,
  formatNamedCauseFailure,
  type NamedCauseMessage,
  remedyForGate,
} from "./named-cause.js";
export type {
  CachedCheckCompletion,
  CheckOrchestratorOptions,
  CheckOrchestratorSeams,
} from "./orchestrator.js";
export {
  dispatchTaskCheck,
  isFrameworkRepoRoot,
  isFrameworkSourceContext,
  resolveCheckTarget,
} from "./orchestrator.js";
export {
  CHECK_EMPTY_PLANNING_NARRATIVES_GATE_ID,
  type CheckPersistedPlanningNarrativesSeams,
  checkRejectsEmptyPlanningNarratives,
  evaluateCheckPersistedPlanningNarratives,
} from "./persisted-planning-narratives-gate.js";
export {
  lookupProductMutationCompletion,
  PRODUCT_MUTATION_COMPLETION_MARKER_REL,
  type ProductMutationCompletionLookup,
  type ProductMutationCompletionMarker,
  productMutationCompletionAtRoot,
  productMutationCompletionMarkerPath,
  type RecordProductMutationCompletionResult,
  recordProductMutationCompletion,
} from "./product-mutation-completion.js";
export {
  detectTestRunner,
  type RunnerDetectResult,
  runnerDetectionTable,
  type TestRunnerKind,
} from "./runner-detect.js";
export {
  type ResolveSessionCompletedAcInput,
  resolveSessionCompletedVerifyAcTarget,
  SESSION_COMPLETED_AC_REMEDIATION,
  SESSION_COMPLETED_MARKER_REL,
  type SessionCompletedAcTarget,
  type SessionCompletedMarker,
  sessionCompletedMarkerPath,
  writeSessionCompletedMarker,
} from "./session-completed-ac.js";
