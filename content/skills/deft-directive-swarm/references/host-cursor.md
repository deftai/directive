# Host adapter: Cursor

Legend (RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

Descriptor: `cursor-composer` or `cursor-cloud-agent`. Detect still probes the Cursor `Task` tool. Local implement launch is dest-placing Cursor, not dest-binding Task (#4295).

Load this file only after detect selects Cursor. Do not load other host adapters.

! **Windows + Cursor Task-tool console windows (#2563):** Local dest-placing Cursor swarms on Windows are first-class. Shipped mitigations (do not regress): `windowsHide: true` (CREATE_NO_WINDOW) on engine/spawn paths, and warm-dist skip via `tasks/ts-build-fresh.cjs` so `engine:_ts-build` does not cold-rebuild when `packages/cli/dist` is current. See `templates/agent-prompt-preamble.md` §3.8. ! Default to **local dest-placing Cursor** on Windows (not cloud-for-Windows; not dest-binding Task). Parallel cohorts are allowed — do not force concurrency=1 for #2563. ⊗ Drop or weaken those mitigations without a replacement that keeps Windows local swarm workable.

### Step 2e: Cursor Launch — dest-placing, not Task dest (#4295 / #1877)

Cursor `Task` has no local dest field. Extra keys (`isolation`, `worktree_path`, `cwd`) are stripped before `preToolUse`. Hook `updated_input` dest fields do not re-root Task. A prompt token may select a trusted reservation record; it does not move the child. Comment 5611146439 stands.

⊗ Dispatch local implement via Cursor `Task` dest keys, a worktree map in the prompt, or inherited primary cwd.
⊗ Treat a prompt token as moving the child onto a worktree.

! **Local implement (required):** dest-placing Cursor. The child process or window folder is an already-created linked worktree *before* it can write.

Two local hatches, in this order:

1. **Nursery inherit (interactive dest-rooted window).** Open Composer on the reserved linked worktree (not primary). One Task child may inherit that payload root: consult treats the window as dest, mints a unique reservation, and admits the child through `occupancy:grant`. While that grant is live, parent product writes in that tree are denied. A second Task in the same window is reservation-conflict. Nested Task from a dest-rooted session is still dest-missing unless *this* window is the dest. Nursery child `workspace_roots` equal the parent window.
2. **Headless dest-rooted SDK.** `@cursor/sdk` `Agent.create({ local: { cwd: <reserved-worktree> } })` with `Agent.resume` / `agent.send` as the retain-capable sibling. Reservation before exec. Process-handle liveness (not parent-cwd `verify:subagent-alive`). Doctor check `cursor-sdk-auth` for the separate SDK login (`CURSOR_API_KEY`). The leaf implements in that session and does not nested-Task.

Cursor Task dest-missing deny copy is CURSOR_TASK_SPAWN_CLASS_RECOVERY in packages/core/src/hooks/dispatcher.ts. It names these hatches as payload-root and does not advertise Task dest keys (#4362).

! Create `<worktree>/.deft-scratch/subagent-status/` before spawn if `swarm:launch` / `swarm:pre-dispatch` did not already (#3730). Include preamble § 10.5 (heartbeat + commit early). Headless SDK liveness is the process handle; scratch heartbeats remain for dest-rooted Composer sessions.
! Include the canonical `templates/agent-prompt-preamble.md` content as the preamble.
! Include the standard worktree prompt (STEP 1-6 from the Prompt Template).
! **`run_in_background: true`** (or SDK async create) for any worker or poller whose loop runs longer than a short task (~3 min).
! **Deliberate model routing (#1739):** pass the route `resolved_model` (when non-null) into the actual spawn primitive.

~ Cursor stays **Tier 1 → Approach 1**. Do not downgrade to `generic-terminal`. Spawn available means dest-placing dispatch exists, not Task-present (#3032 / #4295).
? Cloud `Task` (`environment: "cloud"`) is the #4294 dest-consult carve-out. Complementary. Do not treat cloud as local dest-proof. Do not duplicate that hook slice here.

### Fence-in-place (parked)

Fence-in-place (bind a parent-cwd Task and rewrite writes into `.deft-scratch/worktrees/`) stays parked until measured:

- Shell `updated_input.cwd`
- Write/ApplyPatch path rewrite
- Composer visibility of gitignored `.deft-scratch/worktrees/`

The write gate does not cover Shell or MCP. Relative targets resolve against hook cwd. Bind is specifiable later (`EXACT_LIFECYCLE_VERBS` + identity rewrite; adding `spawn:bind`). ⊗ Sequence `best-of-n-runner` ahead of nursery. ⊗ Primary-window writes through `.deft-scratch/worktrees/`.

## Nested Task boundary

! Cursor ownership split (#2797 / #2893) lives in `references/core-phase-3.md` Orchestrator dispatch doctrine — a Cursor implement leaf MUST NOT nested-spawn a review-monitor Task. Dest-rooted SDK / nursery leaves implement in-session.

## Retained / continue-by-id (#3158)

! **Default one-shot after Task completion:** Cursor `Task` leaves that exit their tool loop are typically terminal — prefer **split-dispatch** for mid-scope user-approval gates (#954) unless the host surfaces an explicit continue/resume-by-agent-id for that Task.
? `@cursor/sdk` `Agent.resume` / `agent.send` is retain-capable for the headless dest-rooted path.
! Liveness failures (`task verify:subagent-alive` exit `1` / `REDISPATCH_OK`) still authorize replacement re-dispatch for Composer heartbeats — retain does not override the false-alive contract (#2824). Headless SDK replacement keys on the process handle.
~ Stance: orchestration only (#3164).
