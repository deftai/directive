/**
 * Handoff evidence bound-proof contract (#3120).
 *
 * Makes invented remote artifact claims an illegal shape under status pass.
 */

export type {
  AxisEvidence,
  AxisState,
  HandoffEvidence,
  HandoffEvidenceValidation,
  HandoffFailClass,
  ProofStatus,
  RemoteProbe,
} from "./validate.js";
export { canClaimPass, detectRemoteClaims, validateHandoffEvidence } from "./validate.js";
