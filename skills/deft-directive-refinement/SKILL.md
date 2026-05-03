---
name: deft-directive-refinement
description: >
  Conversational refinement session. Ingests external work items into
  vBRIEF proposed/ scope, deduplicates via origin references, evaluates
  proposals with the user, reconciles stale origins, and promotes/demotes
  scopes through the lifecycle using deterministic task commands.
triggers:
  - refinement
  - reprioritize
  - refine
  - roadmap refresh
  - refresh roadmap
  - triage
  - action menu
  - work the cache
  - pre-ingest
---

# Deft Directive Refinement

Conversational refinement session -- ingest, evaluate, reconcile, and prioritize scope vBRIEFs with the user.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**See also**: [`../../contracts/deterministic-questions.md`](../../contracts/deterministic-questions.md) (canonical numbered-menu rule used by every Phase 0 / Phase 2-5 gate below) | `task triage:cache` / `task triage:bootstrap` / `task triage:accept` / `task triage:reject` / `task triage:defer` / `task triage:needs-ac` / `task triage:mark-duplicate` / `task triage:bulk` / `task triage:refresh` (Phase 0 task surface introduced under #845).

## Platform Requirements

! This skill requires **GitHub** as the SCM platform and the **GitHub CLI (`gh`)** to be installed and authenticated. Issue ingestion, origin freshness checks, and completion lifecycle all depend on `gh`.

## Deterministic Questions Contract

! Every numbered-menu prompt rendered in this skill (Phase 0 Triage action menu, Phase 2 Evaluate per-item accept/reject, Phase 3 Reconcile flagged-item walk, Phase 4 Promote/Demote lifecycle gates, Phase 5 Prioritize reorder gates) MUST follow [`../../contracts/deterministic-questions.md`](../../contracts/deterministic-questions.md): the final two numbered options MUST be `Discuss` and `Back`, in that order. The Discuss-pause semantic is documented verbatim there -- on `Discuss` selection the agent MUST halt the in-progress sequence immediately, prompt `What would you like to discuss?`, and resume only on an explicit user signal. Implicit resumption is forbidden.

## When to Use

- User says "refinement", "reprioritize", "refine", "roadmap refresh", or "refresh roadmap" (legacy v0.19 terms -- deft-directive-refinement is the current skill name)
- User says "triage", "action menu", "work the cache", or "pre-ingest" -- first-class Phase 0 direct triggers introduced under #845; they route to Phase 0 (Triage), not the general refinement entry
- New issues have accumulated since the last refinement session
- Periodic maintenance pass (e.g. weekly or after a batch of user feedback)
- User wants to review and organize the backlog

! **Entry point (#845).** Phase 0 -- Triage (cache + action menu) is the new canonical entry point for any refinement that begins from a populated `.deft-cache/issues/` mirror or a non-empty `vbrief/.eval/candidates.jsonl` audit log. Phase 0 routes each cached candidate through `task triage:accept|reject|defer|needs-ac|mark-duplicate` so that **only accepted items reach `vbrief/proposed/`**, eliminating the pre-#845 "ingest-everything-then-evaluate" drift in `proposed/`. Phase 0 ! MUST chain into Phase 1 -- Ingest after the action menu is exhausted (or auto-skip when the cache is empty -- see Phase 0 below). Phase 1+ semantics are unchanged.

## Prerequisites

- ! `vbrief/` directory exists with lifecycle folders (`proposed/`, `pending/`, `active/`, `completed/`, `cancelled/`)
- ! GitHub CLI (`gh`) is authenticated and can access the repo
- ~ `PROJECT-DEFINITION.vbrief.json` exists (run `task project:render` if missing)

## Session Model

Refinement is a **conversational loop**, not a batch job. The user directs the flow:

- "Triage" / "action menu" / "work the cache" / "pre-ingest" -> Phase 0 (Triage -- cache + action menu, #845)
- "Pull in issues" / "ingest" -> Phase 0 FIRST when `.deft-cache/issues/` is non-empty OR `vbrief/.eval/candidates.jsonl` has non-terminal candidates (Phase 0 then chains into Phase 1); Phase 1 directly only when the Phase 0 auto-skip condition is met (#845)
- "Show proposed" / "evaluate" -> Phase 2 (Evaluate)
- "Check origins" / "reconcile" -> Phase 3 (Reconcile)
- "Accept these" / "reject that" / "promote" / "demote" -> Phase 4 (Promote/Demote)
- "Reprioritize" / "reorder pending" -> Phase 5 (Prioritize)
- "Close out" / "scope is done" / "completion" -> Phase 6 (Completion Lifecycle)
- "Done" / "exit" -> Exit

The agent may suggest the next phase, but the user decides. Phases can be entered in any order and repeated.

## Branch Setup (Preflight)

! Before making any changes, ensure you are working on a feature branch. This preflight runs before Phase 0 and again before Phase 1 if Phase 0 is auto-skipped.

1. ! Check if the working tree has uncommitted changes that would conflict -- stop and ask the user to resolve them first
2. ! Create or switch to a refinement branch (e.g. `refinement/YYYY-MM-DD`) if not already on one
3. ! Confirm the branch and working directory to the user before proceeding

## Phase 0 -- Triage (Cache + Action Menu)

! Phase 0 is the canonical pre-ingest entry point introduced under #845. It operates on the **three-tier inventory model** so that `vbrief/proposed/` only ever contains items the user has explicitly accepted. Phase 0 ! MUST chain into Phase 1 -- Ingest on completion (or auto-skip into Phase 1 when the cache is empty -- see Step 1 below). Numbered prompts in Phase 0 ! MUST follow [`../../contracts/deterministic-questions.md`](../../contracts/deterministic-questions.md) -- the final two numbered options are `Discuss` and `Back`, in that order, and the Discuss-pause semantic from the contract applies verbatim.

### Three-Tier Inventory Model

Phase 0 reads and writes three distinct tiers; ! MUST NOT collapse any pair into a single store:

- **Tier 1 -- `.deft-cache/issues/` (local mirror).** Full-fidelity local cache of fetched issue bodies/labels/state, populated by `task triage:cache` (and refreshed by `task triage:refresh` ahead of swarm dispatch). Mirror is gitignored; #583 quarantine rules apply on the cache path. This is the **read** surface for Phase 0 -- the agent works from the cache, not from live `gh` calls, so triage decisions are reproducible across re-runs.
- **Tier 2 -- `vbrief/.eval/candidates.jsonl` (audit log).** Append-only JSONL recording every candidate the user has ever seen plus the action taken (`accept | reject | defer | needs-ac | mark-duplicate`) and timestamp. Frozen schema lives at `vbrief/schemas/candidates.schema.json`. This is the **memory** surface -- a re-run of Phase 0 against the same cache short-circuits items that already have a terminal entry in the log.
- **Tier 3 -- `vbrief/proposed/` (accepted-only).** Standard scope-vBRIEF lifecycle folder. Phase 0 only writes here on `accept`; everything else stays out of `proposed/` so the folder's semantic is once again "backlog the user has agreed to consider." `task triage:accept` is the canonical write path -- it delegates the actual vBRIEF authoring to `task issue:ingest` so slug/reference/schema rules stay in one place (#537).

! MUST NOT bypass Tier 1 by triaging directly off `gh issue list` output -- the cache is the source of truth for Phase 0; reading live exposes the agent to mid-triage drift the audit log cannot reconstruct.
! MUST NOT bypass Tier 2 by writing accepted items to `proposed/` without first appending the corresponding `accept` record to `vbrief/.eval/candidates.jsonl` -- the audit log is the only durable record of decline/defer decisions; proposed/ alone cannot answer "why didn't this candidate make it in?".

### Trigger Conditions

Phase 0 is entered when **any** of the following hold:

- The user types one of the trigger phrases ("triage", "action menu", "work the cache", "pre-ingest")
- The skill is entered via the standard refinement triggers AND (`.deft-cache/issues/` is non-empty OR `vbrief/.eval/candidates.jsonl` contains at least one candidate without a terminal action) -- the parenthesised disjunction binds tighter than the leading AND so Phase 0 only fires when the skill was actually invoked via a refinement trigger AND there is something to triage
- The user explicitly invokes `task triage:bootstrap` (which seeds the cache) prior to entering refinement

### Step 1: Auto-Skip Probe

! Before any user prompt, the agent MUST probe the cache state and decide whether Phase 0 has any work to do:

1. ! Check whether `.deft-cache/issues/` exists AND contains at least one cached issue file.
2. ! Check whether `vbrief/.eval/candidates.jsonl` exists AND contains at least one record without a terminal action (`accept | reject | mark-duplicate`); `defer` and `needs-ac` are non-terminal and DO count as outstanding work.
3. ! If BOTH probes return empty (cache missing/empty AND audit log missing/empty-of-non-terminals), Phase 0 ! MUST emit the verbatim informational message and ! MUST chain directly into Phase 1 without prompting:

   ```
   triage cache empty -- skipping Phase 0; opt in via `task triage:bootstrap`
   ```

4. ! If the **cache is empty BUT the audit log holds non-terminal records** (e.g. the cache was deleted by `git clean` or manual housekeeping after a prior triage session that left `defer` / `needs-ac` records behind), Phase 0 ! MUST NOT walk an empty cache and produce a misleading `0/0/0/0/0 of 0` summary. Instead the agent ! MUST emit the verbatim recovery message and ! MUST chain directly into Phase 1 without entering the action menu:

   ```
   triage cache absent but audit log has {M} outstanding defer/needs-ac records -- run `task triage:refresh` (re-sync the existing cache) before re-entering Phase 0 if you want to revisit them; chaining into Phase 1 now
   ```

   The recovery message ! MUST surface the outstanding `{M}` count so the user knows what is being deferred again, and ! MUST point at `task triage:refresh` (re-sync) -- ! MUST NOT point at `task triage:bootstrap` because re-bootstrapping can overwrite the existing audit-log records.

5. ! Otherwise (cache non-empty), surface a one-line summary (e.g. `triage cache: {N} cached issues, {M} outstanding candidates`) and proceed to Step 2.
6. ! Record the current ISO 8601 UTC timestamp as `phase0_entry_ts` (in-memory only, no disk write) -- this value is consumed by the Step 4 audit-log cross-check as the cutoff for filtering `defer` / `needs-ac` records created during the current Phase 0 entry. ! MUST be captured here at Step 1 (immediately after the proceed-to-Step-2 branch) so it represents the entry time, not Step 4's invocation time.

⊗ Prompt the user with the action menu when the auto-skip condition is met -- the message above is the only user-visible output before chaining into Phase 1.
⊗ Treat `defer` or `needs-ac` records as terminal during the auto-skip probe -- those statuses mean "come back to this later" and MUST keep Phase 0 alive on the next re-entry.

### Step 2: Refresh the Cache (Optional)

~ When the user wants to start from a known-fresh state (e.g. immediately before a swarm dispatch), run `task triage:refresh` to re-sync the cache from `gh` and update the candidate log. The refresh task is idempotent and respects the #583 quarantine rules on the cache path. Skip this step on subsequent passes within the same session unless the user explicitly asks for it.

### Step 3: Walk Each Candidate -- Action Menu

! For each cached candidate without a terminal entry in `vbrief/.eval/candidates.jsonl`, present the candidate to the user (title, origin URL, labels, body excerpt) and render the canonical numbered action menu. The menu ! MUST be rendered exactly in the order below so the deterministic-questions contract is satisfied (`Discuss` and `Back` are the final two options):

```
What would you like to do with this candidate?
  1. Accept       -- delegate to `task triage:accept <issue>` (writes proposed/ vBRIEF + audit-log entry)
  2. Reject       -- delegate to `task triage:reject <issue>` (audit-log entry only; nothing written to proposed/)
  3. Defer        -- delegate to `task triage:defer <issue>` (non-terminal; resurfaces on the next Phase 0 pass)
  4. Needs-AC     -- delegate to `task triage:needs-ac <issue>` (non-terminal; flags missing acceptance criteria for follow-up)
  5. Mark duplicate -- delegate to `task triage:mark-duplicate <issue> <of-issue>` (terminal; cross-links the duplicate target)
  6. Discuss
  7. Back
```

- ! Each action option ! MUST route to the corresponding `task triage:*` command introduced under Stories 1-4 of #845. Skills MUST NOT reimplement the audit-log append, schema validation, or `proposed/` write inline -- the tasks are the canonical implementation (mirrors the #537 ingest-task discipline).
- ! On `Discuss`, halt the action menu sequence immediately, prompt `What would you like to discuss?`, and resume only on an explicit user signal per the deterministic-questions contract. ⊗ Implicit resumption. **Buffer behaviour during a Discuss halt:** the buffered action for the prior candidate ! MUST be held intact through the halt and dispatched only when the user resumes AND commits a non-`Discuss`, non-`Back` forward action at the current candidate -- a Discuss halt by itself is neither a forward commit nor a stop and ! MUST NOT trigger any `task triage:*` dispatch.
- ! On `Back`, treat the prior candidate's action as un-answered and re-render its action menu (this lets the user undo a misclick without re-running the entire triage pass). When the user selects `Back` on the **very first** candidate of the pass (no prior candidate exists), follow [`../../contracts/deterministic-questions.md`](../../contracts/deterministic-questions.md) Back semantic: surface `Nothing earlier to go back to` and re-render the current candidate's action menu -- do NOT bounce back to Step 2 (refresh) or to the Session Model entry, since the calling-skill entry point for Phase 0 is the Branch Setup preflight, not a question that can be re-asked.
- ! **Back is permitted ONLY before the action has been dispatched to a `task triage:*` command** -- once a `task triage:*` command has run for the prior candidate (its audit-log record is appended AND its `proposed/` write, if any, has landed), the action is committed and `Back` ! MUST NOT be offered as an option to revoke it. **Dispatch timing (precise):** the action chosen for candidate N is **buffered** when the user makes the selection; the buffered action is **dispatched only when the user commits a forward action at candidate N+1** (i.e. when the user advances from N+1 to N+2 OR the pass terminates). "Pass terminates" covers BOTH normal completion (all candidates have a chosen action) AND user-initiated mid-pass stop ("that's enough for today"); in both cases the **last buffered action is dispatched** before Step 4 runs, so a partial pass never leaves an Accept silently un-written to `proposed/`. Concretely: after the user picks an action at N, the agent presents N+1's menu but ! MUST NOT call any `task triage:*` command for N yet; if the user picks `Back` at N+1, the still-buffered action for N is discarded and N's menu is re-rendered. If the user picks a forward action at N+1, N's buffered action dispatches immediately and N+1's selection enters the buffer. If the user opts to stop at any point (mid-pass or end-of-pass), the currently-buffered action ! MUST dispatch before transitioning to Step 4 -- ! MUST NOT discard a buffered action on stop; the user's most recent selection is binding. If the user wants to change an already-committed (dispatched) decision, they ! MUST re-enter Phase 0 in a fresh session and use `task triage:bulk` (Story 4) or a re-issue of the action against the same issue ID -- the canonical task suite owns the supersession contract; this skill does not duplicate it. The audit log remains append-only with no inline supersession semantic.
- ~ Bulk operations: when the user has a clear pattern (e.g. "reject every `wontfix`-labelled candidate"), use `task triage:bulk -- --action reject --label wontfix` (Story 4) instead of walking the menu N times. Bulk results still flow through the audit log so the action history stays coherent.

### Step 4: Pre-Phase-1 Handoff

! When the action menu is exhausted (every cached candidate has a terminal action OR the user opts to stop), Phase 0 ! MUST:

1. ! Surface a session summary (`{accepted}/{rejected}/{deferred}/{needs-ac}/{duplicates} of {total} candidates`) so the user can see what landed in `proposed/`.
2. ! Chain into Phase 1 -- Ingest, which now runs against `vbrief/proposed/` containing only user-accepted items. Phase 1 dedup against existing references is unchanged; the dedup surface is just smaller because rejected/deferred candidates never wrote a vBRIEF. ! Before presenting Phase 1's `task issue:ingest -- --all --dry-run` preview, the agent ! MUST cross-check `vbrief/.eval/candidates.jsonl` for `defer` / `needs-ac` records added since this Phase 0's start timestamp (the agent ! MUST record the Phase 0 entry timestamp at Step 1 and use it as the cutoff -- the audit-log schema (#845 Story 2) does not expose a session-ID field, so timestamp-since-entry is the canonical filter) and surface a one-line note before the dry-run list. The note ! MUST use Phase 0's own vocabulary -- ! MUST NOT import Phase 1's "new-vs-already-tracked" terminology, since the Phase 1 dry-run output is unknowable until after the dry-run runs. Use the form `note: {N} of {total_triaged} candidates triaged in this Phase 0 entry were marked defer/needs-ac -- exclude them from this ingest pass unless the user opts back in`, where `{total_triaged}` is Phase 0's processed-candidate count from the Step 4 Point 1 summary (NOT a Phase 1 quantity). This closes the in-session dedup gap where Phase 1's reference-based dedup has no visibility into non-terminal Phase 0 actions because they intentionally wrote no vBRIEF.
3. ! If the user opts out of Phase 1 (e.g. "that's it for today"), exit via the **Phase 0 mid-session exit surface** below -- ! MUST NOT route to the `### EXIT` block under `## PR & Review Cycle` because that block is the post-PR-creation exit path and every chaining instruction it contains references `PR #{N}`, but no PR exists at this point in the flow.

#### Phase 0 mid-session exit surface

! When the user opts out of Phase 1 after completing (or partially completing) Phase 0 triage, perform exactly these steps -- ! MUST NOT mention any PR number, since none has been created yet:

1. ! Surface the outstanding-work tally: `{deferred} candidate(s) deferred, {needs_ac} flagged Needs-AC -- these will resurface on the next Phase 0 entry.`
2. ! Note the audit-log location verbatim using double-backtick fencing so the inner path renders correctly: ``Audit log preserved at `vbrief/.eval/candidates.jsonl`.``
3. ! Confirm skill exit with the canonical phrasing: `deft-directive-refinement complete -- exiting skill.`
4. ! Provide the Phase-0-appropriate chaining instruction: ``Resume with `task triage:refresh` (re-sync the existing cache) followed by re-entering the refinement skill when ready to continue triage.`` Use `task triage:refresh` for an already-populated cache; `task triage:bootstrap` is the first-time seed and ! MUST NOT be used here because re-seeding can overwrite the deferred/needs-ac audit-log state just created. Do NOT reference a PR, a review cycle, or a monitor agent.

⊗ Skip Phase 1 silently after Phase 0 -- always render the chaining decision so the user knows the entry point shifted.
⊗ Mutate `vbrief/proposed/` directly during Phase 0 -- only `task triage:accept` (which itself delegates to `task issue:ingest`) is allowed to write there.
⊗ Route Phase 0 mid-session opt-out to the post-PR `### EXIT` block under `## PR & Review Cycle` -- that block surfaces a non-existent `PR #{N}` and confuses the user.

## Phase 1 -- Ingest

! Scan external sources for new work items and create proposed scope vBRIEFs.

### Step 1: Gather Sources

1. ? Scan non-GitHub sources (Jira, direct user requests, etc.) manually if applicable — those ingest paths are not yet task-wrapped
2. ! GitHub issues are ingested via the task wrapper documented in Step 3 — the task fetches open issues itself, so no separate `gh issue list` call is needed

### Step 2: Deduplicate via References (Dry-Run Preview)

1. ? Run `task issue:ingest -- --all --dry-run` to preview which issues the ingest task would create scope vBRIEFs for. The task deduplicates candidates against `references` entries in existing vBRIEFs (across all lifecycle folders) so already-tracked issues are skipped automatically.
2. ! Present the user with the list of new-vs-already-tracked items the dry-run reports: "{N} new items found, {M} already tracked"
3. ! Wait for user approval before proceeding to ingest

### Step 3: Ingest Approved Items

! Delegate ingest to `task issue:ingest` — the task is the canonical implementation of scope-vBRIEF creation. Skills MUST NOT reinvent the slug rules, reference shape, or deduplication logic inline (see #537 for background).

- **Single issue**: `task issue:ingest -- <N>` — creates `vbrief/proposed/YYYY-MM-DD-<slug>.vbrief.json` with origin `references`, canonical slug from `scripts/slug_normalize.py` (see [`../../conventions/vbrief-filenames.md`](../../conventions/vbrief-filenames.md)), and schema-conformant shape.
- **Batch**: `task issue:ingest -- --all [--label <L>] [--status <S>]` — ingests every open issue matching the filters, skipping duplicates by `references.uri` match.
- **Preview**: add `--dry-run` to either form to preview without writing files.

The task emits vBRIEFs conforming to the canonical v0.6 schema (`vbrief/schemas/vbrief-core.schema.json`) with origin references in the form documented in [`../../conventions/references.md`](../../conventions/references.md):

```json
"references": [
  {
    "uri": "https://github.com/{owner}/{repo}/issues/{N}",
    "type": "x-vbrief/github-issue",
    "title": "Issue #{N}: {issue title}"
  }
]
```

- ! New scope vBRIEFs MUST target `"vBRIEFInfo": { "version": "0.6" }` (the task handles this automatically)
- ! `plan.status` starts at `"proposed"`; the task sets this
- ! Conform to `vbrief/schemas/vbrief-core.schema.json` (v0.6) -- the task validates before writing
- ~ After ingest, review the generated vBRIEFs with the user before promoting any of them to `pending/`

⊗ Hand-author scope vBRIEFs inside the skill when the ingest task exists — duplicating the narrative logic is how #534 (non-conformant references) and #537 (drift between skill and task) arise
⊗ Write references with `url`/`id`/bare `github-issue` types — use the schema-conformant `{uri, type, title}` shape above
⊗ Ingest an item that already has a matching vBRIEF reference -- `task issue:ingest` handles deduplication; skills MUST NOT duplicate that logic inline

## Phase 2 -- Evaluate

! List proposed items for interactive user review.

### Step 1: List Proposed Items

1. ! Read all vBRIEFs in `vbrief/proposed/`
2. ! Present each item with:
   - Title and filename
   - Origin link(s) from `references`
   - Summary from `narratives` (if populated)
   - Labels/category (if available from origin)
3. ! Sort by creation date (oldest first) or as user prefers

### Step 2: Interactive Review

! For each proposed item (or batch, as user directs):

- ! Present the item and wait for user decision
- ~ The user may: accept (promote to pending), reject (cancel), defer (keep in proposed), or request more detail
- ! Do not proceed to the next item until the user responds
- ? The user may batch-accept or batch-reject multiple items at once

⊗ Auto-accept or auto-reject proposed items without user review

## Phase 3 -- Reconcile (RFC D12)

! Check if linked origins have changed since the vBRIEF was last touched. Delegate the scan to `task reconcile:issues` and walk the user through flagged items for approval (see #537 for why the skill is a thin wrapper over the task).

### Step 1: Run the Reconciler

```
task reconcile:issues
```

The task scans every vBRIEF with a GitHub-backed reference (whether the reference uses the legacy `github-issue` bare type or the canonical `x-vbrief/github-issue` shape), fetches each linked issue, compares timestamps and state, and reports items in four buckets:

- **Linked & current** — origin has not changed since the vBRIEF was last updated (no action)
- **Stale** — origin `updatedAt` is newer than the vBRIEF (propose an update)
- **Externally closed** — origin issue is `CLOSED` (propose cancellation or reconcile if intentional divergence)
- **Unlinked** — vBRIEF has no GitHub reference (flag for review)

### Step 2: Walk Flagged Items with the User

1. ! For each **stale** item the task surfaces, show the user the diff between the current vBRIEF and the refreshed origin. Propose edits; ! wait for explicit user approval before writing anything.
2. ! For each **externally closed** item, ask the user whether to `task scope:cancel <file>` it or preserve intentional divergence.
3. ! For each **unlinked** item, ask whether to attach an origin reference or leave the vBRIEF as-is.

### Step 3: Apply User-Approved Updates

- ! Agent proposes edits; ! user approves each change
- ! Never auto-update vBRIEFs — intentional divergence (vBRIEF refined beyond original issue scope) must be preserved
- ! For approved updates, update the vBRIEF content and `vBRIEFInfo.updated` timestamp; prefer the task commands (`task scope:cancel`, `task scope:block`, etc.) over hand-editing where they apply

⊗ Replace the task invocation with a hand-written `gh issue view` loop — the task is the canonical implementation; skills MUST NOT duplicate it (#537)
⊗ Auto-update vBRIEFs based on origin changes without user approval
⊗ Overwrite intentional divergence -- if a vBRIEF has been refined beyond the original issue, preserve the refinement

## Phase 4 -- Promote/Demote

! Move vBRIEFs between lifecycle folders using deterministic task commands. The status values below align with the canonical v0.6 Status enum (`draft | proposed | approved | pending | running | completed | blocked | failed | cancelled`) — note that `failed` is also a valid terminal transition for active work that could not complete.

### Available Commands

- `task scope:promote <file>` -- proposed/ -> pending/ (status: pending)
- `task scope:activate <file>` -- pending/ -> active/ (status: running)
- `task scope:complete <file>` -- active/ -> completed/ (status: completed)
- `task scope:cancel <file>` -- any -> cancelled/ (status: cancelled)
- `task scope:restore <file>` -- cancelled/ -> proposed/ (status: proposed)
- `task scope:block <file>` -- stays in active/ (status: blocked)
- `task scope:unblock <file>` -- stays in active/ (status: running)
- `task scope:fail <file>` (v0.6+) -- active/ -> completed/ (status: failed) — record a failure terminal state when a scope cannot complete but should not be cancelled

### Workflow

1. ! Execute transitions using the task commands above -- they handle `plan.status` updates, `plan.updated` timestamps, and file moves atomically
2. ! Derived-artifact renders (`task roadmap:render`, `task project:render`) happen after a **batch** of promotions/demotions, not after each individual item. During high-volume triage (e.g. dozens of accept/reject decisions in one session), defer both renders until the end of the batch -- the source of truth is the lifecycle folder contents under `vbrief/`, so ROADMAP.md and PROJECT-DEFINITION.vbrief.json can be refreshed once per batch without losing correctness.
3. ! `task roadmap:render` regenerates ROADMAP.md from the updated lifecycle folder contents. Call it once per batch (typically at the end of Phase 4, before handing back to the user or transitioning to Phase 5), not after every single promote/demote.
4. ! `task project:render` refreshes the PROJECT-DEFINITION items registry. Call it **once per refinement pass** -- usually at the end of the session alongside the final roadmap render -- unless the user explicitly needs an intermediate registry refresh. It is not a per-edit tax.
5. ! Before the user is shown the final backlog state (end of Phase 4, end of Phase 5, or session exit), both `task roadmap:render` AND `task project:render` MUST have been run at least once so ROADMAP.md and PROJECT-DEFINITION.vbrief.json reflect the current lifecycle folder truth. This preserves correctness while allowing N promotions/demotions to share one render checkpoint.
6. ! Mark rejected items as `cancelled` via `task scope:cancel` (never delete vBRIEFs)

~ Operationally: a large refinement session can ingest/evaluate/promote multiple issues and close out with **one** final render checkpoint, rather than N repetitive renders after every individual item.

⊗ Rerender derived artifacts (`task roadmap:render`, `task project:render`) after every single accept/reject/promote/demote during high-volume triage -- batch the lifecycle edits and render once at the end of the batch
⊗ Move vBRIEFs between folders manually (cp/mv) -- always use `task scope:*` commands
⊗ Delete vBRIEFs -- use `task scope:cancel` to preserve history

## Phase 5 -- Prioritize

! Reorder and organize the pending backlog.

1. ! List all vBRIEFs in `vbrief/pending/` with titles, origins, and any phase/dependency metadata
2. ~ Help the user set phases and dependencies:
   - Group related items into phases (via vBRIEF `items` hierarchy or `tags`)
   - Identify dependencies between items (via `edges` in vBRIEF schema)
3. ! `task roadmap:render` is the **checkpoint** before showing the reordered backlog to the user -- not a per-edit tax. Run it ONCE at the end of the reorder pass to regenerate ROADMAP.md from the updated pending/ contents. Do not invoke it after each individual reorder action.
4. ~ Present the regenerated roadmap summary to the user for confirmation

## Phase 6 -- Completion Lifecycle

! On scope completion, update origins to close the loop.

### When a Scope Completes

1. ! Read the completed vBRIEF's `references` array
2. ! For each GitHub-issue reference (either the legacy bare `github-issue` type or the canonical `x-vbrief/github-issue` shape):
   - Close the issue with a comment linking to the implementing PR:
     ```
     gh issue close {N} --comment "Completed via PR #{PR} -- scope vBRIEF: {filename}"
     ```
   - The issue number is extracted from the reference `uri` (e.g. `https://github.com/o/r/issues/{N}`)
3. ? For other reference types (`x-vbrief/jira-ticket`, `x-vbrief/user-request`, `x-vbrief/github-pr`, etc.), follow the appropriate update mechanism
4. ! Update PROJECT-DEFINITION via `task project:render`

⊗ Complete a scope without updating its origins
~ Completion lifecycle can be triggered during refinement or as a standalone action after a PR merge

## CHANGELOG Convention

- ! Write ONE batch `CHANGELOG.md` entry at the END of the full refinement session -- not one entry per vBRIEF created or promoted. The batch entry summarizes all changes made during the session.
- ⊗ Add a CHANGELOG entry after each individual action during refinement -- wait until the full session is complete and write a single summary entry.

## PR & Review Cycle

After all refinement work is complete:

1. ! Ask the user: "Ready to commit and create a PR?"
2. ! Wait for explicit user confirmation before proceeding.

### Pre-Flight (before pushing)

! Run all pre-flight checks BEFORE committing and pushing:

1. ! Verify `CHANGELOG.md` has an `[Unreleased]` entry covering the refinement changes
2. ! Run `task check` -- all checks must pass
3. ! Verify `.github/PULL_REQUEST_TEMPLATE.md` checklist is satisfiable for this PR. If the file is **missing**, do NOT block — copy the canonical template from `templates/PULL_REQUEST_TEMPLATE.md` (ship-with-deft) to `.github/PULL_REQUEST_TEMPLATE.md` in the consumer project, then proceed with pre-flight (#531). If the file exists but contains unsatisfiable checklist items for this PR, call them out to the user before pushing.
4. ! **Mandatory file review**: Re-read ALL modified files before committing. Explicitly check for:
   - Encoding errors (em-dashes corrupted to replacement characters, BOM artifacts)
   - Unintended duplication (accidental double vBRIEFs or duplicate entries)
   - Structural issues (malformed vBRIEF JSON, broken references)
   - Semantic accuracy (verify that counts and claims in CHANGELOG entries match the actual data)

### Commit, Push, and Create PR

1. ! Commit with a descriptive message: `docs(vbrief): refinement session -- {summary}`
2. ! Push the branch to origin
3. ! Create a PR targeting the appropriate base branch

### Review Cycle Handoff

! After the PR is created, automatically sequence into `skills/deft-directive-review-cycle/SKILL.md`.

- ! Inform the user: "PR #{N} created -- starting review cycle."
- ! Follow the full review cycle skill from Phase 1 (Deft Process Audit) onward.

### EXIT

! When the review cycle completes (exit condition met) or the PR is ready for human review:

1. ! Explicitly confirm skill exit: "deft-directive-refinement complete -- exiting skill."
2. ! Provide chaining instructions to the user/agent:
   - If review cycle is complete and PR is approved: "PR #{N} is ready for human merge review."
   - If review cycle is still in progress: "Review cycle handed off to deft-review-cycle. Monitor PR #{N} for Greptile findings."
   - If returning to a monitor agent: "Returning control to monitor agent -- refinement PR #{N} created and review cycle initiated."
3. ! Do NOT continue into adjacent work after this point -- the skill boundary is an exit condition.

## Anti-Patterns

- ⊗ Bypass Phase 0 by triaging directly off `gh issue list` -- the `.deft-cache/issues/` mirror is the source of truth (#845)
- ⊗ Write accepted Phase 0 items to `vbrief/proposed/` without first appending the corresponding `accept` record to `vbrief/.eval/candidates.jsonl` (#845)
- ⊗ Skip Phase 1 silently after Phase 0 -- always render the chaining decision so the user knows the entry point shifted (#845)
- ⊗ Auto-accept or auto-reject proposed items without user review
- ⊗ Create vBRIEFs without origin provenance (`references` linking to the source)
- ⊗ Ingest items without deduplicating against existing vBRIEF references first
- ⊗ Auto-update vBRIEFs based on origin changes -- user approves all updates
- ⊗ Overwrite intentional divergence when reconciling stale origins
- ⊗ Move vBRIEFs between folders manually -- always use `task scope:*` commands
- ⊗ Delete vBRIEFs -- use `task scope:cancel` to preserve history
- ⊗ Complete a scope without updating its origins (closing issues, posting comments)
- ⊗ Skip deduplication during ingest -- always diff against existing references
- ⊗ Add a CHANGELOG entry per individual action during refinement -- write one batch entry at the end of the full session
- ⊗ Proceed to the next proposed item without waiting for user decision during evaluate
- ⊗ Auto-push without explicit user instruction
- ⊗ Rerender ROADMAP.md or PROJECT-DEFINITION.vbrief.json after every single accept/reject/promote/demote during high-volume triage -- `task roadmap:render` and `task project:render` are batch checkpoints, not per-edit taxes, and calling them N times for N lifecycle edits turns O(1) render work into O(N) without changing correctness (see #638)
- ⊗ Return a final backlog view to the user without having run `task roadmap:render` and `task project:render` at least once since the last lifecycle edit -- batch the renders, but do not skip them
