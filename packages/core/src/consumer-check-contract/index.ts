/**
 * consumer-check-contract package surface (#3145).
 */

export {
  CANONICAL_DEFT_TASKFILE_INCLUDE_RE,
  type ConsumerCheckContractFinding,
  type ConsumerCheckContractOptions,
  type ConsumerCheckContractResult,
  evaluateConsumerCheckContract,
  extractCheckDeps,
  frameworkTaskfileComposesRequiredGates,
  REQUIRED_CONSUMER_ENFORCEMENT_GATES,
  requiredGatesFromConsumerList,
  resolveCanonicalDeftTaskfileInclude,
  taskfileInvokesCheckOrchestrator,
  textReferencesGate,
  workflowExecutesCheck,
} from "./evaluate.js";
