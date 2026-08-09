# Host adapter: Cursor

Legend (RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

Descriptor: `cursor-composer` or `cursor-cloud-agent` (Cursor `Task` tool).

Load this file only after detect selects Cursor. Do not load other host adapters.

! **Windows + Cursor Task-tool console windows (#2563):** Local Cursor Task swarms on Windows are first-class. Shipped mitigations (do not regress): `windowsHide: true` (CREATE_NO_WINDOW) on engine/spawn paths, and warm-dist skip via `tasks/ts-build-fresh.cjs` so `engine:_ts-build` does not cold-rebuild when `packages/cli/dist` is current. See `templates/agent-prompt-preamble.md` §3.8. ! Default to **local** Task workers on Windows (not cloud-for-Windows). Parallel cohorts are allowed — do not force concurrency=1 for #2563. ⊗ Drop or weaken those mitigations without a replacement that keeps Windows local swarm workable.

### Step 2e: Cursor Launch (Task tool available) — #1877

! When the platform descriptor is `cursor-composer` or `cursor-cloud-agent` (Cursor `Task` tool detected with Cursor signals, no `start_agent`, no `WARP_*`, no Claude Code classification, no OpenClaw `sessions_spawn`, no `spawn_subagent`), dispatch each worker via the Cursor `Task` tool with:
1. The canonical `templates/agent-prompt-preamble.md` content as the preamble (AGENTS.md read mandate, #810 xBRIEF gate, #798 PowerShell UTF-8, pre-PR + review-cycle mandates).
2. The standard worktree prompt (STEP 1-6 from the Prompt Template below).
3. The worktree path set to the agent's isolated git worktree.
4. ! **`run_in_background: true`** for any worker or poller whose loop runs longer than a short task (~3 min) — implementation, fix, and review-cycle workers — so the monitor conversation pane stays interactive (#1880 Gap D). The parent is notified on completion.
5. ! **Deliberate model routing (#1739):** pass the route's `resolved_model` (when non-null) as the Task tool's `model` argument — stamping the C2 manifest is prep; the recorded model MUST reach the actual spawn call.

~ This is the first-class Cursor path. It is **Tier 1 → Approach 1** (a backgroundable sub-agent primitive), equivalent in tier to `start_agent` / `spawn_subagent` / OpenClaw `sessions_spawn`; it MUST NOT be downgraded to a `generic-terminal` blocking poll. Cursor pollers whose loop runs > ~3 min MUST honour the sub-agent heartbeat contract (`docs/subagent-heartbeat.md`, #1166), same as the `spawn_subagent` path.


## Nested Task boundary

! Cursor ownership split (#2797 / #2893) lives in `references/core-phase-3.md` Orchestrator dispatch doctrine — a Cursor `Task` implementation leaf MUST NOT nested-spawn a review-monitor Task.

## Retained / continue-by-id (#3158)

! **Default one-shot after Task completion:** Cursor `Task` leaves that exit their tool loop are typically terminal — prefer **split-dispatch** for mid-scope user-approval gates (#954) unless the host surfaces an explicit continue/resume-by-agent-id for that Task.
? When the host documents resume of the same Task / agent id with context intact, treat as **retain-capable** for message-later / steer-mid-flight and re-message instead of a full second Task spawn.
! Liveness failures (`task verify:subagent-alive` exit `1` / `REDISPATCH_OK`) still authorize replacement re-dispatch — retain does not override the false-alive contract (#2824).
~ Stance: orchestration only (#3164).
