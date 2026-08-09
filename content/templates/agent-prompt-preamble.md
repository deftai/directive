# Canonical orchestrator preamble (#954)

This is the canonical preamble that orchestrators (this conversation, swarm-skill dispatchers, monitor agents, scheduled / cloud agents) MUST include verbatim or by reference in any implementation sub-agent's dispatch envelope. It encodes the rules learned from prior recurrence patterns so each fresh dispatch starts with the institutional memory already loaded.

The orchestrator copies the section bodies into the worker prompt; the worker reads them as binding rules. Orchestrators MAY trim sections that are demonstrably out of scope (e.g. a docs-only worker may skip the rate-limit-throttle section), but MUST NOT silently drop the AGENTS.md read mandate, the #810 xBRIEF gate, the #1378 allocation-context token, the #1531 worker-metadata section when backend routing applies, or the PowerShell 5.1 non-ASCII rule.

## 1. Read AGENTS.md before any other tool call

The first action in your tool loop MUST be reading `AGENTS.md` at the project root. Confirm the read in your first status message ("Deft Directive active -- AGENTS.md loaded."). The rules below override or extend the AGENTS.md content where they are stricter; AGENTS.md takes precedence where they are silent.

Anti-pattern: skimming AGENTS.md via `head` or `wc -l` and proceeding. Read the full file.

## 2. #810 xBRIEF Implementation Intent Gate

Before any code-writing tool call (or before dispatching a sub-agent that will write code), satisfy the gate:

1. Locate (or create) a scope xBRIEF for the work. If none exists in `xbrief/proposed/`, `xbrief/pending/`, or `xbrief/active/`, create one in `xbrief/proposed/` first.
2. Promote the xBRIEF to `xbrief/pending/` via `task scope:promote -- <path>` (idempotent; lifecycle requires proposed -> pending -> active).
3. Activate it: `task xbrief:activate -- <path>`. This moves the file to `xbrief/active/` and flips `plan.status` to `running`.
4. Run the gate: `task xbrief:preflight -- xbrief/active/<file>.xbrief.json`. Exit 0 means you are clear to write code.

Anti-pattern: editing files before activating the xBRIEF, then activating "to make the gate pass" retroactively. The gate is the contract; satisfy it first.

The gate also requires an explicit action-verb directive from the user (`build`, `implement`, `ship`, `swarm`, `run agents`, `start agent`). Affirmative continuation phrases ("yes", "go", "proceed") are NOT authorisation unless the prior turn explicitly proposed implementation.

## 2.5 Allocation context -- swarm-cohort consent token (#1378)

Every dispatch envelope MUST carry a `## Allocation context` section so any downstream skill (the build SKILL Story Start Gate, the `task xbrief:preflight` gate) or deterministic gate can decide whether batched work was operator-approved by reading structured fields instead of pattern-matching free-form prose. The section has exactly five fields, in this order:

- `dispatch_kind`: `solo` | `swarm-cohort` -- whether this worker is a lone dispatch or one member of an operator-approved swarm cohort.
- `allocation_plan_id`: <swarm-monitor session id, or path to the Phase 5 allocation-plan snapshot> | null -- the stable handle for the allocation plan that authorized this dispatch.
- `batching_rationale`: <one-line rationale from the Phase 5 allocation plan> | null -- the one-line reason the cohort was batched together.
- `cohort_vbriefs`: [<xbrief-path>, ...] -- the full cohort xBRIEF list; a `solo` dispatch lists just its one xBRIEF.
- `operator_approval_evidence`: <Phase 5 approval timestamp or session reference> -- the audit handle proving the operator approved the allocation plan (advisory / audit-only -- it is NOT part of the recognition-contract gate below).

**Recognition contract:** a section reporting `dispatch_kind: swarm-cohort` with a NON-NULL `allocation_plan_id` AND a NON-NULL `batching_rationale` satisfies the Story Start Gate consent-token requirement (the #1371 carve-out) -- the worker does NOT re-prompt the operator for batching approval mid-cohort. When the `## Allocation context` section is ABSENT (pre-#1378 dispatches, solo-interactive sessions), fall back to the #1371 prose carve-out in the Story Start Gate.

Worked example (a swarm-cohort member):

```markdown
## Allocation context

- dispatch_kind: swarm-cohort
- allocation_plan_id: orchestrator-run-019e80bd-7328-7636-b283-a2f818243dd9
- batching_rationale: Three disjoint-file-scope stories from #1378; Story A freezes the schema, Stories B and C build against it in parallel.
- cohort_vbriefs: [xbrief/active/2026-06-01-1378a-allocation-context-schema.xbrief.json, xbrief/active/2026-06-01-1378b-skill-allocation-context-recognition.xbrief.json, xbrief/active/2026-06-01-1378c-preflight-story-start-gate.xbrief.json]
- operator_approval_evidence: user directive "swarm 1378 per option a" 2026-06-01T02:26Z
```

A `solo` dispatch sets `dispatch_kind: solo`, MAY leave `allocation_plan_id` / `batching_rationale` null, and lists only its own xBRIEF in `cohort_vbriefs`; such a section does NOT by itself satisfy the consent token, so the Story Start Gate falls through to the #1371 prose carve-out for a lone interactive dispatch.

## 2.55 Ordered-plan continuation boundary (#2402)

When the operator supplies an ordered plan (delivery sequence, cohort, checklist, review batch, or phase list), continuation language is bounded by that sequence — not by the triage queue, skill chaining, or adjacent backlog memory.

! Record the active sequence with `task plan-sequence:set -- --file <json>` (persists `.deft/plan-sequence.json`). Inspect with `task plan-sequence:current`; advance with `task plan-sequence:advance`; clear with `task plan-sequence:clear`.

! Before creating or dispatching a new external work unit (PR, branch, story activation, sub-agent implementation task), when a sequence is active run `task verify:plan-sequence -- --target-kind <kind> --target <id-or-title>`. Exit non-zero means fail closed.

! "next" / "what's next?" / "proceed" / "resume" / "move on" means **exactly one** next unit in the **narrowest active** ordered sequence. Unit type is inherited from that sequence.

! When the sequence is exhausted (`continuation_past_final` defaults false), stop and ask. Do not open PR 3 after an approved two-PR plan. Do not consult `task triage:queue`, open-issue intuition, or skill-chaining instructions to invent the next unit.

! Explicit queue/backlog asks ("what's the queue?", "build a cohort") remain queue-driven even mid-plan. Bare "what's next?" is **not** such an ask while a sequence is active.

! Skill-exit chaining instructions are advisory entrypoints only — they do not authorize adjacent work unless it matches the current ordered-plan entry or a fresh operator directive.

! Review-cycle exit returns to the ordered-plan context and authorizes at most the next sequence entry (after `plan-sequence:advance` for the completed PR). Cohort/build flows stop after the final approved entry.

⊗ Reuse triage queue `continuationNumbers` / `continuationOrder` for ordered-plan state — those fields are for `[RESUME]` / stale-defer ordering only.

⊗ Treat affirmative continuation ("yes", "proceed") as permission to widen past the approved sequence.

## 2.6 Provider-neutral worker metadata (#1531)

Heterogeneous swarm dispatch (#1531) assigns each worker a **dispatch provider** (the runtime primitive that launched the agent), a **worker role** (what the agent is allowed to do), and a **selected backend** or **routing policy** (how the harness maps that role to a concrete agent). These fields are provider-neutral: Composer-class coding agents, Grok Build (`spawn_subagent`), Cursor/cloud agents, Claude Code (`claude-code` / `claude-agent`, #3134), OpenClaw (`sessions_spawn`, #2874 / #2879), and future adapters share the same contract.

! Every intentional backend-routed dispatch MUST carry a separate `## Worker metadata` section in the dispatch envelope, placed AFTER `## Allocation context` and BEFORE the task body. This section is advisory metadata for the worker and for audit; it does NOT replace, extend, or reorder the five-field #1378 `## Allocation context` recognition contract above.

When present, the section documents these fields in order:

- `dispatch_provider`: the runtime primitive that launched this worker -- e.g. `spawn_subagent`, `start_agent`, `sessions_spawn` (OpenClaw host; platform descriptor `openclaw` per #2874 / #2875), `cursor-composer`, `cursor-cloud-agent`, `claude-code` (Claude Code host; register primitive `claude-agent` per #3134), or a future adapter id. Names the harness surface, not the model.
- `worker_role`: the role boundary for this dispatch -- one of `leaf-implementation`, `orchestrator`, `review-monitor`, or `merge-release` (stable ids from `packages/core/src/swarm/routing.ts` `SWARM_WORKER_ROLES`). Tells the worker which preamble rules and skill surfaces apply.
- `selected_backend`: the stable backend id from `plan.policy.swarmSubagentBackend` / `task policy:subagent-backends` (accepted set today: `composer`, `grok-build`, `cursor-cloud` only — see `KNOWN_SUBAGENT_BACKEND_IDS`) | null -- which catalogued **coding** backend the operator selected for this role. OpenClaw is a **host / dispatch_provider** (`sessions_spawn` / descriptor `openclaw`), not a `swarmSubagentBackend` enum value; do not write `selected_backend: openclaw` into policy (#2879 Greptile P1).
- `routing_policy`: <path or reference to the operator's routing file / tiering policy> | null -- when backend selection is delegated to harness routing instead of a typed policy field, cite the policy handle here so postmortems can reconstruct the route. The canonical handle is the gitignored, per-machine `.deft/routing.local.json` (#1739), keyed by `(dispatch_provider, worker_role)`; set decisions with `task swarm:routing-set -- --role <role> (--model <slug> | --harness-default)`.
- `resolved_model` (#1739): the concrete model slug the operator pinned for this `(provider, role)` | null for an explicit harness default. Resolved from `.deft/routing.local.json` and stamped into the `task swarm:launch` manifest. **This is the field the dispatch primitive must actually honor** -- see the threading rule below.
- `model_source` (#1739): provenance of `resolved_model` -- e.g. `cursor-route`, `harness-default explicit`. Lets a postmortem tell a pinned model from a harness default.

! THREADING RULE (#1739): when `resolved_model` is non-null, the orchestrator MUST pass it as the model argument of the actual dispatch primitive (e.g. the Task tool's `model` parameter for a Cursor sub-agent). Stamping the manifest is PREP; the dispatch is agent-driven, so a recorded model that is never passed into the spawn call is the exact bug #1739 closes. For harness-bound providers (e.g. `grok`) the model is chosen by the harness; only `mode: harness-default` is recordable and `resolved_model` stays null.

Populate `selected_backend` OR `routing_policy` (or both when the operator sets a default backend and also maintains a routing file). Nullability by role:

- `leaf-implementation` + intentionally tiered dispatch: at least one MUST be non-null.
- `orchestrator`, `review-monitor`, or `merge-release` + explicit backend routing: at least one MUST be non-null so strong-tier audit traces stay reconstructable.
- Any role on the harness-default agent with no tiering decision: both MAY be null; `dispatch_provider` and `worker_role` remain required.

**Role-boundary expectations (all providers):** the same boundaries apply whether the worker runs on Composer, Grok Build, Cursor/cloud, Claude Code, OpenClaw, or a future adapter:

- ! `leaf-implementation` workers implement scoped xBRIEF work in their assigned worktree only -- gates (`task check`, file-scope audit, Greptile review cycle) are model-agnostic and MUST still pass.
- ! `orchestrator`, `review-monitor`, and `merge-release` roles MUST run on strong or review-capable agents; dispatchers MUST NOT route these roles to cheap leaf backends.
- ⊗ Route a cheap leaf backend onto the merge cascade, Phase 5->6 release gate, conflict-resolution rebase, or review-cycle merge-ready decision -- these are irreversible-damage surfaces that stay on the strong tier regardless of provider.

**Audit visibility:** review cycles and postmortems MUST be able to reconstruct which backend and role produced a change without inferring it from harness-specific prose.

- ! Dispatchers MUST populate `## Worker metadata` in the dispatch envelope whenever backend routing is intentional (headless `task swarm:launch`, monitor dispatch, or manual orchestrator spawn).
- ! Workers MUST echo `dispatch_provider`, `worker_role`, and `selected_backend` or `routing_policy` (plus `resolved_model` when set, #1739) in the final status message per §11 (e.g. `DONE: ... (commit <sha>, PR #N, role leaf-implementation, model composer-2.5-fast via cursor-route)`). Omitting backend/role/model from the terminal message when metadata was present in the envelope is a hard `⊗`.

Worked example (a tiered leaf worker on Composer):

```markdown
## Worker metadata

- dispatch_provider: cursor-cloud
- worker_role: leaf-implementation
- selected_backend: null
- routing_policy: .deft/routing.local.json
- resolved_model: composer-2.5-fast
- model_source: cursor-route
```

! Pre-dispatch gate (#1739 / #1877): run `task verify:routing` before spawning ANY sub-agent (cohort OR solo) — it fails when a dispatched worker role has no decision (pinned model or explicit harness default) for the active provider. `task verify:story-ready` chains the same routing gate for single Cursor/Grok Task dispatches (#1877). Session start runs `task verify:routing -- --advise` (non-blocking disclosure).

Reference: `.deft/routing.local.json` + `task swarm:routing-set` + `task verify:routing` (#1739, supersedes the `plan.policy.swarmSubagentBackend` enum of #1531a / #1735), `packages/core/src/swarm/routing.ts` `SWARM_WORKER_ROLES`, issue #1531 scope update (dispatch provider / worker role / model selection are three separate concerns).

## 2.7 Runtime and GitHub auth mode (#1557)

Swarm launch manifests and worker dispatch envelopes MUST carry **runtime** and **GitHub auth mode** labels so each worker knows whether host `gh` credential store access is permitted. These fields are policy labels only -- they MUST NOT contain `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, or any secret token value.

When present, document the fields in a separate `## Runtime and GitHub auth mode` section placed AFTER `## Worker metadata` (when present) and BEFORE the task body:

- `runtime_mode`: one of `local-unsandboxed`, `cursor-native-sandbox`, or `cloud-headless` -- the execution envelope the worker runs in (from the read-only runtime probe, #1557a).
- `github_auth_mode`: one of `host-gh` or `injected-token` -- which GitHub credential rule applies to this worker (#1557b).

Launch-manifest entries (#1387 C2 contract) carry the same two fields at the top level alongside `allocation_context`. Workers MUST read the dispatch envelope (or launch manifest) and apply the identity-separation rules in §8 according to `github_auth_mode`, not the historical one-size-fits-all injected-token default.

Worked example (local interactive worker with validated host gh):

```markdown
## Runtime and GitHub auth mode

- runtime_mode: local-unsandboxed
- github_auth_mode: host-gh
```

Worked example (cloud / headless worker):

```markdown
## Runtime and GitHub auth mode

- runtime_mode: cloud-headless
- github_auth_mode: injected-token
```

Reference: `packages/core/src/platform/platform-capabilities.ts` (#1557a), `packages/core/src/intake/github-auth-modes.ts` (#1557b), issue #1557.

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

## 3.6 Safe subprocess on Windows -- UTF-8 capture (#1366)

**Historical note:** The `scripts/` Python directory was removed in #2022 (TS-native migration). The `scripts/_safe_subprocess.py::run_text` helper no longer exists. The underlying risk -- locale-codepage decode failures when capturing `gh api` output on Windows -- still applies to any TS tooling that shells out.

**Directive rule for TS tooling:** Any TS script that captures `gh` output or other child-process output for parsing MUST use `execa` (preferred) or `child_process.spawn` with explicit `encoding: "utf8"`. Never use `execSync` / `spawnSync` without explicit encoding when the output may carry non-ASCII glyphs (Greptile bodies, gh REST bodies, user-authored commit messages).

```typescript
// WRONG -- Buffer return; non-ASCII bytes become mojibake or throw on .toString()
const out = execSync("gh api ...");

// RIGHT -- explicit utf8 encoding; non-ASCII bytes survive the round-trip
import { execa } from "execa";
const { stdout } = await execa("gh", ["api", "..."], { encoding: "utf8" });
```

This rule bites on Windows + Grok Build / cmd / PowerShell hosts where the default codepage is not UTF-8. Linux / macOS generally default to UTF-8 and do not reproduce the crash, but explicit encoding keeps behavior identical across platforms.

Reference: AGENTS.md `## Safe subprocess capture (#1366)`. Recurrence record: the #1166 swarm session repeatedly observed `Thread-3 (_readerthread) UnicodeDecodeError` across multiple gh-shelling tools; #1366 is the structural fix. `scripts/_safe_subprocess.py` was the Python-era solution; the TS-era solution is explicit encoding on every `execa`/`spawn` call.

## 3.7 Per-run unique pytest basetemp under concurrent swarm dispatch (#1681)

Parallel swarm workers run as the same OS user and, by default, share pytest's `/tmp/pytest-of-<user>/` basetemp root. With `tmp_path_retention_count = 0` (pyproject.toml, #281), one worker's session-startup temp cleanup deletes another worker's in-use `tmp_path`, and `tmp_path_factory.mktemp` then fails with `FileNotFoundError` -- the #1681 cascade observed across three concurrent `task check` runs (~3.3k errors). This is a concurrency-only amplifier: a single run on a clean checkout passes.

**Directive rule:** When you run `task check` (or any pytest invocation) inside a swarm cohort -- i.e. concurrently with sibling workers under the same user -- you MUST give pytest a per-run unique basetemp so no two runs share a root. Either prefix a unique `TMPDIR` or set `PYTEST_ADDOPTS=--basetemp=<unique>`:

```bash path=null start=null
# Preferred: a fresh private temp root per run (also isolates non-pytest tmp use)
TMPDIR=$(mktemp -d) task check

# Equivalent: pin pytest's basetemp explicitly to a unique per-run path
PYTEST_ADDOPTS="--basetemp=$(mktemp -d)/pt" task check
```

A clean result under an isolated basetemp is attributable to your change, not to the ambient shared-`/tmp` race. Do NOT point `--basetemp` at a static path shared across workers -- that re-introduces the collision. Solo / single-run invocations on a private worktree do not require this, but it is harmless to apply unconditionally.

## 3.8 Windows Cursor Task-tool console windows (#2563)

On Windows, Cursor Task-tool local subagents historically opened a visible `cmd.exe` / `conhost` window per shell turn. Framework source checkouts amplified this when every `task <verb>` cold-ran `engine:_ts-build` → `pnpm`/`tsc` via `shell: true`.

**Shipped mitigations (keep; do not regress):**

- `windowsHide: true` (CREATE_NO_WINDOW) on engine invoke / package-manager probe / `spawnCommandText` paths
- Warm-dist skip via `tasks/ts-build-fresh.cjs` so `_ts-build` does not rebuild when `packages/cli/dist` is current (override with `DEFT_FORCE_TS_BUILD=1` / `DEFT_SKIP_TS_BUILD=1`)

**Directive rule for orchestrators on Windows:**

- ! Use **local** Cursor Task swarm workers as the default dispatch path — same as other platforms. Do not route to cloud solely because the host is Windows.
- ! Parallel local cohorts are allowed; do not force concurrency=1 because of #2563.
- ~ Prefer the normal warm `task` / `dist/bin.js` path; avoid unnecessary `DEFT_FORCE_TS_BUILD=1` across a parallel cohort.
- ⊗ Drop or weaken the #2563 `windowsHide` / warm-dist mitigations without a replacement that keeps Windows local swarm workable.

Reference: issue #2563; swarm skill Platform Requirements; env scrub + stdio inherit for nested Task recursion (#2554 / #2438).

## 3.9 Windows PowerShell: safe multi-line git/gh bodies (#2646 / #1417)

! Multi-line git commit / gh issue|pr|comment bodies: write UTF-8 (no BOM) to OS temp, then `git commit -F` / `gh --body-file` / `deft scm:body:* --body-file`. ⊗ bash heredocs, `<<<`, inline multi-line `--body`, or multi-line PS here-strings in the agent command box on Windows PowerShell — those patterns fail at parse time, split arguments, or get rewritten by host shell wrappers before git/gh runs. This applies to your own commit and PR tooling on win32; do not use bash heredocs even when user rules show POSIX patterns. `ghx` is read-only — mutations stay on live `gh`. Detail: `content/scm/github.md` § #2646 (#1417, #240, #798).

! Issue-body read-modify-write on win32: `task scm:body:issue:fetch --out-file` then edit the body file then `task scm:body:issue:edit --body-file` (fail-closed postcondition verify, #2607). ⊗ Capture-concat of `gh api repos/.../issues/<N> --jq .body` into PowerShell variables — PS string[]/$OFS collapses newlines to spaces and silently destroys live bodies (#2744, #2087, #2741, #1492). Detail: `content/scm/github.md` § #2744.

## 4. pre-pr and review-cycle skills

Before pushing any branch:

- Run `skills/deft-directive-pre-pr/SKILL.md` end-to-end. The skill's RWLD loop (read, write, lint, doc) catches the easy stuff before Greptile sees it.
- After opening the PR, run `skills/deft-directive-review-cycle/SKILL.md` end-to-end on bot findings. Cap iterations at 3 unless the user explicitly extends.

Anti-pattern: pushing without pre-pr and relying on Greptile to find issues. That burns review-cycle iterations on issues you could have caught locally; each iteration costs GraphQL budget under your shared identity.

## 4.5 Review-surface precedence -- deft review-cycle wins over host review tools (#2308)

The active host harness may expose its own review-labeled surfaces. On Cursor these are the `bugbot` and `security-review` Task **subagent types** and the `review-bugbot` / `review-security` **skills**; other harnesses may ship equivalents. A generic operator request to "review" / "get this reviewed" / "use sub-agents for reviews" must NOT be routed to those host-native tools as the review of record.

- ! Route ALL review work through the canonical `skills/deft-directive-review-cycle/SKILL.md` surface. Map a generic review request to the review cycle **by intent**, not by literal keyword -- "review this", "get this reviewed", and "use sub-agents for reviews" all mean run `deft-directive-review-cycle` (extends the #1862 / #2261 intent-routing fix).
- ! Map **PR shepherding intent** the same way: `babysit`, `babysit this PR`, `shepherd`, `watch the PR`, and the Cursor product action **babysit-pull-request-in-cloud** all mean run `deft-directive-review-cycle` on Deft-managed repos (`.deft/core/` installed) -- NOT the Cursor-global `babysit` skill (`~/.cursor/skills-cursor/babysit/SKILL.md`) (#2261).
- ~ Host review tools (Cursor `babysit` / `bugbot` / `security-review` subagent types, `review-bugbot` / `review-security` skills, or any future host equivalent) MAY be folded in as *advisory* finding sources INSIDE the review cycle -- the #2019 harness-aware-reviewer path -- with their findings batched alongside the Greptile / bot findings the cycle already processes.
- ⊗ Substitute a host-native review subagent type, Cursor global `babysit`, or `review-*` skill for `deft-directive-review-cycle` as the review surface. The host tools are advisory inputs folded into the cycle, never a replacement for it. Reaching for them on a bare "review" or "babysit" request is the #1862 / #2261 wrong-review-surface class (see also #2019, #2018).

## 4.6 Cloud PR-shepherd dispatch -- review-monitor worked example (#2261)

When an operator triggers **babysit-pull-request-in-cloud** (or equivalent PR-shepherding intent) on a Deft-managed repo, the orchestrator MUST dispatch a **review-monitor** worker with this preamble (or a reference to `templates/agent-prompt-preamble.md`) and an explicit mandate to read `skills/deft-directive-review-cycle/SKILL.md` before any PR mutation.

Worked example (cloud background review-monitor on PR #1037):

```markdown
## Allocation context

- dispatch_kind: solo
- allocation_plan_id: null
- batching_rationale: null
- cohort_vbriefs: []
- operator_approval_evidence: operator selected babysit-pull-request-in-cloud 2026-07-03

## Worker metadata

- dispatch_provider: cursor-cloud-agent
- worker_role: review-monitor
- selected_backend: cursor-cloud
- routing_policy: null
- resolved_model: null
- model_source: harness-default explicit

## Runtime and GitHub auth mode

- runtime_mode: cloud-headless
- github_auth_mode: injected-token

## Unit of work

drive-to: merge-ready on PR #1037 (repo: deftai/deftvisage, branch: fix/visage-repo-org-scoping)

## Mandates

1. First tool call: read AGENTS.md; confirm Deft alignment.
2. Read `templates/agent-prompt-preamble.md` (binding) and `skills/deft-directive-review-cycle/SKILL.md` end-to-end -- NOT `~/.cursor/skills-cursor/babysit/SKILL.md`.
3. Run review-cycle Phase 1 process audit before the fix loop; batch Phase 1 + Phase 2 fixes per review-cycle discipline.
4. Poll terminal verdict via `task pr:watch -- <N>` when waiting on Greptile/SLizard (#1056).
5. Exit only on review-cycle Step 6 fail-closed all-of (#1259) -- ad hoc SLizard P2 fixes without the exit predicate are insufficient.

DONE: include PR URL, role review-monitor, and whether Step 6 CLEAN was reached.
```

Anti-pattern: dispatching `Task(environment=cloud)` with only the Cursor global babysit skill attached and no preamble / `deft-directive-review-cycle` path -- that is the #2261 recurrence class.

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

## 5.5 Safe Markdown body posting (#1555)

Markdown-rich GitHub bodies MUST NOT be embedded inside double-quoted shell commands. In Bash and zsh, backticks perform command substitution before `gh` receives the text, so a phrase like ``"include `ghx`"`` can be posted as the output of running `ghx` instead of the literal Markdown.

Use the canonical safe wrapper for issue bodies, PR bodies, and issue/PR comments:

```bash path=null start=null
task scm:body:comment:create -- --repo OWNER/REPO --issue 1555 --body-file "$bodyFile"
task scm:body:comment:edit -- --repo OWNER/REPO --comment 123456789 --body-file "$bodyFile"
task scm:body:issue:create -- --repo OWNER/REPO --title "Title" --body-file "$bodyFile"
task scm:body:issue:fetch -- --repo OWNER/REPO --issue 1555 --out-file "$bodyFile"
task scm:body:issue:edit -- --repo OWNER/REPO --issue 1555 --body-file "$bodyFile"
task scm:body:pr:edit -- --repo OWNER/REPO --pr 42 --body-file "$bodyFile"
```

The wrapper reads UTF-8 body text from a file and invokes the `github-body` TS CLI (which routes through `gh api --input -` with explicit UTF-8 encoding), then prints the live post-mutation read-back object. Use live `gh` for immediate verification after mutations; do not use `ghx` for the first read-back because it may serve a cached stale GET.

## 5.6 Issue reading — body then comments (#2143 / #2066)

Before ingesting a GitHub issue, building a worker dispatch envelope, or concluding what an issue actually asks for, satisfy the body→comments reading discipline for **any** issue (not only umbrellas):

1. ! Fetch the issue via REST: `gh api repos/<owner>/<repo>/issues/<N>` (or `ghx api ...` for cached read-only GET).
2. ! Fetch the comment thread via REST: `gh api repos/<owner>/<repo>/issues/<N>/comments` (or `ghx api ...` for cached read-only GET). The issue-ingest path fetches `/comments` by default and folds the thread into the ingested overview (#2143).
3. ! Read body first, then the comment thread in chronological order. Later maintainer comments may supersede the original body — the #2126 recurrence shipped the wrong fix because dispatch used a body-only fetch.
4. ! Any scope, fix, or status conclusion about the issue MUST reflect the full thread, not the body alone.

**Umbrellas and epics (#1152):** when the issue is an umbrella or epic, the reading order extends to body → `## Current shape (as of pass-N)` comment → amendment comments. Prefer `task umbrella:current-shape <N>` for the deterministic current-shape read path.

Anti-pattern: reading only the issue body and building a dispatch envelope from it — e.g. `gh issue view <N> --json body` or REST `repos/.../issues/<N>` body field alone when `comments` count is greater than zero.

⊗ Conclude what an issue asks for, or build a dispatch envelope, from the issue body alone when the issue has comments (#2143 / #2066).

Reference: AGENTS.md `## Issue body→comments reading (#2143)`, `## Umbrella current-shape convention (#1152)`, issue #2143.

## 5.6.1 Typed escalation channel (#518 slim / #2948 Wave 5)

When blocked on human input under multi-agent load, file a **typed** escalation instead of a synchronous interrupt storm:

- Types: `cmd_approval` | `design_decision` | `approval` | `resource` | `external` | `question`
- CLI: `deft escalation:file` / `list` / `resolve` / `batch-approve` (bulk only for non-dangerous `cmd_approval` + `question`)
- Store: `.deft/escalations/<id>.json`
- Mark write-scope shell / merge / release requests `dangerous: true` so they stay individual
- Escalations are **not** implement authority — compose with `deft authz:grant` (Wave 1) after approval

Contract + residual full priority-inbox UI: `content/contracts/escalation.md`.

## 5.7 Value feedback opt-in and gap escalation (#1709)

Value attribution, budgeted session readbacks, and upstream gap escalation are gated on `plan.policy.valueFeedback` (default OFF). Workers MUST NOT emit value claims, session readback lines, or file upstream framework-gap issues unless the relevant sub-flag is ON and the operator has confirmed enablement where required.

- ! Trusted-org local auto-enable (#2376): a repo whose GitHub origin belongs to a company-owned org (default `deftai`; extend via `DEFT_VALUE_AUTOENABLE_ORGS`) auto-resolves LOCAL emit + session readback ON with `source=org-auto` and network/upstream OFF -- no per-repo confirmation. An explicit typed `valueFeedback` block (including `enabled: false`) always wins; any other repo or no origin remote stays OFF.
- ! While `valueFeedback.enabled` is false AND no trusted-org auto-enable applies, treat every value-feedback path as a no-op -- no ledger writes, no session lines, no upstream prompts, no token spend.
- ! Value claims MUST cite concrete attributed ledger events; silence when nothing is attributable.
- ! Session readback repeats suppress for 4 hours per attribution event id (same debounce class as #1279 triage welcome). Pull-based detail uses `task value:show` / `deft value:show`, not ambient pushes.
- ! Upstream gap filing is confirmation-gated -- route through `deft-directive-feedback`; draft + dedup with `task feedback:file` / `deft feedback:file`, then re-run with `--confirm` only after explicit operator approval. Consumer projects only; maintainer repo no-ops unless `DEFT_VALUE_SELF_DOGFOOD=1`.
- ⊗ File upstream issues without operator confirmation or past duplicate detection.
- ⊗ Use `Closes`/`Fixes`/`Resolves` on upstream gap bodies -- use `Refs #1709` only.

Reference: AGENTS.md `## Value feedback and attribution (#1709)`, issue #1709.

## 5.8 Deterministic questions runtime self-check (#1470)

The #767 contract applies to skill prose AND to agent-initiated structured questions at runtime. Prose-scanning tests cannot observe host `ask_user_question` tool calls — workers and orchestrators MUST self-enforce before every structured prompt.

- ! Before calling any host structured-question tool (`ask_user_question`, Cursor `AskQuestion`, or equivalent) OR rendering any numbered decision menu in chat — inside or outside a skill — verify the final two options are `Discuss` then `Back`, in that order.
- ! On `Discuss` selection, halt immediately per the verbatim Discuss-pause semantic in `content/contracts/deterministic-questions.md`: no further tool calls beyond acknowledging the pause; prompt `What would you like to discuss?`; resume only on an explicit user signal (re-asking the original question, saying `resume`/`continue`, or re-issuing the prior selection).
- ⊗ Rely on the host UI's `Other` affordance as the Discuss escape — it widens the answer space; `Discuss` exits the deterministic flow entirely (#767).
- ⊗ Omit `Discuss`/`Back` on ad-hoc orchestration prompts (swarm approval, routing decisions, scope confirmations) — the highest-traffic runtime surface (#1470 recurrence).

Reference: AGENTS.md `## Deterministic questions runtime obligation (#1470)`, `content/contracts/deterministic-questions.md`, issue #1470. Refs #767.

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

## 8. Identity separation -- mode-aware GitHub credential rules (#983 / #1557)

Workers MUST follow the GitHub credential rule recorded in the dispatch envelope's `github_auth_mode` field (§2.7) or launch manifest. The rule prevents maintainer/worker bucket coupling and audit conflation when modes are mixed across a cohort.

Why: maintainer and workers sharing a single PAT couples the human review/merge workflow and N concurrent workers onto one 5,000-req/hr GraphQL bucket per identity. The architectural fix is bucket partitioning by identity -- the maintainer keeps their PAT for review/merge/release, workers consume a dedicated bot account or GitHub App installation token (injected-token mode) or an explicitly approved host `gh` session (host-gh mode). The full pattern lives at `patterns/multi-agent.md`.

### injected-token mode (required for `github_auth_mode: injected-token` and always for `runtime_mode: cloud-headless`)

- ! Consume the GitHub credential injected by the dispatcher (typically `GH_TOKEN` / `GITHUB_TOKEN` / `GH_ENTERPRISE_TOKEN` in the prompt-supplied env). If unset and no other dispatcher-supplied credential is present, FAIL LOUD -- do not silently run under the host's `gh auth status` token.
- ~ Confirm the credential's identity matches expectation: `gh api user --jq .login` should return the bot/App login, not the maintainer login. Mismatch is `BLOCKED: identity mismatch` to the parent.
- ⊗ Inherit the maintainer's `gh auth status` token implicitly. Host `gh` fallback is forbidden in injected-token and cloud-headless modes.

### host-gh mode (permitted only when `github_auth_mode: host-gh`)

Applies to local interactive workers (`runtime_mode: local-unsandboxed` or, after validation, `cursor-native-sandbox`) where swarm launch preflight confirmed `gh auth status` and repo access from the worker environment.

- ! Use the worker environment's `gh` credential store -- the dispatch envelope explicitly authorises host `gh` for this worker. Do NOT require an injected `GH_TOKEN` when host gh auth is already valid in the worker shell.
- ! Still verify identity before GitHub operations: `gh auth status` must pass and `gh api user --jq .login` must return the expected account.
- ⊗ Fall back to host `gh` when `github_auth_mode` is `injected-token` or `runtime_mode` is `cloud-headless` -- those modes forbid host credential store use regardless of what is available on the host.
- ~ When `runtime_mode: cursor-native-sandbox`, host `gh` may fail inside the sandbox even when the parent session is authenticated. Fail loud with remediation (full-access execution, trusted-path allowlist, or switch to injected-token handoff) rather than assuming parent auth is visible to the worker.

Dispatchers MUST inject worker credentials for injected-token / cloud-headless dispatches and MUST record the selected `github_auth_mode` in the launch manifest and dispatch envelope. v1 deliberately keeps token injection operator-implemented; mode labels make the contract explicit without placing token values in prompts or transcripts.

This rule is complementary to §5 (REST-by-default) and §7 (rate-limit-aware throttle): REST-by-default reduces GraphQL demand on whichever bucket the worker is using; rate-limit throttle keeps the worker from exhausting its own bucket; mode-aware identity separation prevents the worker bucket from being the maintainer's bucket when injected-token mode applies. All three are required for stable swarm operation.

## 9. Sub-agent spawn rules per #727

If you (the worker) need to spawn a sub-agent yourself:

- Sub-agents MUST have non-overlapping file scopes. Use the parent xBRIEF's `files_owned` / `files_must_not_touch` to partition.
- Destructive operations (worktree removal, branch deletion, force-push) run alone, never in parallel.
- Each sub-agent receives its own dispatch envelope including this preamble (or a reference to it).
- Each child dispatch MUST carry its own `## Worker metadata` section per §2.6 when backend routing applies: set `dispatch_provider` and `worker_role` for the child's actual harness and role; propagate or override `selected_backend` / `routing_policy` so audit trails remain reconstructable at every tree depth (#1531).
- Coordinate shared append-only files (CHANGELOG, lessons.md) with explicit ownership at dispatch time.
- Sub-agents inherit the parent worker's credential policy: when the parent dispatch is `github_auth_mode: injected-token`, children MUST use the injected token; when `host-gh`, children inherit the same host-gh authorisation. They MUST NOT mint or fall back to a different credential mode than the parent envelope specifies. Identity separation per §8 cascades through the spawn tree.

### Orchestrator dispatch doctrine (#1880)

These rules bind **orchestrators** dispatching implementation, fix, or review-cycle workers (not only workers spawning their own children). Root cause: the 2026-06-22 #1878 session split implementation and review across separate leaf dispatches and blocked the parent conversation on long-running workers.

**Worker-owns-lifecycle (Gap C):**

- ! When dispatching an implementation worker, the dispatch envelope MUST declare the unit-of-work boundary explicitly: `stop-at: pr-open` (worker opens PR and exits) OR `drive-to: merge-ready` (worker owns PR + Greptile review cycle + fix batches through merge-ready as ONE unit of work, spawning its own review poller per `skills/deft-directive-review-cycle/SKILL.md` monitoring tiers). Default for story implementation dispatches is `drive-to: merge-ready`.
- ! **Envelope selection SLA (#3153):** Choose the boundary before spawn using the swarm decision tree (`skills/deft-directive-swarm/references/core-phase-0.md` — capacity stall, conf-only residual, wall-clock budget, large multi-gate, host nest limits). Happy-path default remains `drive-to: merge-ready`. A **deliberate** `stop-at: pr-open` is valid only with an immediate partner merge-path owner per `skills/deft-directive-review-cycle/SKILL.md` § Partner merge-path (babysit / Approach 1 lease / parent-retained — not freestyle global babysit). Under human-merge policy, that owner (or an explicit handoff recipient) remains responsible through merge + `scope:complete` — do not stand down at CLEAN alone. Consumer pin: `templates/agents-entry.md` § Envelope selection SLA. Silent PR-open handback for a worker already scoped merge-ready remains **forbidden**.
- ! **Cursor Task ownership split (#2797 / #2814):** A Cursor `Task` implementation leaf MUST NOT spawn another Cursor `Task` review-monitor: nested Task (leaf spawning leaf) is unsupported/unreliable. A Cursor `drive-to: merge-ready` leaf instead owns a blocking `task pr:watch -- <N>` in its own process. To use an Approach 1 monitor, scope the leaf `stop-at: pr-open`; the orchestrator that owns the Task primitive then launches the sibling monitor and runs `task review-monitor:register -- --pr <N> --monitor-agent-id <id> --platform-primitive cursor-task` (GitHub sticky `<!-- deft:review-owner -->` lease — not local JSON).
- ⊗ Let a Cursor leaf background `task pr:watch` and claim review monitoring is active. The process dies with the leaf and has no GitHub review-owner lease; treat that claim as a regression/eval failure and let `task verify:review-monitor -- --pr <N>` fail closed.
- ! **Post-merge scope lifecycle (#2321 / Gap C):** Workers scoped `stop-at: pr-open` MUST NOT run `task scope:complete` before exit — their activation checkpoint rides into master on merge. The **orchestrator** (or Phase 6 `task swarm:finalize-cohort` / `task swarm:complete-cohort` on the headless path) MUST run `task scope:complete` or `task scope:cancel` for each shipped story xBRIEF after its PR merges. Workers scoped `drive-to: merge-ready` (or `drive-to: merge`) MUST include `task scope:complete` on their active xBRIEF as part of the same unit of work (after merge when appropriate).
- ! Workers scoped `drive-to: merge-ready` MUST drive to merge-ready in their own tool loop — pre-PR, push, PR open, review-cycle poll/fix loop, and the #1259 Step 6 fail-closed exit — without handing back at PR-open for the orchestrator to re-dispatch separate leaf agents for review or fixes.
- ⊗ Re-dispatch a separate review-monitor or fix agent after an implementation worker exits at PR-open when the original envelope scoped `drive-to: merge-ready` — that split recreates cross-agent state-handoff hazards and terminal lifecycle gaps (#1878 / Gap C).
- ⊗ Dispatch `stop-at: pr-open` without a named review-cycle partner merge-path owner plan (#3153).
- ⊗ Leave an `xbrief/active/` brief with `plan.status == running` on master after the story's issue is closed or its PR merged — `task verify:orphan-active` fails closed on that signature (#2321).

**Background / independent dispatch (Gap D):**

- ! Long-running workers (expected >~3 min: implementation, fix batches, review-cycle owners, pollers) MUST be dispatched independently / in the background so the parent conversation channel stays interactive and the orchestrator is notified on completion (`DONE` / `BLOCKED` / `FAILED` per §11).
- ! On Cursor, background dispatch means the Task tool's background path (`run_in_background: true` on the Task invocation) — NOT blocking the orchestrator's turn for the worker's full wall-clock.
- ! On OpenClaw, background dispatch means `sessions_spawn` (optionally with `visible` so the Control UI can watch the subagent) so the parent session stays interactive; the completion channel is **parent push / announce**, not `get_command_or_subagent_output` and not Cursor Task completion (#2874 / #2879). Nested leaf-spawn-leaf limits mirror Cursor #2797 when the platform does not support reliable nested `sessions_spawn`.
- ⊗ Foreground/blocking dispatch for long-running implementation, fix, or review-cycle workers when a background/independent dispatch primitive is available — blocking locks the conversation and prevents user steerability (#1878 / Gap D).
- ~ Foreground dispatch is reserved for short tasks (<~3 min): quick probes, single-command checks, terse status reads.

**Deliberate model routing before ANY dispatch (doctrine; enforcement #1877):**

- ! Before dispatching ANY sub-agent (cohort OR single), the orchestrator MUST make a deliberate per-`worker_role` model-routing decision — consult `task verify:routing` / `task swarm:routing-set`, populate `## Worker metadata` per §2.6, and pass `resolved_model` into the actual dispatch primitive when non-null. Never silently inherit the parent orchestrator's model.
- ⊗ Dispatch a worker without a recorded routing decision for its `(dispatch_provider, worker_role)` pair when backend routing applies — silent inheritance of the parent model is forbidden.
- ~ Deterministic gate enforcement for undecided routes is tracked in #1877; this subsection is the behavioral rule only.

Reference: issue #1880 (doctrine), #1877 (gate enforcement), #954 (multi-agent discipline). Cross-references: `skills/deft-directive-swarm/SKILL.md` Phase 3 dispatch + Phase 5→6, `skills/deft-directive-review-cycle/SKILL.md` Review Monitoring.

## 10. Dispatcher lifecycle hygiene -- workers are all-or-nothing (capability-tiered, #3158)

**Default (hosts without retain):** If your dispatch envelope contains a "pause for user approval" step in the middle of the worker's scope, REWRITE IT into two dispatches:

- WRONG: `Implement deliverables 1-3, then pause and wait for user confirmation before opening the PR.`
  - Worker implements 1-3, sends "paused, awaiting confirmation" message, exits its tool loop, lifecycle goes `succeeded` (terminal). User approval message hits a dead `agent_id`. Dispatcher must spawn a successor anyway -- the gate accomplished nothing except adding a context-handoff cost.
- CORRECT: two dispatches
  - Dispatch A: `Implement deliverables 1-3, push, report DONE.` Worker completes, lifecycle goes `succeeded`.
  - User reviews diff.
  - Dispatch B: `Open PR via REST, apply label, run review-cycle skill.`

Lifecycle events (`succeeded`, `failed`, `blocked`, `in_progress`, `cancelled`, `errored`) are emitted by the platform observing the worker's process state -- the worker does not choose them directly. A worker that finishes its tool loop with a "paused" message will be observed as `succeeded` (terminal); the agent_id becomes unreachable. The only ways for a worker to remain reachable mid-flight are: keep the tool loop alive (long-lived poll / sleep) or be observed by the platform as `blocked` via a sanctioned blocked_action. Neither is a natural fit for "I finished sub-task A and want approval before sub-task B" **when the host cannot re-attach**.

**Capability tier (#3158):** On hosts that **retain** a live, addressable child (continue-by-agent-id / resume-by-name / steerable mid-flight session — see host adapter retained notes and `swarm/swarm.md` § Retained addressable sub-agents), a single dispatch MAY include a mid-scope gate: the parent re-messages the same child after approval instead of forcing a second full dispatch. Capability-gate first via platform descriptor; do not invent retain on one-shot hosts. Retention is for **orchestration** (message-later, steer-mid-flight) only — not mid-run constitution self-edit (#3164). Topology bounds: #3155 nuclear-family (retain does not license open mesh).

On hosts without retain, workers remain all-or-nothing on their dispatch envelope. Approval gates split scope at the dispatcher layer.

Reference: scope-expansion comment 4399553752 on issue #954; retained-child amendment #3158.

## 10.5 Heartbeat contract (#1365)

Long-running `spawn_subagent` review-cycle agents on the Grok Build hybrid swarm path can go completely dark from the monitor's perspective -- no commits, no PR comments, no completion notifications. The same visibility gap applies to OpenClaw `sessions_spawn` and Cursor `Task` pollers. The #1166 swarm session demonstrated the failure mode: two of three dispatched pollers produced zero observable signals; the monitor could not distinguish stalled from healthy.

The heartbeat contract closes that gap. Any sub-agent whose tool loop is expected to run for more than ~3 minutes (review-cycle pollers, watchdogs, long-running implementation agents) MUST emit a small JSON heartbeat at `<project-root>/.deft-scratch/subagent-status/<agent-id>.json` per `docs/subagent-heartbeat.md`.

The contract in one paragraph:

- Write a heartbeat IMMEDIATELY on startup (`phase: "starting"`).
- Re-write the heartbeat at minimum every 2-3 minutes during normal operation. The canonical poller template's 90s poll cadence satisfies this for free -- one heartbeat per poll iteration.
- Write a FINAL heartbeat right before exiting with `phase: "terminal"` and `terminal_state` populated with the canonical exit name (`CLEAN` / `ERRORED` / `TIMEOUT` / `STALL` / `FAILED` / `BLOCKED`). The terminal heartbeat is what tells the monitor "finished cleanly" vs "went silent".
- The record is JSON with at least `agent_id` (matches filename), `parent_id`, `last_heartbeat_at` (ISO-8601 UTC, `Z`-suffix), `last_message` (one human-readable line), `phase` (one of `starting | implementing | validating | committing | pushing | polling | fixing | terminal`), and optional `terminal_state`.
- Writes MUST be atomic (write-to-temp + rename) so the monitor never reads a half-written file.

The parent monitor watches the heartbeat file directly (three-state exit 0 ok / 1 stale-or-malformed / 2 config error). Skipping the heartbeat is a hard `⊗` for any long-running sub-agent: a stalled agent with no heartbeat surface is the exact #1166 failure mode this contract closes.

! **Cursor false-alive / REDISPATCH_OK (#2824):** On the Cursor `Task` path, the host may report a leaf as "still running" after it has gone silent (empty transcript, no heartbeats, no DONE/FAILED). When `task verify:subagent-alive` exits `1` for a registered in-flight `drive-to: merge*` worker — missing heartbeat, STALE heartbeat, or no recent git/PR activity — the monitor MUST treat the worker as dead and print `REDISPATCH_OK` to authorize takeover re-dispatch. Do NOT block on host resume when the liveness gate has failed closed.

! **OpenClaw `sessions_spawn` / heartbeat mapping (#2879):** Same file-heartbeat contract applies to OpenClaw review-monitors and long-running leaves. OpenClaw host session liveness, Control UI presence, or gateway channel reachability does NOT replace periodic heartbeats — those signals only prove the session exists, not that the tool loop is progressing. OpenClaw pollers write `.deft-scratch/subagent-status/<agent-id>.json` so `task agent:monitor` / `task verify:subagent-alive` can detect stalled monitors; OpenClaw-native session status MAY be a *supplementary* signal only. Host "still running" + missing/STALE heartbeat authorizes the same `REDISPATCH_OK` posture as Cursor #2824.

! **Parent ensures scratch dir + startup grace before REDISPATCH_OK (#2879):** `task verify:subagent-alive` exits `2` (config error, no `REDISPATCH_OK`) when the scratch directory is **missing** and has no records. Parents MUST `mkdir` the worker worktree's `.deft-scratch/subagent-status/` at dispatch time so a later missing record is exit `1` + `REDISPATCH_OK`. Parents MUST ALSO wait a **startup grace** (default 3 minutes from dispatch, or until the first `phase: "starting"` heartbeat is observed) before treating a missing required-agent as takeover-eligible — probing an empty parent-created dir immediately races a healthy worker still writing its first heartbeat and can spawn a duplicate. Exit `2` remains reserved for true config errors (bad args / wrong path).

- Monitors run `task verify:subagent-alive -- --require-agent <agent-id> [--scratch-dir <worktree>/.deft-scratch/subagent-status]` each poll iteration.
- Workers run `task agent:monitor` (raw sweep) or the gate verb above; both wrap `subagent-monitor` (#1365).

## 10.6 Dual stop for multi-iteration worker loops (#2442)

Multi-iteration implement, pre-PR, repair, and monitor loops require **two** stops: **success** (goal / AC / checker met) and **failure or budget** (max iterations, no-progress, or time/token budget). Single-turn tasks are exempt. Principle and defaults: `main.md` `## Dual Stop Rule (#2442)`; build skill dual-stop table; swarm Phase 4 / core-ops.

! On failure stop: halt; emit an operator-visible report (what was tried, what is missing, what human decision is needed). Prefer `BLOCKED:` over silent retry. ⊗ Thrash past the envelope. Durable delivery/acceptance mechanical enforcement is **#3143** (`packages/core/src/delivery-attempt/`; not prompt-only).

! **Implement-leaf pre-dispatch (#3228):** Before spawning a peer implement leaf on a unit (story/worktree), monitors/orchestrators MUST run `task swarm:pre-dispatch -- --scope-id <id> --target-id <worktree-or-branch>` (exit **0** allow / **1** active deny / **2** config). Non-zero → do not spawn. Gate is #3143 `DENY_DUPLICATE_ACTIVE`. Takeover = `--action cancel` then pre-dispatch begin again. Pointer only — skill depth: swarm `core-phase-4.md`.

## 11. Mandatory DONE message even on early exit

Every worker MUST send a final status message before exiting its tool loop, regardless of outcome:

- Success: `DONE: <one-line summary> (commit <sha>, PR #N)` -- when the dispatch envelope carried `## Worker metadata` per §2.6, extend the parenthetical with `role <worker_role>` and `backend <selected_backend|routing_policy>` (e.g. `DONE: ... (commit <sha>, PR #N, role leaf-implementation, backend composer)`).
- Halted at cap: `BLOCKED: <reason> (review-cycle iter <i>/3, wall-clock <t>m/<cap>m)`
- Failure: `FAILED: <reason> + recovery hint`
- Stand-down: `STOOD-DOWN: <reason>` (e.g. user said "wait" with no follow-up dispatch)

! **`drive-to: merge-ready` DONE reservation (#2843):** When the dispatch envelope scoped `drive-to: merge-ready` (or `drive-to: merge`), `DONE` is reserved for merge-ready completion — `task pr:merge-ready -- <N>` exit 0 on current HEAD, or merge + `task scope:complete` when the envelope included merge authority. Greptile P0/P1 outstanding, CI failure, branch behind, review-cycle cap, or any other merge blocker MUST NOT exit as `DONE`.

! **Mid-cycle BLOCKED contract (#2843):** A `drive-to: merge-ready` worker that must exit before merge-ready (blocker, cap, context limit, host turn budget) MUST emit `BLOCKED:` (never `DONE`) with: PR number (or `no-pr`), HEAD SHA, blocker class (`greptile_p0_p1` / `ci_failures` / `behind_base` / `review_cycle_cap` / `context_limit` / other), worktree path, and `REDISPATCH_OK` when a continuation leaf should take over. Example: `BLOCKED: Greptile P1 on HEAD abc1234 (PR #2842, blocker greptile_p0_p1, worktree .deft-scratch/worktrees/2839-appsec, REDISPATCH_OK)`.

⊗ Emit `DONE` from a `drive-to: merge-ready` worker while merge-ready is false — a false-terminal `DONE` pulls the cohort monitor into inline Greptile fixes and violates Gap D (#2843 monitor-as-implementer recurrence).

! **Thin DONE is not success (#2943):** A terminal message that lacks PR URL / merge evidence (no `PR #N`, no PR URL, no merge confirmation) is a **thin DONE** / failed-leaf signal for the parent monitor — re-dispatch or take over after ground truth. Prefer structured completion fields when the host supplies them (`prUrl`, `mergeStatus`, `emptyDiff`). Workers MUST NOT exit with mid-edit prose and call it `DONE` when the envelope required a PR or merge-ready outcome.

! **Empty announce ≠ done / single review-monitor lease (#3044 / FC04 residual):** An empty settle, missing `STATUS:` line, or `status: unknown` from a review-monitor (`subagent_announce` with `(no output)` included) is **not** DONE/CLEAN/merge-ready. Parent MUST same-turn ground truth (`gh pr view` + checks + HEAD) and MUST NOT spawn a second monitor while the prior owner is running or only falsely settled. Prefer one sticky `<!-- deft:review-owner -->` lease and a non-empty `STATUS`/`HEAD`/`CHECKS`/`MERGE` handback. Full MUST language: `skills/deft-directive-review-cycle/SKILL.md` + OpenClaw host adapter residual.

! **`review_cycle` evidence enum (#3090):** Handoffs, swarm finish messages, and L4 process claims MUST use only `done` | `in_progress:<pr>#<monitor_or_lease_ref>` | `skipped:<reason>` | `n/a`. Freeform `started` / `pending` / `initiated` is forbidden. L4 `status: pass` is illegal unless `review_cycle: done` (Step 6 fail-closed on HEAD) or `review_cycle: in_progress:…` with a verifiable sticky lease / parent-retained ownership. After a drive-to:merge-ready / babysit / shepherd claim, the same turn MUST end in Owner Continuity Gate A/B/C (monitor+lease, parent-retained next dual-source action, or explicit BLOCKED/FAILED finish) — never silent hold. Optional machine gate: `deft verify:l4-owner --pr <N>` / `task verify:l4-owner -- --pr <N>`. Full MUST language: `skills/deft-directive-review-cycle/SKILL.md` Owner Continuity Gate.

! **Bound proof for remote artifact claims / invented-done (#3120):** Handoff evidence MUST distinguish at least three axes and a binding state:

| Axis / field | Meaning |
|---|---|
| **work** | Local changes (edits, tests, commits on the branch) |
| **ship** | Pushed branch / PR exists on the forge |
| **gate** | Checks / review verdict on the claimed HEAD |
| **`proof_status`** | `bound` \| `unbound` \| `n/a-no-remote-claim` |

- ! **`proof_status` enum:** `bound` (same-turn probes bind every remote claim) \| `unbound` (remote claims present without probes — illegal under `status: pass`) \| `n/a-no-remote-claim` (no PR URL / PR number / SHA / CI-green / review-score fields filled).
- ! **`status: pass` is forbidden** when any remote artifact is claimed (PR URL/number, commit/HEAD SHA, CI green/success, review score) unless `proof_status` is `bound` **and** each claim has a same-turn probe (`command` + short raw `snippet` from that command's stdout). Unbound remote claims → **invalid evidence (fail)**, not pass-with-notes.
- ! **Binding = probe-then-fill (MUST):** run `git` / forge probe first (`git rev-parse HEAD`, `gh api repos/<o>/<r>/pulls/<N>`, `task pr:watch -- <N> --one-shot`, checks API), then **copy** IDs/URLs/SHAs/scores from the probe JSON/text into the evidence block. ⊗ Fill PR/SHA/CI/review fields from recollection, narration, or prior-turn memory.
- ! **Fail ranking:** **invented-done** (false or unbound remote artifacts under pass) is **stricter** than **empty-done** (pass with no work/ship/gate substance and no remote claims). Empty returns are incomplete; invented complete returns are worse and MUST fail closed.
- ! **Legal partial:** local work `done` + ship `not_started` / `blocked` **without** PR/SHA/CI/review fields and `proof_status: n/a-no-remote-claim` (or non-pass `status: partial`) is valid — do not invent ship state.
- Machine check (library): `validateHandoffEvidence` in `@deftai/directive-core` `handoff-evidence` (`packages/core/src/handoff-evidence/`). Skills: build / pre-pr / review-cycle final checklist.

! **Parent tool-first after leaf completion (#2943 / hard-stop #3131):** When a parent / monitor receives a leaf completion event (`subagent_announce`, parent-push, or host completion notify), its **first response** MUST be exactly one of: (1) a **tool-first** ground-truth batch (`gh` / `git` / worktree or file status) then one consolidate, (2) a host **yield** (`sessions_yield` on OpenClaw, or equivalent), or (3) **one short user answer** that is **not** a repeated progress line. ⊗ Multi-sentence progress-only first response with zero tools / yield — the OpenClaw text-repetition hang class (#2943). ⊗ Emit **N>2** near-identical assistant sentences (or streaming text chunks) in one turn with no `tool_use` / yield — **FC14** illegal shape; hard-stop the turn (#3131). Soft skill prose is **not** sole mitigation.

! **Machine check (FC14 hard-stop):** `evaluateParentTurnShape` in `@deftai/directive-core` `parent-turn-shape` (`packages/core/src/parent-turn-shape/`). Feed ordered turn events (`assistant_text` / `tool_use` / `yield`); when `ok === false` and `failClass` is `FC14` (or post-announce `progress-only-no-tool`), abort / force tool-or-yield. Operator recovery for current OpenClaw beta pins: `docs/openclaw-agent-host.md` § Operator recovery — FC14.

⊗ Treat thin DONE (no PR URL / merge evidence) as success (#2943).
⊗ N>2 near-identical assistant sentences with no tool_use / yield, or soft-prose-only mitigation for the parent hang (FC14 / #3131).
⊗ Treat empty/unknown review-monitor settle as DONE without same-turn ground truth, or dual-spawn a second monitor while the first lease is live (#3044).
⊗ Emit freeform `review_cycle: started` / `pending` / `initiated` or L4 `status: pass` without `done` or verifiable `in_progress:<pr>#…` (#3090).
⊗ Claim `status: pass` (or equivalent process-green handoff) with PR URL / SHA / CI green / review score filled from memory without same-turn probe binding — **invented-done** (#3120).
⊗ Set `proof_status: n/a-no-remote-claim` while remote PR/SHA/CI/review fields are non-empty (#3120).
⊗ Mark ship/gate `done` or fill PR fields when only local work completed — legal partial omits remote fields (#3120).

Per-step acks during the run are noise. ONE start message, ONE final message; intermediate messages only on `BLOCKED` / `FAILED`. The final message lets the dispatcher distinguish a clean exit from a silent timeout when the lifecycle event arrives.

## 11.5 Completion latch — one consolidate per runId (#3092)

Multi-agent **orchestrators** (OpenClaw parent seats, Cursor Task parents, grok-build swarm monitors, any parent that receives child settle / completion events) MUST apply a portable **completion latch**. Host-level announce dedupe is complementary and imperfect; this is the **agent-side** default when the same settled batch is re-delivered.

### Completion latch (MUST)

1. **One user- or caller-visible consolidate per child `runId` / settle batch** (or the explicit equivalent batch key the harness provides — e.g. spawn id, task id, announce id). Accept or reject for that batch still counts as the one consolidate.
2. After that consolidate is emitted, **identical or equivalent completion replay** for the same key ⇒ **silent**: no tools, no re-QC, no second final answer. When the host defines a silent token (example: OpenClaw `NO_REPLY`), use it; otherwise emit no outbound user/caller message.
3. **Re-open only when:**
   - new `runId` / new child batch key, **or**
   - caller / principal **explicit** steer to reopen, **or**
   - the completion payload carries **materially new** evidence (new HEAD, new blocker class, new PR URL / merge state) — not a re-paste or fat re-embedding of the same rollup / full task text.
4. If the harness **storms** replays with no new key: **at most one** fail-loud note to the caller (`completion replay storm; ignoring`), then silent. ⊗ Infinite consolidate loops.
5. Fat completion payloads that re-embed full task text, prior prompts, or prior consolidate prose **MUST NOT** be treated as a new mission or as material new evidence.

### Eval checklist (second settle same runId)

Given: parent already emitted a consolidate for `runId=R` (or harness batch key `R`).  
Second settle event for `R` arrives with the same claims / equivalent rollup.  
**Expect:** silent / host silent-token path — **not** a new investigation narrative, dual-source re-fetch, or second user-visible final.

### Normative anti-patterns

- ⊗ Second+ user-visible "final" for the same settled `runId` without new evidence or explicit reopen
- ⊗ Full dual-source / full test re-run solely because the settle event was delivered again
- ⊗ Treating "send consolidated final **now**" wording on a **replay** as authorization to undo a prior consolidate for that batch
- ⊗ Treating fat prompt / task-text re-embeds in completion payloads as a new mission (#3092)

Cross-links: swarm Phase 5 completion-notification / parent handback (`skills/deft-directive-swarm/references/core-phase-5-6.md`); review-monitor empty-settle DoD remains #3044 (empty ≠ done) and is orthogonal — empty is not a latch hit; identical non-empty replay after a prior consolidate **is** a latch hit.

## 12. Session ritual + `task verify:cache-fresh` gates before `start_agent` (#1348 / #1127)

Dispatchers (this orchestrator, swarm Phase 4 dispatch, monitor agents, scheduled / cloud runs) run in a headless worker context and MUST set `DEFT_SESSION_RITUAL_SKIP=1` for dispatched implementation workers. The interactive parent session remains responsible for `task session:start`; worker processes bypass the local `.deft/ritual-state.json` gate explicitly so they do not need per-clone interactive ritual state. When the bypass would hide a stale/missing ritual state, `task verify:session-ritual` prints a warning to stderr; preserve that warning in the dispatch log.

Dispatchers MUST run `task verify:cache-fresh --for-issue <N>` immediately before any `start_agent` invocation that will dispatch an implementation sub-agent for upstream issue N, and MUST refuse dispatch on any non-zero exit. The cache gate follows the session ritual gate in the canonical pre-`start_agent` gate stack documented in `AGENTS.md` (`verify:session-ritual` -> Story Start Gate -> Implementation Intent Gate -> `verify:cache-fresh` -> branch-policy gate -> `start_agent`).

The gate is detection-bound and has three exit states (mirrors the #747 branch gate):

- `0` -- cache fresh, target issue's latest decision is `accept`, and the issue is inside the active `plan.policy.triageScope[]` subscription (D12 / #1131). Proceed to `start_agent`.
- `1` -- cache is stale OR a blocking condition was found (issue's latest decision is `defer` / `reject` / `needs-ac` / `mark-duplicate` / absent, OR the issue is outside the active subscription, OR no cached entry exists for the issue under the resolved subscription). The dispatcher MUST refuse `start_agent` and surface the printed remediation (cite `task triage:bootstrap` / `task cache:fetch-all` for staleness, `task triage:accept` / `task triage:scope --list` for the gating decision).
- `2` -- config error: `.deft-cache/` is absent or `xbrief/.eval/candidates.jsonl` is missing. The dispatcher MUST refuse `start_agent` and surface the bootstrap recovery line (`task triage:bootstrap`). This is the never-bootstrapped case and is distinct from the stale-cache case so the operator sees the right action.

The `--allow-stale` override is per-shell and audited: the dispatcher MAY pass it after operator approval when the upstream issue body is known to be stable across the freshness window, but the override is logged to stderr and SHOULD be cited in the dispatch envelope so a downstream reviewer can audit the decision. Never silently strip the `--for-issue` arg to clear a failing gate; that defeats the contract.

The `--allow-missing-bootstrap` flag exists for the framework's own `task check` wiring (so a fresh framework checkout doesn't fail its own `verify:cache-fresh` aggregate run) and MUST NOT be passed by dispatchers. Consumer dispatchers leave it OFF; a missing cache is a real failure for them.

Reference: the gate is exposed via `task verify:cache-fresh`; the subscription scope is read via the D12 surface (`task triage:scope`) so a consumer that has tightened `plan.policy.triageScope[]` is not gated by stale entries outside their subscription.

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

This template is owned by `xbrief/active/2026-05-07-954-orchestrator-agents-md-preamble-template.xbrief.json` (lifecycle-moves to `xbrief/completed/` on PR merge) and may be revised via a #954-tagged PR.
