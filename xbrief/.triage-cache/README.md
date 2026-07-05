# `xbrief/.triage-cache/` -- triage working-set artefacts

This directory holds the append-only JSON-lines logs and local scratch dirs that
the triage and slicing skills emit. The framework governs which files in here
are tracked by git versus gitignored using a **hybrid policy** (#1144, child of
#1119). The version-eval results store owns the sibling `.eval/` namespace (#1703).

## Tracking policy

| File | Tracked? | Why |
| --- | --- | --- |
| `slices.jsonl` | Yes -- **committed** | Team-shared cohort records produced by slicing skills (D13 / #1132). New operators joining the team need to see prior cohort outputs to detect orphans and avoid re-slicing the same scope. |
| `candidates.jsonl` | No -- **gitignored** | Operator-private triage decisions (#845 Story 2). Each operator's local accept / defer / reject stream is per-machine state; sharing it would conflate operators' timing + identity across the team. Re-derive on a fresh clone via `task triage:bootstrap`. |
| `summary-history.jsonl` | No -- **gitignored** | Operator-private observability for `task triage:summary` output time-series. Not load-bearing for any decision. |
| `scope-lifecycle.jsonl` | No -- **gitignored** | Operator-private scope-lifecycle audit decisions (D1 / #1121). Each demote (`task scope:demote`) appends one entry including a `demote_meta` block (`was_promoted`, `original_promotion_decision_id`, `days_in_pending`, `demote_reason`, `demoted_from`). Per-operator stream; sharing would conflate operators' demote timing across the team. Lightweight metrics over this log are tracked separately at #1180. |
| `decompositions/` | No -- **gitignored** | Temporary story-decomposition proposal drafts. These JSON drafts are local scratch artifacts, not vBRIEFs; generated child story vBRIEFs are created by `task scope:decompose` in lifecycle folders, defaulting to `xbrief/pending/`. |
| `doctor-state.json` | No -- **gitignored** | Per-machine `task doctor` throttle state (last exit code + timestamps) persisted to gate the 24h/4h re-probe window (#1308 / #1464). Local to each clone; never committed. |

The gitignore lines live in the repo-root `.gitignore` (`xbrief/.triage-cache/candidates.jsonl`,
`xbrief/.triage-cache/summary-history.jsonl`, `xbrief/.triage-cache/scope-lifecycle.jsonl`,
`xbrief/.triage-cache/decompositions/`, and `xbrief/.triage-cache/doctor-state.json`). All paths
not listed above remain committed by default.

## Fresh-clone regeneration

On a fresh clone (or any machine that has never run triage), `candidates.jsonl`
is absent. Regenerate it with:

```
task triage:bootstrap
```

The bootstrap path detects the missing file, runs the auto-classifier, and
writes a fresh `xbrief/.triage-cache/candidates.jsonl`. It does NOT touch the tracked
`slices.jsonl`; cohort records remain a team-shared resource.

## `merge=union` policy for `*.jsonl`

The repo-root `.gitattributes` declares:

```
xbrief/.triage-cache/*.jsonl  merge=union
```

The `union` merge driver concatenates both sides' appended lines on
auto-merge, so two branches that each appended a different record to the
same JSON-lines file rebase cleanly without operator surgery.

## See also

- Current Shape comment on #1144 for the canonical decisions (the source
  of truth this README documents).
- `.gitignore` -- selective gitignore entries for the operator-private
  files.
- `.gitattributes` -- the `merge=union` rule.
