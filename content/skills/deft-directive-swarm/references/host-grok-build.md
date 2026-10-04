# Host adapter: Grok Build

Legend (RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

Descriptor: `grok-build` (`spawn_subagent`).

Load this file only after detect selects Grok Build. Do not load other host adapters.

## Runtime contract

## Running Swarms in Grok Build / Non-Warp Environments

Minimal runtime contract for the Grok Build dispatch-provider path (one supported backend among several -- see Phase 3 Step 1b for provider-neutral heterogeneous routing):

- One isolated git worktree per agent (identical to the Warp path — see Phase 2)
- Workers launched via `spawn_subagent` dispatch (Phase 3 Step 2d)
- Layer A (adapter): background spawn of the **full planned set**, then end the parent turn only after those launches, any required review-monitor lease register, and a completion-owner ack (Step 2d). User-facing `get_command_or_subagent_output` is pull-wait and is not the Gap D completion channel.
- Layer B (host): no `sessions_yield`, no live `resume_from`, no general retain. Steer is the #4286 file inbox (child-steer only).
- Review-cycle **sibling** monitors spawned via `spawn_subagent` by the **parent/orchestrator** (not `start_agent`). Implementation leaves MUST NOT nested-spawn a review-monitor -- see Nested spawn_subagent boundary below.
- Worktree git (`git status`, `git log`) and on-disk heartbeat remain liveness evidence. They are not parent-pane yield.

This path became first-class in #1342 (platform adapter slices 1-3) and is fully documented in Phase 3 Step 2d and Phase 4. Grok Build + Windows users should also see #1353 (§3.5 in `templates/agent-prompt-preamble.md`) for shell output capture limitations that affect `get_command_or_subagent_output` in PowerShell 5.1 contexts. Refs #1342, #1331, #4796.

~ **Windows + Grok Build (#1353):** When issuing shell commands via `run_terminal_command` on this platform, avoid `|`, `>`, or `2>&1` in the command string — use Python `pathlib`/`subprocess` or plain `task` targets instead to avoid wrapper leakage. See `templates/agent-prompt-preamble.md` §3.5 for the full escape hatch list.

### Step 2d: Grok Build Launch (spawn_subagent available)

! When the platform descriptor is `grok-build` (spawn_subagent detected, no start_agent, no WARP_*, no Cursor `Task`, no OpenClaw `sessions_spawn`, no Grok Bot unique signals), dispatch each worker via `spawn_subagent` with:
0. ! **Dest-place then cwd (#4575 Prefer-A).** Before interactive implement `spawn_subagent`, parent dest-places a unique linked worktree per child via `destPlaceImplementSpawn` (`packages/core/src/swarm/dest-place.ts`) — same `git worktree add --detach <path> <commit-ish>` argv as createWorktree / ensureArcDest, plus deposit reconstitution. Path + commit-ish required; bare `--detach` refused. Then set `tool_input.cwd` to that path. Do not substitute a raw shell `git worktree add` for dest-place: that skips deposit reconstitution and leaves the child without `.deft/core`. Dest-place only creates the path; `mintImplementSpawnReservation` remains the reservation mint after consult allows. Do not dest-place a "reserved" worktree or mint reservation before spawn. Deny-copy stays on leftover #5184. Dispatcher-owned release is existing child-occupancy compare-and-release.
1. Create `<worktree>/.deft-scratch/subagent-status/` before spawn if dest-place / launch / pre-dispatch did not already, and instruct the worker to heartbeat + commit early (#3730).
2. The canonical `templates/agent-prompt-preamble.md` content as the preamble
3. The standard worktree prompt (STEP 1-6 from the Prompt Template below). Workers coordinate via worktree git + heartbeat. Do not adapt the worker prompt to parent `get_command_or_subagent_output`.
4. `tool_input.cwd` set to the dest-placed linked worktree from step 0. Grok implement dest is `cwd` only. Do not pass `worktree_path`, `worktreePath`, `worktree`, or `isolation=worktree`.
5. ! **Background / non-blocking spawn** for any worker or poller whose loop runs longer than a short task (~3 min) — implementation, fix, and review-cycle workers — so the parent conversation stays interactive (#1880 Gap D). Use `spawn_subagent` in the background (host typically returns `subagent_id` immediately).
6. ! **End the parent turn after the planned launch set, not after the first spawn.** For a cohort with multiple workers, keep the turn open until every planned worker has launched. If an Approach 1 review-monitor is in that set, spawn it and register the sticky lease in the same turn (`task review-monitor:register -- --pr <N> --monitor-agent-id <id> --platform-primitive spawn_subagent`; `task verify:review-monitor -- --pr <N>` exit 0). Then end the user-facing turn. Do not keep it in `get_command_or_subagent_output` / Phase 4–6 pull-wait. Tier-1 spawn is not Tier-1 parent interactivity. ⊗ End the turn after the first spawn of a multi-worker cohort.
7. ! **Completion owner before the user-facing turn ends (#3153).** Host completion-notify (parent notified on child terminal without polling: `DONE` / `BLOCKED` / `FAILED` per preamble §11) is **Unknown** on this ship. ⊗ Pick it as the owner path until trial A or B evidence exists (harness version, model, Directive SHA). Until then, create or transfer a durable completion owner and receive ack **before** ending the interactive turn. That owner observes child completion, merge, and `swarm:finalize-cohort` / `scope:complete`. Pick one:
   - **Approach 1 sibling.** Parent `spawn_subagent` the review-monitor / Phase 6 closer. Ack is `task review-monitor:register -- --pr <N> --monitor-agent-id <id> --platform-primitive spawn_subagent` success (sticky `<!-- deft:review-owner -->`) and `task verify:review-monitor -- --pr <N>` exit 0 in the same turn. The sibling is the owner.
   - **Parent-retained on this dest-proven occupancy-lease holder.** This session already holds the dest occupancy lease and is named owner (`review_cycle: in_progress:<pr>#parent-retained` when a PR exists; before PR, name this session as Phase 6 / leftover-complete owner). Ack is that same-turn named ownership plus this session's occupancy claim. This session MAY pull-wait; it is not the interactive research pane.
   - **Two-session transfer.** Second session dest-places a unique linked worktree (`cwd` = that path) and claims occupancy there. One owner, one read-only companion, one durable handoff. Ack is the dest-proven session's occupancy claim output naming it as lease holder, recorded on the transferring turn. The companion does not write the steer inbox. The owner session MAY pull-wait.
   ⊗ End the interactive parent turn with nobody owning Phase 6 / leftover-complete. That is bake-off (c) as a #3153 defect, not a Gap D workaround. ⊗ Treat unmeasured host notify plus a vague "second session" as that owner.

! **Parent ritual HEAD-discontinuous / dest occupancy deny class (#4215).** Native `spawn_subagent` with `cwd` to a dest-proven reserved linked worktree must not require a live parent primary ritual. Occupancy-refused on the contended primary is why `session:start --rearm` on master is the wrong recovery, not a spawn skip. If native spawn is denied, record that deny text in the handback. CLI `grok --cwd` is last-resort after that deny, not a habit after the first failure. Do not dual-launch CLI and `spawn_subagent` on the same unit. Do not document CLI as the real Grok Build launch path.

~ This is the first-class non-Warp path. It is **Tier 1 → Approach 1** for **spawn**. It is not Tier 1 for parent interactivity until trial evidence says otherwise.

! Design-critique N≥3 other-family seats are not `spawn_subagent` Grok catalog rows. When `claude` / `codex` resolve on PATH, CLI-spawn those seats (`content/docs/grok-build-subscription-setup.md`). Paste-ready is fallback. Normative stop: `content/contracts/design-critique.md` Envelope and ceiling (#4067).


## Gap D fidelity matrix (#4796)

Gap D (#1880) is background dispatch so the parent channel stays interactive **and** the orchestrator is notified on completion. Closing #1880 shipped that guidance. This adapter recut is operator-visible fidelity, not a relitigation of that prose. Do not merge this issue into #3984. Do not bind pause/checkpoint as primary.

Axes (score independently; Gap D fidelity is the first three only):

| Axis | Gap D? | Scores |
| --- | --- | --- |
| background launch | yes | long worker dispatched non-blocking |
| parent turn return | yes | user-facing turn ends without waiting on worker wall-clock |
| completion delivery | yes | parent learns terminal without user-facing pull-wait |
| live steer | no | re-prompt a live child |
| soft pause/resume | no | pause without abort |
| interrupt/orphan | no | interrupt vs child fate |

Trials per host (required before a non-Unknown cell):

- **(A)** primitive-only spawn, then immediate parent-turn return
- **(B)** canonical Directive swarm/review flow

Record: `parent_turn_returned_at`, whether a second user turn was accepted while the child stayed alive, how completion arrived, interrupt effect on parent and child.

Every non-Unknown cell needs dated evidence keyed by harness version, model, Directive SHA, trial shape, and observed result. Unmeasured starting-point rows are **Unknown**.

Grok Build cells in this ship: **Unknown**. Adapter Layer A binds anyway.

Bake-off scoring:

- **(c)** background workers + forced parent stop: score only when a named completion owner is acked before the turn ends (Approach 1 lease, parent-retained occupancy holder, or two-session occupancy-claim transfer) **or** host completion-notify is measured true. Unmeasured notify plus a vague second-session fallback is a #3153 defect.
- **(d)** steer inbox: child-steer only. Does not score parent-pane usability. A scratch path does not interrupt a blocked tool.
- **(a)** two-session split: dest-proven session claims occupancy; transferring parent records that claim as ack. One owner, one read-only companion, one durable handoff. The companion does not write the steer inbox.

Until a measured callback exists, Grok wording is conditional: background `spawn_subagent` is available; parent-chat interactivity depends on returning the turn rather than entering pull-wait.

! Review-cycle "parent yielding" is not a Grok host primitive. Reconcile that phrase with this adapter's pull-wait recut: until a measured callback exists, Grok wording is conditional.


## Nested spawn_subagent boundary (#4130 / #2797 analogue)

! Nested `spawn_subagent` (implementation leaf spawning leaf) is unsupported for an Approach 1 review-monitor. Nested spawn does not report to the parent, and the parent cannot re-prompt a live child (`resume_from` requires terminal). A Grok Build **implementation leaf** MUST NOT nested-spawn a second-level review-monitor via `spawn_subagent`. Prefer either:

- (a) a `drive-to: merge-ready` leaf that owns a blocking dual-invoke `pr:watch` (`deft pr:watch` then `task deft:pr:watch`) in its own process, then `pr:merge-ready` / merge in the same loop, or
- (b) `stop-at: pr-open` with the dispatcher (parent that owns `spawn_subagent`) launching a sibling monitor and registering it via dual-invoke `review-monitor:register -- --platform-primitive spawn_subagent`.

! **Grok through-merge (#4529 / #4821 / #5219):** implement MUST use (b) `stop-at: pr-open`. Path (a) is for non-through-merge Grok leaves only. Named leftover (class A) requires a dest-cwd one-shot residual, stop-at after the push; then Approach 1 wait owner is a **`spawn_subagent` review-monitor sibling** whose `monitor_agent_id` is registered (`review-monitor:register --platform-primitive spawn_subagent`) and whose child-bound `pr:watch --monitor-agent-id <id>` satisfies `verify:review-monitor --merge-path-arm --live-wait`; then Phase 6 / parent-retained squash-merges via `pr:wait-mergeable-and-merge` only after CLEAN. Pass a declared wait budget when the envelope states one (#3984). Parent-retained is the **closer after CLEAN**, not the pre-CLEAN poller/fixer. Dest spawn deny is `BLOCKED` or dest-cwd residual via native implementation-capable spawn (#4215) — not parent-primary. ⊗ Send class-A residual through process-only CLI `grok --cwd`. ⊗ Choose Approach 1 sibling or parent-retained as the first partner without dest residual. ⊗ Dispatch a Grok through-merge implement as (a). ⊗ Harvest a Grok `drive-to: merge-ready` continuation as this closer. ⊗ Treat a parent-owned shell/`bash` `pr:watch` (heartbeat `parent_id=pr-watch`) as Approach 1 babysit when `spawn_subagent` is available (#5219).

! **Cheapest admitted Approach 1 path (#5219 P3 / #5229):** after `pr-open`, Approach 1 `spawn_subagent` babysit is the **cheapest admitted** path vs parent shell `pr:watch`, host `monitor`, or bespoke `%TEMP%` pollers. Prefer one background `spawn_subagent` babysitter that owns watch → class A residual handoff → re-watch until CLEAN, then hand CLEAN to the parent closer. Child register + watch first (heartbeat live); parent verify after:
```
task review-monitor:register -- --pr <N> --monitor-agent-id <id> --platform-primitive spawn_subagent
DEFT_MONITOR_AGENT_ID=<id> task pr:watch -- <N> --monitor-agent-id <id>
# parent after child watch is live:
task verify:review-monitor -- --pr <N> --merge-path-arm --live-wait
```
Core helper: `formatApproach1BabysitterOneLiner` / `formatApproach1CheapestAdmissionCard` (`packages/core/src/swarm/approach1-babysitter.ts`). Bounded-form deny: `evaluateBoundedPrWatchDeny` refuses Directive `pr:watch` / `task deft:pr:watch` without `--monitor-agent-id` when Tier 1 is provable. ⊗ Parent-shell `pr:watch --monitor-agent-id <leased id>` without spawn-injected `DEFT_MONITOR_AGENT_ID` (or CLI matching `GROK_SESSION_ID`) — that impersonation does not arm. ⊗ Start `pr:wait-mergeable-and-merge` before CLEAN (#4822). ⊗ Treat host `monitor` or bare shell `pr:watch` as the sole babysit when `spawn_subagent` is available (#5229).

! **Durable host→CLI capability stamp (#5229):** Before any CLI `verify:review-monitor` / `pr:watch` subprocess, write `.deft-scratch/host-capability-stamp.json` via `writeHostCapabilityStamp(projectRoot)` / `ensureHostCapabilityStampForBabysit` (and prefer exporting `GROK_BUILD=1` / `DEFT_HAS_SPAWN_SUBAGENT=1` into that subprocess). `review-monitor:register` also writes the stamp on successful claim/renew. Stamps older than 8h or bound to a different `host_session_id` are ignored so a later plain-terminal session cannot inherit Tier 1. Without a fresh stamp, bare `node … verify:review-monitor` can mis-detect Tier 3 / `generic-terminal` and fail-open with "no active review-monitor required" even though this parent owns `spawn_subagent`. `probeMonitoringTier` merges the stamp; `DEFT_MONITOR_TIER=3` is labeled `override-tier3` (not honest `generic-terminal`) and refused when stamp/env already proves Tier 1. `evaluateReviewMonitorGate` consults sticky lease `platform_primitive` before Approach 3 READY and before `!isTier1` READY. Bounded `pr:watch` without `--monitor-agent-id` is refused at the watch entry when Tier 1 is provable.

! **Named residual — bespoke `%TEMP%` pollers (#5229):** Unsanctioned `%TEMP%` / ad-hoc PowerShell one-shot watchers are **not** covered by the bounded Directive `pr:watch` form deny unless the host routes them through deft-hook. Do not claim total coverage of arbitrary host/shell babysitting without host admission. Prefer Approach 1; kill freestyle watchers when they appear.

! **Mandatory checked handoff (#5219 / #5229):** before the parent yields on a Tracking PR that still needs Greptile/CI shepherding while `spawn_subagent` is available, the same-turn checked handoff is `task verify:review-monitor -- --pr <N> --merge-path-arm --live-wait` exit 0 after Approach 1 register + **still-running** child-bound wait (verify after watch starts, not before).

! **Cohort babysit inventory (#5318):** When multiple cohort Tracking PRs are open, parent MUST also run `task verify:cohort-review-monitors -- --prs <csv>` (default resolver = launch-manifest ∪ open linked Tracking; operator `--prs` must not silently shrink that union). Exit 0 only when every listed PR is `armed-live` (per-PR `--merge-path-arm --live-wait`) or `halted-explicit` (durable `--explicit-finish` / option-C attestation — prose dual-stop resume lines are **not** halted-explicit). Re-run and remediate `unarmed` (spawn Approach 1 / `approach1BabysitterCommands` / `pr:watch --monitor-agent-id`; parallel OK) at: after each PR-open/discover; before each serial rebase/squash-merge; after Approach 1 child exit or review-monitor lease release; after merge/tip-churn that dirties siblings; after dual-stop/conf-hold/BLOCKED halt recording. ⊗ Treat `swarm:verify-review-clean` CLEAN as babysit arm — inventory is arm-class, not Greptile CLEAN (#1364 anti-substitute). This host does **not** intercept every conversational yield — guarantee is scoped to that checked handoff (and Swarm Phase 5→6 / review-cycle ownership probes that invoke the same arm). Publish limitation: omitting the arm flag is unarmed stand-down, not silent Approach 1. #3984 stays separate (no parent-turn-shape detector). Do not reopen #4529 implement `stop-at: pr-open`. Do not reopen the shipped #5219 false-claim join.

! Top-level parents/orchestrators that own `spawn_subagent` MAY Approach-1 background a review-monitor. After the full planned launch set (workers + that monitor), lease register, and completion-owner ack, they MUST end the user-facing turn (Gap D above). Background spawn permission is not parent-yield.

⊗ An implementation leaf backgrounds a nested `spawn_subagent` poller and exits claiming monitoring is active.
⊗ Invent mid-flight message-later on grok-build as a substitute for this boundary.
⊗ Arm merge-path with parent-shell `pr:watch` alone when Tier-1 `spawn_subagent` is available (#5219).

If the leaf needs another agent, it stops and reports `BLOCKED`. The parent owns the next spawn.

## Monitor notes

! Heartbeat liveness on the Grok Build hybrid path is required — see `references/core-phase-4.md` Heartbeat liveness check (#1365) and `.deft/core/docs/subagent-heartbeat.md`.
! User-facing parent MUST NOT poll via `get_command_or_subagent_output`. A named durable-owner session (second-session split or Phase 4 takeover on that owner) MAY use worktree state + `get_command_or_subagent_output` for liveness/takeover. That session is then not the interactive research pane.
⊗ Treat OpenClaw parent-announce as present on this host.

## Parent-steer inbox (#4286)

! Grok-build leaves still need a parent-writable steer path because this host has no child prompt and no live `resume_from`. Directive owns that path. Do not wait for an xAI input field.

! Inbox: `<worktree>/.deft-scratch/subagent-steer/<agent-id>.json` (not heartbeat JSON). Child reads on each pollable slice and acks apply-once via `<agent-id>.ack.json`. `task verify:subagent-steer` is the parent-visible unread flag (`STEER_PENDING`). It is not `REDISPATCH_OK`.

! Tool-loop duty: no blocking wait longer than the heartbeat/steer poll interval when the leaf must remain steerable; between slices, read the inbox and rewrite heartbeat. A scratch path does not interrupt a blocked tool.

! Steer inbox scores child-steer only, not parent-pane usability.

⊗ Replace split-dispatch for mid-scope approval gates with this inbox.
⊗ Invent OpenClaw `sessions_yield` or live `resume_from` on this host.
⊗ Drop a second JSON schema into `.deft-scratch/subagent-status/`.

## Retained / continue-by-id (#3158)

! **Default one-shot:** `spawn_subagent` workers that finish their tool loop are observed terminal (`succeeded` / failed); the `agent_id` is not a general message-later inbox. Mid-scope user-approval gates MUST use **split-dispatch** (#954) unless this host later documents continue-by-id.
? While a worker is still `in_progress` and the host exposes a live steer / re-prompt channel to that `agent_id`, the parent MAY steer mid-flight without a second spawn — that is the only retain-capable slice on this path today.
! After terminal exit, always dispatch a successor for remaining scope; do not invent re-attach semantics.
~ Stance: orchestration only (#3164).
