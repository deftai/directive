/**
 * Signed approvals package surface (#6945).
 */
export {
  ATTESTATION_PROFILES,
  type AttestedRegistration,
  type RegistrationInput,
  type RegistrationResult,
  type RegistrationVerifier,
  verifyAttestedRegistration,
} from "./attestation.js";
export {
  base64urlDecode,
  base64urlEncode,
  buildRecordApprovalEntry,
  buildRecordApprovalPayload,
  buildRegistrationChallengePayload,
  buildTransitionPayload,
  CanonicalEncodingError,
  canonicalBytes,
  canonicalJson,
  isRepoSlug,
  normalizeRepoSlug,
  payloadHasEntry,
  recordApprovalPayloadError,
} from "./canonical.js";
export {
  type RecordApprovalCheck,
  type RecordApprovalResult,
  SIGNED_APPROVAL_CLAIM,
  SIGNED_RECORD_KEYS,
  verifyRecordApproval,
} from "./record-approval.js";
export {
  applyTrustVersion,
  computeBodyDigest,
  computeVersionDigest,
  parseApproversFile,
  type TrustChainState,
  transitionPayloadBytes,
  type VersionContext,
  type VersionResult,
} from "./trust-file.js";
export {
  loadTrustHistory,
  parseRemoteRepo,
  resolveApprovalRepo,
  resolveSignedLevel,
  SHALLOW_REMEDIATION,
  type SignedLevel,
  signedLevelFromLoad,
  type TrustChainResult,
  type TrustHistoryLoad,
  type TrustVersion,
  type VerifiedTrust,
  verifyTrustHistory,
} from "./trust-history.js";
export * from "./types.js";
export { VENDOR_ROOTS, type VendorRoot } from "./vendor-roots.js";
export { FLAG_UP, FLAG_UV, spkiOf, verifyAssertion } from "./webauthn.js";
