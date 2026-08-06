/**
 * consumer-check-contract package surface (#3145).
 */

export {
  type ConsumerCheckContractFinding,
  type ConsumerCheckContractOptions,
  type ConsumerCheckContractResult,
  evaluateConsumerCheckContract,
  extractCheckDeps,
  REQUIRED_CONSUMER_ENFORCEMENT_GATES,
  requiredGatesFromConsumerList,
  textReferencesGate,
} from "./evaluate.js";
