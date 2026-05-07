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

## 3. PowerShell 5.1 non-ASCII rule (#798)

If your shell is `pwsh 5.x` on Windows AND you are editing a file containing any non-ASCII glyph (em dashes, en dashes, arrows, smart quotes, ⊗, ✓, ellipses, emoji, ...), you MUST route the read AND write through Python `pathlib`:

```pwsh path=null start=null
python -c "import pathlib; p = pathlib.Path('path/to/file.md'); s = p.read_text(encoding='utf-8'); s = s.replace('old', 'new'); p.write_text(s, encoding='utf-8')"
```

The corruption happens on the READ side (`Get-Content -Raw` decodes via cp1252 / cp437 BEFORE any safe write can preserve the bytes), so a UTF-8 write of already-corrupted text just persists the mojibake. PS 7+ (`pwsh`), bash, and zsh handle UTF-8 correctly and are exempt. The deterministic gate `task verify:encoding` will catch violations in `task check`, but a tooling failure here costs a full review-cycle iteration.

This is the recurrence with four prior occurrences (#236 / #240 / #283 / PR #795); do not be the fifth.

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

## 8. Sub-agent spawn rules per #727

If you (the worker) need to spawn a sub-agent yourself:

- Sub-agents MUST have non-overlapping file scopes. Use the parent vBRIEF's `files_owned` / `files_must_not_touch` to partition.
- Destructive operations (worktree removal, branch deletion, force-push) run alone, never in parallel.
- Each sub-agent receives its own dispatch envelope including this preamble (or a reference to it).
- Coordinate shared append-only files (CHANGELOG, lessons.md) with explicit ownership at dispatch time.

## 9. Dispatcher lifecycle hygiene -- workers are all-or-nothing

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

## 10. Mandatory DONE message even on early exit

Every worker MUST send a final status message before exiting its tool loop, regardless of outcome:

- Success: `DONE: <one-line summary> (commit <sha>, PR #N)`
- Halted at cap: `BLOCKED: <reason> (review-cycle iter <i>/3, wall-clock <t>m/<cap>m)`
- Failure: `FAILED: <reason> + recovery hint`
- Stand-down: `STOOD-DOWN: <reason>` (e.g. user said "wait" with no follow-up dispatch)

Per-step acks during the run are noise. ONE start message, ONE final message; intermediate messages only on `BLOCKED` / `FAILED`. The final message lets the dispatcher distinguish a clean exit from a silent timeout when the lifecycle event arrives.

## Footer

If any rule above conflicts with the user's explicit in-conversation directive, ASK rather than improvise. Rules represent the project's institutional memory; the user can override on a case-by-case basis but the dispatcher should surface the conflict, not silently bypass.

This template is owned by `vbrief/active/2026-05-07-954-orchestrator-agents-md-preamble-template.vbrief.json` (lifecycle-moves to `vbrief/completed/` on PR merge) and may be revised via a #954-tagged PR.
