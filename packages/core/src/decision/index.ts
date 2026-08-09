/**
 * Structured agent decision log (#1396).
 *
 * CLI surface: task decision:write / task decision:list
 */

import { decisionListMain } from "./list.js";
import { decisionWriteMain } from "./write.js";

export {
  type DecisionListCliArgs,
  type DecisionListEntry,
  type DecisionListOptions,
  type DecisionListResult,
  decisionListMain,
  parseDecisionListArgs,
  runDecisionList,
} from "./list.js";
export {
  DECISION_FILE_SUFFIX,
  DECISION_SCHEMA_VERSION,
  DECISIONS_DIR_REL,
  type DecisionAlternative,
  type DecisionConfidence,
  type DecisionGoverningRule,
  type DecisionRecord,
  type DecisionValidationError,
  type DecisionValidationResult,
  datePrefixFromTimestamp,
  decisionFilename,
  formatDecisionValidationErrors,
  normalizeTimestamp,
  slugifyDecision,
  validateDecisionRecord,
} from "./schema.js";
export {
  appendScopeDecisionPointer,
  type DecisionWriteCliArgs,
  type DecisionWriteInput,
  type DecisionWriteOutcome,
  type DecisionWriteResult,
  decisionWriteMain,
  parseDecisionWriteArgs,
  runDecisionWrite,
} from "./write.js";

/**
 * Unified CLI entry for dispatch when verb is decision-write / decision-list.
 * Expects first argv token to be the subcommand (write|list) when routed via
 * a single decision stem; dispatch registers separate stems per verb.
 */
export function mainEntry(argv: string[] = process.argv.slice(2)): number {
  const [head, ...rest] = argv;
  if (head === "write" || head === "decision:write") {
    return decisionWriteMain(rest);
  }
  if (head === "list" || head === "decision:list") {
    return decisionListMain(rest);
  }
  // When dispatch loads decision-write / decision-list stems, argv has no head.
  // Callers use decisionWriteMain / decisionListMain directly from loadCoreModuleHandler.
  process.stderr.write("decision: unknown subcommand. Use decision:write or decision:list.\n");
  return 2;
}

export function writeMainEntry(argv: string[] = process.argv.slice(2)): number {
  return decisionWriteMain(argv);
}

export function listMainEntry(argv: string[] = process.argv.slice(2)): number {
  return decisionListMain(argv);
}
