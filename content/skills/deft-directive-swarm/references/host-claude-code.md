# Host adapter: Claude Code

Legend (RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

Descriptor: `claude-code` (Claude Code backgroundable sub-agent primitive — commonly the `Agent` tool with `run_in_background: true`). Tier 1 → Approach 1 (#3134).

Register primitive: `claude-agent` (`task review-monitor:register -- --platform-primitive claude-agent`).

Load this file only after detect selects Claude Code. Do not load other host adapters (#2928).

## Detection spike (ordered matrix placement) — #3134

! Claude Code MUST be classified with **Claude-unique** signals. ⊗ Classify Claude Code from bare `Task` alone — that misclassifies as `cursor-composer` (or vice versa).

### Skill-side ordered probe (tool set + env)

Probe order (must match engine `probeMonitoringTier` / `resolveDispatchProvider`):

1. `start_agent` → `warp-orchestrated`
2. `WARP_*` → `warp-manual`
3. Cursor `Task` **with Cursor signals** (`CURSOR_COMPOSER` / `CURSOR_AGENT` or Cursor-only Task surface) → `cursor-composer` / `cursor-cloud-agent`
4. **Claude Code** (this descriptor) — see unique signals below → `claude-code`
5. OpenClaw `sessions_spawn` → `openclaw`
6. `spawn_subagent` → `grok-build`
7. else → `generic-terminal` (Tier 3)

### Claude-unique signals (any one is sufficient when earlier probes are absent)

| Signal | Notes |
|--------|--------|
| Tool fingerprint | `Agent` (or host-equivalent `CreateAgent` / `SubagentStart`) with background / `run_in_background: true` — **not** bare `Task` alone |
| `DEFT_PROBE_CLAUDE_CODE` / `DEFT_HAS_CLAUDE_AGENT` | Explicit framework probe / override |
| `DEFT_AGENT_RUNTIME=claude-code` (or `claude`) | Explicit runtime stamp |
| `CLAUDECODE` / `CLAUDE_CODE` | Anthropic sets `CLAUDECODE=1` in Claude Code tool/hook/IDE-terminal subprocesses |

! When both Cursor and Claude signals could appear, **Cursor probes win** (earlier in the chain) so Claude never steals a Cursor session.

! Engine env probe is env-centric (same pattern as Cursor `CURSOR_*`); skill prose names the tool fingerprint for agents that can see the tool set. Do not widen that skew further.

## Launch — Step 2g

### Step 2g: Claude Code Launch (`Agent` / background sub-agent available) — #3134

! When the platform descriptor is `claude-code` (Claude-unique signals detected; no `start_agent`, no `WARP_*`, no Cursor `CURSOR_*` / Cursor-only Task classification), dispatch each worker via the Claude Code backgroundable sub-agent primitive (commonly `Agent` with `run_in_background: true`) with:

1. The canonical `templates/agent-prompt-preamble.md` content as the preamble (AGENTS.md read mandate, #810 xBRIEF gate, #798 PowerShell UTF-8, pre-PR + review-cycle mandates).
2. The standard worktree prompt (STEP 1-6 from the Prompt Template in `references/core-ops.md`).
3. The worktree path set to the agent's isolated git worktree.
4. ! **`run_in_background: true` (or host equivalent)** for any worker or poller whose loop runs longer than a short task (~3 min) — implementation, fix, and review-cycle workers — so the monitor conversation pane stays interactive (#1880 Gap D). The parent is notified on completion.
5. ! **Deliberate model routing (#1739):** resolve `(dispatch_provider=claude, worker_role)` via `task verify:routing` / `task swarm:routing-set` and pass `resolved_model` into the spawn when non-null — stamping the C2 manifest is prep; the recorded model MUST reach the actual spawn call.

~ This is the first-class Claude Code path. It is **Tier 1 → Approach 1** (a backgroundable sub-agent primitive), equivalent in tier to `start_agent` / Cursor `Task` / OpenClaw `sessions_spawn` / `spawn_subagent`; it MUST NOT be misclassified as `cursor-composer` or downgraded to a `generic-terminal` blocking poll.

! Claude Code pollers whose loop runs > ~3 min MUST honour the sub-agent heartbeat contract (`docs/subagent-heartbeat.md`, #1166), same as the Cursor / `spawn_subagent` paths.

## Nested Agent boundary

! Claude Code ownership split (analogue of Cursor #2797 / #2893): An implementation leaf MUST NOT nested-spawn a second-level review-monitor via `Agent` when nested Agent is unsupported or unreliable on the host. Prefer either:

- (a) a `drive-to: merge-ready` leaf that owns a blocking dual-invoke `pr:watch` (`deft pr:watch` then `task deft:pr:watch`) in its own process, or
- (b) `stop-at: pr-open` with the dispatcher launching a sibling monitor and registering it via dual-invoke `review-monitor:register -- --platform-primitive claude-agent`.

A leaf that backgrounds a monitor and exits MUST NOT claim monitoring is active.

## Babysit / review-monitor

! Babysit / PR shepherd on Claude Code is **Approach 1** via backgrounded `Agent` (`skills/deft-directive-review-cycle/SKILL.md`). Register with `--platform-primitive claude-agent`.

! Long review-monitor ownership (>~3 min) MUST NOT block the parent Claude Code session — background `Agent` + parent yield (#1880 Gap D); heartbeats per #1166.

⊗ Fall through to Approach 3 blocking `sleep` poll when Claude Code sub-agent spawn is available (#3134).
⊗ Misclassify Claude Code as `cursor-composer` because a historical surface also exposed a tool named `Task` (#3134).

## Monitor / completion channel

! Completion is host completion / background-task notify for the Claude Code `Agent` path. Do not poll via Grok Build `get_command_or_subagent_output` or OpenClaw `subagent_announce` unless those primitives are actually present under a different descriptor.

! Long pollers MUST honour on-disk heartbeats (`docs/subagent-heartbeat.md`, #1166).

! Pre-spawn verification and Duplicate-Agent rules in `references/core-phase-4.md` apply.

## Phase handoff (see also core #2934)

! After coding cohort complete, same-turn next-phase tool dispatch or explicit terminal status — see `references/core-phase-5-6.md` and the thin SKILL MUST block. ⊗ End the turn with only narrative “I will spawn…”.
