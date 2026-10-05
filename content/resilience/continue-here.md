# Continue-Here: Interruption Recovery

Surviving context window exhaustion, session timeouts, and manual stops.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [context/long-horizon.md](../context/long-horizon.md) | [resilience/context-pruning.md](./context-pruning.md) | [core/glossary.md](../glossary.md)

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

Persist to `./xbrief/continue.xbrief.json` in xBRIEF format (legacy `./vbrief/continue.vbrief.json` is read-accepted until migrated):

- ! **Completed** — what's already done (xBRIEF items with `completed` status)
- ! **Remaining** — what's left (xBRIEF items with `pending` status)
- ! **Decisions** — choices made during this session (xBRIEF narratives)
- ~ **Hazards** — what was tricky, what to watch out for (narrative)
- ! **Resume point** — the exact first thing to do when resuming (narrative on the next `pending` item)
- ! **Scope xBRIEF reference** — when scope xBRIEFs exist, MUST include `planRef` to the scope xBRIEF(s) the agent was working on (enables the resuming agent to load the durable scope record)

## Resume Protocol

- ! On resume, read the continue checkpoint — **don't replay conversation history**
- ! Load the task plan + continue checkpoint into context
- ! Pick up from the resume point, not from the beginning
- ! After successful resume, mark the continue checkpoint consumed (status: `completed`)
- ⊗ Re-debate decisions already recorded in the continue checkpoint
- ⊗ Re-read prior conversation to reconstruct state

## Continue Checkpoint Lifecycle

- ! Continue checkpoints are **ephemeral** — consumed on resume, not permanent records
- ~ Durable learnings from the session → persist to [meta/lessons.md](../../meta/lessons.md)
- ~ Durable state → persist to the task's xBRIEF plan file or scope xBRIEF(s) in lifecycle folders
- ! Scope xBRIEFs (`./xbrief/{proposed,pending,active,completed,cancelled}/`; legacy `./vbrief/` read-accepted) are **durable** — they persist across sessions and are shared between agents; do not conflate them with ephemeral continue checkpoints
- ⊗ Accumulate stale continue checkpoints — clean up after resume

## Not the interview phase/approval carrier (#5352 Prefer-A Bound)

! Interview phase and approval scope after a planning draft live on
  `plan["x-directive/interviewContinuation"]` under `./xbrief/plan.xbrief.json`
  — see `skills/deft-directive-interview/SKILL.md` Rule 12. Continue-here
  remains the interruption checkpoint only (consumed on resume).

! After a successful continue-checkpoint resume, if a post-draft design
  interview is still in force, the agent MUST still load that durable carrier.
  A consumed continue checkpoint MUST NOT be treated as proof of phase,
  reopenable decision set, deferrals, confirmation scopes, or approval
  target/revision identity.

⊗ Use `xbrief/continue.xbrief.json` / this continue-here protocol as the
  durable interview phase/approval-scope carrier. Prefer-A Bound explicitly
  excludes that substrate. Unlabeled Decisions / Hazards / Resume-point prose
  in a continue checkpoint is not authorization evidence for handoffs.

⊗ Resume a post-draft design interview from Resume-point-only / next-question
  orientation without the durable carrier's required fields.

---

## Anti-Patterns

- ⊗ Resuming by asking the user "where were we?"
- ⊗ Re-reading full conversation history instead of the continue checkpoint
- ⊗ Losing in-flight decisions because they weren't persisted
- ⊗ Starting over from scratch after an interruption
- ⊗ Creating `continue-{ULID}.json` — the file is singular: `continue.xbrief.json`
- ⊗ Using continue-here as the durable interview phase/approval-scope carrier (#5352) — load `plan["x-directive/interviewContinuation"]` on `./xbrief/plan.xbrief.json` instead
