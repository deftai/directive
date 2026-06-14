# Domain pack: TEMPLATE

Copy this file to `references/domains/<your-project>.md` and replace every `<placeholder>`.

---

## Evidence adapters

| Adapter | When to use | How |
|---------|-------------|-----|
| **Logs** | Always | `<command or UI path — e.g. CloudWatch, kubectl logs, file path>` |
| **Metrics** | Concurrency, latency, errors | `<dashboard, /metrics, stats API>` |
| **Runtime config** | Flag claims | `<secrets manager, env dump — never infer from code>` |
| **External API** | User-visible status | `<e.g. CI check run, incident ticket, deploy history>` |
| **Code read** | After traps pass | Cite file:line in EV description only when logs point there |

Save excerpts to `evidence/`; register `EV-*` in ledger.

---

## Anchor

| Field | Your system |
|-------|-------------|
| Anchor id | `<traceId, requestId, jobId, …>` |
| Time window | UTC from operator or logs |
| Symptom | One line |

---

## Starter logic tree

### "Why was it slow?" / slowness

| id | title |
|----|-------|
| `branch.slowness.admission` | Never started or skipped |
| `branch.slowness.queue` | Waited for slot / queue |
| `branch.slowness.phases` | Which phase dominated (evidence only) |
| `branch.slowness.mechanism.<phase>` | Why that phase was slow (Wave 2b) |

### Terminal

| id | title |
|----|-------|
| `branch.terminal.outcome` | How it ended (timeout, error code, rollback) |

---

## Popularity traps (Wave 1)

Define 3–6 traps your team always guesses wrong.

### trap.concurrency_assumed

| Claim | Check |
|-------|-------|
| `claim.trap.concurrency.B1` | Metric shows saturation during anchor window |
| `claim.trap.concurrency.B2` | Log lifecycle shows other jobs in-flight (define terminal events) |

**Falsified when:** Anchor was sole in-flight job → `invalidates` `branch.slowness.queue`.

### trap.config_assumed

| Claim | Check |
|-------|-------|
| `claim.trap.config.B1` | Flag value read from **runtime**, not source |

### trap.downstream_blame

| Claim | Check |
|-------|-------|
| `claim.trap.downstream.B1` | Errors scoped to anchor id in window |

Add project-specific traps here.

---

## Phase mechanisms (Wave 2b)

When `branch.slowness.phases` names dominant phase `<P>`, add claims under `branch.mechanism.<P>`:

| Claim id | Mechanism to verify |
|----------|---------------------|
| `claim.mechanism.<P>.M1` | `<e.g. lock wait, pool exhaustion, N+1 queries>` |
| `claim.mechanism.<P>.M2` | `<e.g. external API latency>` |
| `claim.mechanism.<P>.M3` | `<e.g. host/fleet pressure>` |

⊗ Stop at "phase took N minutes" — that is evidence, not mechanism.

---

## Day-wide sanity (optional)

If single-anchor forensics mislead (fleet epidemic), define day-wide counters:

- Jobs started / failed / completed on anchor UTC day
- P90 duration for dominant phase

Save → `evidence/fleet-day-*.txt`, cite `EV-FLEET-*`.

---

## Disproof order (falsifier)

1. Cheapest metric/gauge for anchor id
2. Runtime config read
3. Anchor-scoped log line
4. Broader day scan
5. Exclude noise from other tenants/jobs
