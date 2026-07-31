# Research: opt-in minimal consumer AGENTS profile (#3014)

**Status:** research only — does **not** block multi-scope turn/cache budget epic #3009 (P0 A–C–E / #3010–#3013).  
**Date:** 2026-07-31  
**Related:** #2508 skill pin policy; #2769 post-compact AGENTS re-read; closed budget work #645 / #2455 / #2490 / #2492.

## Hypothesis

A short always-on AGENTS surface (alignment + four process pins from #2508 + Skills Index pointers) can preserve “real enough Directive” for app-bank / multi-scope greenfield while cutting prompt-cache prefix mass — **if** the arm is explicitly labeled (opt-in deposit, image-only policy, or `plan.policy` flag).

## Evidence context

Pre-v0.90 DevHammer saw ~9k AGENTS.md + skills list injected after `directive init` (baseline/spec_kit had none). Under prompt caching, prefix mass × turn count multiplies cache cost. Epic #3009 lands turn cuts first (batch promote, check-once-at-end, no re-ceremony, one-shot render). Residual prefix-shrink gain should be measured on **v0.90+ after those land**.

## Research questions (open)

1. What is the minimum always-on set that still routes build / pre-pr / review-cycle / swarm without false negatives (#2508 always-pin tier)?
2. Delivery surface: opt-in deposit profile vs image-only policy vs typed `plan.policy` flag?
3. Tension with post-compact AGENTS re-read (#2769) — does a thin prefix re-expand on compact?
4. After #3010–#3013 land, how much residual gain remains from prefix shrink alone? (External DevHammer retest.)

## Non-goals

- Making minimal AGENTS the default for all consumers without a product decision.
- Claiming parity with baseline by stripping process unlabeled.
- Replacing skill-pin policy (#2508) or undoing AGENTS budgets already shipped.

## Recommendation

Do **not** implement a default thin AGENTS in this epic. Revisit after:

1. #3010–#3013 merge and ship.
2. External DevHammer (or equivalent) retest on v0.90+ ceremony + turn-budget surface.
3. Explicit product decision on opt-in vs default.

If revisited, prefer a named opt-in profile with false-negative eval against `task eval:triggers` / pin policy, not an unlabeled strip.
