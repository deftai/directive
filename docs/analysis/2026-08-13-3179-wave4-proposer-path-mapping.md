# #3179 Wave 4 — Proposer path mapping

| Field | Value |
|-------|-------|
| **Title** | Proposer path intersection: #1307 × #2436 × #2741 (consume, do not refile) |
| **Date** | 2026-08-13 |
| **Status** | Proposed (thin SoT; long-form research map retained in operator scratch, non-normative) |
| **Parent epic** | [#3179](https://github.com/deftai/directive/issues/3179) — self-improving under gates; wave 4 = written mapping only |
| **Dual credit** | Satisfies the [#2436](https://github.com/deftai/directive/issues/2436) AC "written mapping SkillOpt mechanisms → directive artifacts" |
| **Composes** | #3164 propose-not-apply (shipped); #3156 gate integrity (shipped); #2741 inter-run memory principles |

## The path (whole design, one sentence)

Evidence from **existing** SoTs (#2741 tiers) → one staged **proposal artifact** (#1307) → offline
**control gate** when it exists (#2436 bar) → **disposal** by PR/operator (#3164). No auto-apply.
No new memory store. A proposal never mutates live skills, managed AGENTS, or policy; production
bytes change only via merge.

```text
L0 EVIDENCE   #2741 over existing SoTs (decisions, lessons, ritual, xBRIEF) — no new store
L1 PROPOSER   #1307 hypothesis + bounded patch ops, staged under .deft/skill-opt/<run-id>/
L2 CONTROL    #2436 bar (frozen evaluator, strict selection, reject buffer) — DEFERRED, see below
L3 DISPOSAL   #3164 holdout report → issue/PR → gates → merge (#894 finalize + #830 pin posture)
```

## Roles (no overlapping SoR)

| Layer | Home | Owns | Does not own |
|-------|------|------|--------------|
| L0 Evidence | #2741 | hot/cold/operator-gated contract over existing SoTs; budgets; freeze | proposer logic; accept/reject math; loop file schema |
| L1 Proposer | #1307 | hypothesis + structured ops (`append \| insert_after \| replace \| delete`) under a textual budget; staging under run root | memory tiers; reject-buffer schema; live skill mutation |
| L2 Control | #2436 (deferred) | frozen target; train/selection/test; strict selection gate; **reject buffer SoR**; freeze-on-promote export | product gate integrity (#3156); memory SoR; constitution disposal |
| L3 Disposal | #3164 (shipped) | propose-not-apply; PR/issue/gate disposal; constitution vs playbook | proposer runtime; optimizer lifecycle |
| Loop scaffold + files | #894 | `frontier.json`, `evolution.jsonl`, autoresearch loop phases | benchmark-integrity **rules** (#896) |

**Ownership corrections** (carry to home issues as comments):

- #894 owns the loop **files**; #896 owns benchmark-integrity **rules** (corrects the #1307 stack diagram, which attributes frontier/evolution to #896).
- #837 is the skillify **offer trigger** only — not the held-out promote checklist home (that is #894 finalize + #830/#2508 pins + #3164 PR disposal).
- #1615 is **audit** rejection memos — a pattern sibling, not the skill-opt reject buffer SoR.

## Anti-overlap (⊗)

- ⊗ New GitHub issues under #3179 for proposer / memory / SkillOpt runtime — amend home issues instead.
- ⊗ A fourth memory product, parallel trajectory ledger, or second SkillOpt design doc.
- ⊗ #1307 inventing hot/cold tiers or a reject-buffer schema — it consumes #2741 evidence and the #2436 buffer contract.
- ⊗ #2436 redefining product gate integrity — #3156 owns that; #2436 owns refine-internal protected regions and the skill-opt reject buffer.
- ⊗ Mid-session constitution self-edit (#3164); selection score as ship criterion (#896 / #3156).

## Doctrine adopted now (near-zero token cost, no runtime)

These three SkillOpt-derived rules are worth carrying immediately; everything else waits:

1. **Bounded structured edits.** Skill-variant proposals are `append | insert_after | replace | delete`
   ops under a textual budget — never free-form full-file rewrites. (Amend #1307 AC.)
2. **Selection ≠ ship.** A gate score can accept a candidate to a frontier; only holdout report +
   PR + operator ships it. Never clear a red step by editing the gate, scorer, or fixtures
   (#3156, #896).
3. **Freeze-on-promote, compact export.** A shipped skill is a frozen, compact artifact; length is
   not quality (#865). Optimizers never run at consumer inference time.

## #2436 disposition — deferred with a named re-entry trigger

#2436 stays `triage:deferred`. Its written-mapping AC is satisfied by this document (dual credit);
its remaining AC is pilot + runtime. Revisit only when **both** hold:

- **(a)** A #1584 mechanical scorer cell exists in-tree (`evals/shared-benchmark.json`-class,
  with_skill vs without_skill). A strict-improvement selection gate needs a scorer whose variance
  is below the effect size; no current benchmark meets that bar.
- **(b)** Internal benchmark evidence (private) attributes remaining task losses to **skill-content
  quality**, rather than harness, gate, or orientation behavior — which is where all losses
  observed to date have been.

Until then: no reject-buffer runtime, no run-root harness, no frontier/evolution writers. When
(a)+(b) hold, the first slice is the synthetic pilot cell under #1584 (offline; zero consumer
inference cost by design).

## Wave 4 exit checklist

- [ ] This document lands under `docs/analysis/` via PR (CHANGELOG `[Unreleased]` entry).
- [ ] #3179 current-shape comment updated in place (pass-N) with the path + role table pointer.
- [ ] Home-issue comments: **#1307** (ops-algebra AC + diagram correction), **#2436** (dual credit +
      deferral trigger), **#2741** (consume-only; no refile) — plus ownership notes on
      **#894 / #896 / #837 / #1615**.
- [ ] No new issues opened under #3179 for this path.

## Non-normative appendix

The long-form research map (rev-3: 18-row role table, proposal/reject schemas, KD-1…KD-18, staged
PR plan) is retained in operator scratch as a non-normative appendix. Its schemas become normative
only when versioned in code by a home-issue PR.

## References

| Resource | Where |
|----------|-------|
| Parent epic / stance / gate integrity | #3179; #3164 + `main.md`; #3156 + `content/docs/gate-integrity.md` |
| Inter-run memory contract | #2741; `docs/analysis/2026-07-31-inter-run-learning-surface.md` (#2742, accepted) |
| Proposer / control stack / loop / rules | #1307; #2436 (arXiv:2605.23904); #894; #896 |
| Scorer home / token-tax rule | #1584–#1586; #865 |
| Dispose precedent | portfolio-priority skill (#3198/#3201); decision log (#1396) |
