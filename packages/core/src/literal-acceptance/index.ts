/**
 * Literal acceptance-command verification (#3267).
 *
 * Capture exact stated shell commands at intake; run them verbatim before done.
 * Extends #973; survives ceremony dial rapid/minimal (#3214).
 */

export {
  attachLiteralAcceptanceCommands,
  type CaptureLiteralAcceptanceResult,
  captureAndAttachLiteralAcceptance,
  captureLiteralAcceptanceCommands,
  captureLiteralAcceptanceCommandsDetailed,
  formatRejectedLedger,
  hasStructuredAcceptanceCommands,
  isProseDerivedRejection,
  readStoredLiteralAcceptanceCommands,
  readStoredLiteralAcceptanceDetailed,
} from "./capture.js";
export {
  appendLiteralAcceptanceAdvisory,
  type EvaluateLiteralAcceptanceOptions,
  evaluateLiteralAcceptanceFromPath,
  evaluateLiteralAcceptanceFromPlan,
  formatLiteralAcceptanceAdvisory,
  isLiteralAcceptanceRequiredAtCeremonyDepth,
  LITERAL_ACCEPTANCE_ADVISORY_MARKER,
  type ResolvedLiteralAcceptance,
  resolveLiteralAcceptanceCommands,
  resolveLiteralAcceptanceDetailed,
  stripLiteralAcceptanceAdvisory,
} from "./evaluate.js";
export {
  defaultLiteralAcceptanceRunner,
  runLiteralAcceptanceCommand,
  runLiteralAcceptanceCommands,
} from "./run.js";
export {
  type CommandSafetyResult,
  evaluateCommandSafety,
  evaluateNoopDenylist,
  evaluateStampAcceptanceSafety,
  isExecutableLiteralSource,
  isNoopRefusalReason,
  isVerbatimStatementSpan,
  NOOP_ACCEPTANCE_REMEDIATION,
  REJECTED_NOOP_OUTCOME,
  type RejectedNoopOutcome,
  type StampAcceptanceCommand,
  type StampAcceptanceSafetyInput,
  type StampAcceptanceSafetyResult,
  type StampSourceRung,
} from "./safety.js";
export {
  EXECUTABLE_LITERAL_SOURCES,
  LITERAL_ACCEPTANCE_METADATA_KEY,
  LITERAL_ACCEPTANCE_METADATA_KEY_CAMEL,
  LITERAL_ACCEPTANCE_REJECTED_METADATA_KEY,
  type LiteralAcceptanceCommand,
  type LiteralAcceptanceGateResult,
  type LiteralAcceptanceRunner,
  type LiteralAcceptanceRunResult,
  type LiteralAcceptanceSource,
  type RejectedLiteralCommand,
} from "./types.js";
