# Context Pruning

Fresh context windows for every task — eliminating context rot.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [context/context.md](../context/context.md) | [context/fractal-summaries.md](../context/fractal-summaries.md) | [core/glossary.md](../core/glossary.md)

> Adapted from [GSD](https://github.com/gsd-build/get-shit-done) context pruning model.

---

## Core Principle

Context rot is the silent killer of multi-task agent work. By task 3–4 in a sequence, the context window is saturated with stale tool output, dead-end debugging, and outdated file reads. The model doesn't know what's current — reasoning quality drops as signal-to-noise collapses.

---

## Task Anchoring

- ~ Each task gets a **logical anchor point** in the conversation
- ~ Before each task, prune prior tasks' tool calls, intermediate reads, and debugging traces
- ! The only things in context for a new task: **current task plan** + **curated upstream summaries**
- ⊗ Carrying forward stale file reads, old terminal output, or resolved debugging traces

## Zero Discovery Calls

- ~ Pre-assemble everything the agent needs **before** the task starts:
  - Task plan (goal, steps, acceptance criteria)
  - Compressed summaries from dependency features (see [fractal-summaries.md](../context/fractal-summaries.md))
  - Locked decisions from interview phase (see [strategies/discuss.md](../strategies/discuss.md))
  - Continue checkpoint data if resuming (see [resilience/continue-here.md](./continue-here.md))
- ~ If the agent must `grep` for project structure or search for prior decisions, the context assembly is broken
- ⊗ Spending tokens on "where am I, what exists, what was decided" — that's context assembly's job

## Token Budget

- ~ Cap injected summary context at **~2500 tokens**
- ~ If dependency chain is too large, drop oldest/least relevant summaries first
- ~ Priority: release summaries > feature summaries > task summaries
- ! Never exceed the budget by loading "just one more" summary

---

## Self-Monitoring

Behavioral guidelines for recognizing and acting on context degradation mid-sequence.

- ~ After every 3 completed tasks in a sequence, pause and assess: is reasoning quality declining?
- ~ Watch for these signals of context rot:
  - Repeating tool calls that were already made earlier
  - Conflating details from different tasks
  - Hesitating on decisions that were already locked
  - Growing urge to re-read files that haven't changed
- ! When signals appear: write a continue checkpoint (see [continue-here.md](./continue-here.md)) and start a fresh context
- ~ Proactively checkpoint **before** degradation — don't wait until reasoning visibly breaks
- ≉ Pushing through "just one more task" when context is saturated
- ? If task count is uncertain, err on the side of checkpointing early

---

## Anti-Patterns

- ⊗ Task 5 seeing 40 tool calls from tasks 1–4
- ⊗ Referencing variables/patterns from code that was since refactored
- ⊗ Avoiding approaches that failed earlier for reasons that no longer apply
- ⊗ Re-reading the entire project structure at the start of every task
