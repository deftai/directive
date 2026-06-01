# Canonical orchestrator preamble (#954)

This is the canonical preamble that orchestrators (this conversation, swarm-skill dispatchers, monitor agents, scheduled / cloud agents) MUST include verbatim or by reference in any implementation sub-agent's dispatch envelope. It encodes the rules learned from prior recurrence patterns so each fresh dispatch starts with the institutional memory already loaded.

The orchestrator copies the section bodies into the worker prompt; the worker reads them as binding rules. Orchestrators MAY trim sections that are demonstrably out of scope (e.g. a docs-only worker may skip the rate-limit-throttle section), but MUST NOT silently drop the AGENTS.md read mandate, the #810 vBRIEF gate, or the PowerShell 5.1 non-ASCII rule.

## 1. Read AGENTS.md before any other tool call

The first action in your tool loop MUST be reading `AGENTS.md` at the project root. Confirm the read in your first status message ("Deft Directive active -- AGENTS.md loaded."). The rules below override or extend the AGENTS.md content where they are stricter; AGENTS.md takes precedence where they are silent.

Anti-pattern: skimming AGENTS.md via `head` or `wc -l` and proceeding. Read the full file.

## 2. #810 vBRIEF Implementation Intent Gate

Before any code-writing tool call (or before dispatching a sub-agent that will write code), satisfy the gate:

1. Locate (or create) a scope vBRIEF for the work. If none exists in `vbrief/proposed/`, `vbrief/pending/`, or `vbrief/active/`, create one in `vbrief/proposed/` first.
2. Promote the vBRIEF to `vbrief/pending/` via `task scope:promote -- <path>` (idempotent; lifecycle requires proposed -> pending -> active).
3. Activate it: `task vbrief:activate -- <path>`. This moves the file to `vbrief/active/` and flips `plan.status` to `running`.
4. Run the gate: `task vbrief:preflight -- vbrief/active/<file>.vbrief.json`. Exit 0 means you are clear to write code.

Anti-pattern: editing files before activating the vBRIEF, then activating "to make the gate pass" retroactively. The gate is the contract; satisfy it first.

The gate also requires an explicit action-verb directive from the user (`build`, `implement`, `ship`, `swarm`, `run agents`, `start agent`). Affirmative continuation phrases ("yes", "go", "proceed") are NOT authorisation unless the prior turn explicitly proposed implementation.

## 2.5 Allocation context -- swarm-cohort consent token (#1378)

Every dispatch envelope MUST carry a `## Allocation context` section so any downstream skill (the build SKILL Story Start Gate, the `task vbrief:preflight` gate) or deterministic gate can decide whether batched work was operator-approved by reading structured fields instead of pattern-matching free-form prose. The section has exactly five fields, in this order:

- `dispatch_kind`: `solo` | `swarm-cohort` -- whether this worker is a lone dispatch or one member of an operator-approved swarm cohort.
- `allocation_plan_id`: <swarm-monitor session id, or path to the Phase 5 allocation-plan snapshot> | null -- the stable handle for the allocation plan that authorized this dispatch.
- `batching_rationale`: <one-line rationale from the Phase 5 allocation plan> | null -- the one-line reason the cohort was batched together.
- `cohort_vbriefs`: [<vbrief-path>, ...] -- the full cohort vBRIEF list; a `solo` dispatch lists just its one vBRIEF.
- `operator_approval_evidence`: <Phase 5 approval timestamp or session reference> -- the audit handle proving the operator approved the allocation plan (advisory / audit-only -- it is NOT part of the recognition-contract gate below).

**Recognition contract:** a section reporting `dispatch_kind: swarm-cohort` with a NON-NULL `allocation_plan_id` AND a NON-NULL `batching_rationale` satisfies the Story Start Gate consent-token requirement (the #1371 carve-out) -- the worker does NOT re-prompt the operator for batching approval mid-cohort. When the `## Allocation context` section is ABSENT (pre-#1378 dispatches, solo-interactive sessions), fall back to the #1371 prose carve-out in the Story Start Gate.

Worked example (a swarm-cohort member):

```markdown
## Allocation context

- dispatch_kind: swarm-cohort
- allocation_plan_id: orchestrator-run-019e80bd-7328-7636-b283-a2f818243dd9
- batching_rationale: Three disjoint-file-scope stories from #1378; Story A freezes the schema, Stories B and C build against it in parallel.
- cohort_vbriefs: [vbrief/active/2026-06-01-1378a-allocation-context-schema.vbrief.json, vbrief/active/2026-06-01-1378b-skill-allocation-context-recognition.vbrief.json, vbrief/active/2026-06-01-1378c-preflight-story-start-gate.vbrief.json]
- operator_approval_evidence: user directive "swarm 1378 per option a" 2026-06-01T02:26Z
```

A `solo` dispatch sets `dispatch_kind: solo`, MAY leave `allocation_plan_id` / `batching_rationale` null, and lists only its own vBRIEF in `cohort_vbriefs`; such a section does NOT by itself satisfy the consent token, so the Story Start Gate falls through to the #1371 prose carve-out for a lone interactive dispatch.

## 3. PowerShell 5.1 non-ASCII rule (#798)

If your shell is `pwsh 5.x` on Windows AND you are editing a file containing any non-ASCII glyph (em dashes, en dashes, arrows, smart quotes, ⊗, ✓, ellipses, emoji, ...), you MUST route the read AND write through Python `pathlib`:

```pwsh path=null start=null
python -c "import pathlib; p = pathlib.Path('path/to/file.md'); s = p.read_text(encoding='utf-8'); s = s.replace('old', 'new'); p.write_text(s, encoding='utf-8')"
```

The corruption happens on the READ side (`Get-Content -Raw` decodes via cp1252 / cp437 BEFORE any safe write can preserve the bytes), so a UTF-8 write of already-corrupted text just persists the mojibake. PS 7+ (`pwsh`), bash, and zsh handle UTF-8 correctly and are exempt. The deterministic gate `task verify:encoding` will catch violations in `task check`, but a tooling failure here costs a full review-cycle iteration.

This is the recurrence with four prior occurrences (#236 / #240 / #283 / PR #795); do not be the fifth.

## 3.5 Windows Grok Build harness capture limitations (observed 2026-05, #1353)

When running under the Grok Build runtime on Windows + pwsh 7+, `run_terminal_command` leaks internal wrapper text (Get-Content and redirection fragments) whenever the command string contains `|`, `2>&1`, `| cat`, `>`, or similar metacharacters. Non-piped commands execute cleanly.

**Directive rule:** Never emit commands containing pipes or redirections through the agent shell tool on this platform. For anything requiring a pipe, use one of:
- Python one-liners with `pathlib` / `subprocess.run(capture_output=True)` (preferred -- bypasses the wrapper at the OS level)
- Run the operation in the user's native terminal and paste the result back
- Isolate the work in a dedicated worktree and mark the step as "user shell required"

This rule applies to the Grok Build runtime (pwsh 7+); Warp + Claude (PTY-based) is not affected by this wrapper leakage.

## 3.6 Safe subprocess on Windows -- UTF-8 capture helper (#1366)

Windows hosts running deft tooling (Grok Build, native PowerShell, scheduled / cloud agents) inherit the locale codepage (cp1252 / cp437) as the default `text=True` decode encoding for `subprocess.run`. When the child process (most commonly `gh api` returning a Greptile rolling-summary body) emits bytes that are not valid in that codepage, Python's internal `Thread-3 (_readerthread)` crashes with `UnicodeDecodeError`. The calling script then returns empty / malformed stdout, and any monitor parsing the JSON sees `head: None` -- the exact failure mode behind the #1166 swarm `Still waiting... (last reviewed: none, head: None)` symptom.

**Directive rule:** Any deft script that captures `gh` output or another Python subprocess for parsing MUST route its capture through `scripts/_safe_subprocess.py::run_text` (or pass `encoding="utf-8", errors="replace"` to `subprocess.run` directly). The helper FORCES `capture_output=True`, `text=True`, `encoding="utf-8"`, `errors="replace"`, and `shell=False`; callers cannot regress the safety contract via kwargs.

```python path=null start=null
# WRONG -- crashes Thread-3 (_readerthread) on Windows when output contains non-cp1252 bytes
result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)

# RIGHT -- bytes that don't decode under utf-8 become U+FFFD; the reader thread never crashes
from _safe_subprocess import run_text
result = run_text(cmd, timeout=60)
```

This rule applies on every platform but BITES on Windows + Grok Build / cmd / PowerShell hosts where the locale codepage is not UTF-8. Linux / macOS hosts generally default to UTF-8 already and so do not reproduce the crash, but routing through `run_text` keeps the behavior identical across platforms.

Reference: AGENTS.md `## Safe subprocess capture (#1366)`. Recurrence record: the #1166 swarm session repeatedly observed `Thread-3 (_readerthread) UnicodeDecodeError` across multiple gh-shelling tools; #1366 is the structural fix.

## 4. pre-pr and review-cycle skills

Before pushing any branch:

- Run `skills/deft-directive-pre-pr/SKILL.md` end-to-end. The skill's RWLD loop (read, write, lint, doc) catches the easy stuff before Greptile sees it.
- After opening the PR, run `skills/deft-directive-review-cycle/SKILL.md` end-to-end on bot findings. Cap iterations at 3 unless the user explicitly extends.

Anti-pattern: pushing without pre-pr and relying on Greptile to find issues. That burns review-cycle iterations on issues you could have caught locally; each iteration costs GraphQL budget under your shared identity.

## 5. REST-by-default for read-only gh calls

The GraphQL bucket (5000 pts/hr) is the operational bottleneck under shared-identity workflows, not the REST `core` bucket. Every read-only GitHub API call MUST prefer REST:

```pwsh path=null start=null
# REST -- preferred
gh api repos/<owner>/<repo>/issues/<N> -q '.title,.state'
gh api repos/<owner>/<repo>/pulls/<N> -q '.draft,.mergeable_state'
ghx api repos/<owner>/<repo>/issues/<N>      # cached REST via ghx; even better

# GraphQL -- forbidden in steady-state polling
gh issue view <N> --json title,state         # GraphQL
gh pr view <N> --json draft,mergeable        # GraphQL
gh pr ready <N>                              # GraphQL mutation (mutation, not poll)
gh pr update-branch <N>                      # GraphQL mutation
```

The forbidden surfaces are convenient and well-documented but route through GraphQL; under N concurrent workers they exhaust the bucket within minutes. Use the explicit REST forms above. Mutations to REST endpoints (`gh api -X POST/PATCH/PUT/DELETE /repos/...`) do not consume GraphQL budget and are fine; mutations to the `/graphql` endpoint (`gh api -X POST /graphql -f query=...`) DO consume GraphQL budget and are subject to the same throttle.

## 6. No Draft re-toggling within a single review cycle

Once a PR transitions Draft -> Ready, keep it Ready unless a P0 finding requires re-Draft. Repeated Draft<->Ready toggles cost GraphQL mutations and trigger stale CheckRun states downstream (Greptile re-runs, branch-protection re-evaluations).

The PR #652 merge-cascade incident traced back to a Draft re-toggle that hid a stale Greptile verdict from `gh pr view --json`'s cache. The mitigation: at most one toggle per cycle.

Anti-pattern: re-Drafting a PR to "indicate work in progress" between review iterations. Use commit-status messages or PR comments instead.

## 7. Rate-limit-aware throttle

Before any GraphQL-heavy operation (PR readiness check loop, batch issue ingest, review-cycle Greptile polling, mass `gh pr list`), probe the rate limit:

```pwsh path=null start=null
gh api rate_limit -q '{core: .resources.core.remaining, graphql: .resources.graphql.remaining}'
# {
#   "core": 4998,
#   "graphql": 3989
# }
```

Decision tree:

- `graphql.remaining >= 1500` -- GraphQL paths are fine
- `500 <= graphql.remaining < 1500` -- prefer REST equivalents; defer non-essential GraphQL polling
- `graphql.remaining < 500` -- HALT GraphQL paths; switch to REST or batch+wait until reset (`reset` field is a unix timestamp)
- `core.remaining < 500` -- you have bigger problems; stop and escalate

The probe itself is a `core`-bucket call, so polling it cheaply does not consume GraphQL.

## 8. Identity separation -- consume dispatcher credential, never fall back to host gh auth (#983)

Workers MUST consume the GitHub credential injected by the dispatcher (typically `GH_TOKEN` in the prompt-supplied env). Workers MUST NOT fall back to the host's `gh auth status` token.

Why: maintainer and workers sharing a single PAT couples the human review/merge workflow and N concurrent workers onto one 5,000-req/hr GraphQL bucket per identity. The maintainer gets rate-limited by their own swarm; audit logs conflate human and machine actions under one `actor.login`; a leaked worker prompt acts with the full scope of the maintainer's PAT instead of the narrow scope a worker actually needs (issues:write / pulls:write / contents:read). The architectural fix is bucket partitioning by identity -- the maintainer keeps their PAT for review/merge/release, workers consume a dedicated bot account or GitHub App installation token. The full pattern (provisioning, scoping, rotation, leaked-token recovery) lives at `patterns/multi-agent.md`.

Enforcement at the worker side:

- ! After AGENTS.md read, verify `GH_TOKEN` is set. If unset and no other dispatcher-supplied credential is present, FAIL LOUD with a clear error -- do not silently run under the host's `gh auth status` token.
- ~ Confirm the credential's identity matches expectation: `gh api user --jq .login` should return the bot/App login, not the maintainer login. Mismatch is `BLOCKED: identity mismatch` to the parent.
- ⊗ Inherit the maintainer's `gh auth status` token implicitly. The dispatch envelope is the contract; an implicit fallback re-introduces the bucket coupling and audit conflation this rule eliminates.

Dispatchers (orchestrators / monitor agents / scheduled runs) are the other side of the contract: they MUST inject the worker credential into the env at spawn time and MUST NOT pass through the maintainer's credential. v1 deliberately ships docs-only per #983 non-goals; the env-var injection contract is operator-implemented today.

This rule is complementary to S5 (REST-by-default) and S7 (rate-limit-aware throttle): REST-by-default reduces GraphQL demand on whichever bucket the worker is using; rate-limit throttle keeps the worker from exhausting its own bucket; identity separation prevents the worker bucket from being the maintainer's bucket. All three are required for stable swarm operation.

## 9. Sub-agent spawn rules per #727

If you (the worker) need to spawn a sub-agent yourself:

- Sub-agents MUST have non-overlapping file scopes. Use the parent vBRIEF's `files_owned` / `files_must_not_touch` to partition.
- Destructive operations (worktree removal, branch deletion, force-push) run alone, never in parallel.
- Each sub-agent receives its own dispatch envelope including this preamble (or a reference to it).
- Coordinate shared append-only files (CHANGELOG, lessons.md) with explicit ownership at dispatch time.
- Sub-agents inherit the parent worker's `GH_TOKEN`; they MUST NOT mint or fall back to a different credential. Identity separation per §8 cascades through the spawn tree.

## 10. Dispatcher lifecycle hygiene -- workers are all-or-nothing

If your dispatch envelope contains a "pause for user approval" step in the middle of the worker's scope, REWRITE IT into two dispatches:

- WRONG: `Implement deliverables 1-3, then pause and wait for user confirmation before opening the PR.`
  - Worker implements 1-3, sends "paused, awaiting confirmation" message, exits its tool loop, lifecycle goes `succeeded` (terminal). User approval message hits a dead `agent_id`. Dispatcher must spawn a successor anyway -- the gate accomplished nothing except adding a context-handoff cost.
- CORRECT: two dispatches
  - Dispatch A: `Implement deliverables 1-3, push, report DONE.` Worker completes, lifecycle goes `succeeded`.
  - User reviews diff.
  - Dispatch B: `Open PR via REST, apply label, run review-cycle skill.`

Lifecycle events (`succeeded`, `failed`, `blocked`, `in_progress`, `cancelled`, `errored`) are emitted by the platform observing the worker's process state -- the worker does not choose them directly. A worker that finishes its tool loop with a "paused" message will be observed as `succeeded` (terminal); the agent_id becomes unreachable. The only ways for a worker to remain reachable mid-flight are: keep the tool loop alive (long-lived poll / sleep) or be observed by the platform as `blocked` via a sanctioned blocked_action. Neither is a natural fit for "I finished sub-task A and want approval before sub-task B."

Workers must therefore be all-or-nothing on their dispatch envelope. Approval gates split scope at the dispatcher layer.

Reference: scope-expansion comment 4399553752 on issue #954.

## 10.5 Heartbeat contract (#1365)

Long-running `spawn_subagent` review-cycle agents on the Grok Build hybrid swarm path can go completely dark from the monitor's perspective -- no commits, no PR comments, no completion notifications. The #1166 swarm session demonstrated the failure mode: two of three dispatched pollers produced zero observable signals; the monitor could not distinguish stalled from healthy.

The heartbeat contract closes that gap. Any sub-agent whose tool loop is expected to run for more than ~3 minutes (review-cycle pollers, watchdogs, long-running implementation agents) MUST emit a small JSON heartbeat at `<project-root>/.deft-scratch/subagent-status/<agent-id>.json` per `docs/subagent-heartbeat.md`.

The contract in one paragraph:

- Write a heartbeat IMMEDIATELY on startup (`phase: "starting"`).
- Re-write the heartbeat at minimum every 2-3 minutes during normal operation. The canonical poller template's 90s poll cadence satisfies this for free -- one heartbeat per poll iteration.
- Write a FINAL heartbeat right before exiting with `phase: "terminal"` and `terminal_state` populated with the canonical exit name (`CLEAN` / `ERRORED` / `TIMEOUT` / `STALL` / `FAILED` / `BLOCKED`). The terminal heartbeat is what tells the monitor "finished cleanly" vs "went silent".
- The record is JSON with at least `agent_id` (matches filename), `parent_id`, `last_heartbeat_at` (ISO-8601 UTC, `Z`-suffix), `last_message` (one human-readable line), `phase` (one of `starting | implementing | validating | committing | pushing | polling | fixing | terminal`), and optional `terminal_state`.
- Writes MUST be atomic (write-to-temp + rename) so the monitor never reads a half-written file.

The parent monitor watches via `scripts/subagent_monitor.py` (three-state exit 0 ok / 1 stale-or-malformed / 2 config error). Skipping the heartbeat is a hard `⊗` for any long-running sub-agent: a stalled agent with no heartbeat surface is the exact #1166 failure mode this contract closes.

## 11. Mandatory DONE message even on early exit

Every worker MUST send a final status message before exiting its tool loop, regardless of outcome:

- Success: `DONE: <one-line summary> (commit <sha>, PR #N)`
- Halted at cap: `BLOCKED: <reason> (review-cycle iter <i>/3, wall-clock <t>m/<cap>m)`
- Failure: `FAILED: <reason> + recovery hint`
- Stand-down: `STOOD-DOWN: <reason>` (e.g. user said "wait" with no follow-up dispatch)

Per-step acks during the run are noise. ONE start message, ONE final message; intermediate messages only on `BLOCKED` / `FAILED`. The final message lets the dispatcher distinguish a clean exit from a silent timeout when the lifecycle event arrives.

## 12. `task verify:cache-fresh` gate before `start_agent` (#1127 / D5 of #1119)

Dispatchers (this orchestrator, swarm Phase 4 dispatch, monitor agents, scheduled / cloud runs) MUST run `task verify:cache-fresh --for-issue <N>` immediately before any `start_agent` invocation that will dispatch an implementation sub-agent for upstream issue N, and MUST refuse dispatch on any non-zero exit. The gate is the second hop of the canonical pre-`start_agent` gate stack documented in `AGENTS.md` (Implementation Intent Gate -> `verify:cache-fresh` -> branch-policy gate -> `start_agent`).

The gate is detection-bound and has three exit states (mirrors the #747 branch gate):

- `0` -- cache fresh, target issue's latest decision is `accept`, and the issue is inside the active `plan.policy.triageScope[]` subscription (D12 / #1131). Proceed to `start_agent`.
- `1` -- cache is stale OR a blocking condition was found (issue's latest decision is `defer` / `reject` / `needs-ac` / `mark-duplicate` / absent, OR the issue is outside the active subscription, OR no cached entry exists for the issue under the resolved subscription). The dispatcher MUST refuse `start_agent` and surface the printed remediation (cite `task triage:bootstrap` / `task cache:fetch-all` for staleness, `task triage:accept` / `task triage:scope --list` for the gating decision).
- `2` -- config error: `.deft-cache/` is absent or `vbrief/.eval/candidates.jsonl` is missing. The dispatcher MUST refuse `start_agent` and surface the bootstrap recovery line (`task triage:bootstrap`). This is the never-bootstrapped case and is distinct from the stale-cache case so the operator sees the right action.

The `--allow-stale` override is per-shell and audited: the dispatcher MAY pass it after operator approval when the upstream issue body is known to be stable across the freshness window, but the override is logged to stderr and SHOULD be cited in the dispatch envelope so a downstream reviewer can audit the decision. Never silently strip the `--for-issue` arg to clear a failing gate; that defeats the contract.

The `--allow-missing-bootstrap` flag exists for the framework's own `task check` wiring (so a fresh framework checkout doesn't fail its own `verify:cache-fresh` aggregate run) and MUST NOT be passed by dispatchers. Consumer dispatchers leave it OFF; a missing cache is a real failure for them.

Reference: the gate is implemented at `scripts/preflight_cache.py` and exposed via `task verify:cache-fresh`; the subscription scope is read via the D12 surface `scripts/triage_scope.py` so a consumer that has tightened `plan.policy.triageScope[]` is not gated by stale entries outside their subscription.

## 13. Cancellation Attribution (#1300)

When a tool result reports `cancelled` / `aborted` / `killed`, default to **runtime glitch, not user intent.** Tool-runtime signals (parallel-batch limits, network glitches, server 5xx, timeouts, scheduler interruptions, IPC drops) look identical to a real user-issued cancel and MUST NOT be attributed to the user without direct user-side evidence. The canonical rule body lives at `main.md` `## Cancellation Attribution (#1300)`; this section is the worker-side propagation so dispatched sub-agents inherit the behavior.

Required flow on any `cancelled` / `aborted` / `killed` tool result:

1. Retry the affected operation SEQUENTIALLY (one at a time) before drawing any conclusion about user intent.
2. If the retry succeeds, treat the original event as a runtime glitch -- do NOT tell the user they cancelled.
3. If the retry also fails the same way, surface the actual error to the user and ASK whether they intended to cancel -- do not assert it.
4. Reserve "you cancelled" / "you stopped" / "you declined" phrasing for cases where the user explicitly performed a cancellation gesture (terminal Ctrl-C, an explicit "stop" / "cancel" / "abort" instruction in chat, an explicit decline of a confirmation prompt).

Dispatchers reading lifecycle events: the platform-emitted `cancelled` lifecycle state (see §10) is also subject to this rule -- a worker that the platform reports as `cancelled` is NOT necessarily a worker the user cancelled. Probe before attributing; the live incident motivating this rule was a parallel `gh issue edit` batch where three of four calls returned `{"cancelled":true}` from the runtime, the orchestrator told the operator "you cancelled the other three", and a sequential retry rescued all three immediately.

Anti-pattern: a parallel batch returns `{"cancelled":true}` on N-1 of N calls, the agent reports "you cancelled the other N-1", and the operator has to correct the agent before a sequential retry rescues the work. The sequential retry is the rule; reaching for user-intent attribution before retrying is the failure mode.

Forbidden phrasing without direct user-side evidence: `you cancelled`, `you stopped`, `you declined`. SHOULD phrasing when reporting a probable runtime cancellation: "N parallel calls returned cancelled -- likely a runtime hiccup; retrying sequentially."

## Footer

If any rule above conflicts with the user's explicit in-conversation directive, ASK rather than improvise. Rules represent the project's institutional memory; the user can override on a case-by-case basis but the dispatcher should surface the conflict, not silently bypass.

This template is owned by `vbrief/active/2026-05-07-954-orchestrator-agents-md-preamble-template.vbrief.json` (lifecycle-moves to `vbrief/completed/` on PR merge) and may be revised via a #954-tagged PR.
