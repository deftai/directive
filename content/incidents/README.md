# Incidents Library

This directory captures real-world incidents that motivated specific Deft
Directive rules. Each entry is short, structured, and answers one question:
"if our rules had been in force, would this incident have been prevented?"

The library was stood up by Wave 2 cohort issue [#708](https://github.com/deftai/directive/issues/708)
alongside the destructive-op guardrails it documents.

## Why this exists

Rules without recurrence records become advisory prose. Recurrence records
without rules become war stories. The pairing -- rule body in `coding/`,
incident entry here, deterministic test in `tests/content/` -- is the
[AXIOM] strongest-applicable-encoding tier in `main.md`.

When a future agent reads `coding/security.md` and asks "do I really need
the Environment Isolation Gate?", the incident entry answers in the
agent's own terms: a real database with real backups got wiped in nine
seconds because the agent acted on the user's prompt instead of a trusted
environment signal.

## Entry format

Every entry MUST follow this shape. Use [`_template.md`](_template.md) as
the starting point.

1. **One-line summary** (`# <date>: <plain-English summary>`)
2. **Date** -- ISO 8601; the date of the incident, not the date of the
   write-up
3. **Source** -- canonical external link (vendor postmortem, news article,
   GitHub issue, internal write-up)
4. **What happened** -- one or two paragraphs in the actor's perspective;
   no editorialising
5. **Root cause** -- the structural gap, not the proximate trigger
6. **Which Deft rule(s) would have intervened** -- explicit cross-reference
   to the rule body in `coding/` (path + section heading + issue number).
   If no rule existed at incident time, name the rule introduced by this
   entry
7. **Eval / regression coverage** -- link to the test that exercises the
   lesson (typically `tests/content/test_*.py` for content-pinned rules,
   or `tests/cli/` for behavioural rules)
8. **Status** -- one of: `rules-in-place`, `rules-proposed`, `no-rule-yet`

## Filename convention

`YYYY-MM-<short-slug>.md` for incidents identified by month;
`YYYY-MM-DD-<short-slug>.md` when the exact date matters.

Examples:

- `2026-04-pocketos-railway-prod-db-wipe.md`
- `2026-04-15-some-other-incident.md`

Filenames use hyphens, not underscores -- this mirrors the project-wide
filename convention in [`main.md`](../../main.md).

## When to add an entry

Add an entry when ALL of these are true:

- The incident is publicly documented (vendor postmortem, news article,
  GitHub issue) OR is reproducible from a synthetic prompt
- The structural gap maps to a specific Deft rule (existing or proposed)
- The lesson is non-obvious -- "the agent ran `rm -rf /`" without a
  structural takeaway does not warrant an entry

Add an entry WITHOUT a backing rule only when the entry itself is the
proposal mechanism (status: `rules-proposed`); the rule MUST land in a
follow-up PR within the same cycle.

## Anti-patterns

- Long, editorialising write-ups -- the goal is a structured record, not
  a narrative
- Entries without a `Which Deft rule(s) would have intervened` section --
  the cross-reference is the load-bearing field
- Entries that cite a rule body without a deterministic test reference --
  use [AXIOM] tier 1 enforcement, not prose alone
- Speculative incidents ("imagine if an agent did X") -- this directory
  is for documented or synthetic-reproducible recurrence records only
