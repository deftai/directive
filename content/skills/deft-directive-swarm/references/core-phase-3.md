# Swarm core — Phase 3 Launch (host-neutral)

## Phase 3 — Launch

### Step 0: Populate the allocation-context consent token (#1378)

! Before dispatching ANY worker prompt -- swarm cohort OR solo -- the dispatcher MUST populate a `## Allocation context` section (the frozen schema defined in `templates/agent-prompt-preamble.md`, Story A of #1378) in every launched agent's dispatch envelope. Populate all five fields in order: `dispatch_kind` (`solo` | `swarm-cohort`), `allocation_plan_id`, `batching_rationale`, `cohort_vbriefs`, and `operator_approval_evidence`.

- ! For a **swarm cohort**, set `dispatch_kind: swarm-cohort` with a non-null `allocation_plan_id` (the Phase 0 allocation-plan snapshot path or the monitor session id) AND a non-null `batching_rationale` (the one-line rationale from the Phase 0 Step 4 allocation plan), and list the full cohort in `cohort_vbriefs`. This is the structured consent token the worker's build-skill Step 0 recognizes mechanically (#1378 Story B), so the worker processes its cohort without re-prompting the parent for batching approval mid-cohort.
- ! For a **solo dispatch**, set `dispatch_kind: solo` and list the single assigned xBRIEF in `cohort_vbriefs`; `allocation_plan_id` and `batching_rationale` MAY be null. Populating the section even for solo dispatches keeps the recognition surface uniform across every launch path.

⊗ Dispatch a worker prompt (cohort or solo) without a populated `## Allocation context` section -- an absent section forces the worker back onto the #1371 prose carve-out fallback and forfeits the deterministic consent-token recognition the structured section enables (#1378).

### Step 0.5: Consume the launch-manifest before dispatch (headless path, C2 / #1387)

! On the headless path, before dispatching ANY worker, the monitor consumes the **C2** launch-manifest emitted by `task swarm:launch` -- a JSON array of `{ "story_id": str, "vbrief_path": str, "worktree_path": str, "branch": str, "allocation_context": {...} }`, where each record's `allocation_context` is the #1378 token (its five fields `dispatch_kind`, `allocation_plan_id`, `batching_rationale`, `cohort_vbriefs`, `operator_approval_evidence`, per `templates/agent-prompt-preamble.md` § 2.5). Each record carries everything one worker dispatch needs.
! On the headless path the manifest's per-record `allocation_context` already satisfies Step 0 above -- the consent token is pre-populated, so the monitor READS it from the manifest rather than re-assembling the `## Allocation context` section by hand.
! **Manifest consumption is PREP ONLY.** It supplies the per-agent dispatch parameters (`worktree_path`, `branch`, `vbrief_path`, `allocation_context`); the spawn itself remains agent-driven via the runtime-detected launch path (Step 2a `start_agent` / Step 2d `spawn_subagent`). `task swarm:launch` emits the manifest and STOPS -- it does NOT spawn agents.
⊗ Treat the C2 launch-manifest as the spawn itself -- it is dispatch-prep / handoff data, not an agent-launch primitive. The actual dispatch still goes through the platform adapter (Step 2a / 2d per the runtime detection below); the manifest replaces the manual per-agent parameter assembly, NOT the spawn primitive.
? On the interactive path (no `task swarm:launch`, no manifest), the monitor assembles each dispatch's parameters from the Phase 1 assignment plus the Step 0 token by hand, as before.

### Step 1: Runtime Capability Detection

! Before selecting a launch method, probe the environment to determine the best available path.

1. ! **Probe for `start_agent` tool** — check the available tool set for `start_agent` (or equivalent agent-orchestration tool). Its presence indicates a Warp environment with native orchestration support.
2. ! **Probe for Warp environment** — if `start_agent` is not available, check for `WARP_*` environment variables (e.g. `WARP_TERMINAL_SESSION`, `WARP_IS_WARP_TERMINAL`). Their presence indicates Warp without orchestration.
3. ! **Probe for the Cursor `Task` tool** — when neither `start_agent` nor `WARP_*` is present, check the tool set for the Cursor `Task` sub-agent tool (dispatchable in the background via `run_in_background: true`) **with Cursor signals** (`CURSOR_COMPOSER` / `CURSOR_AGENT` or Cursor-only Task surface). Its presence indicates a Cursor environment with a **first-class Tier-1 sub-agent primitive** (#1877). Classify as `cursor-composer` for an interactive Composer session and `cursor-cloud-agent` for a Cursor cloud agent. Cursor is **Tier 1 → Approach 1** — do NOT let it fall through to `generic-terminal` / the Approach-3 blocking poll. ⊗ Classify from bare `Task` alone when Claude Code also exposes a similarly named tool (#3134).
4. ! **Probe for Claude Code** — when none of `start_agent`, `WARP_*`, or Cursor-classified `Task` is present, check for **Claude-unique** signals: the Claude Code `Agent` tool (or host-equivalent `CreateAgent` / `SubagentStart`) with background / `run_in_background: true`, and/or env `DEFT_PROBE_CLAUDE_CODE` / `DEFT_HAS_CLAUDE_AGENT` / `DEFT_AGENT_RUNTIME=claude-code` / `CLAUDECODE`. Classify as descriptor `claude-code`. Claude Code is **Tier 1 → Approach 1** (#3134) — do NOT misclassify as `cursor-composer` (bare `Task`) or fall through to `generic-terminal`. Engine env probe: `packages/core/src/review-monitor/tier-detection.ts` `probeMonitoringTier` (ordered after Cursor, before OpenClaw).
5. ! **Probe for the OpenClaw `sessions_spawn` tool** — when none of `start_agent`, `WARP_*`, Cursor, or Claude Code is present, check the tool set for OpenClaw `sessions_spawn` (optional `visible` flag). Its presence indicates an OpenClaw environment with a **first-class Tier-1 sub-agent primitive** (#2875). Classify as descriptor `openclaw`. OpenClaw is **Tier 1 → Approach 1** — do NOT misclassify it as `grok-build` (that uses `spawn_subagent`) or fall through to `generic-terminal`.
6. ! **Probe for Grok Bot** — when none of `start_agent`, `WARP_*`, Cursor, Claude Code, or OpenClaw is present, check for **Grok-Bot-unique** signals: question widgets, Task/executor/CloudAgent, routines, short main-chat beats, and/or env `DEFT_PROBE_GROK_BOT` / `DEFT_HAS_GROK_BOT_WIDGETS` / `DEFT_HAS_GROK_BOT_EXECUTOR` / `DEFT_AGENT_RUNTIME=grok-bot` / `GROK_BOT`. Classify as descriptor `grok-bot`. Grok Bot is **Tier 1 → Approach 1** (#4201) — do NOT misclassify as `grok-build` via bare `spawn_subagent` or as `cursor-composer` via bare `Task`. Probe **before** `spawn_subagent`. Engine env probe: `packages/core/src/review-monitor/tier-detection.ts` `probeMonitoringTier` (ordered after OpenClaw, before grok-build).
7. ! **Probe for `spawn_subagent` tool** — when none of `start_agent`, `WARP_*`, Cursor, Claude Code, OpenClaw `sessions_spawn`, or Grok Bot unique signals is present, check for `spawn_subagent` (Grok Build / non-Warp TUI launch adapter, #1342 slice 2). Its presence indicates the grok-build platform.
8. ! **Select launch path automatically** based on detection results — do NOT present static options:
   - **`start_agent` available** → Orchestrated launch (Step 2a) — preferred path, fully automated, no manual tab management
   - **`start_agent` unavailable, Warp detected** → Interactive Warp tabs (Step 2b) — full MCP, global rules, warm index; requires manual tab management
   - **Cursor `Task` tool available (no `start_agent`, no `WARP_*`)** → Cursor sub-agent launch (Step 2e) via the `Task` tool with `run_in_background: true` (Tier 1 / Approach 1) — keeps the monitor pane interactive; descriptor is `cursor-composer` (interactive) or `cursor-cloud-agent` (cloud)
   - **Claude Code available (no `start_agent`, no `WARP_*`, no Cursor classification)** → Claude Code launch (Step 2g) via `Agent` with `run_in_background: true` (Tier 1 / Approach 1) — descriptor is `claude-code` (#3134)
   - **OpenClaw `sessions_spawn` available (no `start_agent`, no `WARP_*`, no Cursor, no Claude Code)** → OpenClaw launch (Step 2f) via `sessions_spawn` (Tier 1 / Approach 1) — descriptor is `openclaw`
   - **Grok Bot unique signals available (no earlier Tier-1 primitive)** → Grok Bot launch (Step 2h) via Task/executor/CloudAgent (Tier 1 / Approach 1) — descriptor is `grok-bot` (#4201)
   - **`grok-build` (`spawn_subagent` available, no earlier Tier-1 primitive)** → Grok Build launch (Step 2d) — first-class non-Warp path
   - **No orchestration primitive detected** → `generic-terminal` degraded launch. Offer a **Serial self-execution downgrade** first: with explicit operator consent, the monitor may execute the prepared worker prompts itself one story at a time from the isolated worktrees. This preserves forward progress but is not true concurrent swarm execution.
9. ! **Return a stable platform descriptor** for downstream phases — one of `warp-orchestrated` (start_agent available), `warp-manual` (Warp without start_agent), `cursor-composer` (Cursor `Task` tool, interactive Composer), `cursor-cloud-agent` (Cursor `Task` tool, cloud agent), `claude-code` (Claude Code `Agent` / Claude-unique env, #3134), `openclaw` (`sessions_spawn` available, non-Warp, non-Cursor, non-Claude), `grok-bot` (Grok-Bot-unique signals, #4201), `grok-build` (spawn_subagent available after earlier primitives absent), or `generic-terminal` (no orchestration primitives). The detection matrix MUST include explicit absence checks for `start_agent`, `WARP_*`, Cursor, Claude Code, OpenClaw `sessions_spawn`, and Grok Bot unique signals so the descriptors are unambiguous. Phase 4 monitoring and Phase 6 sub-agent dispatch read this stable platform descriptor as a single source of truth instead of re-running detection per call.
10. ? **Cloud escape hatch** — use `oz agent run-cloud` (Step 2c) ONLY if the user explicitly requests cloud execution. Never default to cloud. (The Cursor `cursor-cloud-agent` descriptor above is distinct — it is a Cursor-native cloud agent detected via the `Task` tool, not the `oz` escape hatch.)

! In `generic-terminal` mode, if the operator declines serial self-execution, the manual terminal prompt-paste fallback remains available: the user can paste each generated prompt into any terminal or agent interface with access to the matching worktree. Surface the tradeoff clearly: manual paste preserves user control but requires tab/process management and is still not automated orchestration.

⊗ Do not describe this downgrade as a swarm, parallel execution, or concurrent orchestration. It is serial fallback execution: one story at a time, same gates, same isolated worktrees, lower coordination value (#1053).

⊗ Present static launch options (A/B/C) instead of detecting capabilities at runtime.
⊗ Offer Warp-specific launch paths (tabs, `start_agent`) when not running inside Warp — gate on `WARP_*` environment variables or `start_agent` tool presence.

### Step 1a: Worker Runtime and GitHub Auth Preflight (#1557)

! Before dispatching workers that will call `gh`, probe the **worker execution envelope** (not the parent monitor shell) for runtime mode and GitHub credential readiness. The read-only capability probe (`packages/core/src/platform/platform-capabilities.ts`, #1557a) and auth validator (`packages/core/src/intake/github-auth-modes.ts`, #1557b) MUST run from the same environment the worker will use.

1. ! **Classify runtime mode** — run the capability probe from each worker worktree (or dispatch target):

```
task verify:tools -- --json
```

The probe returns one of:

- `local-unsandboxed` — interactive local shell without Cursor native sandbox
- `cursor-native-sandbox` — Cursor native sandbox; effective UID 0 inside the worker is a sandbox identity, not host root
- `cloud-headless` — cloud or headless agent runtime without local host context

2. ! **Interpret Cursor sandbox UID remap** — when `sandbox_uid_remap` is true, effective UID 0 inside the worker is **remapped to the host user**, not real root. The probe sets `identity_kind` to `sandbox-remapped-local-user`. Do NOT present sandbox UID 0 or sandbox-root ownership as proof of host-root access — cwd ownership and `/proc/self/uid_map` are interpreted as a **sandbox view** of the host filesystem, not as the host running as root.

3. ! **Validate GitHub auth from the worker environment** — run auth validation from the same envelope:

```
task verify:gh-auth -- --json
```

Modes:

- `host-gh` (default for `local-unsandboxed` and `cursor-native-sandbox`) — requires `gh auth status` and a minimal GitHub API reachability check from the worker environment
- `injected-token` (default for `cloud-headless`) — requires `GH_TOKEN`, `GITHUB_TOKEN`, or `GH_ENTERPRISE_TOKEN`; **fails closed** with `missing_injected_token` when absent and never falls back to host `gh` credential store

4. ! **Surface remediation when parent host auth works but worker auth fails** — a common failure mode is the parent shell passing `gh auth status` while the worker sandbox cannot authenticate or reach GitHub. When validation reports `gh_auth_failed`, `api_unreachable`, or `repo_access_denied` in `cursor-native-sandbox`, surface these remediation paths to the operator (token values MUST NOT enter prompts or transcripts):

   - **Full-access execution** — run the GitHub step with full filesystem/network access so the worker shares the host `gh` credential store
   - **Trusted `gh` command allowlisting** — allowlist the trusted `gh` command path for the worker sandbox
   - **Injected-token handoff** — bind credentials at the invocation layer (`GH_TOKEN` / `GITHUB_TOKEN`) without pasting token values into dispatch envelopes

5. ! **Cloud/headless injected-token failure** — when runtime mode is `cloud-headless` and no injected token is available, validation fails with `missing_injected_token`. Do NOT assume host `gh` state is visible to cloud workers; re-dispatch with injected-token handoff or switch to a local interactive runtime.

⊗ Assume parent-shell `gh auth status` proves worker-environment readiness — always validate from the worker envelope (#1557).
⊗ Present sandbox UID 0 or sandbox-root cwd ownership as host-root access — UID remap means sandbox identity is a view of the host user (#1557).
⊗ Paste `GH_TOKEN` / `GITHUB_TOKEN` values into worker prompts or dispatch envelopes — use invocation-layer handoff only (#1557).

Cross-references: `packages/core/src/platform/platform-capabilities.ts` (#1557a), `packages/core/src/intake/github-auth-modes.ts` (#1557b), `docs/subagent-heartbeat.md` (runtime/auth troubleshooting). Refs #1557.

### Step 1b: Provider-neutral sub-agent routing (#1531)

! **Heterogeneous dispatch is provider-neutral.** Tiered / heterogeneous swarm topology is an opt-in extension of the platform adapter (#1342 / #1331), not a Grok Build-only path. When routing leaf workers, the monitor separates three concerns that MUST NOT be collapsed:

1. **Dispatch provider** — the runtime primitive or adapter that launches the child worker (e.g. `spawn_subagent`, `start_agent`, Cursor Composer/task agents, cloud agents, or a future adapter).
2. **Worker role** — what the child is permitted to do: leaf implementation, orchestrator/strategist, review-cycle monitor, conflict-resolution rebase, merge, or release gate. Role boundaries are load-bearing regardless of which dispatch provider is active.
3. **Model or agent selection** — the operator or harness policy that maps role plus xBRIEF attributes to a concrete agent/model. deft stays model-agnostic at dispatch time; the harness or provider backend resolves the concrete model.

! **Supported backend examples (none mandatory):** Composer-class coding agents, Grok Build `spawn_subagent` workers, Cursor/cloud agents, and future adapters are all first-class examples. No single backend is required — Grok Build is one implementation of provider-neutral routing, not the only target.

! **Implement-leaf pre-dispatch (#3228 / #3730):** Before the actual spawn primitive for an implement leaf (and before any re-dispatch), run `task swarm:pre-dispatch -- --scope-id <id> --target-id <worktree-or-branch>` — exit **0** only means spawn is allowed; exit **1** is `DENY_DUPLICATE_ACTIVE` (do not spawn). Begin on a filesystem worktree target also mkdirs `.deft-scratch/subagent-status/` so `verify:subagent-alive --require-agent` can return REDISPATCH_OK instead of exit 2. Depth + takeover: [`core-phase-4.md`](core-phase-4.md) Pre-dispatch deny gate; library #3143.

! **Arm the heartbeat path at dispatch (#3730):** Create the worker worktree's `.deft-scratch/subagent-status/` before spawn (mechanical on `swarm:launch` worktree-map and `swarm:pre-dispatch` begin). Instruct the worker to heartbeat per `templates/agent-prompt-preamble.md` § 10.5 and to commit early. Monitors MUST pass `--require-agent <agent-id>` on `task verify:subagent-alive`. ⊗ Put liveness on the C2 launch manifest or in `occupancy.json`.

! **Operator model routing (#1739):** the concrete per-role model lives in the gitignored, per-machine `.deft/routing.local.json`, keyed by `(dispatch_provider, worker_role)`. Record a decision with `task swarm:routing-set -- --role <role> (--model <slug> | --harness-default)`. `task swarm:launch` resolves the active provider's route and stamps `resolved_model` + `model_source` into each C2 manifest record. When `resolved_model` is non-null, the monitor MUST pass it as the **model argument of the actual dispatch primitive** (e.g. the Task tool's `model` field for a Cursor sub-agent) — stamping the manifest is prep; a recorded model that never reaches the spawn call is the bug #1739 closes. Run `task verify:routing` before dispatching a cohort (pre-dispatch hard gate; fails when a dispatched role is undecided) and `task verify:routing -- --advise` at session start (non-blocking disclosure). For harness-bound providers (e.g. `grok`) only `--harness-default` is recordable and `resolved_model` stays null.

~ **DEPRECATED — Policy surface (#1531a / #1891):** `plan.policy.swarmSubagentBackend` (set via `task policy:subagent-backend`) was the previous mechanism for recording the operator's preferred coding sub-agent provider. It is superseded by per-role operator model routing above (#1739). The enum and associated `task policy:subagent-backend(s)` tasks remain functional but deprecated; hard deletion is tracked by #1860. Use `task swarm:routing-set` instead.

! **Role boundaries for cheaper leaf agents:** Cheaper, high-context leaf agents are appropriate for **leaf implementation** work in isolated worktrees when xBRIEF scope is tight and gates (`task check`, Greptile review cycle) hold. The following roles MUST remain on strong, review-capable agents regardless of backend availability:

- orchestration and cohort monitoring (the monitor / strategist conversation)
- review-cycle decisions (fix-or-defer judgment, P0/P1 triage)
- conflict-resolution rebase during merge cascades
- merge cascade execution and protected-issue gates
- release gates (Phase 5->6 version bump approval, `task release` surfaces)

⊗ Treat Grok Build `spawn_subagent` as the only supported sub-agent backend in swarm guidance — provider-neutral routing explicitly includes Composer-class coding agents, Cursor/cloud agents, and future adapters (#1531).
⊗ Route orchestration, review-cycle decisions, conflict-resolution rebase, merge cascade, or release gates to cheaper leaf agents — irreversible-damage surfaces stay on strong/review-capable agents (#1531).

Cross-references: `packages/core/src/swarm/routing.ts` (`SWARM_WORKER_ROLES`), `templates/agent-prompt-preamble.md` (dispatch envelope metadata), `docs/the-harness-is-everything.md` (orchestrator -> commodity-coder layering). Refs #1531.


### Retained vs one-shot dispatch mode (#3158)

! After platform detection (Step 1) and before spawn, classify the host as **retain-capable** or **one-shot** using the loaded host adapter's retained / continue-by-id note (and `swarm/swarm.md` § Retained addressable sub-agents).

| Classification | Dispatch posture | Mid-scope user-approval gate |
|----------------|------------------|------------------------------|
| **retain-capable** | Prefer **retained-child** when the unit of work needs iterative refinement, standing expertise, or mid-flight steer; keep persistent `agent_id` / session handle | Single dispatch MAY include a mid-scope gate — parent **re-messages** the same live child (message-later / steer-mid-flight). Do not force a second full dispatch solely for the gate. |
| **one-shot** (default when adapter does not document retain) | **dispatch-and-collect** — closed envelope; worker terminal on tool-loop exit | **Split-dispatch** remains mandatory (#954 / preamble §10): Scope A completes → user approves → Scope B as a new dispatch |

! Record the mode in monitor notes when non-default (e.g. `dispatch_mode: retained-child` + retained `agent_id`) so Phase 4 does not spawn a duplicate on the same worktree while a retained child is still addressable.
! Stance (#3164): retention is orchestration only — ⊗ mid-run rewrite of managed AGENTS, pinned skills, or policy via retained messaging.
~ Topology bounds for retained A2A messaging: obey landed nuclear-family bounds in swarm/swarm.md § Communication Topology (#3155).

⊗ Treat every host as retain-capable without adapter evidence.
⊗ Spawn a replacement on a worktree that still has a live retained child the parent can re-message (#261 / #263 duplicate-agent class).

### Orchestrator dispatch doctrine (#1880)

! **Deliberate model routing before ANY dispatch:** Before launching ANY worker in this phase (cohort OR solo), run `task verify:routing` and resolve each `(dispatch_provider, worker_role)` via `task swarm:routing-set` / `.deft/routing.local.json`. Populate `## Worker metadata` per `templates/agent-prompt-preamble.md` §2.6 and pass `resolved_model` into the actual dispatch primitive when non-null. Never silently inherit the monitor's model. Deterministic gate enforcement is #1877; this rule is behavioral doctrine (#1880).

! **Cursor ownership split (#2797 / #2893):** A Cursor `Task` implementation leaf MUST NOT launch a nested Cursor `Task` review-monitor: nested Task (leaf spawning leaf) is unsupported/unreliable. For Cursor, a `drive-to: merge-ready` leaf owns a blocking dual-invoke `pr:watch` (`deft pr:watch <N>` first, else `task deft:pr:watch -- <N>`) in its own process, or the dispatcher uses `stop-at: pr-open` and itself launches a sibling monitor and dual-invoke `review-monitor:register`. A leaf that backgrounds `pr:watch` and exits MUST NOT claim monitoring is active; this is a review-monitor-gate failure.

! **Worker-owns-lifecycle (Gap C):** Every implementation-worker dispatch prompt MUST declare the unit-of-work boundary: `stop-at: pr-open` OR `drive-to: merge-ready` (default for story xBRIEF work). Workers scoped `drive-to: merge-ready` own pre-PR, push, PR open, Greptile review-cycle poll/fix, and the #1259 Step 6 fail-closed exit as ONE dispatch — following `skills/deft-directive-review-cycle/SKILL.md` monitoring tiers (Grok Build / Cursor / Claude Code leaves that cannot nest block on `pr:watch` in-process and MUST NOT spawn a child poller) (#4130). The monitor MUST NOT plan a separate post-PR review leaf for a worker already scoped merge-ready.

! **Envelope selection at launch (#3153):** Choose the unit-of-work boundary using the Phase 0 **Envelope selection SLA** decision tree (`references/core-phase-0.md`) before spawn. Default remains `drive-to: merge-ready`. When the tree recommends or requires `stop-at: pr-open` (capacity stall, wall-clock budget, large multi-gate, host nested-monitor limits), the monitor MUST pre-plan the **partner merge-path owner** (review-cycle babysit / Approach 1 review-monitor) and dispatch or retain that owner when the implement leaf hands back — same turn as ground-truth of PR open, not improvised thin-DONE recovery. Cohort through-merge still means land on master; only mile ownership splits.

! **Deliberate `stop-at: pr-open` is not silent Gap C handback:** Silent PR-open handback for a worker whose envelope already said `drive-to: merge-ready` remains **forbidden**. A **pre-declared** `stop-at: pr-open` plus an immediately owned review-cycle babysit path is the supported alternative under the #3153 SLA. Partner contract depth: `skills/deft-directive-review-cycle/SKILL.md` § Partner merge-path when implement stops at PR-open.

! **Post-merge scope lifecycle (#2321 / Gap C / #3429):** Workers scoped `stop-at: pr-open` MUST NOT run `task scope:complete` before exit — their activation checkpoint rides into master on merge. The monitor (or Phase 6 `task swarm:finalize-cohort` / `task swarm:complete-cohort` on the headless path) MUST run `task scope:complete` or `task scope:cancel` for each shipped story xBRIEF after its PR merges. Workers scoped `drive-to: merge-ready` (or `drive-to: merge`) MUST include `task scope:complete` on their active xBRIEF as part of the same unit of work (after merge when appropriate). After merge of issue `#N`, `task verify:orphan-active -- --issue N` must be exit 0 before `DONE`; exit 1 shipped prints `task scope:complete -- <path>`; unresolved lookup prints a retry remediation.

! **Background / independent dispatch (Gap D):** Dispatch implementation, fix, and review-cycle workers independently / in the background when the platform supports it. On Cursor, use the Task tool background path (`run_in_background: true`); on Claude Code, use the `Agent` tool with `run_in_background: true` (or host equivalent) (#3134); on OpenClaw, use `sessions_spawn` with the host's non-blocking / background session flags so the monitor conversation stays interactive. Foreground dispatch is for short tasks (<~3 min) only.

⊗ Hand back at PR-open and re-dispatch separate review-monitor or fix leaf agents for a worker whose envelope scoped `drive-to: merge-ready` (#1880 Gap C).

⊗ Dispatch `stop-at: pr-open` without a named review-cycle babysit / merge-path owner plan — that drops the merge mile (#3153).

⊗ Foreground/blocking dispatch for long-running implementation, fix, or review-cycle workers when background dispatch is available (#1880 Gap D).


### Step 2 — Host launch adapters

! After runtime detection (Step 1), load **one** host adapter from the route table in `SKILL.md` and follow its Step 2 launch rules.
- Warp orchestrated / manual → `references/host-warp.md`
- Cursor → `references/host-cursor.md`
- Claude Code → `references/host-claude-code.md`
- OpenClaw → `references/host-openclaw.md`
- Grok Bot → `references/host-grokbot.md`
- Grok Build → `references/host-grok-build.md`
- generic-terminal / cloud escape → `references/host-generic.md`

⊗ Load every host adapter “just in case.” Unused host rules stay out of context (#2928).
