/**
 * Record stamps for the two declared records (#7031).
 *
 * `scope:record-observable-scope` and `scope:record-intent-constraint` write
 * from any shell with a `declared` stamp that names the command. A declared
 * stamp is a declaration the product check holds the PR to, not an approval.
 * `isHumanApprovalStamp` stays closed to it, so approved-scope, the one-PR
 * proof and every other human-approval reader still refuse a declared record.
 * Both record builders and both parsers use `isRecordStamp`, so legacy
 * human-stamped records (including `mintedVia: in-harness-ask`) still parse.
 *
 * Signed level (#6945): with `.deft/approvers.json` on the merge base's
 * history, a stamp alone approves nothing. Both evaluators resolve the level
 * with `resolveRecordApprovalLevel` and admit the selected record with
 * `admitSignedRecord`; a record without a valid approval is treated as absent.
 */
import {
  type ApprovalRecordKind,
  resolveSignedLevel,
  SIGNED_APPROVAL_CLAIM,
  type SignedLevel,
  verifyRecordApproval,
} from "../approvers/index.js";
import { isHumanApprovalStamp } from "./digest.js";

export type { SignedLevel };
export { SIGNED_APPROVAL_CLAIM };

/** The approval level at `mergeBase`; `injected` wins (tests). */
export function resolveRecordApprovalLevel(
  projectRoot: string,
  mergeBase: string,
  injected?: SignedLevel,
): SignedLevel {
  return injected ?? resolveSignedLevel(projectRoot, mergeBase);
}

/** The selected record, as both evaluators hold it after parsing. */
export interface SignedRecordCandidate {
  readonly kind: ApprovalRecordKind;
  readonly recordRel: string;
  /** Record text at the merge base. */
  readonly text: string;
  readonly planId: string;
  readonly xbriefRelPath: string;
  readonly changeKind: string | null;
  readonly contractDigest: string;
}

/**
 * Admit the selected record at the signed level. On refusal the reason is
 * ready to print: it says the record is treated as absent and carries the
 * honest claim.
 */
export function admitSignedRecord(
  level: Extract<SignedLevel, { readonly ok: true }>,
  candidate: SignedRecordCandidate,
):
  | { readonly ok: true; readonly approver: string }
  | { readonly ok: false; readonly reason: string } {
  let record: unknown;
  try {
    record = JSON.parse(candidate.text) as unknown;
  } catch {
    record = null;
  }
  const result = verifyRecordApproval({
    kind: candidate.kind,
    record,
    recordRel: candidate.recordRel,
    planId: candidate.planId,
    xbriefRelPath: candidate.xbriefRelPath,
    changeKind: candidate.changeKind,
    contractDigest: candidate.contractDigest,
    repo: level.repo,
    body: level.trust.body,
  });
  if (result.ok) return { ok: true, approver: result.approver };
  return {
    ok: false,
    reason:
      `${candidate.recordRel} is not approved at the signed level (.deft/approvers.json): ${result.reason}. ` +
      "It is treated as absent; it needs a fresh approval signed by a key enrolled in .deft/approvers.json. " +
      SIGNED_APPROVAL_CLAIM,
  };
}

/** Text for an unusable trust file at the signed level. */
export function signedLevelRefusal(level: Extract<SignedLevel, { readonly ok: false }>): string {
  return `signed level (.deft/approvers.json) refuses: ${level.reason}. ${SIGNED_APPROVAL_CLAIM}`;
}

/** Suffix for a passing signed-level verify. */
export function signedLevelNote(
  level: Extract<SignedLevel, { readonly ok: true }>,
  approver: string,
): string {
  return ` Signed level: approved by ${approver}; root ${level.trust.rootKind}, epoch from ${level.trust.epochStart.slice(0, 12)}.`;
}

/** Stamp kind the two record commands write (#7031). */
export const DECLARED_STAMP_KIND = "declared";

/** The command that writes declared observable-scope records (#7031). */
export const OBSERVABLE_SCOPE_WRITER_VERB = "scope:record-observable-scope";
/** The command that writes declared intent-constraint records (#7031). */
export const INTENT_CONSTRAINT_WRITER_VERB = "scope:record-intent-constraint";

/** The two commands that write declared records (#7031). */
export const DECLARED_RECORD_WRITER_VERBS = [
  OBSERVABLE_SCOPE_WRITER_VERB,
  INTENT_CONSTRAINT_WRITER_VERB,
] as const;
export type DeclaredRecordWriterVerb = (typeof DECLARED_RECORD_WRITER_VERBS)[number];

/** Stamp shape shared by the observable-scope and intent-constraint records. */
export interface RecordStamp {
  readonly kind: string;
  readonly actor: string;
  readonly mintedAt: string;
  readonly mintedVia?: string;
}

/**
 * True for `{kind: "declared"}` written by `writerVerb`: `mintedVia` names that
 * command and `mintedAt` is set. The actor is a declared-by display name and
 * may be an agent, so it is not checked.
 */
export function isDeclaredRecordStamp(
  stamp: RecordStamp | null | undefined,
  writerVerb: DeclaredRecordWriterVerb,
): boolean {
  if (stamp === null || stamp === undefined) return false;
  if (stamp.kind !== DECLARED_STAMP_KIND) return false;
  if (stamp.mintedVia !== writerVerb) return false;
  return typeof stamp.mintedAt === "string" && stamp.mintedAt.trim().length > 0;
}

/**
 * The one predicate the record builders and parsers use: a declared stamp from
 * `writerVerb`, or a stamp `isHumanApprovalStamp` accepts (legacy records).
 */
export function isRecordStamp(
  stamp: RecordStamp | null | undefined,
  writerVerb: DeclaredRecordWriterVerb,
): boolean {
  return isDeclaredRecordStamp(stamp, writerVerb) || isHumanApprovalStamp(stamp);
}
