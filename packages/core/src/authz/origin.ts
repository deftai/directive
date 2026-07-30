/**
 * Human-origin provenance predicates (#2944).
 * Self-authored lifecycle / dispatch / xBRIEF state never counts as approval.
 */

import {
  type GrantOrigin,
  HUMAN_ORIGIN_KINDS,
  type HumanOriginGrant,
  type HumanOriginKind,
  REJECTED_ORIGIN_KINDS,
} from "./types.js";

const HUMAN_SET = new Set<string>(HUMAN_ORIGIN_KINDS);
const REJECTED_SET = new Set<string>(REJECTED_ORIGIN_KINDS);

/** True when origin.kind is an accepted human-origin kind. */
export function isHumanOriginKind(kind: string | null | undefined): kind is HumanOriginKind {
  if (kind === null || kind === undefined) return false;
  return HUMAN_SET.has(kind.trim().toLowerCase());
}

/** True when origin.kind is explicitly agent/self-authored (always reject). */
export function isRejectedOriginKind(kind: string | null | undefined): boolean {
  if (kind === null || kind === undefined) return false;
  return REJECTED_SET.has(kind.trim().toLowerCase());
}

/**
 * Structural human-origin check for a grant record.
 * Rejects missing kind, rejected kinds, empty actor, and agent-like actors.
 */
export function isHumanOriginGrant(grant: HumanOriginGrant | null | undefined): boolean {
  if (grant === null || grant === undefined) return false;
  return isHumanOrigin(grant.origin);
}

export function isHumanOrigin(origin: GrantOrigin | null | undefined): boolean {
  if (origin === null || origin === undefined) return false;
  const kind = (origin.kind ?? "").trim().toLowerCase();
  if (kind.length === 0) return false;
  if (isRejectedOriginKind(kind)) return false;
  if (!isHumanOriginKind(kind)) return false;
  const actor = (origin.actor ?? "").trim().toLowerCase();
  if (actor.length === 0) return false;
  // Agent-shaped actor strings are not human provenance even with a human kind stamp.
  if (actor === "agent" || actor.startsWith("agent:") || actor === "self") return false;
  return true;
}

/**
 * Reject evidence shapes agents commonly invent as consent:
 * allocation_context free-text, xBRIEF status, lifecycle flags, dispatch envelopes.
 * These never independently satisfy an implementation-approval gate.
 */
export function evidenceSatisfiesImplementationApproval(evidence: {
  readonly grant?: HumanOriginGrant | null;
  readonly xbriefStatus?: string | null;
  readonly allocationContext?: Record<string, unknown> | null;
  readonly dispatchEnvelope?: string | null;
  readonly lifecycleAdvancedBy?: string | null;
}): boolean {
  // Only a validated human-origin grant counts.
  if (evidence.grant !== undefined && evidence.grant !== null) {
    return isHumanOriginGrant(evidence.grant);
  }
  // Explicit non-grant evidence channels always fail closed for implement gates.
  void evidence.xbriefStatus;
  void evidence.allocationContext;
  void evidence.dispatchEnvelope;
  void evidence.lifecycleAdvancedBy;
  return false;
}
