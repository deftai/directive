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
 */
import { isHumanApprovalStamp } from "./digest.js";

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
