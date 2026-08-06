# Host adapter: OpenClaw

Legend (RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

Descriptor: `openclaw` (`sessions_spawn`). Tier 1 → Approach 1 (#2875 / #2874).

Load this file only after detect selects OpenClaw. Do not load other host adapters (#2928).

Operator host guide: [`../../docs/openclaw-agent-host.md`](../../docs/openclaw-agent-host.md). Skill text remains source of truth for dispatch rules.

Host lifecycle duty list (all hosts): [`../../../contracts/host-lifecycle-duties.md`](../../../contracts/host-lifecycle-duties.md) (#2968 A3).

## Cold-start — Directive load on OpenClaw (#2968 / A7)

OpenClaw is a **session-first** host: the agent may wake in a workspace home where `available_skills` is **not** the Directive Skills Index. IDE deposit rails do not run automatically.

! When user intent is **Deft-shaped** (skills, review, triage, swarm, build, pre-PR, article-review, xBRIEF / consumer-repo Directive work, or equivalent process verbs), complete cold-start **before** freestyle host tools:

1. ! **Resolve project root.** Prefer the git worktree or repo that holds `AGENTS.md` / `.deft/core/` / `xbrief/` (framework checkout: repo root with `content/`). On WSL dual-path setups, use the path that is source of truth for that checkout — do not freestyle from a sibling home folder.
2. ! **Load Skills Index before freestyle tools.** Scan Level-0 Skills Index (`REFERENCES.md` under deposit `.deft/core/` or framework `content/` / root) and open the matching Directive `SKILL.md` **before** host-global skills, raw `gh` poll loops, or improvised shell.
3. ! **Prefer pinned Directive skills** over same-named host skills. Always-pins: `deft-directive-build`, `deft-directive-pre-pr`, `deft-directive-review-cycle`, `deft-directive-swarm` (#2508). On-demand examples: `deft-directive-article-review`, `deft-directive-triage`. Cursor `/review` or a host skill named “review” is **not** a substitute for the Directive skill that matches the intent.
4. ~ **Record the gate** in session notes / MEMORY when the host supports durable notes (which skill path ran, project root used) so APE continuity does not re-miss the route.

### Regression note (2026-07-30 miss class)

Live miss: operator said “use review skill” + URL; agent stayed on host freestyle / same-named host path and **never entered** `deft-directive-article-review` via Skills Index.

! On review / article-review / babysit / shepherd intent under OpenClaw: open the matching Directive skill (`deft-directive-article-review` or `deft-directive-review-cycle` per intent) from Skills Index **first**.

⊗ Treat host `available_skills` alone as the Directive Skills Index.
⊗ Answer Deft-shaped intent with freestyle tools only when a Directive skill is indexed for that intent.
⊗ Skip project-root resolution and improvise from workspace home outside the target checkout.

### Pin wire into OpenClaw workspace skills (#3001)

Package install alone does not put always-pins into `~/.openclaw/workspace/skills`. Operators / agents SHOULD run `deft doctor` (detect) and `deft doctor --fix` (symlink or copy the four pins) when main-workspace pins are missing. Multi-seat only with `--openclaw-all-agents`. Operator steps: [`../../docs/openclaw-agent-host.md`](../../docs/openclaw-agent-host.md) § Wire skills into OpenClaw workspace.

### Soft post-compact AGENTS re-bind (#3171)

OpenClaw does **not** claim file-host PreCompact hard re-arm alone. Soft re-bind is a **required** durable skill (`deft-directive-post-compact-rebind`) deposited by `deft doctor --fix` / init when OpenClaw is detected — same checklist SoT as Cursor/Claude/Grok. After deposit, restart gateway or start a new session. Full dual-surface matrix: [`../../docs/openclaw-agent-host.md`](../../docs/openclaw-agent-host.md) § Soft post-compact AGENTS re-bind; `commands.md` compact + soft section.

## Hard isolation before spawn (#2929)

! For **parallel** OpenClaw leaves (cohort size > 1):
1. ! Create isolated worktrees under `.deft-scratch/worktrees/<id>` **or** consume a pre-built C3 worktree-map / `task swarm:launch --worktree-map` **before** any `sessions_spawn`.
2. ! Set each worker `cwd` / working directory to that worktree path. The shared repo root is **not** a valid parallel leaf cwd.
3. ! Prefer blessed entry `task swarm:launch` (manifest + paths). Raw multi-story `sessions_spawn` is allowed only when a worktree-map (or equivalent per-leaf worktree paths) is already present and referenced.
4. ! Fail loud and HALT when parallel cohort size > 1 and any leaf would use the shared repo root or worktrees are missing.

⊗ DIY `sessions_spawn` for multi-leaf work without worktree prep / worktree-map.
⊗ Parallel OpenClaw dispatch that shares one checkout (repo root) across workers.
⊗ Treat file-scope tips (“TS-only”, “stay out of git.go”) as checkout isolation — they are not.

? Serial single-agent work on repo root is allowed when this is **not** a parallel cohort.

## Launch — Step 2f

### Step 2f: OpenClaw Launch (`sessions_spawn` available) — #2875

! When the platform descriptor is `openclaw` (OpenClaw `sessions_spawn` detected, no `start_agent`, no `WARP_*`, no Cursor `Task` tool), dispatch each worker via OpenClaw `sessions_spawn` with:
1. The canonical `templates/agent-prompt-preamble.md` content as the preamble (AGENTS.md read mandate, #810 xBRIEF gate, #798 PowerShell UTF-8, pre-PR + review-cycle mandates).
2. The standard worktree prompt (STEP 1-6 from the Prompt Template below).
3. The worktree path set to the agent's isolated git worktree.
4. ! **Background / non-blocking spawn** for any worker or poller whose loop runs longer than a short task (~3 min) — implementation, fix, and review-cycle workers — so the monitor conversation stays interactive (#1880 Gap D). Prefer `sessions_spawn` with the host's background / non-blocking flags (including optional `visible` when the operator needs an on-screen subagent).
5. ! **Deliberate model routing (#1739):** resolve `(dispatch_provider=openclaw, worker_role)` via `task verify:routing` / `task swarm:routing-set` and pass `resolved_model` into the spawn when non-null — stamping the C2 manifest is prep; the recorded model MUST reach the actual spawn call.
6. ! **Completion channel:** OpenClaw workers complete by parent push / announce (completion message back to the parent session). Do NOT poll via Grok Build's `get_command_or_subagent_output` or Cursor Task-complete semantics — those are other descriptors' channels.

! **OpenClaw nested-spawn boundary (#2875 / #2893, analogue of Cursor #2797):** An OpenClaw implementation leaf MUST NOT nested-spawn a second-level review-monitor via `sessions_spawn` when nested sessions are unsupported or unreliable on the host. Prefer either (a) a `drive-to: merge-ready` leaf that owns a blocking dual-invoke `pr:watch` (`deft pr:watch` then `task deft:pr:watch`) in its own process, or (b) `stop-at: pr-open` with the dispatcher launching a sibling monitor and registering it via dual-invoke `review-monitor:register`. A leaf that backgrounds a monitor and exits MUST NOT claim monitoring is active.

~ This is the first-class OpenClaw path. It is **Tier 1 → Approach 1** (a backgroundable sub-agent primitive), equivalent in tier to `start_agent` / Cursor `Task` / `spawn_subagent`; it MUST NOT be misclassified as `grok-build` or downgraded to a `generic-terminal` blocking poll. OpenClaw pollers whose loop runs > ~3 min MUST honour the sub-agent heartbeat contract (`docs/subagent-heartbeat.md`, #1166) via on-disk heartbeats (completion is still parent-announce, not Grok Build poll output).

⊗ Treat OpenClaw `sessions_spawn` as Grok Build `spawn_subagent` or as `generic-terminal` — the primitives and completion channels differ (#2875).


## Babysit / review-monitor

! Babysit / PR shepherd on OpenClaw remains **Approach 1** via `sessions_spawn` (`skills/deft-directive-review-cycle/SKILL.md`). Cron alone is not Approach 1 (#2874 / #2876).
⊗ Regress babysit to main-session `gh` poll + cron when `sessions_spawn` is available.

### Empty announce ≠ done + single lease residual (#3044)

Skill residual of #2874 / #2876 (spawn routing fixed; post-spawn ownership still thrashed). Canonical MUST language lives in `skills/deft-directive-review-cycle/SKILL.md` (`### Empty announce ≠ done`, `### Single review-monitor lease`, `### Required non-empty monitor handback`).

! On empty body / missing `STATUS:` / status-unknown review-monitor settle (`subagent_announce` with `(no output)` included): parent MUST same-turn ground truth (`gh pr view` + `gh pr checks` + HEAD) and MUST NOT treat the settle as DONE/CLEAN/merge-ready — **FC04 residual**.
! One sticky `<!-- deft:review-owner -->` lease per PR. Pre-spawn: list active same-`taskName` / lease holder. ⊗ Second monitor while prior owner is running **or** last settle was empty/unknown without terminal ground truth. Dead owner + open PR → one replacement + lease update only.
! Monitor handback MUST be non-empty with `STATUS` / `HEAD` / `CHECKS` / `MERGE` (see review-cycle skill + `templates/swarm-greptile-poller-prompt.md`).
~ Prefer `visible:true` when Control UI is the operator plane; invisible empty settles raise FC04 misclassification risk.
~ Recurrence: enterprize PR #43 (2026-08-02) dual-monitor + empty settle.

## Monitor / completion channel

! Completion is parent push / announce. Do not poll via Grok Build `get_command_or_subagent_output` or Cursor Task-complete semantics.
! Long pollers MUST honour on-disk heartbeats (`docs/subagent-heartbeat.md`, #1166).
! Pre-spawn verification and Duplicate-Agent rules in `references/core-phase-4.md` apply; resume the same OpenClaw session when possible rather than spawning a replacement on the same worktree.

### Parent-monitor after `subagent_announce` (#2943 / hard-stop #3131)

! When a leaf completion arrives via `subagent_announce` (parent-push completion), the parent’s **first response** MUST be one of:

1. ! **Tool-first ground-truth batch** in the same turn: inspect worktrees / open PRs / xBRIEF state via `gh`, `git`, or file reads, then one consolidate, **or**
2. ! **`sessions_yield`** (or host yield / wait) so the Control UI stays steerable without narrating unfinished work, **or**
3. ! **One short user answer** that is **not** a repeated progress line.

⊗ Open the first post-announce turn with multi-sentence status narration only (“Checking worktrees and open PRs next…”, “Two leaves look unfinished…”) and zero tool calls / yield — that is the #2943 text-repetition hang class (`stopReason: length` / abort with no tools).
⊗ Emit **N>2** near-identical assistant sentences (or streaming text chunks) in one turn with no `tool_use` / yield — **FC14** illegal shape; **hard-stop** the turn (#3131). Soft skill prose is not sole mitigation.

! **Machine check:** `evaluateParentTurnShape` in `@deftai/directive-core/parent-turn-shape` (`packages/core/src/parent-turn-shape/`). When `failClass` is `FC14` (or post-announce `progress-only-no-tool`), abort / force tool-or-yield. Operator recovery: [`../../docs/openclaw-agent-host.md`](../../docs/openclaw-agent-host.md) § Operator recovery — FC14.

! **Thin DONE = failed leaf (#2943):** completion text without PR URL / merge evidence (and not a structured `BLOCKED` / `FAILED` terminal per preamble §11) is a **failed leaf**, not success. After the ground-truth batch, re-dispatch or take over. ⊗ Treat thin DONE as shipped / success.

~ Prefer structured completion fields when the host supplies them (`prUrl`, `mergeStatus`, `emptyDiff`); free-text thin DONE never counts as merge-ready success.

## Phase handoff (see also core #2934)

! After coding cohort complete, same-turn next-phase tool dispatch or explicit terminal status — see `references/core-phase-5-6.md` and the thin SKILL MUST block. ⊗ End the turn with only narrative “I will spawn…”.
