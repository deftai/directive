# outcome.md template (synthesizer)

Write `.tmp/investigations/<id>/outcome.md` using this structure. **Section 2 is mandatory** when the operator asked why something was slow. Keep fields project-neutral; domain-specific labels belong only in optional examples.

---

## 1. Anchor

One line: subject id (issue/PR/run/session), time window, symptom.

## 2. Why it was slow (mechanism) — REQUIRED for "why slow?"

Reply in plain English to `operatorQuestionVerbatim` — as if answering the operator's sentence directly. Answer the **slowness** clause only. Each bullet must be a **cause**, not a duration restated as cause.

Good (shape only — replace with the investigated system's evidence):

- Resource pool saturated: N concurrent workers, configured concurrency limit, queued work (EV-…)
- Gate degraded: named gate/check failed or slowed on the subject id (EV-…)

Bad (tautology — ⊗ use as section 2):

- Context phase took 11 minutes
- Review exceeded 20m cap
- Failed because it timed out

If no mechanism verified: say **"Mechanism not verified"** and list checked paths + what's still unknown.

If mechanism is **inferred** (indirect evidence, `blocked` claims, no wait-time telemetry): add §2b below.

## 2b. Observability gaps (actionable) — REQUIRED when inference was used

When §2 relies on inference, **say so plainly** and list **concrete logging/metrics** that would make the next investigation definitive.

Format per gap:

- **What we could not measure** — one line
- **What to add** — log field, metric, or dashboard (file/phase if known)
- **Why it helps** — one line

**Trigger §2b when any of:** mechanism reached by inference; required telemetry absent; host/resource mechanism via ratios without a per-event resource line; operator-supplied evidence aligned only with indirect fleet/system evidence.

⊗ Bury this only in "fix candidates" or leave implicit. The operator should hear: *we answered as well as logs allow; here's what to ship so the next run is definitive.*

## 3. How it ended (terminal)

One short paragraph: timeout / failed / salvage / check run conclusion. This does **not** answer section 2.

## 4. Ruled out

Table: theory | disproof (EV ref)

## 5. Evidence index

EV ids → one line each

## 6. Fix candidates (optional)

Only if operator asked. Separate story xBRIEF — not investigated here unless claims verified.

---

### Optional example (SLizard / review-fleet domain)

Use only when the investigation domain matches. Do **not** treat these labels as required outcome fields for unrelated projects.

- Anchor may include `crId` when that is the subject id.
- Good §2 bullets might cite `SLIZARD_EMBED_CONCURRENCY`, `review.gate.degrade`, or embed-fleet queue evidence.
- §2b examples: log `embedFleet.waitMs`; ensure `review.resource` AMBER/RED reaches persistent logs; snapshot CPU/memory on timeout.
- Domain shorthand `M2`/`M5` means inferred embed-contention / host-pressure claims in that pack — translate to the project's own claim ids when writing the outcome.
