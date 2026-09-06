# Host adapter: Grok Build

Legend (RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

Descriptor: `grok-build` (`spawn_subagent`).

Load this file only after detect selects Grok Build. Do not load other host adapters.

## Runtime contract

## Running Swarms in Grok Build / Non-Warp Environments

Minimal runtime contract for the Grok Build dispatch-provider path (one supported backend among several -- see Phase 3 Step 1b for provider-neutral heterogeneous routing):

- One isolated git worktree per agent (identical to the Warp path — see Phase 2)
- Workers launched via `spawn_subagent` dispatch (Phase 3 Step 2d)
- Monitor coordination via worktree-state polling (`git status`, `git log`) and `get_command_or_subagent_output`
- Review-cycle **sibling** monitors spawned via `spawn_subagent` by the **parent/orchestrator** (not `start_agent`). Implementation leaves MUST NOT nested-spawn a review-monitor -- see Nested spawn_subagent boundary below.

This path became first-class in #1342 (platform adapter slices 1-3) and is fully documented in Phase 3 Step 2d and Phase 4. Grok Build + Windows users should also see #1353 (§3.5 in `templates/agent-prompt-preamble.md`) for shell output capture limitations that affect `get_command_or_subagent_output` in PowerShell 5.1 contexts. Refs #1342, #1331.

~ **Windows + Grok Build (#1353):** When issuing shell commands via `run_terminal_command` on this platform, avoid `|`, `>`, or `2>&1` in the command string — use Python `pathlib`/`subprocess` or plain `task` targets instead to avoid wrapper leakage. See `templates/agent-prompt-preamble.md` §3.5 for the full escape hatch list.

### Step 2d: Grok Build Launch (spawn_subagent available)

! When the platform descriptor is `grok-build` (spawn_subagent detected, no start_agent, no WARP_*, no Cursor `Task`, no OpenClaw `sessions_spawn`, no Grok Bot unique signals), dispatch each worker via `spawn_subagent` with:
0. Create `<worktree>/.deft-scratch/subagent-status/` before spawn if launch/pre-dispatch did not already, and instruct the worker to heartbeat + commit early (#3730).
1. The canonical `templates/agent-prompt-preamble.md` content as the preamble
2. The standard worktree prompt (STEP 1-6 from the Prompt Template below), adapted to use `get_command_or_subagent_output` for polling rather than `start_agent` lifecycle events
3. `tool_input.cwd` set to the agent's reserved linked worktree. Grok implement dest is `cwd` only. Do not pass `worktree_path`, `worktreePath`, `worktree`, or `isolation=worktree`.

! **Parent ritual HEAD-discontinuous / dest occupancy deny class (#4215).** Native `spawn_subagent` with `cwd` to a dest-proven reserved linked worktree must not require a live parent primary ritual. Occupancy-refused on the contended primary is why `session:start --rearm` on master is the wrong recovery, not a spawn skip. If native spawn is denied, record that deny text in the handback. CLI `grok --cwd` is last-resort after that deny, not a habit after the first failure. Do not dual-launch CLI and `spawn_subagent` on the same unit. Do not document CLI as the real Grok Build launch path.

~ This is the first-class non-Warp path. Workers use worktree state polling (`git status`, `git log`) and `get_command_or_subagent_output` as their coordination channel instead of Warp tab state.

! Design-critique N≥3 other-family seats are not `spawn_subagent` Grok catalog rows. When `claude` / `codex` resolve on PATH, CLI-spawn those seats (`content/docs/grok-build-subscription-setup.md`). Paste-ready is fallback. Normative stop: `content/contracts/design-critique.md` Envelope and ceiling (#4067).


## Nested spawn_subagent boundary (#4130 / #2797 analogue)

! Nested `spawn_subagent` (implementation leaf spawning leaf) is unsupported for an Approach 1 review-monitor. Nested spawn does not report to the parent, and the parent cannot re-prompt a live child (`resume_from` requires terminal). A Grok Build **implementation leaf** MUST NOT nested-spawn a second-level review-monitor via `spawn_subagent`. Prefer either:

- (a) a `drive-to: merge-ready` leaf that owns a blocking dual-invoke `pr:watch` (`deft pr:watch` then `task deft:pr:watch`) in its own process, then `pr:merge-ready` / merge in the same loop, or
- (b) `stop-at: pr-open` with the dispatcher (parent that owns `spawn_subagent`) launching a sibling monitor and registering it via dual-invoke `review-monitor:register -- --platform-primitive spawn_subagent`.

! Top-level parents/orchestrators that own `spawn_subagent` MAY Approach-1 background a review-monitor.

⊗ An implementation leaf backgrounds a nested `spawn_subagent` poller and exits claiming monitoring is active.
⊗ Invent mid-flight message-later on grok-build as a substitute for this boundary.

If the leaf needs another agent, it stops and reports `BLOCKED`. The parent owns the next spawn.

## Monitor notes

! Heartbeat liveness on the Grok Build hybrid path is required — see `references/core-phase-4.md` Heartbeat liveness check (#1365) and `docs/subagent-heartbeat.md`.
! Poll coordination uses worktree state + `get_command_or_subagent_output` (not OpenClaw parent-announce).

## Retained / continue-by-id (#3158)

! **Default one-shot:** `spawn_subagent` workers that finish their tool loop are observed terminal (`succeeded` / failed); the `agent_id` is not a general message-later inbox. Mid-scope user-approval gates MUST use **split-dispatch** (#954) unless this host later documents continue-by-agent-id.
? While a worker is still `in_progress` and the host exposes a live steer / re-prompt channel to that `agent_id`, the parent MAY steer mid-flight without a second spawn — that is the only retain-capable slice on this path today.
! After terminal exit, always dispatch a successor for remaining scope; do not invent re-attach semantics.
~ Stance: orchestration only (#3164).
