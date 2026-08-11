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
  readStoredLiteralAcceptanceCommands,
} from "./capture.js";
export {
  evaluateLiteralAcceptanceFromPath,
  evaluateLiteralAcceptanceFromPlan,
  isLiteralAcceptanceRequiredAtCeremonyDepth,
  resolveLiteralAcceptanceCommands,
  type EvaluateLiteralAcceptanceOptions,
} from "./evaluate.js";
export {
  defaultLiteralAcceptanceRunner,
  runLiteralAcceptanceCommand,
  runLiteralAcceptanceCommands,
} from "./run.js";
export {
  LITERAL_ACCEPTANCE_METADATA_KEY,
  LITERAL_ACCEPTANCE_METADATA_KEY_CAMEL,
  type LiteralAcceptanceCommand,
  type LiteralAcceptanceGateResult,
  type LiteralAcceptanceRunner,
  type LiteralAcceptanceRunResult,
  type LiteralAcceptanceSource,
} from "./types.js";
