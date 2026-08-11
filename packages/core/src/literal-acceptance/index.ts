/**
 * Literal acceptance-command verification (#3267).
 *
 * Capture exact stated shell commands at intake; run them verbatim before done.
 * Extends #973; survives ceremony dial rapid/minimal (#3214).
 */

export {
  attachLiteralAcceptanceCommands,
  captureAndAttachLiteralAcceptance,
  captureLiteralAcceptanceCommands,
  captureLiteralAcceptanceCommandsDetailed,
  formatRejectedLedger,
  readStoredLiteralAcceptanceCommands,
  readStoredLiteralAcceptanceDetailed,
  type CaptureLiteralAcceptanceResult,
} from "./capture.js";
export {
  type EvaluateLiteralAcceptanceOptions,
  evaluateLiteralAcceptanceFromPath,
  evaluateLiteralAcceptanceFromPlan,
  isLiteralAcceptanceRequiredAtCeremonyDepth,
  resolveLiteralAcceptanceCommands,
  resolveLiteralAcceptanceDetailed,
} from "./evaluate.js";
export {
  defaultLiteralAcceptanceRunner,
  runLiteralAcceptanceCommand,
  runLiteralAcceptanceCommands,
} from "./run.js";
export {
  type CommandSafetyResult,
  evaluateCommandSafety,
  isExecutableLiteralSource,
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
