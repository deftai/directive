# Swarm core — Phase 4 Monitor (host-neutral)

## Phase 4 — Monitor

### Polling Cadence

- ~ Check each agent's worktree every 2–3 minutes: `git status --short` and `git log --oneline -3`
- ~ After 5 minutes with no changes, check if the agent process is still running

### Heartbeat liveness check (#1365)

! On the Grok Build hybrid path (`spawn_subagent` dispatch, no native lifecycle channel back to the monitor), worktree git state alone is INSUFFICIENT to distinguish a healthy mid-poll sub-agent from a stalled one. Long-running review-cycle pollers spend most of their wall-clock waiting on Greptile and emit no commits during that wait -- the #1166 swarm session is the recurrence record (two of three dispatched pollers went silent with zero observable signals; the monitor could not tell).

! The canonical alive-check on the Grok Build hybrid path is the heartbeat contract documented in `docs/subagent-heartbeat.md`. Every long-running sub-agent (pollers, watchdogs, implementation agents whose tool loop exceeds ~3 min) writes a JSON heartbeat to `.deft-scratch/subagent-status/<agent-id>.json` per the canonical poller template + agent preamble; the monitor reads those records via `task agent:monitor` (three-state exit 0 ok / 1 stale-or-malformed / 2 config error). Default threshold is 30 minutes; `--threshold-minutes` overrides.

```
# Scan all worktrees in the cohort
task agent:monitor -- \
  --scratch-dir <worktree-1>/.deft-scratch/subagent-status \
  --scratch-dir <worktree-2>/.deft-scratch/subagent-status
```

! Run the heartbeat sweep alongside the worktree git checks at every monitor polling iteration (~2-3 min). When a record is reported STALE (mid-flight, terminal_state unpopulated, age > threshold), treat it as a candidate for the Takeover Triggers below; when it is reported MALFORMED, surface the diagnostics to the user and re-dispatch the agent with a fresh prompt that re-establishes the heartbeat contract. A TERMINAL record (terminal_state set) is NEVER stale -- the agent reached its exit on its own terms.

~ The heartbeat is filesystem-only by design; a network partition or rate-limit ceiling cannot mask agent liveness. Pair the on-disk sweep with the worktree git checks (`git status --short`, `git log --oneline -3`) and the per-PR readiness gate (`task pr:merge-ready`) for the full alive + progressing + clean picture.

⊗ Spawn a replacement sub-agent for a worktree where the heartbeat record reports OK or TERMINAL -- the agent is alive (or finished cleanly) and a replacement would re-trigger the Duplicate-Agent Failure Mode below.

⊗ Treat the absence of a `.deft-scratch/subagent-status/<agent-id>.json` record on the Grok Build hybrid path as "agent is alive but quiet" -- a sub-agent that never wrote a heartbeat is either pre-startup (acceptable for the first ~30s) OR violated the contract (treat as stalled and verify via worktree state before any replacement decision).

### Checkpoints

Track each agent through these stages:

1. **Reading** — agent is loading AGENTS.md, xBRIEF files, project files (no file changes yet)
2. **Implementing** — working tree shows modified files
3. **Validating** — agent running iteration-lane gates or full `task check` (full gate required before push/PR — #1704)
4. **Committed** — new commit(s) in `git log`
5. **Pushed** — branch exists on `origin`
6. **PR Created** — PR visible via `gh pr list --head <branch>`
7. **Review Cycling** — additional commits after PR creation (Greptile fix rounds)

### Tool-event mix status line (#2967)

! When the monitor has a sequence of tool names (and optional shell commands) for a leaf — host transcript, heartbeat sidecar, or operator-supplied log — classify with the pure `#2967` taxonomy and include the status line in the **next monitor status** (chat heartbeat or sticky cohort note). Do not invent counts; only report when events are available.

Buckets: `explore` | `commit` | `verify` | `coordinate` | `unknown`. Misclassification policy: prefer `unknown` over wrong `verify`. Canonical docs: [`content/patterns/tool-call-taxonomy.md`](../../../patterns/tool-call-taxonomy.md). API: `@deftai/directive-core/tool-events` (`classifyToolEvent`, `summarizeToolEvents`).

```
# Status line shape (from summarizeToolEvents(...).statusLine)
tools: explore=12 commit=4 verify=2 coordinate=1 unknown=0
tools: explore=0 commit=3 verify=0 coordinate=0 unknown=1 | anomalies: commit-without-explore,verify-skipped
```

! Surface anomalies when present:
- `commit-without-explore` — mutators without any explore events (possible blind edit)
- `verify-skipped` — commit events with zero verify gates (ship without check/test)
- `explore-only` — thrash signal (explore-only, no commit/verify, ≥3 events)

~ Pair the status line with worktree git checks and `task pr:merge-ready` so operators see progress **and** tool mix without reading raw tool logs.
⊗ Treat raw “ran N tools” as a structured mix — always bucket when events are available (#2967).

### Dual stop on monitor and repair loops (#2442)

! Phase 4 monitoring is multi-iteration work. It MUST obey dual stop (`main.md` `## Dual Stop Rule (#2442)`): **success** (leaf DONE with PR/merge evidence, or clean gate) **and** a **failure/budget** stop. One-shot status probes are exempt.

**Default failure envelope (monitor / repair class):**

| Stop | Default |
|------|---------|
| max iterations | **3** repair actions for the same leaf/PR failure class (resume prompt, takeover complete-remaining-steps, re-dispatch replacement, review re-trigger) |
| no-progress | same error / same Greptile finding class / same idle stage **3+** times with no material worktree or review change |
| budget | honor `pr:watch` / poll max-wait and Greptile service-error single-retry+escalate caps; do not nest an unbounded poll outside them |

! When the failure stop fires: **halt** automatic repair/re-dispatch; emit an **operator-visible halt report** (what was tried, current stage, missing evidence, human decision needed). Prefer `BLOCKED:` over thin `DONE` when the unit cannot reach merge-ready inside the envelope.

! **Halt-report resume line (MUST, #3273 / #3448):** Terminal dual-stop / hard-stop / conf-residual halt reports MUST end with a copy-pasteable operator resume affordance so agents discover the follow-up path without prior chat memory:

```
RESUME: residual=<class> leftover=<A|B|C> conf=<n/5|n/a> floor=<resolved min|n/a> standing=<yes|one-shot> PR=<url>
Operator may re-authorize **one residual pass** (one-shot) with: pursue residual | follow-up hard-stop | same as conf-hold | continue dual-stopped PR
Standing order (open cohort/plan units, class A until resolved floor or same-fingerprint loop): until floor or loop | until greptile meets policy | pursue residuals until told otherwise
Skill: deft-directive-swarm § Operator follow-up after dual-stop / hard stop (#3273) · deft-directive-review-cycle same section
```

Residual class examples: `review_cycle_cap` / `greptile_p0_p1` / `conf_floor` / `no_progress` / `ci_weather` / `thin_done`. Leftover class: **class A** already-touched in-AC residual · **class B** new subsystem / AC fight · **class C** score-only.

### Operator follow-up after dual-stop / hard stop (#3273)

Operator-initiated resume after dual-stop, hard-stop, or conf-floor residual — **not** automatic re-thrash. Primary discovery is the halt-report resume line above; this section holds the steps. Portable for consumer deposit and maintainer tree (`task` / `deft` dual-invoke; no framework-monorepo-only path). Continue-until target is the **resolved `#3095` floor** (`plan.policy.review.minGreptileConfidence`: typed project policy > framework dogfood **5** > consumer default **4**; inspect `task policy:show --field=minGreptileConfidence` / `deft policy:show --field=minGreptileConfidence`). ⊗ Hard-code 5/5. ⊗ Lower project policy to clear one PR.

**Leftover classes (A/B/C, #3448):**

| Class | What it is | Auto-continue? |
|-------|------------|----------------|
| **class A** — named leftover on already-touched files | Wrong remediation, dropped field, fixture, same-module hole on files this PR already owns | **in-AC residual.** Continue until the resolved floor or same-fingerprint loop |
| **class B** — new subsystem / AC fight | New ledger, protocol, cross-cutting contract, or work that expands story meaning | Park or file follow-up. Do not expand mid-babysit |
| **class C** — score-only, no concrete finding | Confidence below the resolved floor, 0 P0/P1, no named leftover | Document / same-as-conf-hold / operator floor this-PR-only. Not unbounded redesign |

! **Already-touched leftover is class A (#2881 / #3448):** a leftover on files **already in the PR** is class A unless it needs a new ledger, protocol, or story.

**One-shot vs standing (#3448):**
- **One-shot** triggers: pursue residual · follow-up hard-stop · same as conf-hold · continue dual-stopped PR · re-babysit residual — **one** pass on the unit that just halted, then re-stop. Do not silently widen.
- **Standing** triggers: **until floor or loop** · **until greptile meets policy** · **pursue residuals until told otherwise** — class A leftovers on **every open unit in the active cohort / ordered plan** keep moving until the resolved floor or the same primary leftover fingerprint repeats. Class B/C stay parked unless the operator names them.

**One residual pass (then re-stop, or one standing batch):**
1. Ground-truth: dual-invoke `pr:merge-ready` / `pr:watch --one-shot` on the PR (CLI `deft` first, then `task deft:` — see review-cycle #2893). Classify leftover A/B/C.
2. If a delivery attempt is still active, cancel then begin with the **same unit ids** (exit 0 required before residual spawn) (#3228 / #3143):
   ```
   task swarm:pre-dispatch -- --scope-id <story-or-issue-or-xbrief-id> --target-id <worktree-path-or-branch> --action cancel
   task swarm:pre-dispatch -- --scope-id <story-or-issue-or-xbrief-id> --target-id <worktree-path-or-branch>
   ```
3. Spawn **one** active residual worker or review-cycle owner (not sleep-only re-poll as the only work). Monitor MUST NOT self-implement product fixes after merge-ready leaf handback (#2843).
4. If the operator authorized a conf floor for **this PR only** (e.g. ≥4/5): post a PR audit comment naming the floor, HEAD SHA, and who authorized it. That comment is the **human-merge / documented-override trail** — it does **not** rewrite `plan.policy.review.minGreptileConfidence` or make `pr:merge-ready` / `pr:watch` exit CLEAN below policy. Merge still requires policy CLEAN, bot-merge authority + override path, or human merge after the documented floor is met in the bot body. ⊗ Silent policy edit of `minGreptileConfidence` for one residual.
5. Wait re-review; merge when policy floor + gates met (or human-merge after documented PR-local floor). Run `scope:complete` + lifecycle land when in scope (#3264 / finalize). Halt reports MUST include leftover class + resolved floor + standing vs one-shot.

! **Same-fingerprint halt is the loop stop (#3448 / #2442):** after a real fix, a *new* leftover MAY take another batch. Halt when the **same** primary leftover fingerprint appears on **2 consecutive** re-reviews with no material fix (same as the `#2442` no-progress stop — not the first recurrence after a real fix). `#2442` batch cap (max 3 repair actions) still applies.

! Dual-stop re-entry: after the residual pass (+ re-review wait), if still blocked, halt again with a fresh resume line. Another **one-shot** pass requires **new** operator consent. A **standing** order MAY continue class A with a **new** fingerprint under the `#2442` cap.

⊗ Unlimited auto-retry after dual-stop without new operator consent (#3273 / #2442).
⊗ Sleep-only multi-hour re-poll as the sole residual work.
⊗ Parent/monitor self-implement after merge-ready leaf handback (#2843).
⊗ Lower project-wide `minGreptileConfidence` for one residual.
⊗ Treat one-shot `pursue residual` as a standing order, or park a class A leftover on already-touched files because the score is below 5.

! Composes with minimal-subgraph repair (#2439): repairs stay minimal **and** dual-stop bounded. Mechanical delivery/acceptance circuit breaker: **#3143** `packages/core/src/delivery-attempt/` (`evaluatePreDispatch`). Docs: `docs/delivery-attempt.md`.

⊗ Silently continue the monitor repair loop after the envelope is exhausted.
⊗ Count a worker swap or session handoff as a fresh unlimited budget when the same failure class remains.

### Pre-dispatch deny gate (#3228 / #3143)

! **Before any implement-leaf spawn or re-dispatch** (initial launch, resume-fail recovery, residual batch, thin-DONE recovery, takeover replacement): run the deterministic pre-dispatch gate. Non-zero exit means **do not spawn**.

```
# Register / begin an attempt when no active peer exists (exit 0 allow / 1 deny / 2 config)
task swarm:pre-dispatch -- \
  --scope-id <story-or-issue-or-xbrief-id> \
  --target-id <worktree-path-or-branch>

# Terminal: complete the attempt when the leaf exits
task swarm:pre-dispatch -- \
  --scope-id <id> --target-id <target> \
  --action complete --status succeeded|failed|cancelled|blocked

# Takeover: cancel prior attempt, THEN pre-dispatch begin again (never dual active)
task swarm:pre-dispatch -- --scope-id <id> --target-id <target> --action cancel
task swarm:pre-dispatch -- --scope-id <id> --target-id <target>   # begin
```

! Gate authority is **#3143** `DENY_DUPLICATE_ACTIVE` (`maxActiveAttempts: 1`) on the delivery-attempt unit ledger (`scopeId` + `targetId` + `workflowId`, default workflow `drive-to:merge-ready`). CLI is authoritative; this section is a pointer only.
⊗ Spawn a second implement leaf while pre-dispatch exits 1 (active attempt exists).
⊗ Treat "resume failed" / host false-alive as license to skip the gate.
⊗ Lift DENY by concurrent dual active — escape hatch is cancel-then-begin, not override-while-both-run.
Docs: `docs/delivery-attempt.md`.

### Takeover Triggers

! **Pre-spawn verification:** Before spawning a replacement agent, verify the original is truly unresponsive by waiting for an idle/blocked lifecycle event — verified via worktree state (`git status`, `git log --oneline -3`) and sub-agent lifecycle signals showing no in-flight work (for grok-build / spawn_subagent agents: polling is via worktree state + `get_command_or_subagent_output` rather than tab observation; for openclaw / sessions_spawn agents: worktree state + parent completion announce / heartbeat records, not Grok Build poll output). Do NOT spawn a replacement based solely on message timing, absence of recent commits, or a perceived delay — original agents (Warp tabs, spawn_subagent processes, or OpenClaw sessions) can resume after apparent failure, and spawning a new agent creates two concurrent agents on the same worktree (see Duplicate-Tab Failure Mode below). Run `task swarm:pre-dispatch` after cancel when replacing — see Pre-dispatch deny gate above.

! Take over an agent's workflow if ANY of these occur:

- Agent process has exited and PR has not been created
- Agent process has exited and Greptile review cycle was not started
- Agent is idle for >5 minutes after PR creation with no review activity
- Agent is stuck in an error loop (same error 3+ times) — this is a dual-stop no-progress signal (#2442); after takeover, remaining repair actions still count against the default failure envelope above

When taking over: read the agent's current state (git log, diff, PR comments), complete remaining steps manually following the same deft process. If takeover itself cannot clear the failure class within the dual-stop envelope, halt with the operator-visible report rather than thrashing.

### Duplicate-Agent Failure Mode (a.k.a. Duplicate-Tab Failure Mode)

⚠️ **Root cause of #261 and #263 (generalized for #1342 slice 3 / #2875):** This is the **Duplicate-Agent Failure Mode** -- it fires on every platform descriptor, not just Warp tabs. Original Warp agent tabs may resume after apparent failure (network hiccup, temporary Warp UI freeze, context window pressure); the same failure mode applies to `spawn_subagent`-launched grok-build sub-agents and OpenClaw `sessions_spawn` workers that appear stalled but later resume. If the monitor spawns a new agent for the same worktree, two concurrent agents execute on the same branch simultaneously. This corrupts the `tool_use`/`tool_result` message chain — both agents issue tool calls, but responses are interleaved unpredictably, causing one or both agents to act on stale or incorrect state.

**Recovery guidance:**
- ! Keep original agents active until their PR is merged — do not terminate agent processes that appear stalled (for Warp tabs: keep the tab open; for grok-build / spawn_subagent agents: verify via `get_command_or_subagent_output` before replacing; for openclaw / sessions_spawn: verify via heartbeat + absence of parent completion announce)
- ! If an agent appears stalled, attempt to resume it in its original context (for Warp: go to the original Warp tab and say "continue from where you left off"; for grok-build: re-query via `get_command_or_subagent_output` or send a resume message; for openclaw: re-announce / resume the same session rather than spawning a replacement) rather than spawning a replacement — resume does **not** open a second delivery-attempt (`task swarm:pre-dispatch` will DENY while the first is active)
- ! If the original agent is truly unrecoverable (Warp crash, tab closed, spawn_subagent process terminated, or OpenClaw session ended without recovery), only then create a new agent — cancel the prior attempt via `task swarm:pre-dispatch -- --action cancel`, run pre-dispatch begin (exit 0 required), and verify worktree state (`git status`, `git log`, `gh pr list`) before spawn

### Context-Length Warning

! Long monitoring sessions accumulate large conversation history (hundreds of tool_use/tool_result pairs) and are susceptible to conversation corruption — the tool_use/tool_result mismatch observed in #263 occurred at approximately message 158 in a single monitor conversation. To mitigate:

- ! Offload rebase, review-watch, and merge sub-tasks to ephemeral sub-agents using the tiered approach from `skills/deft-directive-review-cycle/SKILL.md` (spawn via the platform adapter's dispatch primitive when available — e.g. `spawn_subagent` for Grok Build, Cursor `Task`, or OpenClaw `sessions_spawn` for descriptor `openclaw` — discrete tool calls with yield otherwise) — this keeps the monitor conversation shallow
- ~ Target <100 tool-call round-trips in any single monitor conversation before considering a fresh session handoff
- ! If the monitor detects degraded output (repeated errors, inconsistent state references, tool call failures), stop and hand off to a fresh session with a state summary rather than continuing in a corrupted context
