# Swarm core — Phase 5 Review & Phase 6 Close (host-neutral)

## Phase 5 — Review & Complete

### Next-phase tool dispatch after cohort complete (#2934)

! When the parent marks a swarm **coding cohort** complete (last expected child completion for that phase, or the cohort phase boundary before review / CI-fix / merge cascade):

1. ! **MUST** either:
   - dispatch the next phase with a **real tool call in the same turn** (`sessions_spawn`, `task swarm:launch`, review-cycle / poller start, merge-cascade start, or the host adapter's equivalent), **or**
   - write an **explicit terminal status** (`blocked`, `awaiting-human`, or `done`) with a machine-checkable reason (blocker id, missing approval, clean close).
2. ! **MUST NOT** end the turn with only narrative that claims the next phase will start (“Spawning review subagents next”, “I will open the merge cascade”) and **zero** dispatch tools.
3. ~ Prefer a small phase-state note agents can follow: `cohort_id → phase → next_action|terminal` (session note, scratch JSON, or monitor checklist). Optional engine check is bonus; skill contract is mandatory.

⊗ Prose-only handoff at a cohort phase boundary (#2934). Soft skill hope is not a gate — same-turn tools or terminal status only.


### Verify Review Cycle Completion

For each agent's PR:

1. ! Check that Greptile has reviewed the latest commit (compare "Last reviewed commit" SHA to branch HEAD)
2. ! Verify Greptile confidence score > 3
3. ! Verify no P0 or P1 issues remain (P2 are non-blocking style suggestions)
4. ! **Blocked-leaf continuation (#1880 / #2843):** Prefer workers scoped `drive-to: merge-ready` so this step is rare. When a leaf exits `BLOCKED` (or a false-terminal DONE-with-blockers — see `templates/agent-prompt-preamble.md` §11) before merge-ready:
   - **Tier 1 available** (`start_agent`, `spawn_subagent`, Cursor `Task`, OpenClaw `sessions_spawn`): the monitor MUST background-dispatch ONE continuation leaf (`drive-to: merge-ready`, same worktree) owning fix batches + blocking `task pr:watch` + merge readiness. The monitor MUST NOT run inline code edits or review-cycle fix batches in its own turn (#2843 monitor-as-implementer recurrence).
   - **Tier 3 only** (no sub-agent primitive): the monitor MAY run `skills/deft-directive-review-cycle/SKILL.md` itself after explicit operator consent — or offer serial self-execution downgrade from Phase 3.
   - ⊗ Split review polling and fix batches across separate leaf agents for the same PR (#727 + #1880 Gap C).

! **Completion-notification decision tree (#2843 / #2943):** When a background leaf completion notification arrives, parse the terminal message per preamble §11:
   - `DONE` + merge-ready verified (`task pr:merge-ready -- <N>` exit 0): may proceed to merge / `task scope:complete` per Phase 5→6 / Phase 6.
   - `BLOCKED` (+ optional `REDISPATCH_OK`): resume the same leaf if the host supports it, OR background-dispatch ONE continuation leaf with the cited PR/SHA/worktree — no monitor-inline fixes on Tier 1.
   - `FAILED` / silent (no terminal message): run `task verify:subagent-alive`; on exit 1 print `REDISPATCH_OK` and background-dispatch ONE continuation leaf.
   - **Thin DONE (#2943):** completion without PR URL / merge evidence (mid-edit text, empty status, no `PR #N` / URL) is a **failed leaf** — re-dispatch or take over after a tool-first ground-truth batch. It is **not** success.
   - ⊗ Treat `DONE` without merge-ready verification as success — that is the false-terminal pattern §11 closes.
   - ⊗ Treat thin DONE (no PR URL / merge evidence) as success (#2943).

! **Parent tool-first after leaf announce (#2943 / hard-stop #3131):** On the first parent turn after a leaf completion event (`subagent_announce` / parent-push / host completion notify), the parent MUST do exactly one of: (a) emit a **tool-first** ground-truth batch (`gh` / `git` / worktree or file status) then one consolidate, (b) **yield** (`sessions_yield` on OpenClaw, or host equivalent), or (c) one short non-repeated user answer. ⊗ Multi-sentence progress-only first response with zero tools / yield — the text-repetition hang class. ⊗ **N>2** near-identical assistant sentences with no `tool_use` / yield (**FC14**). Machine check: `evaluateParentTurnShape` in `packages/core/src/parent-turn-shape/` — soft prose is not sole mitigation (#3131).

! **Completion latch after first consolidate (#3092):** After the parent has emitted **one** user/caller-visible consolidate for a child `runId` / settle batch (accept or reject), **identical or equivalent completion replay** for the same key MUST be **silent** (no tools, no re-QC, no second final; host silent token when defined, e.g. OpenClaw `NO_REPLY`). Re-open only on new `runId`/batch, principal explicit reopen, or **materially new** evidence (new HEAD, new blocker class) — not fat re-embeds of the same rollup. Replay storms: at most one fail-loud note, then silent. Full MUST + anti-patterns: `templates/agent-prompt-preamble.md` §11.5. Orthogonal to empty settle ≠ done (#3044).

### Human-merge observe path for `stop-at: pr-open` (#3153)

! When any cohort story was dispatched **`stop-at: pr-open`** (or thin-DONE recovery handed merge path to babysit) **and** merge authority is human-only (`requireHumanMerge` / no bot merge), the monitor is the **default durable owner** of post-merge `scope:complete` (review-cycle partner merge-path). Greptile CLEAN alone is **not** lifecycle complete.

! **Required observe path before declaring the cohort closed:**

1. ! Keep a machine-checkable list of open cohort PRs marked `awaiting-human-merge` (PR number, HEAD, story xBRIEF path) in the monitor checkpoint.
2. ! Until each listed PR is `MERGED` (or closed without merge → cancel path), the monitor MUST use one of:
   - **Background merge observer** (preferred on Tier 1): Approach 1 poller or short sub-agent that probes `gh api repos/<owner>/<repo>/pulls/<N>` for `merged == true` / `state`, then signals the parent; parent runs Step 1.5 sweep for that story.
   - **Parent-retained re-entry:** parent keeps `review_cycle: in_progress:<pr>#parent-retained` and **MUST** re-check merge state on every re-invocation / next tool turn until merged — first tool action on re-entry is the merge-state probe.
   - **Phase 6 Step 1 pre-sweep re-poll (always):** Immediately before Step 1.5 `task swarm:complete-cohort` / `task swarm:finalize-cohort`, re-poll **every** cohort PR via REST `pulls/<N>` and refuse the sweep while any `awaiting-human-merge` PR is still open. ⊗ Run the completion sweep solely because Greptile was CLEAN earlier.
3. ! After merge is observed: run post-merge verification (closing keywords) then Step 1.5 sweep / `task scope:complete` for the story.

Cross-link: `skills/deft-directive-review-cycle/SKILL.md` § Partner merge-path / Post-CLEAN wake path. ⊗ Ownership-in-name-only (sticky lease with no observer).

### Complete xBRIEFs

! The cohort's story xBRIEFs are completed by the deterministic **cohort completion sweep** in Phase 6 (`task swarm:complete-cohort`, Phase 6 Step 1.5 below), which runs AFTER the merge cascade. Do NOT move story xBRIEFs out of `xbrief/active/` before their PRs merge — a pre-merge move creates premature state if the merge cascade fails. This section is where the monitor records, per story, what the post-merge sweep will finalize:

1. ! For each story xBRIEF an agent's PR fully resolves, note that it is ready to complete (`xbrief/active/` -> `xbrief/completed/`, status `completed`). The underlying primitive is `task scope:complete <file>`; the Phase 6 sweep wraps it across the whole cohort so nothing is missed on the headless / multi-worker path.
2. ! If a story carries a `planRef` to a parent epic, the sweep also completes that epic once ALL its children are settled — you do NOT reconcile epic parents by hand, and you do NOT manually repair parent/child references (the lifecycle helper keeps `task xbrief:validate` green via the #1485 / #1487 reference maintenance).

⚠️ Both the xBRIEF lifecycle moves AND origin/issue closure happen in Phase 6 (after merge), not here — completing xBRIEFs or closing issues before merge creates premature state if the merge cascade fails.

### Exit Condition

All PRs meet ALL of:
- Greptile confidence > 3
- No P0 or P1 issues remain (P2 issues are non-blocking style suggestions)
- `task check` passed at merge chokepoint before push (or equivalent full-gate validation — #1704)
- CHANGELOG entries present under `[Unreleased]`

! **Mandatory cohort verifier (#1364):** After every poller (Phase 6 review-cycle sub-agent) reports back, the monitor MUST run `task swarm:verify-review-clean -- <pr-numbers...>` and confirm exit 0 BEFORE evaluating the rest of the Exit Condition or surfacing the Phase 5 -> 6 gate. The verifier re-uses the Greptile rolling-summary parser from `task pr:merge-ready` so the per-PR merge gate and the cohort gate stay in lockstep (a parser fix lands in both surfaces at once). Exit codes: 0 (cohort CLEAN -- all PRs simultaneously have SHA match + confidence > 3 + zero P0/P1 + not errored on current HEAD); 1 (one or more PRs unclean with per-PR diagnostics -- re-dispatch the poller for the unclean PR or address findings, then re-run the verifier); 2 (config error -- empty cohort, malformed xBRIEF glob, gh missing). The verifier is the structural answer to the #1166 swarm execution recurrence where multiple pollers exited with `clean_gate_holdout=confidence` (confidence == 3) and the monitor still raised the Phase 5 -> 6 gate because the trigger keyed on "all pollers have reported back" rather than "every PR in the cohort is objectively CLEAN".

! **Gates-surface dual invoke (#2893):** Deep-think gate verbs follow review-cycle probe order — `deft <verb>` / `directive <verb>` first, then `task deft:<verb>` when the root Taskfile includes `.deft/core/Taskfile.yml`, then #2878 gh-only fallback. Bare `task pr:watch` is not the sole consumer form (include key `deft:` → namespaced tasks only).

! **Deterministic PR-verdict wait (#1056 / #2893):** When a Phase 5 monitor needs to wait on Greptile/SLizard for an in-flight PR (cascade rebase + re-review, late Greptile pass), use dual-invoke `pr:watch` — `deft pr:watch <N> [--repo <owner>/<repo>]` first (no go-task bare `--`), else `task deft:pr:watch -- <N> [...]` — as the canonical wait-until-verdict helper. Blocking-by-default poll to a terminal three-state verdict — exit `0` CLEAN, `1` NEW_P0_P1, `2` ERRORED|STALL|TIMEOUT|config — with `--one-shot` for a single probe, `--json` for the structured shape, and `--max-wait-minutes` / `--poll-seconds` for the budget (defaults 30m / 90s). SHA-match gates the verdict to the current HEAD. For mergeable+merge cascade automation (not Greptile verdict alone), use dual-invoke `pr:wait-mergeable-and-merge` (#1369); for adaptive merge-ready polling with layered `via` fallbacks, use dual-invoke `pr:merge-ready` / `pr:monitor` (#1368).

! **Fallback-chain discriminator semantics (#1368):** dual-invoke `pr:merge-ready -- <N> --json` ALWAYS emits a `via` discriminator on every response. `via="primary"` and `via="fallback1"` are authoritative -- a `merge_ready: true` verdict on either is CLEAN. `via="fallback2"` is the coarse PR-view + check-run last-resort signal: it surfaces the PR's `state` / `merged` / `mergeable` / flattened check-run summary so a monitor can keep stepping forward through transient gh failures, but it is NEVER CLEAN -- the failure list carries the sentinel `"fallback2 is a coarse signal, not a CLEAN verdict ..."` and the merge cascade MUST keep waiting for a primary/fallback1 CLEAN. `via="error"` (every layer failed) is also non-CLEAN; the response carries `error` (one-line summary) + `partial_data` (per-layer diagnostics) so the monitor can step forward without blinding. Both `swarm:verify-review-clean` and `pr:merge-ready` treat fallback2 and error as merge-blocked.

⊗ Surface or discuss the Phase 5 -> 6 merge cascade gate while `swarm:verify-review-clean` has not yet exited 0 on the current cohort (#1364). Keying the transition on poller lifecycle completion alone -- i.e. treating "every poller sub-agent returned a terminal message" as sufficient -- is the exact recurrence pattern this rule closes. The verifier is the only authoritative cohort-level CLEAN signal; a poller's `clean_gate_holdout=confidence` / `clean_gate_holdout=has_blocking` / `clean_gate_holdout=sha_match` / `clean_gate_holdout=errored` exit IS a non-CLEAN report and MUST hold the gate even if every sub-agent has technically returned.

! **Review-monitor gate (#2655 / #1386 / #2893):** Before surfacing the Phase 5→6 merge gate (or yielding while implementers' PRs await Greptile), run dual-invoke `verify:review-monitor` for each in-flight PR when Tier 1 is available — CLI: `deft verify:review-monitor --pr <N> [--call-site swarm-phase5-6]`; task: `task deft:verify:review-monitor -- --pr <N> [--call-site swarm-phase5-6]`. Register monitors after spawning Approach 1 pollers via dual-invoke `review-monitor:register` (same CLI-without-`--` vs task-with-`--` rule). Do not duplicate the monitoring matrix here — see `skills/deft-directive-review-cycle/SKILL.md` Review Monitoring + gates-surface dual invoke.

⊗ Treat a `via="fallback2"` or `via="error"` response from `task pr:merge-ready` as CLEAN, regardless of the surrounding `merge_ready` field (#1368). Fallback2 is structurally never CLEAN -- the Greptile rolling-summary comment was unreachable on both the primary and fallback1 paths, so any merge taken on the basis of the coarse signal alone bypasses the SUCCESS-with-findings blind spot the per-PR gate was designed to close (#796 / #652). The merge cascade MUST keep waiting for a primary/fallback1 CLEAN.

### Phase 5→6 Gate: Release Decision Checkpoint

! Before proceeding to Phase 6 (Close), the monitor MUST present the proposed release scope and version bump to the user for confirmation.

⊗ **Context-pressure bypass prohibition:** Even under long-context or time pressure (large conversation history, many tool calls, approaching context limits), this gate MUST NOT be bypassed. The Phase 5→6 gate is mandatory regardless of conversation length, elapsed time, or perceived urgency. If the monitor's context is degraded, hand off to a fresh session rather than skipping the gate.

1. ! Present a summary containing:
   - **PRs ready to merge**: list of PRs with titles, issue numbers, and current review status
   - **Proposed version bump**: the tentative version from Phase 0 (patch/minor/major) with rationale — updated if scope changed during implementation
   - **Release scope**: brief description of what this batch of changes represents
2. ! **Merge-readiness checklist:** Before any `gh pr merge` call, the monitor MUST emit a structured checklist confirming each PR is merge-ready. For each PR, verify and explicitly confirm:
   - Greptile confidence score > 3
   - No P0 or P1 issues remaining
   - full `task check` passed on the branch before push (#1704 merge chokepoint)
   - CHANGELOG.md entry present under `[Unreleased]`
   - Explicit user approval received for this merge cascade

   ! **Cohort gate (#1364):** Before the merge-readiness checklist is even emitted, the monitor MUST have already passed `task swarm:verify-review-clean -- <pr-numbers...>` per the Phase 5 Exit Condition above. The cohort gate is the structural pre-condition for this entire Phase 5 -> 6 sequence -- without exit 0 on the verifier, the checklist below MUST NOT be presented to the user. The per-merge `task pr:merge-ready` gate below remains the merge-time freshness-window-atomic check; the cohort verifier is the once-after-pollers gate that gates the discussion at all.

   ! **Programmatic gate:** Before each `gh pr merge` call, the monitor MUST run `task pr:merge-ready -- <N>` and abort the cascade on non-zero exit. The task parses the Greptile rolling-summary comment **body** (confidence, P0 / P1 badge counts, **advisory should-not-merge prose (#3225)**, errored sentinel, HEAD-SHA freshness) -- not the GitHub CheckRun status. The CheckRun goes green when Greptile finishes its review pass, irrespective of findings; relying on it alone is the SUCCESS-with-findings blind spot that started the PR #652 incident merge cascade against `Confidence: 3/5 + 1×P1 + 2×P2`.

   ! **Mechanical mergeability is necessary, never sufficient (#3225):** GitHub Ready-to-merge / green checks / formal review without Changes-Requested are **not** a CLEAN signal by themselves. Reviewer bots may record should-not-merge + sub-threshold confidence only in comment prose. `pr:merge-ready` / `pr:watch` MUST refuse when advisory prose or `minGreptileConfidence` (#3095) blocks, regardless of the mechanical merge box. Cross-link: `skills/deft-directive-review-cycle/SKILL.md` § Mechanical mergeability.

   ! **Atomic gate (freshness window):** The monitor MUST invoke `task pr:merge-ready -- <N>` and `gh pr merge <N>` in the same shell call (e.g. `task pr:merge-ready -- <N> && gh pr merge <N> --squash --delete-branch --admin`) so no time elapses between verdict and merge. A readiness check more than ~60 seconds stale is a Mode-1 false-positive risk: in the elapsed window an unrelated commit may land on master, auto-rebase trigger a fresh Greptile pass, and the new pass surface a P1 the cached verdict did not see. Re-invoking the gate is cheap (single `gh api` call); the shell-`&&` chain makes the freshness window structurally enforceable rather than prose-trust.

   ⊗ Merge on the basis of a SUCCESS Greptile CheckRun alone. The CheckRun signals review **completion**, not review **approval**. Parse the comment body (confidence + P0/P1 count + advisory should-not-merge prose) via `task pr:merge-ready -- <N>` before merging.

   ⊗ Merge because the merge box is Ready-to-merge while bot prose still says should-not-merge or confidence is below the resolved floor (#3225 / #3095).

   ⊗ Run `task pr:merge-ready -- <N>` upstream of `gh pr merge <N>` (e.g. as a separate batched check during cascade prep, then later run `gh pr merge` after intervening rebase / sub-agent dispatch / user discussion). Stale verdicts risk Mode-1 false positives -- always chain readiness and merge in the same shell call.
3. ! Wait for explicit user approval (`yes`, `confirmed`, `approve`) before proceeding to Phase 6 merge cascade
4. ! If the user requests changes (e.g. different version bump, defer a PR), adjust and re-present

⊗ Begin merge cascade without presenting the version bump proposal and receiving explicit user approval.

## Phase 6 — Close

### Sub-Agent Role Separation (#727)

! **Post-PR sub-agents are review-cycle agents (#727):** Sub-agents addressing review findings, waiting for re-review, and iterating to clean MUST embody `skills/deft-directive-review-cycle/SKILL.md` end-to-end as a single coherent role. Do NOT split the review-cycle into separate "poll" and "fix" agents -- pollers that spawn separate fix agents create cross-agent state-handoff hazards and double the chance of an agent exiting at the wrong lifecycle boundary.

! **Sub-agents MUST emit a heartbeat (#1365):** every long-running review-cycle / poller sub-agent dispatched under Phase 6 MUST write a heartbeat record to `.deft-scratch/subagent-status/<agent-id>.json` per the contract in `docs/subagent-heartbeat.md`. The canonical poller template (`templates/swarm-greptile-poller-prompt.md` bounded poll loop) already encodes the per-iteration heartbeat write and the final terminal heartbeat, and the canonical orchestrator preamble (`templates/agent-prompt-preamble.md` § 10.5) restates the contract for any non-poller long-running sub-agent. The monitor watches via `task agent:monitor` -- see Phase 4 Heartbeat liveness check. Without the heartbeat, a `spawn_subagent`-dispatched poller that stalls is indistinguishable from a healthy mid-poll one (the #1166 recurrence).

! **Post-PR monitoring runs in a fresh sub-agent (#727):** Post-PR monitoring (Greptile, CI checks, downloadCount drift, lifecycle events, etc.) MUST be done by spawning a fresh short-lived sub-agent via the platform adapter's dispatch primitive for the detected runtime (e.g. `spawn_subagent` when the Grok Build / non-Warp platform is active, `start_agent` for Warp-orchestrated environments, Cursor `Task` for Cursor, OpenClaw `sessions_spawn` when the platform descriptor is `openclaw` — #2875). The parent yields with no tool calls and waits for the sub-agent's messages / parent-announce completion -- this preserves conversation steerability so the user can interrupt or redirect while the watch is pending. The platform adapter (introduced in slices 1-3 of #1342; OpenClaw Tier-1 in #2875) supplies the appropriate async callback channel and spawn surface per the runtime capability detection matrix; every Taskfile / shell-sleep / `time.sleep` / synchronous tool-call alternative blocks the parent's turn for the duration of the watch.

! **Canonical poller template (#727):** When delegating to a poller / review-cycle sub-agent, MUST use the canonical poller-prompt template at `templates/swarm-greptile-poller-prompt.md` with placeholders (`{pr_number}`, `{repo}`, `{poll_interval_seconds}`, `{poll_cap_minutes}`, `{parent_agent_id}`) filled in. Do NOT hand-author per-watch prompts -- the template encodes parsing fixes (markdown-link `Last reviewed commit:` regex, badge-based / negation-aware P0/P1 detection) that hand-authored variants have repeatedly missed (Agent D, post-#721 swarm; #727 comment 2).

! **Destructive commands run alone (#727):** Sub-agent prompts MUST instruct the agent to run destructive commands (`rm`, `Remove-Item`, `del`, `git clean`, etc.) in their OWN shell call, never chained with non-destructive commands. Chaining poisons Warp's `is_risky` classification on the entire pipeline and forces manual approval on every otherwise-safe operation -- a multi-commit branch hits the user N times per agent.

! **Commit-message temp file is leave-alone (#727):** When using the canonical PowerShell UTF-8-safe commit-message pattern (`create_file <tmp>` -> `git commit -F <tmp>`), MUST NOT clean up the temp file in the same shell call. Leave it orphaned -- worktree teardown or `git clean -fd` reclaims it. The two-step value (separate cleanup) is not worth the per-commit approval prompt the chained `rm` triggers.

⊗ Run a poll loop in the parent's own turn (via `task`, shell sleep, `time.sleep`, or any synchronous tool call). The conversation must remain user-steerable while watches are pending.

⊗ Bundle "watch for Greptile" / "monitor CI" instructions into an implementation agent's dispatch prompt (regardless of the platform adapter's spawn primitive) -- implementation agents exit at PR-open via the `succeeded` lifecycle, so any post-exit monitoring instruction is unreachable.

⊗ Spawn a "pure poller" sub-agent for a PR that has likely findings. Pure pollers are appropriate ONLY when no fixes are expected (CI watch on known-good HEAD, post-merge state checks, lifecycle observers). Default for post-PR work is review-cycle, NOT poller.

⊗ Chain `rm` (or any destructive command) with `git commit` / `git push` / any non-destructive command in a single shell pipeline.

### Step 1: Merge

! **Per-PR sub-agent identity gate:** Before acting on any PR (merge, force-push, status check), query the specific sub-agent responsible for that PR for live status. Do not infer a PR's status from a different agent's tab, from message timing, or from the absence of recent commits. If the responsible agent is unreachable, verify PR state directly via `gh pr view <number>` and `gh pr checks <number>` before proceeding.

! **Idempotent pre-check pattern:** Before each action in the merge cascade, verify the current PR/branch state to ensure the action is still needed and safe to execute. Check: is this PR already merged (`gh pr view <number> --json state --jq .state`)? Is this branch already rebased onto the latest master? Has this issue already been closed? This makes recovery re-runs safe — a crash mid-cascade can resume from any point without duplicate actions or errors.

! **Pre-merge protected-issue link inspection (Layer 3, #701):** Before any `gh pr merge` call where a referenced issue MUST remain OPEN (umbrella, anchor, follow-up tracker), inspect GitHub's persistent linked-issue list:

```bash
gh pr view <N> --repo <owner/repo> --json closingIssuesReferences --jq '.closingIssuesReferences[].number'
```

The optional `task pr:check-protected-issues -- <pr-number> --protected <N1,N2,...>` Taskfile target (`tasks/pr.yml`) wraps this inspection and exits non-zero if any protected issue is GitHub-side linked.

! **Layer 0 (prevention) cross-reference (#737):** before reaching this Layer 3 recovery surface, the operator should already have run `task pr:check-closing-keywords -- --pr <N>` per `skills/deft-directive-pre-pr/SKILL.md` Phase 4 (Diff). Layer 0 scans the PR body + every commit message for closing-keyword tokens in negation / quotation / example / code-block contexts and refuses to push when findings surface; Layer 3 (this rule) is the persistent-link recovery for cases where Layer 0 was bypassed OR the link was attached via the Development sidebar. The two layers complement each other -- Layer 0 prevents the false-positive from being authored, Layer 3 catches the durable-link case Layer 0 cannot see.

If any protected (umbrella / staying-OPEN) issue number appears in the output, the link is persistent in GitHub's database from a prior PR body revision (or a manual sidebar attachment) and survives subsequent body edits; on squash merge, GitHub will close the issue regardless of the current PR body, commit messages, or explicit `--subject` / `--body-file` overrides. The merger MUST manually unlink via the PR's Development sidebar panel (web UI -> PR -> right-side Development section -> X next to the linked issue) before merging. The `gh` CLI does not expose a direct unlink mutation; the GraphQL surface (`disconnectPullRequestFromIssue` and friends) shifts over time -- the web UI is the reliable path. See `meta/lessons.md` `## GitHub Closing-Keyword False-Positive Layer 3` for the incident history (PR #700 closed #233; PR #401 closed #642).

! **Merge authority:** Monitor proposes merge order and executes merges; user approves before the first merge. Do not merge without explicit user approval.

! **Rebase cascade ownership:** Monitor owns rebase cascade sequencing. Swarm agents do not rebase -- by the time merges begin, swarm agents are idle or complete. The monitor fetches the updated configured base branch, rebases each remaining branch, resolves conflicts, and force-pushes.

! **Read-back verification after conflict resolution:** After resolving any rebase conflict and BEFORE running `git add`, re-read the resolved file and verify structural integrity:
- ! No conflict markers remain (`<<<<<<<`, `=======`, `>>>>>>>`)
- ! No collapsed or missing lines (compare line count to pre-rebase version if feasible)
- ! No encoding artifacts (BOM injection, mojibake, replacement characters)
- ! For `CHANGELOG.md` `[Unreleased]`-section conflicts: the canonical resolution path is `task changelog:resolve-unreleased` (#911) -- it union-merges HEAD entries with branch entries, deduplicates by `(#NNN)` issue-number heuristic, and atomically writes back. Three-state exit (0 resolved / 1 unresolvable / 2 config error). The 2026-05-04 v0.25.1 cascade (PRs #909 -> #907 -> #908 -> #906) honoured the `edit_files` rule below but used a HEAD-take-and-discard pattern that silently dropped each rebasing branch's CHANGELOG entry on every cascade rebase (PR #908 lost #900's entry; PR #906 lost #901's). The helper closes that recurrence by codifying the union-merge pattern. **Manual fallback** (when the helper exits 1 -- e.g. nested markers, conflicts inside a released `## [0.X.Y]` section, or non-trivial structural conflicts the helper cannot mechanize): use `edit_files` over shell regex (`sed`, `Select-String -replace`) for resolution -- edit_files preserves encoding and provides exact match verification, while regex substitutions risk silent line collapse or encoding corruption. The manual path MUST still apply the union-merge pattern (keep ALL HEAD entries; prepend each branch entry whose `(#NNN)` set does not overlap an existing HEAD entry under the same `### subsection`), NOT the legacy HEAD-take-and-discard.
- ⊗ Run `git add` on a conflict-resolved file without first re-reading it and verifying structural integrity
- ⊗ Resolve a `CHANGELOG.md` `[Unreleased]` conflict by HEAD-take-and-discard (taking only the HEAD side of each conflict block and discarding the branch side). The rebasing branch's new CHANGELOG entry MUST land in the resolved file -- run `task changelog:resolve-unreleased` for the canonical union-merge, or apply the union-merge pattern manually when the helper cannot mechanize the conflict (#911)

! **Non-interactive rebase:** Monitor MUST set `GIT_EDITOR=true` (Unix/WSL/Git Bash) or `$env:GIT_EDITOR="echo"` (Windows PowerShell) before running `git rebase --continue` during merge cascade to prevent the default editor from blocking the agent.

! **Merge cascade warning:** Shared append-only files (CHANGELOG.md) cause merge conflicts when PRs are merged sequentially — each merge changes the insertion point, conflicting remaining PRs. Each conflict requires rebase → push → wait for checks (~3 min) + ~2-5 min Greptile re-review per rebase. Plan for N-1 rebase cycles × ~3 min CI + ~2-5 min Greptile re-review per rebase when merging N PRs.

! **Greptile re-review on rebase force-push:** Force-pushing a rebased branch triggers a **full** Greptile re-review (not an incremental diff), even if the rebase introduced no logic changes. Expected latency is ~2-5 minutes per PR in the cascade. Factor this into merge sequencing.

! **Autonomous re-review monitoring after force-push:** After each `--force-with-lease` push of a rebased branch in the cascade, the monitor MUST autonomously wait for the Greptile re-review to complete before proceeding to the next merge. Use the tiered monitoring approach defined in `skills/deft-directive-review-cycle/SKILL.md` Step 4 Review Monitoring (Approach 1: spawn sub-agent via the platform adapter's dispatch primitive (e.g. `spawn_subagent`, `start_agent`, Cursor `Task`, or OpenClaw `sessions_spawn`) to poll and report back; Approach 2 fallback: discrete `run_shell_command` wait-mode calls with yield between polls, adaptive cadence -- see deft-directive-review-cycle SKILL.md). Do NOT duplicate the full monitoring logic here -- follow the canonical skill.

! **Review-monitor gate after force-push (#2655 / #380 / #2893):** After each cascade force-push, run dual-invoke `verify:review-monitor` (CLI: `deft verify:review-monitor --pr <N> --call-site swarm-phase6-cascade`; task: `task deft:verify:review-monitor -- --pr <N> --call-site swarm-phase6-cascade`) before yielding for re-review when Tier 1 is available. Spawn/register Approach 1 pollers per review-cycle skill; do not yield idle without an active monitor record.

~ **In-cascade Greptile wait (#1056 / #2893):** For the wait between a force-push and the next merge, poll the Greptile/SLizard verdict with dual-invoke `pr:watch` (`deft pr:watch <N> [...]` first, else `task deft:pr:watch -- <N> [--repo <owner>/<repo>] [--max-wait-minutes <M>]`) (exit `0` CLEAN / `1` NEW_P0_P1 / `2` ERRORED|STALL|TIMEOUT|config). Do not use `--cap-minutes` — that flag belongs to `pr:monitor`, not `pr:watch`. For the composed wait-until-mergeable-then-merge path, use dual-invoke `pr:wait-mergeable-and-merge` (#1369). Use these in place of hand-rolled polling loops in long-running cascade waits.

! **Cascade automation surface (#1369 / #2385):** The canonical one-verb compose-point for "wait until PR <N> is mergeable, then squash-merge with admin" is `task pr:wait-mergeable-and-merge -- <N> --repo <owner>/<repo>`. The helper runs the resilient wait loop (#1368) and the Layer-3 protected-issue link inspection (#701) AHEAD of any merge call, then invokes `gh pr merge <N> --squash --delete-branch --admin` only after the wait loop exits CLEAN on the current HEAD. Three-state exit (0 merged / 1 timeout-or-escalation / 2 config error) mirrors every other framework verb. Pass `--protected <issue-numbers>` for the Layer-3 chain when the PR is known to reference any umbrella / staying-OPEN issue -- the helper short-circuits with exit 1 BEFORE the merge call if a persistent `closingIssuesReferences` link is detected.  For multi-PR merge cascades (Phase 6), pass --cascade so the helper refuses merge-tree-clean PRs whose base SHA is behind the current target branch HEAD (semantically stale pre-spine CI, #2385); after the first merge in a cascade, also pass --require-master-ci-green so the next merge waits until target-branch CI is green at the new HEAD. Rebase/update-branch onto the post-spine target before re-invoking with --cascade. The Wave-3 surface is the automated cascade wrapper; the per-PR atomic gate (`task pr:merge-ready -- <N> && gh pr merge <N>`) documented above remains the manual freshness-window-atomic check the monitor MUST use when running merges by hand. The two co-exist -- the cascade surface is the automation, the per-PR atomic gate is the manual fall-through. See AGENTS.md `## Cascade automation surface (#1369)`.

⊗ Hand-roll a cascade `while ...; do task pr:merge-ready ...; done` shell loop (or equivalent ad-hoc Python monitor) when `task pr:wait-mergeable-and-merge` is available (#1369). The Wave-1+2 hardening (`_safe_subprocess.run_text` #1366, `pr_merge_readiness.py` layered fallbacks #1368, `monitor_pr.py` resilient wait loop #1368) is composed inside the helper; hand-rolled loops re-introduce the `head: None` / babysit-each-PR failure mode #1369 closes.

! **Gate:** Do NOT proceed to the next merge in the cascade until the Greptile review for the rebased branch is current (pushed SHA matches "Last reviewed commit" SHA) AND the exit condition is met (confidence > 3, no P0/P1 issues remaining). A stale or in-progress review is not sufficient; an errored review is also not sufficient; follow the escalation procedure below.

! **Greptile service errored state (#526):** If the Greptile comment on the current HEAD is the exact string "Greptile encountered an error while reviewing this PR", treat the review as errored (distinct from stale, in-progress, or ready). The GitHub CheckRun will read COMPLETED/NEUTRAL; do NOT interpret that as passing.

Retry ONCE via an `@greptileai review` comment with a 10-minute cap. If the retry also errors, escalate to the user with a three-way choice:

  (a) wait longer (another ~15-20 min in case the service recovers);
  (b) push an empty `chore: retrigger greptile` commit to force a fresh review pass;
  (c) merge with documented override, where the rationale MUST be recorded in the merge commit body (not just the PR body) citing prior Greptile success on a pre-rebase SHA, CI/Go + CI/Python success on the current SHA, and the rebase being a pure conflict-resolution merge with no new business logic.

⊗ Loop the monitor indefinitely on the errored state. The monitor MUST detect the "Greptile encountered an error" comment body and exit with an explicit `errored` report so the parent swarm monitor can route to the escalation procedure above.

⊗ Merge on the basis of the NEUTRAL CheckRun alone -- the service-side failure is indistinguishable from a clean pass at the CheckRun level.

! **Polling sub-agent contract for errored state (#526):** Short-lived polling sub-agents spawned under Phase 6 MUST detect the "Greptile encountered an error" comment body on the current HEAD and emit a distinct "PR #<N> Greptile errored" message back to the parent, rather than silently continuing to poll or timing out. Sub-agents MUST separately track "Greptile last-reviewed SHA" and "Greptile errored on current HEAD" so an errored state on the current HEAD is not masked by a successful review on a prior SHA.

? **Rebase-only annotation:** If the force-push contains no logic changes (pure rebase onto updated master), the monitor MAY post a brief PR comment noting "rebase-only, no logic changes" to give Greptile context and help reviewers triage the re-review.

~ To minimize cascades: rebase ALL remaining PRs onto latest master before starting any merges, then merge in rapid succession.

~ **Parallel rebase + review monitoring (platform dispatch available):** When the platform adapter reports a dispatch primitive is available during the merge cascade, the monitor MAY launch parallel sub-agents to overlap rebase and review monitoring work. For example: while Greptile re-reviews PR #A after a rebase push, spawn a sub-agent to begin rebasing PR #B onto the latest master. Each sub-agent reports back via `send_message_to_agent` when its task (rebase complete, review passed) is done. This reduces total cascade wall-clock time from serial (rebase + review per PR) to overlapped. The gate remains: do NOT merge PR #B until its own Greptile review passes the exit condition.

- ! Undraft PRs: `gh pr ready <number> --repo <owner/repo>`
- ! Squash merge: `gh pr merge <number> --squash --delete-branch --admin` (if branch protection requires)
- ! Use descriptive squash subject: `type(scope): description (#issues)`
- ! After each merge, rebase remaining PRs onto the updated configured base branch before merging the next

! **Post-merge protected-issue reopen sweep (Layer 3, #701):** After every squash-merge of a PR that referenced any umbrella / staying-OPEN issue (`Refs #N` with N a protected issue), verify each protected issue's post-merge state and reopen on regression:

```bash
for n in <protected-issue-numbers>; do
  state=$(gh issue view "$n" --json state --jq .state)
  if [ "$state" != "OPEN" ]; then
    gh issue reopen "$n" --comment "Reopened: closing-keyword Layer 3 false-positive on squash merge of PR #<N>; issue is umbrella for ongoing work. See #701."
  fi
done
```

This is defense in depth -- run it even when the pre-merge inspection above passed, because a sidebar-attached link not visible to a body scan, or a missed protected issue in the protected-issue list, can still slip through. The reopen comment MUST cite #701 and the PR that triggered the false-positive so future operators tracing the closed-then-reopened churn can find the root cause.

### Step 1.5: Cohort Completion Sweep (#1487)

! **REQUIRED.** Once the cohort's PRs are merged (Step 1 complete), the monitor MUST run the deterministic cohort completion sweep so the finished swarm leaves NO stranded xBRIEFs. `task swarm:complete-cohort` / `task swarm:finalize-cohort` release the swarm occupancy lease on a successful non-dry-run sweep (#3433). This step closes the gap where a completed cohort left its story xBRIEFs in `xbrief/active/` and their decompose-created epic parents in `xbrief/pending/` -- nothing in the swarm flow swept them to `completed/` (observed in the 2026-06-03 swarm: after the cohort's PRs merged, the child story xBRIEFs stayed in `active/` and their epic parents stayed in `pending/`).

! **Pre-sweep merge re-poll for human-merge / `stop-at: pr-open` (#3153):** Before invoking `task swarm:complete-cohort` or `task swarm:finalize-cohort`, re-read each cohort PR's merge state via REST. If any PR marked `awaiting-human-merge` is still open, **halt** the sweep, keep durable ownership, and continue the observe path (Phase 5 human-merge section) until merge or operator cancel. ⊗ Sweep on Greptile CLEAN alone while a human-merge PR is still open.

```pwsh path=null start=null
# Sweep the whole cohort by glob (typical close-out)...
task swarm:complete-cohort -- --cohort 'xbrief/active/*.xbrief.json'
# ...or name the cohort's story xBRIEFs explicitly:
task swarm:complete-cohort -- xbrief/active/<story-a>.xbrief.json xbrief/active/<story-b>.xbrief.json
```

What the sweep does (`task scope:complete` per story):

1. ! **Stage 1 -- stories:** every cohort story xBRIEF still in `xbrief/active/` is completed (`active/` -> `completed/`, status `completed`). A story already terminal (`completed/` / `cancelled/`) is an idempotent no-op, so the sweep is safe to re-run.
2. ! **Stage 2 -- epic parents:** each decompose-created epic parent is completed once ALL of its `x-xbrief/plan` children are settled (in `completed/` or `cancelled/`). A parent in `pending/` is bridged `activate` -> `complete`; a parent in `active/` is completed directly. The sweep iterates to a fixpoint, so nested decomposition (phase -> epic -> story) collapses bottom-up. A parent with even one still-active sibling outside the cohort is left untouched.
3. ! **D4 stays green automatically:** every move via `task scope:complete` keeps the decomposed parent<->child references in sync on BOTH directions -- child moves update the parent's forward `x-xbrief/plan` reference (#1485) and parent moves update each child's `planRef` back-pointer (#1487). Do NOT hand-edit references to "fix" linkage; the task already does it.
4. ! After the sweep, the monitor MUST run `task xbrief:validate` and confirm it exits 0 (no D4 regressions). Exit codes for the sweep itself: 0 (sweep clean), 1 (one or more transitions failed -- per-item diagnostics printed), 2 (config error -- empty cohort or missing `xbrief/`).

! **Interactive path:** the monitor runs `task swarm:complete-cohort` by hand (or `--dry-run` first to preview the planned transitions) once the merge cascade finishes, then runs `task xbrief:validate`.

! **Headless / multi-worker path (#2225):** after the merge cascade (`task pr:wait-mergeable-and-merge`, #1369) reports the cohort's PRs MERGED, the monitor SHOULD invoke the automated finalize surface instead of hand-authoring a separate lifecycle-sweep PR:

```pwsh path=null start=null
# Resolve merged stories from PR closing keywords and land the sweep PR:
task swarm:finalize-cohort -- --pr <N1>,<N2> --repo <owner/repo> [--label <cohort-label>]
# Preview only (no commit / no PR):
task swarm:finalize-cohort -- --pr <N1>,<N2> --repo <owner/repo> --dry-run
# Explicit story list when PR bodies omit Closes #N:
task swarm:finalize-cohort -- --stories <issue-or-path>... --repo <owner/repo>
```

The finalize surface runs the same `completeCohort(...)` engine as `task swarm:complete-cohort`, fast-forwards the local base branch, creates a `swarm/finalize/<label>` feature branch (branch policy #747 safe), commits the `xbrief/` lifecycle moves, and auto-opens the sweep PR. Pass `--no-commit` to sweep only (manual Step 2b), or `--no-open-pr` to commit locally without opening the PR. Gate on exit 0 plus green `task xbrief:validate` before declaring the swarm closed.

! **Manual fallback (#1487):** `task swarm:complete-cohort` remains the idempotent manual primitive when finalize automation is unavailable or you need a dry-run preview of transitions only. The headless path above replaces the historical requirement to hand-author a separate `chore(xbrief)` sweep PR every cycle.

⊗ Declare a swarm closed while any cohort story xBRIEF remains in `xbrief/active/` or any fully-childless decompose-created epic parent remains in `xbrief/pending/` -- run `task swarm:complete-cohort` and confirm `task xbrief:validate` is green first (#1487).

### Step 2: Close Issues and Update Origins

- ! Close resolved issues with a comment referencing the PR
- ~ Issues with "Closes #N" in PR body auto-close on squash merge
- ! After each squash merge, verify issues actually closed: `gh issue view <N> --json state --jq .state`. If not closed, close manually with a comment referencing the merged PR. Squash merge + closing keywords can silently fail to close issues (#167).
- ! For each completed xBRIEF: read its `references` array and update each origin:
  - For `github-issue` references: verify the issue is closed (auto-close from PR body or Phase 6 Step 2 above); if not, close with `gh issue close <N> --comment "Completed in #<PR>"`
  - For other reference types: document the completion as appropriate

### Step 2b: Commit and Push the Post-Merge Lifecycle Record (#1358)

! **REQUIRED.** After all cohort PRs have merged (Step 1) and the Cohort Completion Sweep (Step 1.5) has moved every finished story xBRIEF `xbrief/active/` -> `xbrief/completed/` (and bridged its epic parents), the monitor MUST commit and push those lifecycle moves so they become the **authoritative post-swarm lifecycle record** on the base branch. Without this step the moves sit uncommitted in the merger's worktree until an operator hand-runs `task scope:complete` and a `chore(xbrief)` commit by hand -- the exact manual closeout performed after the 2026-06-16 swarm (the #1358 recurrence this step closes).

The monitor MUST, from its OWN worktree and on the configured base branch:

0. ! **Fast-forward the local base branch FIRST:** `git fetch origin && git merge --ff-only origin/<configured-base-branch>` (equivalently `git pull --ff-only origin <configured-base-branch>`). The merge cascade (Step 1) advanced the REMOTE base branch by N squash-merge commits, but the local base branch in this worktree has not yet been pulled (Step 3's canonical pull runs AFTER this step). Without this fast-forward the commit below is built on a stale base and the push in step 4 is rejected as non-fast-forward, stranding the agent. Doing the `--ff-only` sync first makes the subsequent commit + push fast-forward by construction; a non-fast-forward `--ff-only` failure here means an unexpected divergence -- stop and reconcile rather than force-push.
1. ! Confirm the lifecycle moves are present (the Step 1.5 sweep already ran `task scope:complete <file>` per story, `active/` -> `completed/`). If the sweep was skipped, run `task swarm:complete-cohort` now -- do NOT hand-move xBRIEF files.
2. ! Stage ALL lifecycle moves: `git add -A xbrief/` -- this captures both the `active/` deletions and the `completed/` additions, plus any parent/child `planRef` / `x-xbrief/plan` reference edits made during the sweep.
3. ! Commit them in a SINGLE commit on the base branch: `git commit -m "chore(xbrief): complete <slugs> post-merge"`, where `<slugs>` enumerates the completed story xBRIEF slugs (or the cohort label) so the commit is self-describing.
4. ! Push to origin: `git push origin <configured-base-branch>`. Because step 0 fast-forwarded the local base ahead of the commit, this push is a fast-forward and will not be rejected.

! **Authoritative lifecycle record (#1358):** this commit is what keeps the release ceremony's xBRIEF-lifecycle-sync gate green. The release pipeline's deterministic gate and the release skill's Phase 1 sync gate (`skills/deft-directive-release/SKILL.md` Phase 1 -- `task reconcile:issues -- --apply-lifecycle-fixes`) both refuse to cut a release while a closed-issue xBRIEF still sits outside `xbrief/completed/`. Committing the moves here, at swarm close-out, is the **prevention** so the next release does not have to reconcile drift the swarm itself created. If drift is nevertheless detected later, `task reconcile:issues -- --apply-lifecycle-fixes` is the recovery path -- but the post-merge commit in this step is what stops the drift from being authored in the first place.

⊗ Declare a swarm closed while the cohort's `active/` -> `completed/` lifecycle moves remain uncommitted in the merger's worktree -- an uncommitted lifecycle record is invisible to every other clone and re-surfaces as `check_vbrief_lifecycle_sync` drift at the next release (#1358). The Step 1.5 sweep moves the files; this step makes the move durable.

### Step 3: Update Master

- ! Pull merged changes: `git pull origin <configured-base-branch>` from the merger's OWN worktree only.
- ⊗ Run `git checkout` (any branch) in a worktree the merging agent does not own. Post-merge `git pull origin <base-branch>` semantics MUST be performed via `git fetch origin <base-branch>` from the merger's own worktree, OR by leaving the master update entirely to the human operator. NEVER touch HEAD of a sibling worktree another agent is using.
- ! After a successful squash merge, the merger MAY remove its own worktree via `git worktree remove <path>` and delete the now-orphaned local feature branch via `git branch -D <branch>`. The merger MUST NOT alter any other worktree's HEAD or branch state.
- ! **Worktree-boundary discipline (#800, companion to #727):** the `⊗` rule above extends the same boundary discipline as the `### Sub-Agent Role Separation (#727)` companion rules earlier in Phase 6 -- #727 codifies sub-agent spawn shape; #800 codifies worktree HEAD operations. Recurrence record: PR #797 merge session (2026-05-01) -- Agent B (the merger) ran `cd C:\repos\Deft\directive; git checkout master --quiet` against Agent A's sibling worktree after merging its own PR; HEAD detached on Agent A's branch and was retroactively restored. No work was lost (Agent A had pushed) but recovery was incident-driven, not preventative.

### Step 4: Clean Up

- ! Remove worktrees: `git worktree remove <path>`
- ! Delete local branches: `git branch -D <branch>`
- ~ Delete launch scripts if still present
- ? If worktree removal fails (locked files from open terminals), note for manual cleanup

### Step 5: Generate Slack Release Announcement

! After creating the GitHub release (or after the final merge if no formal release is created), generate a standard Slack announcement block and present it to the user for copy-paste into the team channel.

! The announcement block MUST include all of the following fields:

```
:rocket: *{Project Name} {version}* -- {release title}

*Summary*: {one-sentence description of the release scope}

*Key Changes*:
- {bullet per significant change, 3-5 items max}

*Stats*: {N} agents | ~{duration} elapsed | {N} PRs merged
*PRs*: {#PR1, #PR2, ...}
*Override merges*: {#PRX: <one-line rationale from merge commit body>, ...} -- omit this line only if no PR in the release used the Greptile-service-errored override path
*Release*: {GitHub release URL}
```

- ! Populate version from the CHANGELOG promotion commit or git tag
- ! Populate release title from the CHANGELOG section heading or GitHub release title
- ! Key changes summarized from CHANGELOG `[Unreleased]` entries (not raw commit messages)
- ! Agent count and approximate duration from the swarm session (Phase 3 launch to Phase 6 close)
- ! PR numbers from the merged PRs in this swarm run
- ! **Override merges line (#526):** For any PR in the release that was merged via the Greptile-service-errored override path (Phase 6 Step 1 choice (c)), explicitly call it out in the announcement with the one-line rationale taken from the merge commit body so downstream readers of the release notes can trace the documented rationale. Detect override merges by scanning each merged PR's merge commit body for the override rationale footprint (prior Greptile success on a pre-rebase SHA + CI green on current SHA + pure conflict-resolution rebase). Omit the `*Override merges*` line only when no merged PR in this release used the override path.
- ~ **Cascade automation citation (#1369):** When the release used `task pr:wait-mergeable-and-merge` to drive the merge cascade (the canonical Wave-3 surface introduced by #1369), the operator MAY include a one-line announcement footnote -- e.g. `_Merge cascade automated via task pr:wait-mergeable-and-merge (#1369)._` -- so downstream readers of the release notes know the cascade ran through the deterministic three-state-exit surface rather than a hand-rolled monitor. The per-PR atomic gate (`task pr:merge-ready && gh pr merge`) remains the manual fall-through and does NOT need to be cited; only the automated cascade path warrants the explicit footnote.
- ! GitHub release URL from the `gh release create` output (or `gh release view --json url` if already created)
- ~ Present the block as a code-fenced snippet the user can copy directly
- ? If no formal GitHub release was created (e.g. user deferred), still generate the announcement with a placeholder URL and note that the release is pending
