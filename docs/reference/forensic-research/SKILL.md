---
name: forensic-research
description: >-
  Exhaustive evidence-based investigation with sub-agents, vBRIEF claim ledger,
  and mandatory falsification before conclusions or recommendations. Domain-agnostic
  core with pluggable domain packs. Artifacts live under .tmp/investigations/ only.
  Use for "why did", "investigate", "root cause", "what caused", "forensic research",
  production delay/failure questions, or when the operator rejects a first-theory
  diagnosis. Do NOT trigger on action requests that already name a fix unless the
  operator also wants investigation first. Do NOT trigger on bare "run tests" or
  "read logs" without a causal question. Triggers: forensic research, investigate why,
  root cause, what caused, forensic mode, stay in forensic. Mode stays ACTIVE across
  follow-ups until operator exits (exit forensic, done investigating, normal mode).
  Read references/forensic-mode.md + follow-ups.md.
---

# Forensic Research — MODE

**Forensic mode** is a sustained investigation posture, not a one-shot reply. Enter on first causal question; **stay in mode** until the operator exits. Follow-ups drill the **active** ledger (`.tmp/investigations/.active`).

**Mode docs:** `references/forensic-mode.md`, `references/follow-ups.md`

Multi-agent investigation discipline: decompose the question into a logic tree, verify every claim with evidence, falsify popular wrong theories, and conclude only when surviving theories have verified causal chains.

**Core references:** `references/forensic-mode.md`, `references/follow-ups.md`, `references/question-framing.md`, `references/investigation-profile.md`, `references/orchestrator-protocol.md`, `references/subagent-prompts.md`, `references/outcome-template.md`, `references/failures.md`

**Domain packs:** `references/domains/<domain>.md` — **you must add one per project** (start from `references/domains/TEMPLATE.md`).

**Examples:** `examples/slizard/` — full SLizard production pack (reference only).

**Template:** `templates/investigation.vbrief.json`

---

## Iron laws

0. **Mode gate** — On enter: read `references/forensic-mode.md`. If `.tmp/investigations/.active` exists, resume that id (follow-up). Else scaffold new id + write `.active`. First chat line: `Forensic mode active — .tmp/investigations/<id>/`. Stay in mode every turn until operator exits.
0b. **Artifact gate** — Before ANY causal statement in chat, active investigation must have `investigation.vbrief.json`. Follow-ups extend it; do not answer from chat memory alone.
1. **Answer embargo (chat gate)** — While `plan.status` is `running` OR validator has not passed: chat may only say forensic mode is active, current wave, and path to ledger/`outcome.md` if it exists from a **prior** completed pass. ⊗ Root cause, ⊗ mechanism names, ⊗ counts, ⊗ config recommendations. After Wave 5: chat may summarize **only** what `outcome.md` already states.
1b. **Operator challenge = re-verify** — When the operator disputes a claim, treat as mandatory re-verification: new or updated `EV-OPERATOR` or disproof evidence **before** repeating the claim. ⊗ Debate from memory.
2. **Evidence before narrative** — every factual claim cites a `plan.references` id (`EV-…`). Assertions without citations are `[HYPOTHESIS]` only.
3. **Config is not code** — production flags require runtime proof (secrets manager, deploy env, or log line showing actual value). ⊗ Infer from source code or docs alone.
3b. **No tautologies** — "failed because timed out" and "slow because X took N minutes" are **not** answers to why it was slow. Name a **mechanism** or close with "mechanism not verified" after exhausting `branch.mechanism.*`.
4. **Falsification before fixation** — a branch is **ruled out** (`status: failed`) when disproof evidence exists; "less likely" is not allowed.
5. **Proof-required disproval** — "no evidence found" → `unknown`, not `failed`. `failed` requires a specific counter-evidence ref.
6. **Sub-agents own branches** — orchestrator prefetches evidence bundles (domain adapters) into `evidence/` before dispatch; branch/trap agents interpret and cite `EV-*`. Sub-agent returns `blocked: needs_shell` if required adapter output is missing — orchestrator fetches, then re-dispatches.
7. **Scratch only** — all artifacts under `.tmp/investigations/<id>/`. ⊗ `git add` anything under that path.

---

## Artifact layout

```
.tmp/investigations/<investigation-id>/
  investigation.vbrief.json
  evidence/
  outcome.md
```

**Investigation id:** `YYYY-MM-DD-<slug>` (slug from anchor).

---

## Orchestrator workflow (summary)

| Wave | Agent(s) | Output |
|------|----------|--------|
| 0 — Init | Orchestrator | Dir + template + traps |
| 1 — Traps | trap-runner | Popular theories falsified |
| 2 — Branches | branch investigators | Claims verified/failed/unknown |
| 2b — Mechanism | branch investigator | Why dominant phase was slow |
| 3 — Falsify | falsifier | Disproof attempts — **mandatory** |
| 4 — Red-team | red-team | Counter-evidence — **mandatory** |
| 5 — Synthesize | synthesizer | `outcome.md` after validator pass |

**Domain selection:** infer from question; if ambiguous, ask **one** question. Load `references/domains/<your-pack>.md`.

Read `references/orchestrator-protocol.md` for full detail.

---

## Quick start (orchestrator checklist)

- [ ] Domain pack exists for this project (`references/domains/<name>.md`)
- [ ] Anchor recorded in `narratives.Problem`
- [ ] `.tmp/investigations/<id>/` created from template
- [ ] Wave 1 traps dispatched
- [ ] Wave 2 + 2b branch agents dispatched
- [ ] Wave 3–4 falsifier + red-team dispatched
- [ ] Validator pass (`references/investigation-profile.md` § Validator)
- [ ] Wave 5 `outcome.md` written
- [ ] Chat: brief summary + path to `outcome.md` only
