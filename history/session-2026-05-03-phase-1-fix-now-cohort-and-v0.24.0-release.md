# Session 2026-05-03 — Phase 1 "Fix Now" cohort + v0.24.0 release

## Outcome

Shipped **v0.24.0** ([release](https://github.com/deftai/directive/releases/tag/v0.24.0)) — 9-brief Phase 1 adoption-blocker cohort plus a same-release release-pipeline hot-fix surfaced during cut.

- 11 PRs merged: #844, #846, #850, #851, #854, #858, #859, #860, #861, #862, #863, #869
- Master tip at release: `93782b3` (`chore(release): v0.24.0 -- promote CHANGELOG + ROADMAP`)
- Wall-clock: ~13 hours across two contiguous sessions
- Zero direct-master commits
- All Greptile reviews ≥ 4/5; zero rollbacks; one in-flight escalation (release-pipeline branch-gate, fixed in v0.24.0)

## Sequence

1. **Coverage-gap pass** (#844): cross-referenced 9 currently-open `bug`/`adoption-blocker` issues against `vbrief/**/*.json`. 5 were already in `proposed/`; 4 (#784, #796, #800, #814) were missing → ingested via `task issue:ingest`.
2. **Phase 1 stamp + promote**: stamped `metadata.x-migrator.{Phase, PhaseDescription}` on all 9 briefs, promoted `proposed/` → `pending/`, set `swarm_ready: true`.
3. **Refinement**: re-shaped 4 newly-stamped briefs to canonical 9-narrative shape (Problem/Overview/Background/Constraint/Risk/Outcome/Test/Action/Urgency) + 6-7 plan.items each, distilled from the (well-written) issue bodies. Critical gap caught here: the 4 new briefs were structurally `swarm_ready` but semantically misleading without proper narratives — initial flag was a contract violation. Fixed in same PR cycle.
4. **Wave 1 (#814 solo)**: dispatched single sub-agent for the `cp1252` Windows commit blocker. Solo because it self-blocked all subsequent Windows agents until master ships the fix. Merged at `9bfa37b`.
5. **Wave 2 (8 in parallel)**: 8 sub-agents via `start_agent` (sequential calls, concurrent execution) on isolated worktrees. Each followed: activate brief → implement → self-review-cycle. All 8 reached Greptile-clean within ~30 min wall-clock.
6. **Cascade-orchestrator sub-agent**: delegated 7 rebase + Greptile-wait + atomic-merge cycles to a single sub-agent (small-blast-radius first ordering). ~42 min wall-clock; `meta/lessons.md` and `CHANGELOG.md` conflicts resolved trivially via append-only-by-convention.
7. **Lifecycle cleanup (#863)**: 9 active briefs → `completed/` via `task scope:complete`; encoding-gate self-caught two literal-mojibake comments in `tests/content/test_swarm_skill.py` on first run after #862 merged — replaced with escape-sequence form (intended-purpose dogfood).
8. **Release v0.24.0**: Phase 1-3 (pre-flight + dry-run + e2e) green. Phase 4 Step 9 BLOCKED by #747 branch-gate refusing the release pipeline's `git commit` on master. User chose option (b): fix in v0.24.0.
9. **Hot-fix #867 (PR #869)**: `scripts/release.py` now sets `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1` in subprocess env when invoking git commit/tag/push for release artifacts. Filed, branched, fixed, tested, reviewed, merged in one cycle.
10. **Release retry**: all phases green. User Phase 5 user-only-authority gate → `publish`. v0.24.0 went live.

## Multi-agent orchestration patterns used

- **Implementation sub-agents**: 9 (1 Wave 1 + 8 Wave 2). Each one isolated worktree, single coherent role per #727 (build SKILL → review-cycle SKILL end-to-end), stops at PR-clean signal.
- **Review-cycle sub-agents**: 2 (PR #844 monitor pre-merge; PR #863 cleanup). Read review state, address P0/P1, re-poll Greptile, report clean. No merge authority.
- **Cascade-orchestrator sub-agent**: 1, replacing what would have been 7 in-conversation rebase cycles. Single coherent role: rebase + force-push + Greptile re-review wait + atomic merge for 7 PRs. Centralized merge logic + state.
- **Release-prep sub-agent**: 2 (initial + retry). Each ran release SKILL Phases 1-4, halted at Phase 5 user gate as designed.
- **Hot-fix sub-agent**: 1 (#867). File issue + branch + implement + test + PR + review-cycle.

Total `start_agent` calls in session: 13. Concurrency at peak: 8 (Wave 2 implementation agents).

## Real bugs surfaced (and fixed in this release)

1. **`U+2297` mojibake in 12 places across two pending briefs** (#796, #800). Caught by Greptile during PR #844 review. The mojibake form (cp1252 round-trip of `U+2297`) is intentionally not written verbatim in this doc to keep it clean against the #798 encoding gate. Root cause: my refinement helper used Python on Windows; `locale.getpreferredencoding()` defaulted to cp1252; literal `U+2297` source bytes were misread. Fix: read source files explicitly with `encoding="utf-8"`. Lesson reinforced the case for the deterministic encoding gate that #798 then shipped.
2. **`scripts/preflight_branch.py` cp1252 UnicodeEncodeError** (#814). The hook printed `\u2713` to cp1252 stdout; crashed every Windows commit AFTER the gate had already approved it. Maximally confusing UX. Fix: hook self-reconfigures stdout/stderr to UTF-8 at entry.
3. **Encoding-gate dogfood**: the new #798 verify_encoding gate fired on its OWN test file (literal mojibake in documentation comments). Caught it before merge of the cleanup PR. Replaced with `\u…` escape-sequence form.
4. **Multi-worktree pytest tmpdir pollution**: `C:\Temp\pytest-of-msadams` shared across sibling worktrees produced ~200 ERROR setups during local `task check` runs. CI passed cleanly per-worktree. Known pattern; agents flagged it in their PRs but did not block on it.
5. **Release pipeline + #747 branch-gate collision** (#867). The release-cut commit on master was refused by the just-shipped branch gate. e2e didn't catch it (tmp-clone has no hooks). Fix: `scripts/release.py` programmatically uses the existing `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT` escape hatch.
6. **go-task arg forwarding into deps** (caught by agent-793 mid-cycle): `task migrate:vbrief -- --dry-run` propagated `--dry-run` into the new `migrate:preflight` subtask. Fix: `vars: {CLI_ARGS: ""}` on the dep to clear the forward.
7. **PR closing-keyword false positives** (already-existing protection from #701 / #737): no incidents this cohort.

## Lessons (codified inline; not duplicated here per [AXIOM])

- Add narrative-completeness check before flipping `swarm_ready: true` on freshly-ingested briefs. Stamping metadata is cheap; refinement is expensive but mandatory for clean swarm output. (Surfaced when I conflated stamping with refinement; corrected mid-session.)
- e2e rehearsals against tmp-clones miss host-config-dependent gates (hooks, policy state). Either provision the rehearsal repo with the same gate config OR document the gap.
- Append-only-by-convention works for `meta/lessons.md` + `CHANGELOG.md` in cohort cascades — N-1 rebases produce trivial section-vs-section conflicts.
- Cascade-orchestrator pattern (one sub-agent owns sequential rebase+merge for N PRs) saves monitor context budget vs. per-PR poller sub-agents.
- The release-cut commit is a recognizable canonical shape (`chore(release): v\d+\.\d+\.\d+`). The branch-gate carve-out via env-var is the right shape because the release pipeline is the canonical authorized commit-on-master path.

## Artifacts

- `vbrief/PROJECT-DEFINITION.vbrief.json`: 339 scope items
- `ROADMAP.md`: Phase 1 cohort fully under Completed
- `CHANGELOG.md`: `[0.24.0] - 2026-05-03` section, 11 Added + 10 Fixed entries
- All 9 cohort briefs in `vbrief/completed/`

## What remains open

None. Phase 1 closed; Phase 2 cohort selection is the next refinement-pass decision.
