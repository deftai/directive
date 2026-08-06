# Delivery-attempt circuit breaker (#3143)

Deterministic pre-dispatch gate and durable attempt ledger for autonomous
**delivery** and **operational-acceptance** loops.

This is the mechanical enforcement surface for the delivery/acceptance subset of
the dual-stop principle (#2442). Skill defaults (build / swarm / review-cycle)
remain behavioral; hosts and orchestrators that dispatch delivery workflows
MUST evaluate this gate before automatic retry or re-dispatch.

## Module

| Path | Role |
|------|------|
| `packages/core/src/delivery-attempt/` | Library (types, fingerprint, material-delta, ledger, evaluate, handoff) |
| `@deftai/directive-core/delivery-attempt` | Package subpath export |
| `.deft/delivery-attempts/` | On-disk unit ledgers (project-local) |

## Pre-dispatch decisions

`evaluatePreDispatch(ledger, input)` returns one of:

| Decision | Meaning |
|----------|---------|
| `ALLOW_FIRST_ATTEMPT` | No open failure identity for the unit |
| `ALLOW_TRANSIENT_RETRY` | Bounded retry after a transient (or under-threshold unknown) failure |
| `ALLOW_MATERIAL_PROGRESS` | Relevant material delta addresses the failing invariant |
| `ALLOW_OVERRIDE` / `ALLOW_RESUME` | Audited override or satisfied resume condition |
| `DENY_DUPLICATE_ACTIVE` | Queued/running attempt already exists for the unit |
| `BLOCK_NON_RETRYABLE` | Deterministic failure without progress |
| `BLOCK_NO_MATERIAL_PROGRESS` | Same failure class, no relevant delta |
| `BLOCK_REPEATED_UNKNOWN` | Identical unknown failures hit the threshold |
| `BLOCK_ATTEMPT_BUDGET` | Failed-dispatch budget for the phase exhausted |
| `BLOCK_ELAPSED_BUDGET` | Wall-clock budget exhausted |
| `BLOCK_TOOL_OR_TOKEN_BUDGET` | Tool-call (or host-token when telemetried) budget exhausted |

Once a **block** decision is emitted, automatic re-dispatch MUST stop until a
declared resume condition is satisfied or an audited operator override is
recorded. Persist the terminal handoff (`buildTerminalHandoff` /
`formatHandoffReport`) before the worker exits.

## Unit key and durability

Logical unit: `scopeId + targetId + workflowId`.

Counters (`failedAttemptCount`, `sameFailureCounts`, elapsed/tool/token totals)
survive:

- worker replacement / takeover
- session restart and context compaction
- new source revisions (fingerprint counters do **not** reset)

Raw logs, credentials, and secret-bearing payloads MUST NOT be stored in the
ledger. Failure fingerprints redact volatile ids, paths, timestamps, and
secret-like values (`computeFailureFingerprint`).

## Material progress

Material progress means verifiable state changed in a way that can resolve or
advance beyond the current failure (code/config/evidence/external-state/stage
that **addresses** the failing invariant).

Not material progress by themselves:

- new revision identifiers alone
- repeating the same dispatch
- restating analysis
- replacing the worker
- compaction / session restart
- evidence bound to an intermediate revision when evaluating a later revision

## Safe defaults (`DEFAULT_DELIVERY_BUDGET_POLICY`)

| Knob | Default |
|------|---------|
| max active (queued+running) | 1 |
| max automatic transient retries | 1 |
| identical unknown without progress → block | 2 |
| failed dispatches per phase → block | 3 |
| max elapsed seconds | 3600 |
| max tool calls | 500 |
| max host tokens | null (enforce only when host exposes usage **and** policy sets a cap) |

Missing host token telemetry does **not** disable the circuit breaker — elapsed
and tool-call budgets still apply.

## Operator override

`recordOperatorOverride` requires actor, rationale, timestamp, bounded
`allowedAttempts`, and optional expiry. Overrides do **not** erase attempt
history.

## Skill routing

| Surface | Role |
|---------|------|
| `main.md` Dual Stop Rule (#2442) | Principle; points here for delivery/acceptance |
| build / swarm / review-cycle skills | Behavioral dual-stop defaults; point here for mechanical gate |
| swarm `core-ops` / `core-phase-4` | Prompt + monitor envelopes; do not invent a second ledger |

## Typical call shape

Use the **locked disk APIs** for concurrent-safe begin/complete. Do not evaluate
on a stale in-memory snapshot and then `saveUnitLedger` without the unit lock.

```ts
import {
  beginAttemptOnDisk,
  completeAttemptOnDisk,
  buildFailureInfo,
} from "@deftai/directive-core/delivery-attempt";

// beginAttemptOnDisk: exclusive lock → reload → evaluatePreDispatch → begin → save
let attempt;
try {
  const begun = beginAttemptOnDisk(projectRoot, {
    scopeId,
    targetId,
    workflowId,
    sourceRevision,
    trigger: "automatic",
    anticipatedFailure: lastFailure,
    materialDelta: claims,
  });
  attempt = begun.attempt;
} catch (err) {
  // DENY_*/BLOCK_* — handoff already persisted when blocked
  return;
}

// ... run workflow ...

// completeAttemptOnDisk: exclusive lock → reload → complete → save
const closed = completeAttemptOnDisk(projectRoot, {
  scopeId,
  targetId,
  workflowId,
  attemptId: attempt.attemptId,
  status: "failed",
  failure: buildFailureInfo({ stage, code, message, retryability }),
});
```

Pure in-memory helpers (`evaluatePreDispatch`, `beginAttempt`, `completeAttempt`)
remain for tests and single-threaded hosts. Multi-worker orchestration MUST use
`beginAttemptOnDisk` / `completeAttemptOnDisk` (or `withUnitLock` around an
equivalent sequence). Abandoned unit locks are reclaimed when the owner PID is
dead, the lock record is corrupt, or the lock `startedAt` is older than the
stale window (default 5 minutes — covers PID reuse). Reclaim is serialized via
an exclusive `*.lock.reclaim` ticket so concurrent reclaimers cannot unlink a
live replacement lock. If a lock remains stuck (e.g. live holder hung longer
than the stale window and you still cannot proceed), delete the matching
`.lock` / `.lock.reclaim` files under `.deft/delivery-attempts/` manually.

## Observability

Every evaluation emits a structured `PreDispatchDecisionEvent`
(`decision`, `reasonCode`, retryability, fingerprint, counters, material-delta
class, resume condition, override id). Aggregate metrics can count duplicate
denies, deterministic blocks, and budget savings from early halt.

## Non-goals

- Weakening validation, review, or deploy safety gates
- Treating every different downstream failure as the same failure
- Preventing deliberate audited overrides
- Provider-specific CI/CD lock-in
- Prompt-only thrashing control (use dual-stop skill defaults for that class)
