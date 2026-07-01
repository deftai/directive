## Summary

`task triage:accept` is documented as the canonical write path for accepted
Phase 0 candidates and is supposed to delegate vBRIEF authoring to
`task issue:ingest`. The implementation does not do this. It only appends an
audit-log entry to `vbrief/.eval/candidates.jsonl`. As a result, a complete
Phase 0 walk produces zero files in `vbrief/proposed/` for the accepted set,
which is the artifact the rest of the refinement skill chains on.

## Pairing

! MUST be batched with #988 (ingest fidelity bug) on the SAME swarm agent --
both fixes touch `scripts/triage_actions.py` and/or `scripts/issue_ingest.py`,
so the swarm Phase 1 Step 2 file-overlap audit will force grouping anyway.
Landing #985 without #988 moves the breakage downstream rather than fixing
the pipeline: accept would then write a stub to `proposed/`, but the stub
is still unworkable by the swarm because the body and acceptance criteria
do not survive ingestion (#988). Together they restore the full Phase 0 ->
Phase 1 -> swarm pipeline.

## Skill contract (the documented behaviour)

From `skills/deft-directive-refinement/SKILL.md`, Phase 0 Three-Tier Inventory
Model, Tier 3:

> Phase 0 only writes here on `accept`; everything else stays out of
> `proposed/` so the folder's semantic is once again "backlog the user has
> agreed to consider." `task triage:accept` is the canonical write path -- it
> delegates the actual vBRIEF authoring to `task issue:ingest` so
> slug/reference/schema rules stay in one place (#537).

## Implementation reality

`scripts/triage_actions.py` (function `accept`, lines 295-309 at the time of
filing):

```python
def accept(n, repo, *, actor=None, project_root=None) -> str:
    """Record an accept audit entry. Idempotent on already-accepted state."""
    actor_str = _resolve_actor(actor)
    prior = _is_idempotent_repeat(n, repo, "accept")
    if prior is not None:
        return str(prior["decision_id"])
    log = _require_log()
    entry = _build_entry("accept", n, repo, actor=actor_str)
    return str(log.append(entry))
```

That is the whole function body. There is no `subprocess.run(["task",
"issue:ingest", ...])`, no call into `scripts/issue_ingest.py`, and no write
to `vbrief/proposed/`. Compare `reject()` directly below it -- reject IS
wired through to its upstream side effect (`gh issue close` + label) via
`_run_gh`. The asymmetry is the bug: reject was completed; accept was not.

The module docstring even gives this away:

> - ``accept(n, repo)`` -- record an accept audit entry.
> - ``reject(n, repo, reason)`` -- close the upstream GitHub issue with
>   ``gh issue close ...``, apply the ``triage-rejected`` label, and record
>   a reject audit entry.

So the docstring is consistent with the implementation. Only the SKILL.md
description is out of step with both.

## Observed end-state (today's session)

In a single Phase 0 walk on `refinement/2026-05-08`:

- 7 accept records appended to `vbrief/.eval/candidates.jsonl` for issues
  #910, #911, #975, #976, #979, #983, #984 (all with valid `decision_id`s
  and timestamps).
- 0 corresponding vBRIEF files in `vbrief/proposed/`. The 4 files actually
  present in `proposed/` are unrelated older items from prior sessions.
- `task issue:ingest -- --all --dry-run` reported 272 items it would create
  (i.e. nothing has materialised for the accepted set), confirming the gap.

## Repro

1. Start from a clean Phase 0 (cache populated, audit log non-terminal for
   at least one issue).
2. Run `task triage:accept -- --issue <N> --repo <owner>/<repo>` for any
   issue.
3. Inspect `vbrief/proposed/`: no file exists for issue `<N>`.
4. Inspect `vbrief/.eval/candidates.jsonl`: an `accept` record for issue
   `<N>` was appended successfully.

## Severity

Adoption-blocker. The post-#845 refinement model promises that "only
accepted items reach `vbrief/proposed/`." The current behaviour is "no items
reach `vbrief/proposed/` from Phase 0 at all." Operators who follow the
SKILL.md walkthrough end up with nothing usable for Phase 1+ and have no
indication that anything went wrong (the accept call returns a decision_id
and exits 0).

## Candidate fixes

Two viable shapes; either is acceptable, but the choice should be made
explicitly because they have different downstream implications:

1. **Make `accept()` call `issue:ingest` for the single issue inline.**
   Smallest diff. After the `log.append(entry)` succeeds, invoke
   `scripts/issue_ingest.py` (or the importable function it exposes) for
   the single `(repo, n)` tuple. If the ingest fails, the audit entry MUST
   be rolled back (mirror `reject()`'s `_rollback_audit_entry` pattern) so
   the log never references a decision that did not actually take effect.
   Cleanly matches the SKILL.md "delegates" wording.

2. **Defer the writes to a Phase 1 ingest pass that filters by audit log.**
   Accept stays log-only. `task issue:ingest` grows a new mode (e.g.
   `--from-audit-log`) that reads `vbrief/.eval/candidates.jsonl`, filters to
   `decision == "accept"` since some cutoff, and creates exactly those
   vBRIEFs. SKILL.md updates to say "Phase 0 records intent; Phase 1
   materialises it." Bigger surface change but cleaner separation.

Per the rule of preserving Phase 0 decisions, fix 1 is the lower-risk
default. Fix 2 is the more honest model if we want triage to be cheap and
ingest to remain explicit; it would also fix the secondary observation
below.

## Secondary observation (worth tracking separately)

`task issue:ingest -- --all` does not consult `vbrief/.eval/candidates.jsonl`.
A dry-run after today's Phase 0 walk reported 272 items it would create,
including issues that were explicitly bulk-deferred or rejected during this
or prior Phase 0 sessions. So `--all` is not a safe Phase 1 step in the
post-#845 world: running it undoes Phase 0 by re-ingesting deferred and
rejected candidates. This is a separate defect from the accept bug above,
but the two interact: today, neither half of the Phase 0 -> Phase 1 contract
is intact. If fix shape 2 is chosen above, both halves heal in one change.
If fix shape 1 is chosen, this secondary observation should be filed as its
own issue.

## Related

- #845 -- pre-ingest triage workflow epic (the work that introduced
  `task triage:accept` and the three-tier inventory model)
- #537 -- ingest-task discipline (skills MUST NOT reimplement slug/ref/schema
  inline; this is the rule the SKILL.md cites when claiming `triage:accept`
  delegates to `issue:ingest`)
- #883 -- unified content cache (#883 Story 3 rebound the triage surface
  onto the unified cache; the accept-side ingest delegation was likely
  collateral damage during that rebind)

## Non-goals

- Does NOT change the audit-log schema (`vbrief/schemas/candidates.schema.json`).
- Does NOT change the `vbrief/proposed/` layout, slug rules, or reference
  schema -- those stay owned by `scripts/issue_ingest.py` per #537.

