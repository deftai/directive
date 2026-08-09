# Decision log (`xbrief/decisions/`)

Lightweight **structured agent decision records** for significant choices (#1396).

## What belongs here

Git-inspectable rationale events: what was decided, under which rule/constraint, which alternatives lost, why the winner won, confidence, scope refs, timestamp, and a **revisit trigger**.

**Significant** only:

- architecture
- product behavior
- security
- public/private boundary
- data model
- runtime topology
- hard-to-reverse process

Trivial scope work does **not** need a decision record.

## Layout (dual location)

| Case | Where |
|------|--------|
| Cross-cutting / multi-scope / process policy | Standalone file here: `YYYY-MM-DD-<slug>.decision.json` |
| Decision bound to one active scope | Still write the file here; `task decision:write -- --scope <xbrief>` also appends a pointer under `plan.narratives.Decisions` on that scope xBRIEF |

## Commands

```bash
task decision:write -- --decision "..." --governing-rule "..." --alternative "A" --alternative "B" \
  --why-winner "..." --confidence high --revisit-trigger "..." [--scope xbrief/active/foo.xbrief.json]

task decision:list -- [--query TEXT] [--scope PATH] [--issue N] [--json]
```

Prefer `--body-file` for multi-line fields on Windows.

Full docs: [`content/docs/decision-log.md`](../../content/docs/decision-log.md).

## Not this folder

| Surface | Role |
|---------|------|
| `docs/decisions/ADR-*.md` | Heavyweight architecture ADRs — leave alone |
| Lessons / compound memory (#1513) | Reusable patterns, not single rationale events |
| Chat transcripts | Explicit non-goal |

## Dogfood seeds

- `2026-08-08-scm-label-mirror-first-mass-apply.decision.json` — SCM label-mirror first mass-apply policy (#1423)
