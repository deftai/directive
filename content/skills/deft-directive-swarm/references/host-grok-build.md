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
- Review-cycle sub-agents spawned via `spawn_subagent` (not `start_agent`)

This path became first-class in #1342 (platform adapter slices 1-3) and is fully documented in Phase 3 Step 2d and Phase 4. Grok Build + Windows users should also see #1353 (§3.5 in `templates/agent-prompt-preamble.md`) for shell output capture limitations that affect `get_command_or_subagent_output` in PowerShell 5.1 contexts. Refs #1342, #1331.

~ **Windows + Grok Build (#1353):** When issuing shell commands via `run_terminal_command` on this platform, avoid `|`, `>`, or `2>&1` in the command string — use Python `pathlib`/`subprocess` or plain `task` targets instead to avoid wrapper leakage. See `templates/agent-prompt-preamble.md` §3.5 for the full escape hatch list.

### Step 2d: Grok Build Launch (spawn_subagent available)

! When the platform descriptor is `grok-build` (spawn_subagent detected, no start_agent, no WARP_*, no Cursor `Task`, no OpenClaw `sessions_spawn`), dispatch each worker via `spawn_subagent` with:
1. The canonical `templates/agent-prompt-preamble.md` content as the preamble
2. The standard worktree prompt (STEP 1-6 from the Prompt Template below), adapted to use `get_command_or_subagent_output` for polling rather than `start_agent` lifecycle events
3. The worktree path set to the agent's isolated git worktree

~ This is the first-class non-Warp path. Workers use worktree state polling (`git status`, `git log`) and `get_command_or_subagent_output` as their coordination channel instead of Warp tab state.


## Monitor notes

! Heartbeat liveness on the Grok Build hybrid path is required — see `references/core-phase-4.md` Heartbeat liveness check (#1365) and `docs/subagent-heartbeat.md`.
! Poll coordination uses worktree state + `get_command_or_subagent_output` (not OpenClaw parent-announce).

## Retained / continue-by-id (#3158)

! **Default one-shot:** `spawn_subagent` workers that finish their tool loop are observed terminal (`succeeded` / failed); the `agent_id` is not a general message-later inbox. Mid-scope user-approval gates MUST use **split-dispatch** (#954) unless this host later documents continue-by-agent-id.
? While a worker is still `in_progress` and the host exposes a live steer / re-prompt channel to that `agent_id`, the parent MAY steer mid-flight without a second spawn — that is the only retain-capable slice on this path today.
! After terminal exit, always dispatch a successor for remaining scope; do not invent re-attach semantics.
~ Stance: orchestration only (#3164).
