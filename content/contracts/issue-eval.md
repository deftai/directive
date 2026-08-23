# Issue-eval contract (#3648)

Sole normative source of truth for Stage A issue evaluation: isolated validity, parent WIP census, named gitignored sink, and value advice that must not stamp the reserved design-critique clearance line. The thin skill [`skills/deft-directive-issue-eval/SKILL.md`](../skills/deft-directive-issue-eval/SKILL.md) is a pointer only. The verb is `task triage:evaluate`.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**See also**: [`design-critique.md`](./design-critique.md) (reserved clearance grammar) | [`docs/decisions/ADR-005-design-critique-judgment-gate.md`](../../docs/decisions/ADR-005-design-critique-judgment-gate.md) (gate; not amended here)

Stage B (accept-path default-flip stamp) is not this contract. ⊗ Amend ADR-005 vehicle invariance from this surface.

## Split read sources

! A detached worktree at `origin/master` owns validity and ADR / contract reads.

! The parent on the live working set owns the WIP census: `xbrief/active/`, `xbrief/pending/`, and `plan-sequence`.

! GitHub REST owns open PRs, open issues, and duplicate linkage. Prefer `ghx` for repeated GETs. ⊗ `gh issue view --json` / `gh pr view --json` (GraphQL).

! The evaluator never receives WIP conflict inputs. Parent joins after the evaluator returns.

## Verdict sink

! The parent writes under `.deft-scratch/issue-eval/<sha12>/<invocation-id>/`.

! `<sha12>` is `origin/master` at evaluation start (invalidation key). `<invocation-id>` is a fresh UUID per `triage:evaluate` invocation.

! **No assist posture marker on the CLI parent.** The parent writes after join. The evaluator writes nothing durable.

! Parent tears down evaluator worktrees on success and on failure. Parent MAY GC `<sha12>` directories that are not the current `origin/master`.

⊗ Widen `VALID_DECISIONS` or append a candidates-log row. The audit log is closed and has no SHA field.

⊗ Write under `xbrief/.eval/` (eval-health namespace).

⊗ Use `xbrief/.triage-cache/candidates.jsonl` as the verdict store.

## Evaluator worktrees

! Path: `.deft-scratch/worktrees/issue-eval-<issue>-<invocation-id>` (same layout class as `defaultWorktree`).

! Parent owns `git worktree add --detach` at `origin/master` and `git worktree remove`. The evaluator never creates or removes worktrees.

! Evaluators run `deft session:start --read-only` (never claims occupancy).

⊗ Reuse `swarm:launch` until #3649 lands (create-before-claim occupancy defect).

⊗ Checkout or commit to `origin/master` on the shared working tree.

⊗ Let evaluators read or write the shared working tree.

## Value advice grammar

! Value MAY recommend a critique via a distinct field `critique-recommend:`.

⊗ Emit `design-critique: warranted | not warranted, because …` — that line is the reserved posted clearance shape. The author stamps clearance independently.

## No GitHub writes; existing decisions

! Evaluation writes nothing to GitHub (no comments, labels, or issue edits).

! Operator decisions stay the existing `triage:*` verbs (`accept` / `reject` / `defer` / `needs-ac` / `mark-duplicate`). No new decision verb. No direct `xbrief/proposed/` write.

## Fan-out

! Default **4** parallel evaluators. Override `--concurrency N`. 4 is a bind, not a measured existing cap.

! REST-first reads.

## Acceptance-criterion amendment

The body AC "shared checkout and master untouched" is recut:

! Evaluators never read or write the shared working tree.

! The parent MAY write the named gitignored sink and create the named sibling worktrees.

! `origin/master` is not checked out and not committed to.
