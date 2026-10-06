# outcome.md template (synthesizer)

Write `.tmp/investigations/<id>/outcome.md` using this structure. **Section 2 is mandatory** when the operator asked why something was slow.

---

## 1. Anchor

One line: crId, time window, symptom.

## 2. Why it was slow (mechanism) — REQUIRED

Reply in plain English to `operatorQuestionVerbatim` — as if answering the operator's sentence directly. Answer the **slowness** clause only. Each bullet must be a **cause**, not a duration restated as cause.

Good:

- Embed fleet saturated: N concurrent reviews, `SLIZARD_EMBED_CONCURRENCY=3`, context searches queued (EV-…)
- Index-read gate degraded: `review.gate.degrade` index-read on crId (EV-…)

Bad (tautology — ⊗ use as section 2):

- Context phase took 11 minutes
- Review exceeded 20m cap
- Failed because it timed out

If no mechanism verified: say **"Mechanism not verified"** and list checked paths + what's still unknown.

If mechanism is **inferred** (indirect evidence, `blocked` claims, no wait-time telemetry): add §2b below.

## 2b. Observability gaps (actionable) — REQUIRED when inference was used

When §2 relies on inference (e.g. stacked sessions → embed contention without embed wait ms), **say so plainly** and list **concrete logging/metrics** that would make the next investigation definitive.

Format per gap:

- **What we could not measure** — one line
- **What to add** — log field, metric, or dashboard (file/phase if known)
- **Why it helps** — one line

Examples:

- Could not measure embed queue wait per review → log `embedFleet.waitMs` on context phase completion → proves or kills contention theory next time.
- Grep `review.resource` on anchor day returned **0 lines** (verified negative, EV-LOG-*) → ensure `review.resource` AMBER/RED emitted to persistent log at info → enables M5 host-pressure claims without inference.
- Inferred host sickness from fleet ratios only → log `crs.active` + CPU/memory snapshot on `review.timeout` → separates embed contention from VM pressure next time.

**Trigger §2b when any of:** M2/M5 inferred; `review.resource` absent; host mechanism via fleet ratios without per-timeout resource line; operator `EV-OPERATOR` aligned with indirect fleet evidence.

⊗ Bury this only in "fix candidates" or leave implicit. The operator should hear: *we answered as well as logs allow; here's what to ship so the next run is definitive.*

## 3. How it ended (terminal)

One short paragraph: timeout / failed / salvage / check run conclusion. This does **not** answer section 2.

## 4. Ruled out

Table: theory | disproof (EV ref)

## 5. Evidence index

EV ids → one line each

## 6. Fix candidates (optional)

Only if operator asked. Separate story vBRIEF — not investigated here unless claims verified.