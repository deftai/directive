# `verify:orphan-active`: verdict basis and freshness (#3767)

`verify:orphan-active` decides whether an `xbrief/active/` brief with
`plan.status == running` is really still live work. Until #3767 it answered
that question from a triage-cache hit returned **unconditionally** — no age
bound, no re-validation. A cached `open` written twelve hours earlier beat
reality and suppressed the live read that would have corrected it, so the gate
exited 0 while scanning the very brief whose issue had already closed.

This document records what the gate now does, why, and what it still cannot
promise.

Legend (RFC2119): `!`=MUST, `~`=SHOULD, `⊗`=MUST NOT, `?`=MAY.

---

## Two modes, split by query shape

The gate has two callers with different obligations, so it has two mechanisms.

| | Scoped `--issue N` | Unscoped aggregate |
|---|---|---|
| Caller | after-merge DONE proof (#3429 / #3476) | `task check`, pre-commit, pre-push sweep |
| Mechanism | authoritative per-issue REST read | one complete open-issue inventory |
| N | 1 | one call regardless of brief count |
| Unknown state | **fail closed** (exit 1, `unresolved`) | **fail open** (exit 0, reported `unverified`) |
| Latency budget | 5 s | 15 s |

The unknown asymmetry is deliberate and predates this change. Scoped is a proof
obligation before a worker claims DONE about one named origin. The aggregate
sweep must not make offline work network-authorized — hard-failing every
aggregate unknown would break `--skip-gh`, offline runs, and fresh clones.

⊗ Do not flatten the two unknown policies into one rule.

---

## The freshness choice

**Age bound plus re-validation, applied per mode.** Both options offered by
#3767 are used, because each mode needs a different one.

- A cache hit is honoured only when it is at most **15 minutes** old
  (`ISSUE_CACHE_MAX_AGE_MS`). Older entries are not evidence.
- Scoped `--issue N` re-validates first: it takes the authoritative read and
  falls back to the cache only inside the age bound, when the live read is
  unavailable. Unknown after that is `unresolved`.
- The aggregate sweep resolves from the open-issue inventory when the network
  is allowed, and uses an in-bound cache hit only under `--skip-gh` or when the
  inventory itself is unavailable.

15 minutes keeps a warm-cache offline run working while making an overnight
entry non-authoritative — the measured entry was roughly twelve hours old.

---

## The aggregate inventory

The sweep reuses `restIssueListOpenInventory` (#3752): one
`gh api --paginate --slurp repos/<owner>/<repo>/issues?state=open&per_page=100`
subprocess. It excludes pull-request rows and **fails closed** on command
failure, non-JSON output, a non-array payload, a malformed row, buffer
exhaustion, and the pagination cap.

! The inventory MUST be complete. `probeCacheDrift`'s helper defaults to a
1,000-item limit; reusing that capped set as a closed-state oracle would
misclassify open issue 1001+ in a larger repository.

Membership in a successful inventory means open. **Absence means "not open"**,
which is the direction that tells an operator to run `scope:complete` on what
may be live work — so absence is confirmed by one authoritative per-issue read
before the gate acts on it. In the ordinary case (everything open) that costs
zero extra calls.

When the inventory is unavailable the gate reports `unverified` rather than
inferring closed. Fail-closed here means never manufacturing a false "closed",
not turning the sweep into a connectivity check.

### Why not a live read per brief

Per-brief live reads are the mechanism #3752 removed. Measured: the inventory
is **4.2 s constant**, against **14.2 s** and **76.6 s** for sequential
per-brief reads at the WIP cap of 20 on two different hosts. Crossover is about
5 briefs on `gh` and about 1 on `ghx`. `verify:orphan-active` sits in the
fast-preflight tier, where wall clock rather than REST quota is the constraint.

---

## Reported basis

Every run now says how it decided, so a verified pass is distinguishable from
an unverified one:

```text
verify:orphan-active: no orphaned active/running xBRIEFs (scanned 3 running briefs in active/).
  Basis: inventory 2, cache 1 (max age 4m).
```

```text
verify:orphan-active: no orphaned active/running xBRIEFs (scanned 1 running brief in active/).
  Basis: unverified 1.
  UNVERIFIED: state could not be established for the references below, so this run is
  not evidence that they are unshipped:
    - #8001 (open-issue inventory unavailable: gh api failed: ...)
```

`EvaluateResult.basis` carries the same counts structurally
(`inventory`, `live`, `cache`, `unverified`, `maxCacheAgeMs`, `proxied`,
`elapsedMs`, `budgetMs`).

⊗ Do not cite an exit 0 with `unverified > 0` as evidence that a tree is clean.

---

## The `ghx` caveat

"Live" is itself a cache. `defaultRunGh` resolves through `resolveBinary()`,
which prefers **`ghx`**, a cached read-only GET proxy whose age nothing in this
gate can inspect.

This gate therefore **pins plain `gh`** for its authoritative reads when `gh` is
on PATH. When only `ghx` is available the gate still runs, sets
`basis.proxied`, and prints:

```text
  Note: reads resolved through `ghx`, a cached GET proxy; freshness is bounded by that
  proxy, which this gate cannot inspect (#3737).
```

⊗ Do not claim the gate detects a closed origin "regardless of cache age" while
`ghx` is in the path. Whether `resolveBinary` should prefer `ghx` at all is
[#3737](https://github.com/deftai/directive/issues/3737).

---

## Latency budgets

There were none before #3767, which is why "affordable" was unfalsifiable.

| Mode | Budget | Basis |
|---|---|---|
| Scoped `--issue N` | 5 s | one issue read plus at most one linked-PR read, measured ~0.75 s each |
| Unscoped aggregate | 15 s | one 4.2 s inventory plus confirming reads for apparent closes |

Exceeding a budget prints an advisory line and does **not** change the exit
code. Budget drift is a signal to re-measure the mechanism, not a new failure
mode for callers.

---

## Out of scope

- The offline crash when neither `gh` nor `ghx` is on PATH
  ([#3774](https://github.com/deftai/directive/issues/3774)).
- Whether `resolveBinary` should prefer `ghx`
  ([#3737](https://github.com/deftai/directive/issues/3737)).
- The `cache_fresh` forge-error fail-open decided on
  [#3738](https://github.com/deftai/directive/issues/3738).

## Related

- [#3429](https://github.com/deftai/directive/issues/3429) — the gate's contract
- [#3476](https://github.com/deftai/directive/issues/3476) — `verify:completed-tracked`
- [#3752](https://github.com/deftai/directive/issues/3752) — the open-inventory mechanism reused here
- [#3156](https://github.com/deftai/directive/issues/3156) — gate integrity; this was a deliberate gate-definition change
