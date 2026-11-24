/**
 * Signed approvals for observable-scope and intent-constraint records (#6945).
 *
 * A repository opts in with `.deft/approvers.json`: a signed body that lists
 * the enrolled WebAuthn authenticators, plus a proof. Records are approved by
 * a WebAuthn assertion over a canonical payload rebuilt from this repository
 * and the record's own fields.
 */

/** Trust file path, relative to the repository root. */
export const APPROVERS_FILE_REL = ".deft/approvers.json";
/** Schema of the trust file document. */
export const APPROVERS_FILE_SCHEMA = "deft.approvers.v1";
/** Domain tag of a record approval payload. */
export const RECORD_APPROVAL_SCHEMA = "deft.record-approval.v1";
/** Domain tag of a trust-file transition payload (also signs a root or re-root). */
export const APPROVERS_TRANSITION_SCHEMA = "deft.approvers-transition.v1";

/** COSE algorithm ids accepted for enrolled credentials. */
export const COSE_ALG_ES256 = -7;
export const COSE_ALG_RS256 = -257;
export const COSE_ALG_EDDSA = -8;
export const SUPPORTED_COSE_ALGS = [COSE_ALG_ES256, COSE_ALG_RS256, COSE_ALG_EDDSA] as const;
export type SupportedCoseAlg = (typeof SUPPORTED_COSE_ALGS)[number];

/** The two record kinds a record approval can name. */
export const APPROVAL_RECORD_KINDS = ["observable-scope", "intent-constraint"] as const;
export type ApprovalRecordKind = (typeof APPROVAL_RECORD_KINDS)[number];

/** Relying party the ceremony page runs under; part of the signed body. */
export interface ApproversRp {
  readonly id: string;
  readonly origins: readonly string[];
}

/** One enrolled authenticator. Binary fields are base64url. */
export interface Approver {
  readonly name: string;
  /** Credential id, base64url. */
  readonly credentialId: string;
  /** SubjectPublicKeyInfo DER of the credential key, base64url. */
  readonly publicKey: string;
  /** COSE algorithm id. */
  readonly alg: SupportedCoseAlg;
  /** Authenticator AAGUID, lowercase 8-4-4-4-12 hex. */
  readonly aaguid: string;
  readonly backupEligible: boolean;
}

/** The signed body of `.deft/approvers.json`. */
export interface ApproversBody {
  readonly repo: string;
  readonly rp: ApproversRp;
  readonly approvers: readonly Approver[];
}

/** A WebAuthn get() result. Binary fields are base64url. */
export interface AssertionProof {
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
  readonly signature: string;
}

/** A WebAuthn create() result. Binary fields are base64url. */
export interface RegistrationProof {
  readonly attestationObject: string;
  readonly clientDataJSON: string;
}

/** First version, or a new epoch after every key was lost. */
export interface RootProof {
  readonly kind: "root" | "re-root";
  readonly credentialId: string;
  readonly registration: RegistrationProof;
  readonly assertion: AssertionProof;
}

/** A change signed by a credential of the immediately preceding version. */
export interface TransitionProof {
  readonly kind: "transition";
  readonly credentialId: string;
  readonly assertion: AssertionProof;
}

export type TrustProof = RootProof | TransitionProof;

/** The whole `.deft/approvers.json` document. */
export interface ApproversFile {
  readonly schema: typeof APPROVERS_FILE_SCHEMA;
  readonly body: ApproversBody;
  readonly proof: TrustProof;
}

/** One signed entry of a record approval. */
export interface RecordApprovalEntry {
  readonly kind: ApprovalRecordKind;
  readonly planId: string;
  readonly xbriefRelPath: string;
  readonly recordRel: string;
  /** Observable-scope changeKind; null for intent-constraint records. */
  readonly changeKind: string | null;
  readonly contractDigest: string;
}

/** The bytes a record approval signs (canonical encoding). */
export interface RecordApprovalPayload {
  readonly schema: typeof RECORD_APPROVAL_SCHEMA;
  readonly repo: string;
  readonly entries: readonly RecordApprovalEntry[];
}

/** The bytes a trust-file version's proof signs (canonical encoding). */
export interface TransitionPayload {
  readonly schema: typeof APPROVERS_TRANSITION_SCHEMA;
  readonly repo: string;
  /** Digest of the preceding version; null only for the first root. */
  readonly predecessorDigest: string | null;
  readonly bodyDigest: string;
}

/** The `approval` field a record carries at the signed level. */
export interface RecordApproval {
  readonly payload: RecordApprovalPayload;
  readonly credentialId: string;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
  readonly signature: string;
}

/** Keys of the record `approval` field; any other key is refused. */
export const RECORD_APPROVAL_KEYS = [
  "payload",
  "credentialId",
  "authenticatorData",
  "clientDataJSON",
  "signature",
] as const;
