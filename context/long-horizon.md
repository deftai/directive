# Long-Horizon & Multi-Session Tasks

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

Patterns for tasks that span multiple sessions or phases.

---

## Checkpoint / Resume

- ! **On resume, read the checkpoint — don't replay history.** The checkpoint file is the source of truth, not the conversation that produced it.
- ~ Write checkpoints to `./vbrief/plan.vbrief.json` in the workspace
- ~ Use vBRIEF status lifecycle: `pending` → `running` → `completed` / `blocked` / `cancelled`
- ~ Include a `plan` object with a `title` summarizing the overall objective, `status`, and an `items` array
- ? Add a `narrative` to tasks that need explanation for a future session or agent

## Task Dependencies (DAG Edges)

When tasks have dependencies, express them as vBRIEF edges:

| Edge type      | Meaning                                    |
|----------------|--------------------------------------------|
| `blocks`       | Target cannot start until source completes |
| `informs`      | Target should consider source's output     |
| `invalidates`  | Source completion may require target redo   |
| `suggests`     | Source outcome may spawn target            |

- ~ Use edges when task order matters or when agents need to coordinate
- ≉ Adding edges for trivially sequential tasks — a list order is sufficient

## Context Summarization Between Phases

- ~ **Summarize before moving on** — when completing a phase, write a brief summary of decisions made, files changed, and open questions
- ~ Carry the summary forward, not the full history
- ≉ Re-reading entire conversation history when a checkpoint exists

## Progress Tracking

- ~ Maintain `./vbrief/plan.vbrief.json` for multi-phase work
- ~ Update task statuses as work progresses
- ! Mark tasks `blocked` with a narrative explaining the blocker
- ~ On task completion, review for learnings worth persisting to [meta/lessons.md](../meta/lessons.md)
- ⊗ Use a separate `progress.vbrief.json` — progress tracking lives in `plan.vbrief.json`
