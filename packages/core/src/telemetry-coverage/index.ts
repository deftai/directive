export {
  evaluateTelemetryCoverage,
  remediationFor,
  type TelemetryCoverageFinding,
  type TelemetryCoverageOptions,
  type TelemetryCoverageResult,
} from "./evaluate.js";
export {
  DEFAULT_TRIAL_STEPS,
  type FakeTrialOptions,
  type FakeTrialResult,
  type FakeTrialStep,
  type FakeTrialStepOutcome,
  missingEnrolledKinds,
  runFakeTrial,
} from "./fake-trial.js";
export {
  ENROLLED_FIELD_FIXTURE_KINDS,
  EVENT_KIND_TO_EMITTER_METHODS,
  isKindEmitterMethod,
  kindForMethod,
  methodsForKind,
  RUN_SUMMARY_EVENT_KINDS,
  type RunSummaryEventKind,
} from "./kinds.js";
export {
  type CallerHit,
  type CallerScanResult,
  DEFAULT_SCAN_ROOTS,
  EMITTER_MODULE_REL,
  scanProductionCallers,
} from "./scan-callers.js";
