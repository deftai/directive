/**
 * Owner liveness on non-write hook activity (#3987).
 *
 * The occupancy lease renews on one signal: a gated product write
 * (`evaluateOccupancyWriteGate`, refresh path, #3599). After #3990 widened the
 * PreToolUse matchers, coverage is necessary and still not sufficient, because
 * eligibility — not coverage — is what keeps shell traffic off that path. Only
 * five write verbs are recognized, and a dest carrying `$` / `*` / `?`, a temp
 * path, an out-of-root target, or any compound command is refused before the
 * gate re-stamps. `cd <root>; <command>` is compound, and the mandated Windows
 * body-file flow (#2646 / #2744) is compound, `$`-bearing and temp-targeted at
 * once. So an owner can commit and push all session and still starve its own
 * lease, which is the data-loss half of #3987.
 *
 * The remedy is the one `occupancy.ts` already names in the
 * `OCCUPANCY_MAX_LEASE_MS` docblock: "refresh on non-write activity". The hook
 * fires on every matched tool call and resolves the actor from the host
 * payload, so the owner's presence is already proven there — no new identity
 * has to travel anywhere.
 *
 * Bounds, each one load-bearing (5471374558 F4):
 *
 * - Host-authoritative actor only. An ambient inherited `DEFT_SESSION_ID` is
 *   never enough. On Grok the owner id is a hook-sibling variable, and
 *   publishing it so an agent shell could present it would hand lease renewal
 *   to every descendant process — the widening the arc withdrew.
 * - Owner only, via `heartbeatOccupancy`: it never claims, never mints, never
 *   resurrects, and refuses a foreign or expired lease. Reusing it keeps one
 *   renewal path with one set of refusal semantics.
 * - `markWrite` stays false, so `last_write_at` still means "a product write
 *   was recorded" and `no recorded write` stays honest for a would-be stealer.
 * - Keyed on the lease's own worktree path, so a record describing another tree
 *   is not renewed from this one. The caller supplies the tree the mutation
 *   gates authorized against — a linked worktree, not the payload root — so a
 *   worktree write renews the worktree's lease rather than the primary's.
 * - `claimed_at` is untouched, so `OCCUPANCY_MAX_LEASE_MS` — 12 hours — is
 *   unmoved. Liveness renewal cannot outlive the absolute cap.
 * - Runs after the decision, never as an input to it. A liveness re-stamp must
 *   not change any verdict, and re-stamping before the mutation gates would
 *   suppress their own `markWrite = true` refresh by resetting the age floor.
 *
 * Bound this deliberately does not cross: a call with no write target proves
 * only the tree the host named. `projectRootFromHookPayload` takes that from
 * the payload's own `cwd`-class fields, so a session working inside a linked
 * worktree names the worktree and renews it; a session whose host reports the
 * primary checkout renews the primary. When those differ and nothing in the
 * payload says which tree the work is in, this renews neither by guessing —
 * keeping a lease alive for a tree nobody occupies is a widening, not a fix,
 * and the TTL reclaiming an unused tree is the behaviour the lease exists for.
 * `deft occupancy:heartbeat --session-id <owner>` stays the explicit path for
 * a session whose tree the host does not report.
 */

import { resolve } from "node:path";
import {
  heartbeatOccupancy,
  isOccupancyExpired,
  OCCUPANCY_REFRESH_AFTER_MS,
  readOccupancy,
} from "../session/occupancy.js";
import type { LockDeps } from "../slice/lock.js";

export type OwnerLivenessSkipReason =
  /** No host-authoritative owner resolved; ambient identity is not accepted. */
  | "no-host-authoritative-owner"
  /** Nothing to renew: no lease, or the lease is expired or age-capped. */
  | "no-live-lease"
  /** A lease exists but this actor is not its owner. */
  | "not-owner"
  /** The lease record describes a different worktree than the one hooked. */
  | "foreign-worktree"
  /** Younger than the shared re-stamp floor; renewing would rewrite per keystroke. */
  | "within-refresh-floor"
  /** The lock was busy or the lease changed under us; the lease is left alone. */
  | "refresh-unavailable";

export type OwnerLivenessOutcome =
  | { readonly restamped: true; readonly sessionId: string; readonly heartbeatAt: Date }
  | { readonly restamped: false; readonly reason: OwnerLivenessSkipReason };

export interface OwnerLivenessInput {
  /** Tree the hook fired against; also the tree whose lease may be renewed. */
  readonly projectRoot: string;
  /** Owner id the host payload resolved to, or undefined when none did. */
  readonly ownerSessionId: string | undefined;
  /** False for ambient/environment identity — such an actor never renews. */
  readonly hostAuthoritative: boolean;
  readonly now?: Date;
  readonly lockDeps?: LockDeps;
}

function skip(reason: OwnerLivenessSkipReason): OwnerLivenessOutcome {
  return { restamped: false, reason };
}

/**
 * Renew the owner's lease from a hook event that proved the owner is alive.
 *
 * Pure side effect on `occupancy.json`: the caller's decision is already made
 * and this never alters it. Every refusal path leaves the lease untouched.
 */
export function restampOwnerLivenessOnHookEvent(input: OwnerLivenessInput): OwnerLivenessOutcome {
  if (!input.hostAuthoritative) return skip("no-host-authoritative-owner");
  const owner = input.ownerSessionId?.trim() ?? "";
  if (owner.length === 0) return skip("no-host-authoritative-owner");

  const root = resolve(input.projectRoot);
  const now = input.now ?? new Date();
  const record = readOccupancy(root);
  if (record === null || isOccupancyExpired(record, now)) return skip("no-live-lease");
  // Owner only. A granted member's presence is not the owner's presence, and
  // `heartbeatOccupancy` refuses it anyway — checking here keeps the reason honest.
  if (record.sessionId !== owner) return skip("not-owner");
  if (resolve(record.worktreePath) !== root) return skip("foreign-worktree");
  // Same floor the write gate uses, for the same reason: the hook runs on a
  // large fraction of tool calls, so an unconditional renew would rewrite the
  // lease file continuously without lengthening the safe window at all.
  if (now.getTime() - record.heartbeatAt.getTime() < OCCUPANCY_REFRESH_AFTER_MS) {
    return skip("within-refresh-floor");
  }

  const beat = heartbeatOccupancy(root, {
    sessionId: owner,
    // Never fall back to an ambient owner: the resolved host identity is the
    // only thing that proves who is here.
    env: {},
    now,
    lockDeps: input.lockDeps,
  });
  if (beat.code !== 0 || beat.record === null) return skip("refresh-unavailable");
  return {
    restamped: true,
    sessionId: beat.record.sessionId,
    heartbeatAt: beat.record.heartbeatAt,
  };
}
