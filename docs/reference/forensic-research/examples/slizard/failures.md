# Known skill failures (regression cases)

Document real runs where agents violated discipline. Add traps/code-facts so repeats are structurally blocked.

---

## 2026-06-13 — fresh agent, failed PR review

**Symptom:** Agent read `forensic-research` **and** `investigate-production`, then `Grep` in `src/` for `timeout salvage|timed_out|Review session` (110 hits). Diagnosed in chat; likely no `.tmp/investigations/` ledger.

**Skill conflict:** investigate-production Step 5 ("trace the active code path") encouraged code archaeology before runtime/config verification. That produced agentic-context and zombie-lock fantasies.

**Fix:** forensic-research supersedes investigate-production on causal questions; code search banned before Wave 1 traps.

**Wrong claim 1:** Agentic context ON → 8–12 min multi-hop context loop.

**Truth:** `LLM_AGENTIC_CONTEXT` is **false** in production (unset or not `true`). Context uses single-pass vector search, not `gatherAgenticContext`.

**Root cause:** Agent assumed from code path existence or stale narrative (#1266 probe), not `fly secrets` / runtime env.

**Trap added:** `trap.agentic_assumed` — see domain pack.

---

**Wrong claim 2:** Six stacked timeout sessions; 12:02 zombie overlapped 12:12 run and **competed for repo locks** (index reads, clones), slowing static/context.

**Truth:** A session waiting on a long Gemini LLM HTTP call does **not** hold `withRepoGate` locks. Gates (`index-write`, `working-tree`, `graph-read`, `index-read`) are held only inside gate callbacks; LLM waits are outside that scope. Overlap ≠ lock contention without `review.gate.degrade` / `review.gate.timeout.*` on the anchor crId.

**Root cause:** Plausible narrative from concurrent timeouts without phase or gate evidence.

**Trap added:** `trap.zombie_lock_fantasy` — see domain pack + `code-facts.md`.

---

## 2026-06-13 — agent 2, deftvisage#784 (ledger ok, tautological answer)

**Operator question:** "Why did this review take so long and fail?"

**Agent answer:** Essentially "failed because it took too long" — 20m cap, context phase 11 min, stacked webhooks.

**Gap:** Phase duration reported as cause. No `branch.mechanism.context` (embed contention, gate wait, search volume, host pressure). Slowness question treated as terminal timeout question.

**Fix:** `question-framing.md`, Wave 2b mechanism drill-down, `outcome-template.md` §2, tautology validator.

**Residual gap (agent 3):** Embed contention inferred correctly but agent did not state **actionable observability** (log embed wait ms, snapshot crs.active on timeout). Added `outcome-template.md` §2b.

---

## 2026-06-13 — directive#1612, false concurrency + host epidemic

**Wrong claim:** Three concurrent reviews saturated queue; embed fleet contention primary mechanism.

**Truth:** #1612 was sole in-flight review during its window (`EV-LOG-LIFECYCLE`). Day-wide timeout epidemic (25 timeouts, 2 completions on 2026-06-13) and inflated phase averages indicate sick host, not PR-specific or queue contention. Anchor context 748s — within sick-day baseline (avg 536s, max 789s).

**Root cause:** Active-session counting treated #1607 as in-flight without terminal log (`review.completed` gap). Agent narrated before fleet-wide metrics and operator host context (`EV-OPERATOR`).

**Traps/fixes:** Log footgun `review.completed` gap; `trap.host_sickness`, `trap.epidemic_not_outlier`, `claim.trap.concurrency.B4`; `EV-OPERATOR` type; chat gate + validator blocks Waves 3–4 skip; orchestrator evidence prefetch.

---

## Compliance failures (any date)

| Failure | Detection |
|---------|-----------|
| No investigation dir | No `.tmp/investigations/<id>/` after "conclusion" |
| Config from code/docs | Cited vbrief/ARCHITECTURE instead of `fly secrets` or runtime |
| Architecture storytelling | Explained how system *can* work, not what *did* happen for anchor |
| Waves 3–4 skipped | `wavesCompleted` lacks 3 or 4; early causal chat (CF-2) |
| `freshPullGap` sub-agent | Trap-runner cites failures.md without `evidence/` refs (CF-3) |
| Concurrency without B4 | Stated N concurrent reviews without log lifecycle parse (CF-1) |
| Host sickness missed | Fleet epidemic + operator VM context ignored for embed theory (CF-4) |
| `review.resource` assumed | Pressure claimed without grep; 0-line day not in §2b (CF-5) |