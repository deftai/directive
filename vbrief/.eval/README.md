# `vbrief/.eval/` -- triage + slicing evaluation artefacts

This directory holds the append-only JSON-lines logs that the triage and
slicing skills emit. The framework governs which files in here are tracked
by git versus gitignored using a **hybrid policy** (#1144, child of #1119).

## Tracking policy

| File | Tracked? | Why |
| --- | --- | --- |
| `slices.jsonl` | Yes -- **committed** | Team-shared cohort records produced by slicing skills (D13 / #1132). New operators joining the team need to see prior cohort outputs to detect orphans and avoid re-slicing the same scope. |
| `candidates.jsonl` | No -- **gitignored** | Operator-private triage decisions (#845 Story 2). Each operator's local accept / defer / reject stream is per-machine state; sharing it would conflate operators' timing + identity across the team. Re-derive on a fresh clone via `task triage:bootstrap`. |
| `summary-history.jsonl` | No -- **gitignored** | Operator-private observability for `task triage:summary` output time-series. Not load-bearing for any decision. |
| `scope-lifecycle.jsonl` | No -- **gitignored** | Operator-private scope-lifecycle audit decisions (D1 / #1121). Each demote (`task scope:demote`) appends one entry including a `demote_meta` block (`was_promoted`, `original_promotion_decision_id`, `days_in_pending`, `demote_reason`, `demoted_from`). Per-operator stream; sharing would conflate operators' demote timing across the team. Lightweight metrics over this log are tracked separately at #1180. |
| `decompositions/` | No -- **gitignored** | Temporary story-decomposition proposal drafts. These JSON drafts are local scratch artifacts, not vBRIEFs; generated child story vBRIEFs are created by `task scope:decompose` in lifecycle folders, defaulting to `vbrief/pending/`. |
| `doctor-state.json` | No -- **gitignored** | Per-machine `task doctor` throttle state (last exit code + timestamps) persisted to gate the 24h/4h re-probe window (#1308 / #1464). Local to each clone; never committed. |

The gitignore lines live in the repo-root `.gitignore` (`vbrief/.eval/candidates.jsonl`,
`vbrief/.eval/summary-history.jsonl`, `vbrief/.eval/scope-lifecycle.jsonl`,
`vbrief/.eval/decompositions/`, and `vbrief/.eval/doctor-state.json`). All paths
not listed above remain committed by default.

## Fresh-clone regeneration

On a fresh clone (or any machine that has never run triage), `candidates.jsonl`
is absent. Regenerate it with:

```
task triage:bootstrap
```

The bootstrap path detects the missing file, runs the auto-classifier, and
writes a fresh `vbrief/.eval/candidates.jsonl`. It does NOT touch the tracked
`slices.jsonl`; cohort records remain a team-shared resource.

## `merge=union` policy for `*.jsonl`

The repo-root `.gitattributes` declares:

```
vbrief/.eval/*.jsonl  merge=union
```

The `union` merge driver concatenates both sides' appended lines on
auto-merge, so two branches that each appended a different record to the
same JSON-lines file rebase cleanly without operator surgery. Two things
operators should know:

- **Concatenation, not set-union.** When two branches append DIFFERENT
  records to the file, the merge driver concatenates both sides' lines
  -- there is no smart deduplication of "semantically similar" records.
  (Identical line-for-line appends collapse because git's three-way
  merge sees them as the same change, but distinct records always
  survive verbatim, even if a downstream reader would consider them
  redundant.) The append-only writers in `scripts/candidates_log.py`
  mint a fresh `decision_id` per call, so genuinely duplicate records
  are not the expected case, but downstream readers MUST tolerate
  multiple records describing the same logical decision.
- **Single-operator scope only.** This is the foundational rebase
  ergonomic for the single-operator case (operator A rebases their
  feature branch onto a master that grew while they were AFK).
  Multi-operator merge-conflict resolution is explicitly out of scope per
  #1119 R4 (tracked separately as M1-M4 in #1183).

## See also

- Current Shape comment on #1144 for the canonical decisions (the source
  of truth this README documents).
- `.gitignore` -- selective gitignore entries for the operator-private
  files.
- `.gitattributes` -- the `merge=union` rule.
- `scripts/candidates_log.py` -- the writer for `candidates.jsonl`.
