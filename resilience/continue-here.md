# Continue-Here: Interruption Recovery

Surviving context window exhaustion, session timeouts, and manual stops.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [context/long-horizon.md](../context/long-horizon.md) | [resilience/context-pruning.md](./context-pruning.md) | [core/glossary.md](../core/glossary.md)

> Adapted from [GSD](https://github.com/gsd-build/get-shit-done) continue-here model.

---

## Core Principle

Sessions end. Work must not be lost. A fresh session must resume from **exactly** where the prior one stopped — without the human re-explaining everything.

---

## When to Write a Continue Checkpoint

- ! On session end (timeout, user stop, compaction event)
- ! On context window exhaustion
- ~ Proactively when task complexity suggests resumption is likely
- ? Mid-task if a natural checkpoint is reached

## Continue Checkpoint Contents

Persist to `./vbrief/continue.vbrief.json` in vBRIEF format:

- ! **Completed** — what's already done (vBRIEF items with `completed` status)
- ! **Remaining** — what's left (vBRIEF items with `pending` status)
- ! **Decisions** — choices made during this session (vBRIEF narratives)
- ~ **Hazards** — what was tricky, what to watch out for (narrative)
- ! **Resume point** — the exact first thing to do when resuming (narrative on the next `pending` item)

## Resume Protocol

- ! On resume, read the continue checkpoint — **don't replay conversation history**
- ! Load the task plan + continue checkpoint into context
- ! Pick up from the resume point, not from the beginning
- ! After successful resume, mark the continue checkpoint consumed (status: `completed`)
- ⊗ Re-debate decisions already recorded in the continue checkpoint
- ⊗ Re-read prior conversation to reconstruct state

## Continue Checkpoint Lifecycle

- ! Continue checkpoints are **ephemeral** — consumed on resume, not permanent records
- ~ Durable learnings from the session → persist to [meta/lessons.md](../meta/lessons.md)
- ~ Durable state → persist to the task's vBRIEF plan file
- ⊗ Accumulate stale continue checkpoints — clean up after resume

---

## Anti-Patterns

- ⊗ Resuming by asking the user "where were we?"
- ⊗ Re-reading full conversation history instead of the continue checkpoint
- ⊗ Losing in-flight decisions because they weren't persisted
- ⊗ Starting over from scratch after an interruption
- ⊗ Creating `continue-{ULID}.json` — the file is singular: `continue.vbrief.json`
