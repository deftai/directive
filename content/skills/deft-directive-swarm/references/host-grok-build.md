# Host adapter: Grok Build

Legend (RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

Descriptor: `grok-build` (`spawn_subagent`).

Load this file only after detect selects Grok Build. Do not load other host adapters.

## Runtime contract

## Running Swarms in Grok Build / Non-Warp Environments

Minimal runtime contract for the Grok Build dispatch-provider path (one supported backend among several -- see Phase 3 Step 1b for provider-neutral heterogeneous routing):

- One isolated git worktree per agent (identical to the Warp path — see Phase 2)
- Workers launched via `spawn_subagent` dispatch (Phase 3 Step 2d)
- Layer A (adapter): background spawn, then **end the parent turn**. User-facing `get_command_or_subagent_output` is pull-wait and is not the Gap D completion channel.
- Layer B (host): no `sessions_yield`, no live `resume_from`, no general retain. Steer is the #4286 file inbox (child-steer only).
- Review-cycle **sibling** monitors spawned via `spawn_subagent` by the **parent/orchestrator** (not `start_agent`). Implementation leaves MUST NOT nested-spawn a review-monitor -- see Nested spawn_subagent boundary below.
- Worktree git (`git status`, `git log`) and on-disk heartbeat remain liveness evidence. They are not parent-pane yield.

This path became first-class in #1342 (platform adapter slices 1-3) and is fully documented in Phase 3 Step 2d and Phase 4. Grok Build + Windows users should also see #1353 (§3.5 in `templates/agent-prompt-preamble.md`) for shell output capture limitations that affect `get_command_or_subagent_output` in PowerShell 5.1 contexts. Refs #1342, #1331, #4796.

~ **Windows + Grok Build (#1353):** When issuing shell commands via `run_terminal_command` on this platform, avoid `|`, `>`, or `2>&1` in the command string — use Python `pathlib`/`subprocess` or plain `task` targets instead to avoid wrapper leakage. See `templates/agent-prompt-preamble.md` §3.5 for the full escape hatch list.

### Step 2d: Grok Build Launch (spawn_subagent available)

! When the platform descriptor is `grok-build` (spawn_subagent detected, no start_agent, no WARP_*, no Cursor `Task`, no OpenClaw `sessions_spawn`, no Grok Bot unique signals), dispatch each worker via `spawn_subagent` with:
0. Create `<worktree>/.deft-scratch/subagent-status/` before spawn if launch/pre-dispatch did not already, and instruct the worker to heartbeat + commit early (#3730).
1. The canonical `templates/agent-prompt-preamble.md` content as the preamble
2. The standard worktree prompt (STEP 1-6 from the Prompt Template below). Workers coordinate via worktree git + heartbeat. Do not adapt the worker prompt to parent `get_command_or_subagent_output`.
3. `tool_input.cwd` set to the agent's reserved linked worktree. Grok implement dest is `cwd` only. Do not pass `worktree_path`, `worktreePath`, `worktree`, or `isolation=worktree`.
4. ! **Background / non-blocking spawn** for any worker or poller whose loop runs longer than a short task (~3 min) — implementation, fix, and review-cycle workers — so the parent conversation stays interactive (#1880 Gap D). Use `spawn_subagent` in the background (host typically returns `subagent_id` immediately).
5. ! **End the parent turn after spawn.** Do not keep the user-facing turn in `get_command_or_subagent_output` / Phase 4–6 pull-wait. Tier-1 spawn is not Tier-1 parent interactivity.
6. ! **Completion channel (not parent pull-wait):** Prefer host completion-notify when the harness documents that the parent is notified on child terminal without polling (`DONE` / `BLOCKED` / `FAILED` per preamble §11). Until that path is **measured** (harness version, model, Directive SHA, trial A or B), do not claim it. Legal fallback: a **second session that is the durable owner** (#3153) — occupancy-lease holder, dest-proven cwd, one owner, one read-only companion, one durable handoff. That owner session MAY pull-wait. ⊗ End the interactive parent turn with nobody owning Phase 6 / leftover-complete. That is bake-off (c) as a #3153 defect, not a Gap D workaround.

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

- **(c)** background workers + forced parent stop: score only when completion-notify **or** a second session that is the durable owner is measured true. Otherwise (c) is a #3153 defect.
- **(d)** steer inbox: child-steer only. Does not score parent-pane usability. A scratch path does not interrupt a blocked tool.
- **(a)** two-session split: name the occupancy-lease holder and the dest-proven session. One owner, one read-only companion, one durable handoff. The companion does not write the steer inbox.

Until a measured callback exists, Grok wording is conditional: background `spawn_subagent` is available; parent-chat interactivity depends on returning the turn rather than entering pull-wait.

! Review-cycle "parent yielding" is not a Grok host primitive. Reconcile that phrase with this adapter's pull-wait recut: until a measured callback exists, Grok wording is conditional.


## Nested spawn_subagent boundary (#4130 / #2797 analogue)

! Nested `spawn_subagent` (implementation leaf spawning leaf) is unsupported for an Approach 1 review-monitor. Nested spawn does not report to the parent, and the parent cannot re-prompt a live child (`resume_from` requires terminal). A Grok Build **implementation leaf** MUST NOT nested-spawn a second-level review-monitor via `spawn_subagent`. Prefer either:

- (a) a `drive-to: merge-ready` leaf that owns a blocking dual-invoke `pr:watch` (`deft pr:watch` then `task deft:pr:watch`) in its own process, then `pr:merge-ready` / merge in the same loop, or
- (b) `stop-at: pr-open` with the dispatcher (parent that owns `spawn_subagent`) launching a sibling monitor and registering it via dual-invoke `review-monitor:register -- --platform-primitive spawn_subagent`.

! **Grok through-merge (#4529):** implement MUST use (b). Path (a) is for non-through-merge Grok leaves only. Phase 6 monitor squash-merges via `pr:wait-mergeable-and-merge` (or parent-retained); `swarm:finalize-cohort` is leftover after merge. ⊗ Dispatch a Grok through-merge implement as (a).

! Top-level parents/orchestrators that own `spawn_subagent` MAY Approach-1 background a review-monitor. After that spawn they MUST end the user-facing turn (Gap D above). Background spawn permission is not parent-yield.

⊗ An implementation leaf backgrounds a nested `spawn_subagent` poller and exits claiming monitoring is active.
⊗ Invent mid-flight message-later on grok-build as a substitute for this boundary.

If the leaf needs another agent, it stops and reports `BLOCKED`. The parent owns the next spawn.

## Monitor notes

! Heartbeat liveness on the Grok Build hybrid path is required — see `references/core-phase-4.md` Heartbeat liveness check (#1365) and `docs/subagent-heartbeat.md`.
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
