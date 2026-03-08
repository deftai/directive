# Fractal Summaries

Hierarchical memory compression that scales — without compounding information loss.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [context/context.md](./context.md) (Strategy 3: Compress) | [resilience/context-pruning.md](../resilience/context-pruning.md) | [core/glossary.md](../core/glossary.md)

> Adapted from [GSD](https://github.com/gsd-build/get-shit-done) fractal summary model.

---

## Core Principle

Memory must scale with project size. Re-reading 15 task summaries to plan feature 6 is wasteful. Compress hierarchically: task → feature → release — each level distilling the level below.

---

## Summary Hierarchy

### Task Summary (on task completion)

- ! What was built (files, functions, endpoints)
- ! Key decisions made and why
- ! Patterns established that downstream work should follow
- ~ What downstream work should know about
- ~ Persist as a narrative on the task item in `./vbrief/plan.vbrief.json`

### Feature Summary (on feature completion)

- ! Compress task summaries into one coherent feature summary
- ! What the feature delivers (the demo sentence answer)
- ! Boundary map status — what's now available for downstream features
- ~ Persist as a narrative on the feature item in `./vbrief/plan.vbrief.json`

### Release Summary (on release completion or when needed)

- ! Compress feature summaries into one release summary (~200 lines max)
- ! What was built, what's available, what patterns to follow, what decisions are locked
- ~ Include drill-down paths to feature summaries if more detail needed
- ~ Persist as a narrative on the release item in `./vbrief/plan.vbrief.json`

---

## The Iron Rule

- ! **Never summarize summaries.** Each summary level regenerates from the level below + actual code state.
- ⊗ Compressing a feature summary from a prior compressed feature summary
- ! A feature summary comes from task summaries + code inspection, not from a compressed version of a prior feature summary

This prevents compounding information loss — the telephone-game effect where each compression round loses signal.

---

## Token Budget

- ~ Cap total injected summary context at **~2500 tokens**
- ! Priority order when budget is exceeded: release > feature > task
- ~ Drop oldest and least relevant summaries first
- ⊗ Exceeding the budget by loading "just one more"

---

## Anti-Patterns

- ⊗ Loading 15 task summaries when a release summary exists
- ⊗ Summarizing summaries (compounding compression loss)
- ⊗ Summaries that describe process ("I did X then Y") instead of outcomes ("X is now available")
- ⊗ Omitting decisions and patterns from summaries (they're the highest-signal content)
