# Inter-run learning surface

**Load when:** designing or implementing cross-session agent memory, hot/cold budgets, frozen snapshots, or retargeting memory pattern issues under epic #2741.

Legend (RFC2119): `!`=MUST, `~`=SHOULD, `⊗`=MUST NOT.

## Pointer

Canonical contract (Wave 0 design for [#2742](https://github.com/deftai/directive/issues/2742), epic [#2741](https://github.com/deftai/directive/issues/2741)):

**[docs/analysis/2026-07-31-inter-run-learning-surface.md](../../docs/analysis/2026-07-31-inter-run-learning-surface.md)**

That note inventories Directive memory SoTs (`USER.md` Personal, lessons/packs, triage cache, session ritual, decision/continue), defines **hot / cold / operator-gated** tiers with freeze and budget rules, lists non-goals, and retargets #688, #978, #832–#835, and #479.

## Rules (discovery only)

- ! Prefer the design note vocabulary over free-floating “agent-memory contracts” or Mem0-default RAG for Directive core.
- ! Attach Wave 1+ pattern work (#832–#834, #835, #479) to the tiers and SoTs in the design note.
- ⊗ Revive `x-vbrief/agent-memory` / `swarm/agent-memory.md` (#2700 solution shape abandoned).
- ⊗ Implement mid-session mutable always-in hot memory without freeze-at-session-start.

## Related

- Session ritual: `content/commands.md` § Session-start ritual  
- Continue checkpoints: `content/resilience/continue-here.md`  
- Prompt assembly (freeze mechanism): `content/patterns/prompt-assembly-layer-ordering.md`  
- Skills Index: `REFERENCES.md` → When Managing Context or Long Tasks
