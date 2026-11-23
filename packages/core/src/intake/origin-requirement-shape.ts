/**
 * Requirement-shaped origin comments (#7138, slice of #7007).
 *
 * `xbrief:preflight` refuses a drifted origin only when a comment can carry a
 * requirement. A comment has a requirement shape when it starts with the
 * design-critique comment lead (`model:` then `role:`), when it is the Current
 * shape comment that `selectIngestCurrentShape` selects, or when it carries an
 * `## Acceptance Criteria` list written by the issue author or by an account
 * with write access. An unanswered permission lookup is never read as "not a
 * writer": it is its own verdict, so the caller can refuse on it.
 */
import { criteriaListUnits } from "./admitted-source-units.js";
import { type IssueComment, selectIngestCurrentShape } from "./issue-ingest.js";

/** Why a comment has a requirement shape, or why that cannot be told. */
export type OriginRequirementShape =
  | "design-critique"
  | "current-shape"
  | "acceptance-criteria"
  | "permission-unknown";

/**
 * Write-access lookup for a comment author: true (may write), false (may not),
 * or null when the lookup cannot answer.
 */
export type AuthorWriteLookup = (login: string) => boolean | null;

const MODEL_LEAD_RE = /^model:\s*\S+/;
const ROLE_LEAD_RE = /^role:\s*\S+/;

/** Does the comment start with the design-critique lead, `model:` then `role:`? */
export function hasDesignCritiqueCommentLead(body: string): boolean {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const first = lines[0];
  const second = lines[1];
  return (
    first !== undefined &&
    second !== undefined &&
    MODEL_LEAD_RE.test(first) &&
    ROLE_LEAD_RE.test(second)
  );
}

/** Login of a comment's author, or null. */
export function commentAuthorLogin(comment: IssueComment): string | null {
  const login = comment.user?.login;
  return typeof login === "string" && login.length > 0 ? login : null;
}

/**
 * Id of the comment `selectIngestCurrentShape` selects from a thread, or null.
 * The same selector ingest used for the CurrentShape narrative.
 */
export function selectedCurrentShapeId(thread: readonly IssueComment[]): number | null {
  return selectIngestCurrentShape(thread)?.id ?? null;
}

/**
 * Requirement shape of one comment, or null when it has none. `currentShapeId`
 * is the id the selector picked from the same thread. The write lookup runs
 * only for an Acceptance Criteria list whose author is not the issue author.
 */
export function classifyOriginRequirementShape(input: {
  readonly comment: IssueComment;
  readonly currentShapeId: number | null;
  readonly issueAuthor: string | null;
  readonly mayWrite: AuthorWriteLookup;
}): OriginRequirementShape | null {
  const body = typeof input.comment.body === "string" ? input.comment.body : "";
  if (hasDesignCritiqueCommentLead(body)) {
    return "design-critique";
  }
  if (input.currentShapeId !== null && Number(input.comment.id) === input.currentShapeId) {
    return "current-shape";
  }
  if (criteriaListUnits(body).length === 0) {
    return null;
  }
  const login = commentAuthorLogin(input.comment);
  if (login === null) {
    return "permission-unknown";
  }
  if (input.issueAuthor !== null && login.toLowerCase() === input.issueAuthor.toLowerCase()) {
    return "acceptance-criteria";
  }
  const mayWrite = input.mayWrite(login);
  if (mayWrite === null) {
    return "permission-unknown";
  }
  return mayWrite ? "acceptance-criteria" : null;
}
