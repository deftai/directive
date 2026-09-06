# Host adapter: Grok Bot

Legend (RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

Descriptor: `grok-bot`. Grok Bot is **not** Grok Build. Register primitive: `grok-bot-executor` (`task review-monitor:register -- --platform-primitive grok-bot-executor`).

Load this file only after detect selects Grok Bot. Do not load other host adapters (#2928).

## Detection spike (ordered matrix placement) — #4201

! Grok Bot MUST be classified with **Grok-Bot-unique** signals. Probe those signals **before** probe 7 (`spawn_subagent` → `grok-build`). Same class as Claude-before-Task (#3134) and OpenClaw-before-grok-build (#2875).

⊗ Classify Grok Bot from bare `spawn_subagent` alone — that misclassifies as `grok-build`.
⊗ Classify Grok Bot from bare `Task` alone — that misclassifies as `cursor-composer`.

### Skill-side ordered probe (tool set + env)

Probe order (must match engine `probeMonitoringTier` / `resolveDispatchProvider`):

1. `start_agent` → `warp-orchestrated`
2. `WARP_*` → `warp-manual`
3. Cursor `Task` **with Cursor signals** (`CURSOR_COMPOSER` / `CURSOR_AGENT` or Cursor-only Task surface) → `cursor-composer` / `cursor-cloud-agent`
4. Claude Code (Claude-unique signals) → `claude-code`
5. OpenClaw `sessions_spawn` → `openclaw`
6. **Grok Bot** (this descriptor) — unique signals below → `grok-bot`
7. `spawn_subagent` → `grok-build`
8. else → `generic-terminal` (Tier 3)

### Grok-Bot-unique signals (any one is sufficient when earlier probes are absent)

| Signal | Notes |
|--------|--------|
| Question widgets | Operator-gate UI (`ask_user_question` / host widgets). Phase 0 / mid-scope / dual-stop map here. |
| Task / executor / CloudAgent | Worker spawn surface — **not** Cursor `Task` (requires `CURSOR_*`) and **not** Grok Build `spawn_subagent` |
| Routines | Grok Bot scheduled / routine surface |
| Short main-chat beats | Parent consolidate on the main chat (not a subagent pane) |
| `DEFT_PROBE_GROK_BOT` / `DEFT_HAS_GROK_BOT_WIDGETS` / `DEFT_HAS_GROK_BOT_EXECUTOR` | Explicit framework probe / override |
| `DEFT_AGENT_RUNTIME=grok-bot` (or `grokbot`) | Explicit runtime stamp |
| `GROK_BOT` | Host stamp |

! When both Cursor and Grok Bot signals could appear, **Cursor probes win** (earlier in the chain).
! When both OpenClaw and Grok Bot signals could appear, **OpenClaw probes win** (earlier in the chain).
! When Grok Bot unique signals are present **and** `spawn_subagent` is also present, **Grok Bot wins**. That is the misclassification this adapter exists to close.

! Engine env probe is env-centric (same pattern as Claude `CLAUDECODE` / Cursor `CURSOR_*`); skill prose names the tool fingerprint for agents that can see the tool set.

## Operator gates — widgets keep Discuss and Back (#1470 / #1563)

! Phase 0 / mid-scope / dual-stop operator gates on this host MUST use question widgets (or a numbered chat menu) that **visibly preserve** canonical numbered options, with the final two labels `Discuss` and `Back` in that order.

! Widget labels MUST include the canonical number (for example `1. Accept`). Agents accept fallback chat replies only when they match the displayed number or the exact displayed option text.

⊗ Drop `Discuss` / `Back` because the host widget UI has an `Other` affordance or alphabetic shortcuts — those do not satisfy [`../../../contracts/deterministic-questions.md`](../../../contracts/deterministic-questions.md) Host-UI portability (#1563).

## Consumer facade — three verbs (Phases 0–6 stay internal)

Expose **propose / launch / status**. Keep swarm Phases 0–6 as lazy-loaded depth. Do not load all host adapters just in case (#2928).

| Verb | Operator meaning | Depth (load on demand) |
|------|------------------|------------------------|
| **propose** | Name the cohort (stories / xBRIEFs), file-overlap, worktree plan. Does not spawn. | [`core-phase-0.md`](core-phase-0.md) then [`core-phase-1-2.md`](core-phase-1-2.md) |
| **launch** | Emit the C2 launch-manifest (`task swarm:launch`) then spawn via this adapter. Worktree isolation MUST before parallel spawn. | [`core-phase-3.md`](core-phase-3.md) + this file |
| **status** | Heartbeats, worktree git, PR/review state. Parent consolidate as **short main-chat beats**. | [`core-phase-4.md`](core-phase-4.md) |

! Human decision: one clear ask, then stop. Do not auto-dispatch arcs without operator consent (#3578 / #1702).

## Thin skill pack (Grok Bot consumers)

Discovery set — **thin routers only**. Each item points at the existing Directive skill. ⊗ Put normative contract bodies in these routers.

| Router | Points at |
|--------|-----------|
| setup | `skills/deft-directive-setup/SKILL.md` |
| xbrief | `skills/deft-directive-xbrief/SKILL.md` |
| triage | `skills/deft-directive-triage/SKILL.md` (work selection: `plan-sequence:current` then `triage:queue`) |
| swarm (facade) | this adapter + `skills/deft-directive-swarm/SKILL.md` (propose / launch / status above) |
| build | `skills/deft-directive-build/SKILL.md` |
| **arc** | Companion **#4202** — do not implement the design-critique thin arc router here |

## Doctor / cold-start (one happy path)

! One narratable path: `npx @deftai/directive doctor` → follow its one `Next command:` → optional agent-driven setup (`skills/deft-directive-setup/SKILL.md`).

! Hide package-manager and offline forks behind doctor. Do not invent a second Grok Bot install ladder. Category: Grok Bot is a **coding host**; Directive remains the repo practice layer (`docs/CATEGORY.md`).

## GitHub connector preference

! Prefer GitHub MCP / connector tools when the host exposes them. Fall back to `gh` / `ghx` (REST) when the connector is absent.

⊗ Invent a Grok-Bot-only GitHub client. The SCM contract stays `content/scm/github.md`.

## Launch — Step 2h

### Step 2h: Grok Bot Launch (unique signals detected) — #4201

! When the platform descriptor is `grok-bot` (Grok-Bot-unique signals detected; no `start_agent`, no `WARP_*`, no Cursor classification, no Claude Code, no OpenClaw `sessions_spawn`), dispatch each **leaf worker** via Task / executor / CloudAgent with:

1. The canonical `templates/agent-prompt-preamble.md` content as the preamble.
2. The standard worktree prompt (STEP 1–6 from the Prompt Template in `references/core-ops.md`).
3. The worktree path set to the agent's isolated git worktree.
4. ! **Worktree isolation MUST before parallel spawn** (Phase 2 / #4066). Fail loud if a parallel cohort would share the repo root.
5. ! **Background / non-blocking spawn** for any worker or poller whose loop runs longer than a short task (~3 min) so the parent main-chat stays interactive (#1880 Gap D).
6. ! **Deliberate model routing (#1739):** resolve `(dispatch_provider=grok-bot, worker_role)` via `task verify:routing` / `task swarm:routing-set`. Grok Bot is harness-bound — record `--harness-default`; `resolved_model` stays null.

! Parent consolidate → **short main-chat beats** (not a second worker pane dump). Human decision → one clear ask then stop.

~ This is the first-class Grok Bot path. It is **Tier 1 → Approach 1**. It MUST NOT be misclassified as `grok-build` via bare `spawn_subagent` or as `cursor-composer` via bare `Task`.

! Long pollers MUST honour the sub-agent heartbeat contract (`docs/subagent-heartbeat.md`, #1166).

## Nested executor boundary

! Nested Task / executor / CloudAgent (implementation leaf spawning leaf) is unsupported for an Approach 1 review-monitor. A Grok Bot **implementation leaf** MUST NOT nested-spawn a second-level review-monitor. Prefer either:

- (a) a `drive-to: merge-ready` leaf that owns a blocking dual-invoke `pr:watch` (`deft pr:watch` then `task deft:pr:watch`) in its own process, or
- (b) `stop-at: pr-open` with the dispatcher (parent that owns the executor primitive) launching a sibling monitor and registering it via dual-invoke `review-monitor:register -- --platform-primitive grok-bot-executor`.

! Top-level parents/orchestrators that own the executor primitive MAY Approach-1 background a review-monitor.

⊗ An implementation leaf backgrounds a nested executor poller and exits claiming monitoring is active.

If the leaf needs another agent, it stops and reports `BLOCKED`. The parent owns the next spawn.

## Babysit / review-monitor

! Babysit / PR shepherd on Grok Bot is **Approach 1** via executor / CloudAgent (`skills/deft-directive-review-cycle/SKILL.md`). Register with `--platform-primitive grok-bot-executor`.

! Long review-monitor ownership (>~3 min) MUST NOT block the parent main chat — background executor + parent yield (#1880 Gap D); heartbeats per #1166.

⊗ Fall through to Approach 3 blocking `sleep` poll when Grok Bot executor spawn is available.
⊗ Misclassify Grok Bot as `grok-build` because `spawn_subagent` is also on the tool list (#4201).
⊗ Misclassify Grok Bot as `cursor-composer` because a Task-like tool exists without Cursor signals (#4201).

## Monitor / completion channel

! Completion is host completion / parent main-chat announce for the Grok Bot executor path. Do not poll via Grok Build `get_command_or_subagent_output` unless that primitive is actually present under descriptor `grok-build`.

! Long pollers MUST honour on-disk heartbeats (`docs/subagent-heartbeat.md`, #1166).

! Pre-spawn verification and Duplicate-Agent rules in `references/core-phase-4.md` apply.

## Retained / continue-by-id (#3158)

! **Default one-shot after executor completion:** Grok Bot executor leaves that exit are typically terminal — prefer **split-dispatch** for mid-scope user-approval gates (#954) unless the host documents continue/resume of the same agent id.
? When the host supports re-attach or re-prompt of a still-live executor with context intact, treat as **retain-capable** for message-later / steer-mid-flight.
! Nested-executor boundary above still forbids implementation leaves from retaining a second-level review-monitor.
~ Stance: orchestration only (#3164). Grok Bot stays the coding host / CoS cockpit. Directive does not own Slack/calendar/bot roster orchestration.

## Phase handoff (see also core #2934)

! After coding cohort complete, same-turn next-phase tool dispatch or explicit terminal status — see `references/core-phase-5-6.md` and the thin SKILL MUST block. ⊗ End the turn with only narrative “I will spawn…”.
