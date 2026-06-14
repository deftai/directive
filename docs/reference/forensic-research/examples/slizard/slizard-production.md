# Domain pack: slizard-production

Evidence for SLizard on Fly.io, GitHub reviews, Evolution poller, and operator config. Fly logs are one adapter — not the only source.

---

## Evidence adapters

**Log pull playbook:** operator skill `~/.agents/skills/investigate-production/SKILL.md` Steps 2–3 (check run + `fly ssh` grep). Use inside Wave 2; output → `evidence/` + EV refs. ⊗ investigate-production Steps 5–8 (code trace, present hypothesis) when forensic-research is active.

| Adapter | When to use | How |
|---------|-------------|-----|
| **fly logs** | Live or recent stream | `fly logs -a slizard` — interleaved; always filter by anchor crId/time |
| **fly proxy dashboard** | Structured tail + review history | `fly proxy 3000:3000 -a slizard` → `/logs?lines=2000`, `/reviews`, `/status` |
| **Persistent log files** | Full-day forensics | `fly ssh console -a slizard` → `$SLIZARD_DATA_DIR/logs/slizard-YYYY-MM-DD.log` |
| **Metrics snapshot** | Concurrency, counters, timings | `/status` JSON — gauges `crs.active.github`, config `maxConcurrentReviews` |
| **Fly secrets / env** | Config claims | `fly secrets list -a slizard`; never assume — read actual values |
| **GitHub** | Check run, PR timeline | `gh pr view`, check run status, webhook timing vs review.started |
| **Local docs** | Thresholds, event names | `src/health.ts`, `src/scm/github/github-review-handler.ts`, `src/review-session.ts` |

**Prefer** proxy + persistent files over raw `fly logs` stream when anchor is known.

Save excerpts to `evidence/` with crId filter noted in reference description.

---

## Starter logic tree — "Why was review slow?" / "why take so long"

Under `branch.slowness` (see `question-framing.md`), seed:

| id | title |
|----|-------|
| `branch.slowness.admission` | Never started or skipped |
| `branch.slowness.queue` | Waited for slot / queue |
| `branch.slowness.phases` | Which phase dominated wall time (evidence only — not the mechanism answer) |
| `branch.slowness.mechanism.<phase>` | **Why that phase was slow** — spawn in Wave 2b |

Under `branch.terminal`:

| id | title |
|----|-------|
| `branch.terminal.outcome` | How session ended (timeout, failed, salvage, check run) |

Legacy ids `branch.admission` / `branch.inrun` map to `branch.slowness.*` if already scaffolded.

---

## Key log events (filter by crId)

| event | Meaning |
|-------|---------|
| `webhook.received` | Delivery arrived |
| `webhook.skipped` | Intentionally not processed |
| `review.started` | Session began |
| `review.completed` | Success — check phase breakdown fields (#1265) |
| `review.failed` | Terminal failure |
| `review.timeout` | Hit session wall — check `inProgressPhase` |
| `review.skipped.wide_pr` | Admission rejected |

**Concurrency gauge:** `crs.active.github` (not the same as queue depth — read both).

---

## Log footguns (counting & lifecycle)

| Footgun | Symptom | Correct handling |
|---------|---------|------------------|
| **Missing `review.completed`** | Session ran all phases through `review-dedup` then stalled — no terminal success line | Treat as **terminal for counting** if last phase complete and no later `review.*` for that crId within 30m |
| **`review.aborted`** | Prior session ended without timeout/complete | Terminal — exclude from "active overlap" |
| **`review.timeout` then more phases** | Salvage/post-timeout work continues | Anchor window ends at `review.timeout` for concurrency; salvage is same crId, not a second review |
| **Gauge vs log** | `crs.active.github` ≠ count of crIds with open phases | Prefer **log lifecycle** for "N reviews in flight" claims (`claim.trap.concurrency.B4`) |
| **`review.resource` absent** | Grep returns 0 lines for pressure telemetry | Verified **negative** — document in outcome §2b; do not claim M5 completed without indirect + §2b |
| **Post-timeout `inProgressPhase`** | `review.timeout` shows `checkpoint` while context dominated | Terminal phase ≠ dominant slow phase — use phase breakdown fields |

Regression: `references/failures.md` § directive#1612.

---

## Log lifecycle counting (`trap.concurrency` B4)

**When:** Any claim that "N concurrent reviews" caused delay.

**Window:** `review.started.time` for anchor crId → `review.timeout.time` or `review.completed.time` (anchor terminal).

**Procedure (persistent log, anchor day):**

1. Parse JSON lines; collect all `event` starting with `review.` in window.
2. For each **other** crId, determine if a session was in-flight: `review.started` before window end AND no terminal before overlap start.
3. **Terminal events** (session not in-flight): `review.completed`, `review.failed`, `review.aborted`, `review.timeout`; also **derived terminal**: last `review.phase.complete` through `review-dedup` with no subsequent `review.*` for that crId within 30 minutes.
4. ⊗ Count `review.started` alone. ⊗ Treat #1607-style dangling dedup as active without step 3.

Save parse output → `evidence/log-lifecycle.txt`, cite `EV-LOG-LIFECYCLE`.

**Falsified when:** Only anchor crId has review events in window (B4 `failed`) → `invalidates` `branch.queue`; ⊗ state concurrency saturation.

---

## Popularity traps

Run in Wave 1. Each trap falsification is dispositive for recommendations.

### trap.concurrency

**Wrong move:** Lower `SLIZARD_MAX_CONCURRENT_REVIEWS` without saturation proof.

| Claim id | Check |
|----------|-------|
| `claim.trap.concurrency.B1` | At incident window, `crs.active.github` ≥ 80% of `maxConcurrentReviews` (`/status` or `evidence/status.json`) |
| `claim.trap.concurrency.B2` | Gap webhook.received → review.started large vs phase times (queue wait) |
| `claim.trap.concurrency.B3` | This crId waited — job claimed late, queue depth elevated |
| `claim.trap.concurrency.B4` | **Log lifecycle:** other crIds with in-flight review phases during anchor window (§ Log lifecycle counting) |

**Falsified when:** B4 shows anchor was sole in-flight review OR B1 fails (e.g. active=1–2, cap=8) → `invalidates` → `branch.queue`; ⊗ mention lowering max reviews.

**Mandatory:** B4 must be `completed` or `failed` with `EV-LOG-LIFECYCLE` before any concurrency narrative in `outcome.md`.

### trap.rate_limit

**Wrong move:** Blame GitHub/LLM 429 without crId-scoped 429.

| Claim | Check |
|-------|-------|
| `claim.trap.rate_limit.B1` | 429/403 on requests for **this** crId/repo in incident window |

**Falsified when:** No crId-scoped rate errors; global 429 noise from other work.

### trap.llm_slow

**Wrong move:** Blame model without phase breakdown.

| Claim | Check |
|-------|-------|
| `claim.trap.llm_slow.B1` | `reviews.duration.llm` or phase breakdown shows LLM dominates wall time for this review |

### trap.index_stale

**Wrong move:** Re-index without index events for this repo in window.

| Claim | Check |
|-------|-------|
| `claim.trap.index_stale.B1` | `index.worker.*` failures or stalls for repo during incident window |

### trap.wide_pr

| Claim | Check |
|-------|-------|
| `claim.trap.wide_pr.B1` | `review.skipped.wide_pr` or width admission for this crId |

### trap.agentic_assumed

**Wrong move:** Blame slow `context` phase on multi-hop agentic loop without verifying prod flag.

| Claim | Check |
|-------|-------|
| `claim.trap.agentic.B1` | `LLM_AGENTIC_CONTEXT` is `true` in production (`fly secrets list`, SSH `printenv`, or deploy env dump) |

**Falsified when:** Secret absent or not `true` → context path is single-pass vector (`references/code-facts.md`). ⊗ Claim 8–12 min agentic loop. Investigate real dominant phase on **this** attempt instead.

**Regression:** `references/failures.md` § 2026-06-13.

### trap.zombie_lock_fantasy

**Wrong move:** Overlapping timed-out sessions "compete for repo locks" while one waits on Gemini LLM.

| Claim | Check |
|-------|-------|
| `claim.trap.zombie.B1` | Anchor crId has `review.gate.degrade` or gate timeout during overlap window |
| `claim.trap.zombie.B2` | Slow phase on anchor attempt is one that **holds** a gate (index-write, working-tree) — not bare LLM HTTP wait |

**Falsified when:** No gate events on anchor; overlap is only wall-clock / concurrent `crs.active` without gate degradation. See `references/code-facts.md` § Repo gates.

⊗ Use stacked timeout *count* alone as lock-contention proof.

### trap.host_sickness

**Wrong move:** Blame anchor PR size, embed fleet, or queue when the **host/fleet** is degraded for the whole day.

| Claim id | Check |
|----------|-------|
| `claim.trap.host_sickness.B1` | Day-wide `review.timeout` / `review.completed` ratio extreme (e.g. timeouts ≫ completions on anchor UTC day) — `EV-FLEET-*` |
| `claim.trap.host_sickness.B2` | Phase avg inflation: anchor-day `review.phase.complete` avg for dominant phase within P90 of same-day max (epidemic baseline) |
| `claim.trap.host_sickness.B3` | Infra signals in window: `fly status` health critical, machine restart event, deploy spec lag vs `fly.toml` — `EV-FLY-*` |

**Survives when:** B1+B2 indicate fleet-wide slowness; anchor is **not** an outlier → prefer `branch.mechanism.host` over PR-specific theories.

**Operator context:** `EV-OPERATOR-*` ("VM sick all day") supports B1/B3 when fleet metrics align.

### trap.epidemic_not_outlier

**Wrong move:** Treat anchor as special case when it sits inside sick-day distribution.

| Claim id | Check |
|----------|-------|
| `claim.trap.epidemic.B1` | Anchor dominant phase duration ≤ same-day P90 for that phase (all reviews) |

**Survived/failed:** If anchor context ms ≤ P90 (e.g. 748s vs 789s max) → symptom is **fleet baseline**, not anchor-specific. ⊗ "this PR's N files caused 12 min context" without per-file evidence.

### trap.stacked_sessions_blur

**Wrong move:** Blend N review attempts into one narrative without per-attempt phase breakdown.

| Claim | Check |
|-------|-------|
| `claim.trap.stacked.B1` | Each attempt has its own `review.started` → terminal event with phase timings (#1265) |
| `claim.trap.stacked.B2` | Dominant slow phase identified **per attempt**, not averaged across attempts |

---

## Phase mechanisms (Wave 2b — answers WHY, not how long)

When `branch.slowness.phases` names dominant phase **context** (single-pass, agentic off):

| Claim id | Mechanism to verify |
|----------|---------------------|
| `claim.mechanism.context.M1` | **Index-read gate wait** — `review.gate.degrade` gate=index-read on anchor crId |
| `claim.mechanism.context.M2` | **Embed fleet contention** — concurrent reviews × `SLIZARD_EMBED_CONCURRENCY` (secrets + `/status` crs.active + compare context ms vs quiet period) |
| `claim.mechanism.context.M3` | **Search volume** — file count in scope, `vectorContextCount` on terminal log line |
| `claim.mechanism.context.M4` | **Index/vector cold or miss** — index errors, empty vector results, degradation notes on crId |
| `claim.mechanism.context.M5` | **Host pressure** — `review.resource` AMBER/RED / pressure WARN if deployed (#1267). If grep shows **0** `review.resource` lines: `blocked` + §2b mandatory |

When dominant phase **static-analysis**:

| Claim id | Mechanism |
|----------|-----------|
| `claim.mechanism.static.M1` | working-tree gate degrade |
| `claim.mechanism.static.M2` | Wide PR / check count explosion |
| `claim.mechanism.static.M3` | TSC/Go compile arm slow (per-arm timing in logs if present) |

When dominant phase **fetch** or **path-validation**:

| Claim id | Mechanism |
|----------|-----------|
| `claim.mechanism.fetch.M1` | GitHub API latency / pagination |
| `claim.mechanism.fetch.M2` | Large diff fetch / many commits |

⊗ Stop at "context was 11 min" — that satisfies `branch.slowness.phases` only, not `branch.mechanism.context`.

**File count ≠ file reads:** PR `N files` from `gh api` does not prove `N` vector searches — context uses scoped search (`references/code-facts.md` § Context search scope). Cite code-facts after traps; ⊗ raw `src/` grep.

**Mandatory evidence:** `/status` snapshot → `evidence/status.json` + EV ref (for crs.active, embed concurrency context).

### Host mechanism (`branch.mechanism.host`)

Spawn when `trap.host_sickness` or `trap.epidemic_not_outlier` survives, or `EV-OPERATOR` cites host sickness.

| Claim id | Mechanism to verify |
|----------|---------------------|
| `claim.mechanism.host.M1` | Day-wide timeout epidemic (`EV-FLEET-*`) |
| `claim.mechanism.host.M2` | Phase baseline inflation — anchor within sick-day distribution |
| `claim.mechanism.host.M3` | Fly health / machine restart / undersized VM vs target (`EV-FLY-*`) |
| `claim.mechanism.host.M4` | Operator high-trust context (`EV-OPERATOR-*`) aligned with M1–M3 |

⊗ Lead with embed contention when M1+M2 indicate host epidemic and anchor is not outlier.

When M2 embed contention is inferred without wait telemetry, **outcome §2b** must propose at minimum:

| Gap | Actionable addition |
|-----|---------------------|
| Embed queue wait unknown | Log or metric: embed fleet wait ms per context phase (`embedding-fleet.ts` / context phase completion) |
| `crs.active.github` at incident | Log gauge snapshot on `review.started` / `review.timeout` or retain `/status` scrape |
| Per-phase gate wait | Log `review.gate.wait_ms` already in metrics — ensure exported in timeout diagnostic line (#1265) |
| `review.resource` / pressure | **Verified negative on 2026-06-13** — 0 lines in persistent logs; ensure AMBER/RED reaches persistent log at info if M5 used |

---

## Branch claim templates

### branch.admission

- `claim.admission.A1` — `webhook.received` exists for this PR in window
- `claim.admission.A2` — No `webhook.skipped` / wide_pr skip for this crId
- `claim.admission.A3` — `review.started` exists within reasonable delay of webhook

### branch.queue

- `claim.queue.Q1` — `crs.active.github` at saturation during wait (see trap.concurrency)
- `claim.queue.Q2` — review job queue depth elevated (`review-jobs` / worker pool logs)
- `claim.queue.Q3` — webhook→started gap dominates total delay

### branch.inrun

- `claim.inrun.P1` — Phase breakdown on `review.completed` or `review.timeout` identifies dominant phase
- `claim.inrun.P2` — Dominant phase duration >> other phases
- `claim.inrun.P3` — Dominant phase cause identified (e.g. context planner, static batch, LLM extract)

### branch.timeout

- `claim.timeout.T1` — `review.timeout` event for crId
- `claim.timeout.T2` — `inProgressPhase` at timeout
- `claim.timeout.T3` — Salvage/zombie events if applicable

---

## Disproof order (falsifier)

1. Cheapest metric/gauge check (`/status`, single log grep for crId)
2. Config/secret read (fly secrets)
3. Phase breakdown line for crId
4. Full-day log scan for crId only
5. Cross-review noise exclusion (confirm lines belong to anchor)

---

## Graduation hints

When investigation verifies cause, story vBRIEF may reference:

- Issue numbers (#1265 phase logging, #1260 queue, #1267 resource pressure)
- Verified config changes only with claim chain in investigation ledger