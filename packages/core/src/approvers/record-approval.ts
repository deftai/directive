/**
 * Record approval check at the signed level (#6945).
 *
 * At the signed level an observable-scope or intent-constraint record is
 * approved only when its `approval` verifies against a key enrolled in the
 * merge-base trust file, over a payload rebuilt from this repository and the
 * record's own fields. The payload copy stored in the record is read only for
 * its sibling entries: its repo must be this repository and it must hold this
 * record's rebuilt entry exactly. The approver name comes from the trust
 * file's credential mapping, never from the record.
 *
 * Callers run this on the selected record only; a selected record that fails
 * is treated as absent, so one stale record does not fail unrelated plans.
 */
import {
  buildRecordApprovalEntry,
  canonicalBytes,
  payloadHasEntry,
  recordApprovalPayloadError,
} from "./canonical.js";
import {
  type ApprovalRecordKind,
  type ApproversBody,
  RECORD_APPROVAL_KEYS,
  type RecordApprovalEntry,
  type RecordApprovalPayload,
} from "./types.js";
import { verifyAssertion } from "./webauthn.js";

/** Record keys accepted at the signed level; any other key is refused. */
export const SIGNED_RECORD_KEYS: Readonly<Record<ApprovalRecordKind, readonly string[]>> = {
  "observable-scope": [
    "schema",
    "planId",
    "xbriefRelPath",
    "approvedAt",
    "changeKind",
    "oracle",
    "allowedChanges",
    "mustPreserve",
    "humanApproval",
    "contractDigest",
    "approval",
  ],
  "intent-constraint": [
    "schema",
    "planId",
    "xbriefRelPath",
    "approvedAt",
    "constraints",
    "humanApproval",
    "contractDigest",
    "approval",
  ],
};

/**
 * What a valid approval proves, and the named residuals. Printed with every
 * signed-level refusal.
 */
export const SIGNED_APPROVAL_CLAIM =
  "A valid approval proves a user-verified gesture by an enrolled authenticator over exactly this set. " +
  "The human read the set only if the approval page ran on a device the agent does not drive and was " +
  "deployed with credentials the agent does not hold; Windows Hello, Touch ID, a desktop USB key and the " +
  "desktop browser's cross-device QR are a lower review assurance than the phone's own browser. " +
  "Residuals: removing the surfaces policy, editing CI or pinning an older runtime turns this check off " +
  "without forging an approval (#6207); an approval stays valid while its key stays enrolled, so deleting " +
  "a record does not revoke it and nothing expires (#6945).";

export interface RecordApprovalCheck {
  readonly kind: ApprovalRecordKind;
  /** The record JSON as read from the merge base. */
  readonly record: unknown;
  /** The record's own path, as listed at the merge base. */
  readonly recordRel: string;
  /** Fields from the parsed record (the parser already checked contractDigest). */
  readonly planId: string;
  readonly xbriefRelPath: string;
  readonly changeKind: string | null;
  readonly contractDigest: string;
  /** This repository, lowercase `owner/repo`. */
  readonly repo: string;
  /** The verified merge-base trust body. */
  readonly body: ApproversBody;
}

export type RecordApprovalResult =
  | { readonly ok: true; readonly approver: string; readonly entry: RecordApprovalEntry }
  | { readonly ok: false; readonly reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Verify a selected record's approval at the signed level. */
export function verifyRecordApproval(input: RecordApprovalCheck): RecordApprovalResult {
  const refuse = (reason: string): RecordApprovalResult => ({ ok: false, reason });
  if (!isObject(input.record)) return refuse("record is not a JSON object");
  const allowed = SIGNED_RECORD_KEYS[input.kind];
  const unknown = Object.keys(input.record).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) return refuse(`unknown record key ${unknown.sort().join(", ")}`);
  const approval = input.record.approval;
  if (approval === undefined) return refuse("record carries no approval");
  if (!isObject(approval)) return refuse("approval must be an object");
  const approvalKeys = Object.keys(approval).sort().join(",");
  if (approvalKeys !== [...RECORD_APPROVAL_KEYS].sort().join(",")) {
    return refuse(`approval keys must be exactly ${RECORD_APPROVAL_KEYS.join(", ")}`);
  }
  for (const field of ["credentialId", "authenticatorData", "clientDataJSON", "signature"]) {
    if (typeof approval[field] !== "string") return refuse(`approval.${field} must be a string`);
  }
  const payloadError = recordApprovalPayloadError(approval.payload);
  if (payloadError !== null) return refuse(`approval payload: ${payloadError}`);
  const stored = approval.payload as RecordApprovalPayload;
  if (stored.repo !== input.repo) {
    return refuse(`approval names repository ${stored.repo}, this repository is ${input.repo}`);
  }
  const entry = buildRecordApprovalEntry({
    kind: input.kind,
    planId: input.planId,
    xbriefRelPath: input.xbriefRelPath,
    recordRel: input.recordRel,
    changeKind: input.changeKind,
    contractDigest: input.contractDigest,
  });
  if (!payloadHasEntry(stored, entry)) {
    return refuse("approval payload does not hold this record's entry as rebuilt from its fields");
  }
  const rebuilt: RecordApprovalPayload = {
    schema: stored.schema,
    repo: input.repo,
    entries: stored.entries,
  };
  const credentialId = approval.credentialId as string;
  const approver = input.body.approvers.find((a) => a.credentialId === credentialId);
  if (approver === undefined) return refuse("approval credential is not enrolled in .deft/approvers.json");
  const error = verifyAssertion({
    payloadBytes: canonicalBytes(rebuilt),
    rp: input.body.rp,
    alg: approver.alg,
    publicKey: approver.publicKey,
    authenticatorData: approval.authenticatorData as string,
    clientDataJSON: approval.clientDataJSON as string,
    signature: approval.signature as string,
  });
  if (error !== null) return refuse(error);
  return { ok: true, approver: approver.name, entry };
}
