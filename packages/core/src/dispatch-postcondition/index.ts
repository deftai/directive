/**
 * Dispatch postcondition acceptance (#3979).
 *
 * Distinct from handoff-evidence (#3120): parent/host verification reads bind
 * here; child probes do not. Design-critique panel path is the first-ship
 * consumer (`evaluatePanelSeatDelivery`).
 */

export type {
  ChildHandbackClaim,
  DispatchDeliveryStatus,
  DispatchedObligation,
  DispatchPostconditionFailClass,
  DispatchPostconditionVerdict,
  EnvelopePostcondition,
  ParentVerification,
  PostconditionArtifactClass,
  VerifiedThreadComment,
} from "./evaluate.js";
export { acceptDispatchPostcondition, commentBindsObligation } from "./evaluate.js";
