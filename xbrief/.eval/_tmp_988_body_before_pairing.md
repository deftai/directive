## Summary

`task issue:ingest` is the canonical write path that materialises an accepted
GitHub issue as a scope vBRIEF in `vbrief/proposed/`. Today it produces a
stub: the GitHub issue **body** never reaches the vBRIEF, no sidecar/`.md`
companion is written next to the `.vbrief.json`, and no `plan.items`
acceptance criteria are derived. The result is that every ingested vBRIEF
fails the swarm Phase 0 "acceptance criteria present" check and is treated as
not allocatable. The contract documented in the swarm skill -- that
auto-generated vBRIEFs land with `plan.narratives.Overview` set to the issue
body content -- is unbacked by the implementation.

This issue covers BOTH observations as a single bug because they share one
root cause (`scripts/issue_ingest.py` not carrying the body through) and one
fix surface (the same module that would populate `narratives.Overview` is the
one that would populate or scaffold `plan.items`).

## Observed end-state (2026-05-08 refinement session)

Inspecting `vbrief/pending/2026-05-08-985-bugtriagerefinement-...vbrief.json`
(ingested today via `task issue:ingest -- 985`):

- File size: **1019 bytes total**.
- `plan.narratives` keys: `["Description", "Origin", "Labels"]`
  - `Description` = 138 chars -- the issue **title** verbatim, NOT the body
  - `Origin` = `"Ingested from https://github.com/deftai/directive/issues/985"` (60 chars)
  - `Labels` = `"bug, adoption-blocker"` (21 chars)
- `plan.narratives.Overview` -- **does not exist**.
- `plan.items` -- **empty array**. Zero acceptance criteria.
- `plan.references[0]` -- carries the issue URL + title (this is the only
  pointer back to the real content).

The actual GitHub issue body for #985 is a multi-section markdown document
covering Summary / Skill contract / Implementation reality (with a code
snippet) / Repro / Severity / Candidate fixes / Secondary observation /
Related / Non-goals. None of that survives ingestion.

Same pattern observed across all 8 vBRIEFs ingested in this session
(#910, #911, #975, #976, #979, #983, #984, #985).

## Skill contract (the documented behaviour)

From `skills/deft-directive-swarm/SKILL.md` Phase 0 Step 0B (Option B --
GitHub issue numbers), describing the auto-generated minimal vBRIEF:

> 3. ! The generated vBRIEF must conform to the canonical v0.6 schema [...]:
>    - `plan.narratives`: object with `{ "Overview": "<issue body content>" }`
>    - `plan.items`: empty array (to be enriched)

Issue body content -> `narratives.Overview` is the documented contract.
The implementation produces `narratives.Description` (= title) instead, and
no `Overview` at all. So the skill description and the implementation
disagree.

The empty `plan.items` is intentional per the contract ("to be enriched"),
but with `narratives.Overview` missing the enricher has no body to work
from -- the only durable pointer is the GitHub URL in `references`. That
forces enrichment to require a live `gh` round-trip per vBRIEF, which
defeats the purpose of having a local cache and a local vBRIEF in the
first place.

## Sidecar observation

There is no `.md` / `-body.md` / `-issue.json` sidecar written next to the
`.vbrief.json`. For issues that pre-date `task triage:bootstrap` (or that
went through it), the unified cache at
`.deft-cache/github-issue/<owner>/<repo>/<N>/raw.json` *does* hold the full
issue body. But:

- `task issue:ingest` does not consult the cache to populate
  `narratives.Overview` from `raw.json` -- it appears to call live `gh` for
  title/labels and stop there.
- For issues filed after the cache was last populated (e.g. #983, #984,
  #985, #987 filed mid-session today), `.deft-cache/github-issue/<owner>/<repo>/<N>/`
  does not exist at all unless `task cache:fetch-all` is re-run. So the
  cache is not a reliable substitute for sidecar / body capture.

Net: there is no local, durable record of the issue body bound to the
vBRIEF. The vBRIEF references a URL and trusts the URL to remain authoritative.

## Repro

1. Pick any open GitHub issue with a non-trivial body.
2. Run `task issue:ingest -- <N>`.
3. Open the resulting `vbrief/proposed/YYYY-MM-DD-<N>-<slug>.vbrief.json`.
4. Inspect `plan.narratives` -- only `Description` (= title), `Origin`, and
   `Labels` are present. No `Overview`.
5. Inspect `plan.items` -- empty array.
6. Inspect adjacent files in `vbrief/proposed/` matching the slug -- only
   the `.vbrief.json`. No body sidecar.

## Severity

Adoption-blocker. The downstream consequence is that **every** vBRIEF
landed by Phase 0 / Phase 1 ingest is unworkable by the swarm without a
manual enrichment step that the documentation does not describe and no
script provides. The swarm Phase 0 Step 2 check ("Identify vBRIEFs with
incomplete acceptance criteria (no `plan.items` or empty items array)")
will flag every ingested vBRIEF as not allocatable. This is the second
half of the same broken pipeline that #985 covers (accept-side delegation
gap); together they mean the post-#845 refinement -> swarm pipeline does
not produce swarm-ready artifacts.

## Candidate fixes

Two viable shapes; either is acceptable, but the choice should be made
explicitly:

1. **Fix `scripts/issue_ingest.py` to carry the body through.** Smallest
   diff. After fetching title/labels, also fetch the issue body and write
   it to `plan.narratives.Overview`. Optionally also write a sibling
   `<slug>.body.md` sidecar so the body is greppable / diffable without
   parsing the JSON. This restores the documented contract and gives the
   enricher (human, monitor, or future enrichment skill) something to
   work from. Schema cost: zero. Code cost: small (one extra `gh api`
   field + one assignment). Process cost: zero.

2. **Add a pre-swarm enrichment skill that walks `pending/` (or
   `active/`) and populates `plan.items` and `plan.narratives.Overview`
   from the linked GitHub issue.** Bigger surface change. Keeps
   `issue:ingest` minimal but makes enrichment a first-class step in the
   refinement -> swarm pipeline. The skill would parse the issue body
   for sections ("Acceptance criteria", "Repro", "Non-goals") and
   project them into structured `plan.items` entries. Trade-off: the
   parsing is heuristic and will need iteration; the enrichment lives in
   a skill rather than a deterministic task.

Recommendation (advisory, NOT a decision): **Fix 1** restores the
documented contract with the smallest blast radius and unblocks the next
swarm immediately. **Fix 2** is the more ambitious next step on top of
Fix 1 -- not instead of. Doing Fix 1 first means Fix 2 (when it lands)
has body content to project from, rather than having to live-fetch.

## Related

- #985 -- sister bug: `task triage:accept` skips delegation entirely;
  combined with this issue, the post-#845 Phase 0 -> Phase 1 -> swarm
  pipeline produces no usable artifact at any stage
- #845 -- pre-ingest triage workflow epic
- #883 -- unified content cache (#883 Story 2 cache surface that an
  enriched ingest would consult to avoid live-fetching the body)
- #537 -- ingest-task discipline (skills MUST NOT reimplement
  slug/reference/schema rules; this issue is consistent with that --
  `issue_ingest.py` remains the canonical writer, it just needs to
  carry one more field)
- #987 -- priority signal meta (orthogonal but related: ordering vs.
  fidelity are both gaps in the swarm-ready surface)
- `skills/deft-directive-swarm/SKILL.md` Phase 0 Step 0B / Step 1 / Step
  2 -- the documented contract that the implementation breaks

## Non-goals

- Does NOT change the audit-log schema or the
  `vbrief/proposed/` -> `pending/` -> `active/` lifecycle.
- Does NOT change the slug rules or reference shape -- those stay owned
  by `scripts/issue_ingest.py`.
- Does NOT introduce a new schema field; `plan.narratives.Overview` is
  already valid per the canonical v0.6 schema.
- Does NOT propose section-parsing heuristics for `plan.items` -- that
  belongs in the Fix 2 follow-up, not this issue.

