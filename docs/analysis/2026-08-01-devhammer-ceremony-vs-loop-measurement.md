# DevHammer: ceremony vs loop measurement

**Date:** 2026-08-01  
**Status:** operator measurement guide (not a product change)  
**Audience:** maintainers scoring Directive package upgrades with DevHammer / multi-scope pins  
**Related:** epic #2990 (ceremony wall-clock, v0.90.0), epic #3009 (multi-scope turn/cache budget, P0 in v0.91.0), research #3014 (minimal AGENTS profile)

## Why this note exists

A single-pair DevHammer comparison of **Directive 0.87.0 vs 0.90.0** showed:

| Metric | 0.87.0 | 0.90.0 | Δ |
|--------|--------|--------|---|
| Reward | 0.8182 (9/11) | 0.8182 (9/11) | flat |
| Turns | 37 | 37 | flat |
| Cache tokens | 1,683,456 | 1,833,728 | +~8.9% |
| Input | 90,709 | 85,240 | −~6.0% |
| Output | 22,851 | 22,235 | −~2.7% |

**Reading:** quality and turn count did not move. Raw input/output got slightly leaner; cache footprint got fatter. A ~9% cache swing on **n=1** is consistent with stochastic tool order / prefix billing noise and is **not** strong evidence of a ceremony regression.

**Critical split:** v0.90 ceremony work (#2991–#2994) optimizes **session-start / re-arm / recovery wall-clock**, not “agent turns on a long coding harness.” Epic #3009 (P0 children closed for v0.91) is the **turn/cache thrash** lever for multi-scope pins. Scoring ceremony with loop metrics (or loop work with ceremony-only package deltas) misattributes the result.

## Two clocks (do not mix)

| Bucket | What it measures | Primary unit | Package epic |
|--------|------------------|--------------|--------------|
| **Ceremony** | Getting mutation-ready once (and recovering after compact/deny) | wall ms, process-cost events | #2990 / v0.90 |
| **Loop** | Agent turns after ready | turns, cache/input/output, reward | #3009 / v0.91 surface |

---

## Fixed constants (write once per campaign)

| Field | Example |
|--------|---------|
| Host | Grok Build / Cursor / OpenClaw |
| Model | name + date |
| Directive package | 0.87.0 / 0.90.0 / **0.91.0** |
| Deposit shape | greenfield `directive init` vs already-seeded tree |
| Skills pinned | always-pins only vs full pack |
| Seed method | offline seed + implement vs cold implement from empty |
| Task ID | DevHammer app pin id |
| Date / operator | |

Use the **same** product task (same app pin / same DoD), **same host + model**, and **N ≥ 3** runs per package version. Report **median** and **range**.

---

## Sheet 1 — Ceremony (score v0.90 / #2990)

Run **outside** the long agent loop when possible (operator or scripted).

| # | Step | How to run | Record |
|---|------|------------|--------|
| C1 | Cold `session:start` | Empty/missing `.deft/ritual-state.json` or new worktree | wall ms; if `--json`: total + `steps[]` |
| C2 | Re-arm | Same worktree + continuous HEAD after compact/short idle: `session:start --rearm` | wall ms + `ceremony_tier` (rearm vs cold) |
| C3 | `session:ready` recovery | Force stale ritual, then one `session:ready` | wall ms; steps invoked (start / verify / cache) |
| C4 | PreToolUse deny → ready | Write/edit with stale ritual; time until first allowed write | wall ms + recovery command used |
| C5 | Process-cost log | After C1–C3: local events for `session:start` / `session:ritual-blocked` (#2994) | `duration_ms`, `ceremony_tier`, `exit_code` |

**Pass criteria for “0.90 ceremony worked”:** re-arm ≪ cold; `session:ready` one-shot when blocked; no multi-minute cold on every compact when re-arm applies.

**Not in the 0.87→0.90 DevHammer table:** turns, cache tokens, reward.

### Surfaces (ceremony)

| Surface | Issue | Typical single-run DevHammer? |
|---------|-------|-------------------------------|
| Slim cold `session:start` / optional network | #2991 | No if host never times `session:start` |
| Cold vs re-arm tiers | #2992 | No unless compact + re-arm is forced |
| `session:ready` one-shot | #2993 | Only if hooks enforce ritual and recovery is observed |
| Process-cost events | #2994 | No unless `.deft` events are collected |
| OpenClaw pin detect/fix | #3001 / #3008 | Only on OpenClaw seats |

---

## Sheet 2 — Loop (score multi-scope / #3009; DevHammer row lives here)

Start **after** ceremony is green (or document that the harness never calls session verbs).

| # | Metric | Notes |
|---|--------|--------|
| L1 | Reward / checks passed | same DoD |
| L2 | **Agent turns** | primary bloat signal |
| L3 | Cache tokens | prefix mass + re-read |
| L4 | Input tokens | non-cache bill |
| L5 | Output tokens | |
| L6 | Count of `session:start` / `session:ready` **inside** the run | thrash detector |
| L7 | Count of full quality `check` mid-batch | #3012 |
| L8 | Count of `project:render` / `spec:render` / init | seed identity |
| L9 | Count of `scope:promote` (single vs `--batch`) | #3011 |
| L10 | Active scopes max during run | one-active still holds? |
| L11 | Always-on prefix estimate (AGENTS + pinned skills + tools) | #3014 research |

**Pass criteria for “#3009 loop worked”** (multi-scope pin only): fewer turns and/or less cache than pre-#3009 **for the same multi-scope scenario**, with L6–L9 not exploding.

### Surfaces (loop / multi-scope)

| Surface | Issue | Typical single-app DevHammer? |
|---------|-------|--------------------------------|
| No re-init / ceremony after offline seed | #3010 | Partial if one long implement; miss multi-scope batch |
| Batch `scope:promote --batch` | #3011 | Miss if one-by-one promote or no promote |
| Check once at end of multi-scope batch | #3012 | Miss if every story ends with full `check` |
| Minimal render-ready PROJECT-DEFINITION / one-shot render | #3013 | Miss if template already fully rendered |
| Minimal consumer AGENTS profile | #3014 research | Not default; research only |

### Drivers that inflate loop cache without ceremony regression

- Always-on AGENTS + skills + tools (stable prefix re-read every turn; #3014 target)
- Large skill bodies / always-pins (disk pin shape ≠ API cache)
- Per-turn tool schemas + results (host, not package ceremony)
- Repeated full-repo or multi-file reads (agent strategy)
- Stochastic tool order / retries (n=1 noise)

---

## Run protocol (anti-stochastic)

1. Fix host, model, repo template, acceptance checklist.
2. For each version: **N=3** (better N=5) full runs.
3. Report **median** turns / cache / input / output / reward; also min–max.
4. Log L6–L9 from transcript (or tool log) — one annotated run is enough if turns stay flat.
5. Label deposit: **A** cold clone + init mid-run vs **B** pre-seeded offline then implement only.
6. Do **not** declare a ~9% cache win/loss from a single pair.

---

## Fair retest matrix

| Scenario | Versions | Primary score | Why |
|----------|----------|---------------|-----|
| **S0** Ceremony microbench | 0.90, 0.91 | Sheet 1 only | Isolates #2990 |
| **S1** Current DevHammer (control) | 0.87, 0.90, **0.91** | Sheet 2 L1–L5 | Continuity with the 0.87→0.90 table |
| **S2** Multi-scope pin (N≥6 scopes), **offline seed then implement** | 0.90 vs **0.91** | L2, L3, L6–L9 | Hits #3010–#3013 |
| **S3** Same as S2 but force mid-batch check vs check-once | 0.91 only | L7 | Validates #3012 discipline |
| **S4** Optional: minimal AGENTS experiment | research #3014 | L3, L11 | Prefix mass only |

| Claim | Minimum fair evidence |
|-------|------------------------|
| “0.90 ceremony improved” | **S0**, not DevHammer turns |
| “#3009 turn/cache budget improved” | **S2**, N≥3, **0.90 vs 0.91** (not 0.87 vs 0.90) |

### Suggested first operator run (default)

1. **S0** on 0.91 only (sanity that cold / re-arm / `session:ready` still look healthy).
2. **S1** N=3 on **0.91** next to the existing 0.87/0.90 single runs (control continuity).
3. **S2** N=3 on **0.90 vs 0.91** with ≥6 scopes, offline seed then implement — **this is the turn/cache claim run**.

---

## One-line verdict for stakeholders

> **0.87→0.90 DevHammer: loop scoreboard, ceremony work off-board; turns flat is expected. Cache +9% is noise-or-prefix, not a proven ceremony regression. To judge turn/cache budget, retest multi-scope seed+implement on 0.91 (#3009), and measure session cold/re-arm/`session:ready` separately for 0.90.**

## References

- Epic #2990 — ceremony wall-clock (v0.90.0 CHANGELOG)
- Epic #3009 — multi-scope turn/cache budget; children #3010–#3013 (P0), #3014 research
- `content/commands.md` — Mutable ritual; Process-cost events
- `docs/analysis/2026-07-31-minimal-consumer-agents-profile-research.md` — #3014
