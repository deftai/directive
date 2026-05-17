---
name: deft-directive-triage
description: >
  Triage-cache hygiene and "what's next?" queue selection -- the agent-facing
  playbook for syncing the triage cache, classifying candidates, presenting a
  ranked queue, walking per-item decisions (accept / reject / defer / needs-ac
  / mark-duplicate), and auditing the session. Routing target for "triage
  hygiene", "work the cache", "what's next", "queue", and "build a cohort".
triggers:
  - triage
  - triage hygiene
  - work the cache
  - what's next
  - whats next
  - what should I work on
  - queue
  - build a cohort
  - build cohort
---

# Deft Directive Triage (stub)

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Status

! This skill is a **routing-target stub** landed by N9 (#1149) so the
canonical AGENTS.md routing entries (`"triage hygiene" / "work the cache"`
and `"what's next" / "queue" / "build a cohort"`) and the Skill Routing
"welcome" / "onboard triage" entry have an on-disk destination before D6
(#1130) ships the real body. The implementation -- Phase 0 sync, Phase 1
classify, Phase 2 present, Phase 3 decide, Phase 4 audit, plus the EXIT
block -- is owned by D6 / #1130 and is in progress.

⊗ Agents MUST NOT invoke this stub as if it were the real skill. The
deterministic playbook (sync -> classify -> present -> decide -> audit) is
not yet encoded here; routing here today is informational, not actionable.

! Until D6 lands, agents routed here SHOULD fall back to manual triage:
inspect the cache at `.deft-cache/github-issue/<owner>/<repo>/` (#883),
consult `task triage:queue --limit=10` (D11 / #1128) directly, and walk the
per-item decision verbs (`task triage:{accept,reject,defer,needs-ac,mark-duplicate}`)
already shipped by #845 / #883. The cache-as-authoritative rule in AGENTS.md
(`## Cache-as-authoritative work selection (#1149)`) remains in force.

## References

- Issue (real implementation): #1130 (D6)
- Umbrella: #1119
- Sibling skills the real body will cross-reference: `skills/deft-directive-refinement/SKILL.md`,
  `skills/deft-directive-swarm/SKILL.md`, `skills/deft-directive-sync/SKILL.md`
- Stub author: #1149 (N9 -- AGENTS.md consolidation)

## EXIT

Pre-implementation: nothing to exit from. When this stub is invoked, the
agent SHOULD report `deft-directive-triage stub -- not yet implemented; see
#1130` and chain into the manual fallback documented above.
