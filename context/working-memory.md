# Working Memory & Scratchpads

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

Patterns for externalizing intermediate state to files.

---

## When to Create a Scratchpad

- ~ **Multi-step tasks** — when a task has 3+ phases or steps that produce intermediate artifacts
- ~ **Large outputs** — when generated content exceeds what should stay in context
- ~ **Multi-agent handoffs** — when passing structured state between agents
- ? Single-step tasks with small outputs — usually not worth externalizing

## Recommended Format: vBRIEF

[vBRIEF](https://vbrief.org) is a token-efficient JSON format for task plans and progress tracking.

**Graduated complexity:**
1. ~ **Start minimal** — tasks with statuses are enough for simple work
2. ~ **Add narratives** when tasks need explanation or context for another agent
3. ~ **Add edges** (`blocks`, `informs`, `invalidates`, `suggests`) when task dependencies matter
4. ? Use TRON encoding for ultra-compact status representation

### Minimal Example

```json
{
  "vBRIEFInfo": { "version": "0.5" },
  "plan": {
    "title": "Implement user avatar upload",
    "status": "running",
    "items": [
      { "id": "t1", "title": "Add upload endpoint to API", "status": "completed" },
      { "id": "t2", "title": "Write image resize utility", "status": "running" },
      { "id": "t3", "title": "Update user profile component", "status": "pending" },
      { "id": "t4", "title": "Add integration tests", "status": "blocked" }
    ]
  }
}
```

## Cleanup

- ! **Remove scratch files** when the task is complete — they are working memory, not artifacts
- ~ **Persist durable learnings** to [meta/lessons.md](../meta/lessons.md) before deleting scratch files
- ≉ Leaving stale scratchpads in the workspace after task completion
- ? Keep a scratchpad across sessions only if the task spans multiple sessions (see [long-horizon.md](./long-horizon.md))

## vBRIEF Plan and Spec Files Are NOT Scratch

The cleanup rule above applies to **ad-hoc scratchpads**, not to vBRIEF files:

- ⊗ Delete `./vbrief/plan.vbrief.json` as a "scratch file" — it is the durable work plan
- ⊗ Delete `./vbrief/specification.vbrief.json` — it is the source-of-truth spec
- ⊗ Delete `./vbrief/playbook-*.vbrief.json` — playbooks are permanent operational knowledge
- ! Only `./vbrief/continue.vbrief.json` is ephemeral — it is consumed on resume

**See [vbrief/vbrief.md](../vbrief/vbrief.md) for the full taxonomy of durable vs ephemeral vBRIEF files.**
