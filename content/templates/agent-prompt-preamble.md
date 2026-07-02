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

## 2.6 Provider-neutral worker metadata (#1531)

Heterogeneous swarm dispatch (#1531) assigns each worker a **dispatch provider** (the runtime primitive that launched the agent), a **worker role** (what the agent is allowed to do), and a **selected backend** or **routing policy** (how the harness maps that role to a concrete agent). These fields are provider-neutral: Composer-class coding agents, Grok Build (`spawn_subagent`), Cursor/cloud agents, and future adapters share the same contract.

! Every intentional backend-routed dispatch MUST carry a separate `## Worker metadata` section in the dispatch envelope, placed AFTER `## Allocation context` and BEFORE the task body. This section is advisory metadata for the worker and for audit; it does NOT replace, extend, or reorder the five-field #1378 `## Allocation context` recognition contract above.

When present, the section documents these fields in order:

- `dispatch_provider`: the runtime primitive that launched this worker -- e.g. `spawn_subagent`, `start_agent`, `cursor-composer`, `cursor-cloud-agent`, or a future adapter id. Names the harness surface, not the model.
- `worker_role`: the role boundary for this dispatch -- one of `leaf-implementation`, `orchestrator`, `review-monitor`, or `merge-release` (stable ids from `scripts/policy.py` `SWARM_WORKER_ROLES`). Tells the worker which preamble rules and skill surfaces apply.
- `selected_backend`: the stable backend id from `plan.policy.swarmSubagentBackend` / `task policy:subagent-backends` (e.g. `composer`, `grok-build`, `cursor-cloud`) | null -- which catalogued coding backend the operator selected for this role.
- `routing_policy`: <path or reference to the operator's routing file / tiering policy> | null -- when backend selection is delegated to harness routing instead of a typed policy field, cite the policy handle here so postmortems can reconstruct the route. The canonical handle is the gitignored, per-machine `.deft/routing.local.json` (#1739), keyed by `(dispatch_provider, worker_role)`; set decisions with `task swarm:routing-set -- --role <role> (--model <slug> | --harness-default)`.
- `resolved_model` (#1739): the concrete model slug the operator pinned for this `(provider, role)` | null for an explicit harness default. Resolved from `.deft/routing.local.json` and stamped into the `task swarm:launch` manifest. **This is the field the dispatch primitive must actually honor** -- see the threading rule below.
- `model_source` (#1739): provenance of `resolved_model` -- e.g. `cursor-route`, `harness-default explicit`. Lets a postmortem tell a pinned model from a harness default.

! THREADING RULE (#1739): when `resolved_model` is non-null, the orchestrator MUST pass it as the model argument of the actual dispatch primitive (e.g. the Task tool's `model` parameter for a Cursor sub-agent). Stamping the manifest is PREP; the dispatch is agent-driven, so a recorded model that is never passed into the spawn call is the exact bug #1739 closes. For harness-bound providers (e.g. `grok`) the model is chosen by the harness; only `mode: harness-default` is recordable and `resolved_model` stays null.

Populate `selected_backend` OR `routing_policy` (or both when the operator sets a default backend and also maintains a routing file). Nullability by role:

- `leaf-implementation` + intentionally tiered dispatch: at least one MUST be non-null.
- `orchestrator`, `review-monitor`, or `merge-release` + explicit backend routing: at least one MUST be non-null so strong-tier audit traces stay reconstructable.
- Any role on the harness-default agent with no tiering decision: both MAY be null; `dispatch_provider` and `worker_role` remain required.

**Role-boundary expectations (all providers):** the same boundaries apply whether the worker runs on Composer, Grok Build, Cursor/cloud, or a future adapter:

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

Reference: `.deft/routing.local.json` + `task swarm:routing-set` + `task verify:routing` (#1739, supersedes the `plan.policy.swarmSubagentBackend` enum of #1531a / #1735), `scripts/policy.py` `SWARM_WORKER_ROLES`, issue #1531 scope update (dispatch provider / worker role / model selection are three separate concerns).

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

Reference: `scripts/platform_capabilities.py` (#1557a), `scripts/github_auth_modes.py` (#1557b), issue #1557.

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

## 5.5 Safe Markdown body posting (#1555)

Markdown-rich GitHub bodies MUST NOT be embedded inside double-quoted shell commands. In Bash and zsh, backticks perform command substitution before `gh` receives the text, so a phrase like ``"include `ghx`"`` can be posted as the output of running `ghx` instead of the literal Markdown.

Use the canonical safe wrapper for issue bodies, PR bodies, and issue/PR comments:

```bash path=null start=null
task scm:body:comment:create -- --repo OWNER/REPO --issue 1555 --body-file "$bodyFile"
task scm:body:comment:edit -- --repo OWNER/REPO --comment 123456789 --body-file "$bodyFile"
task scm:body:issue:create -- --repo OWNER/REPO --title "Title" --body-file "$bodyFile"
task scm:body:issue:edit -- --repo OWNER/REPO --issue 1555 --body-file "$bodyFile"
task scm:body:pr:edit -- --repo OWNER/REPO --pr 42 --body-file "$bodyFile"
```

The wrapper reads UTF-8 body text from a file or stdin, sends JSON to `gh api --input -` via `_safe_subprocess.run_text` with `shell=False`, and prints the live post-mutation read-back object. Use live `gh` for immediate verification after mutations; do not use `ghx` for the first read-back because it may serve a cached stale GET.

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
- ! Workers scoped `drive-to: merge-ready` MUST drive to merge-ready in their own tool loop — pre-PR, push, PR open, review-cycle poll/fix loop, and the #1259 Step 6 fail-closed exit — without handing back at PR-open for the orchestrator to re-dispatch separate leaf agents for review or fixes.
- ⊗ Re-dispatch a separate review-monitor or fix agent after an implementation worker exits at PR-open when the original envelope scoped `drive-to: merge-ready` — that split recreates cross-agent state-handoff hazards and terminal lifecycle gaps (#1878 / Gap C).

**Background / independent dispatch (Gap D):**

- ! Long-running workers (expected >~3 min: implementation, fix batches, review-cycle owners, pollers) MUST be dispatched independently / in the background so the parent conversation channel stays interactive and the orchestrator is notified on completion (`DONE` / `BLOCKED` / `FAILED` per §11).
- ! On Cursor, background dispatch means the Task tool's background path (`run_in_background: true` on the Task invocation) — NOT blocking the orchestrator's turn for the worker's full wall-clock.
- ⊗ Foreground/blocking dispatch for long-running implementation, fix, or review-cycle workers when a background/independent dispatch primitive is available — blocking locks the conversation and prevents user steerability (#1878 / Gap D).
- ~ Foreground dispatch is reserved for short tasks (<~3 min): quick probes, single-command checks, terse status reads.

**Deliberate model routing before ANY dispatch (doctrine; enforcement #1877):**

- ! Before dispatching ANY sub-agent (cohort OR single), the orchestrator MUST make a deliberate per-`worker_role` model-routing decision — consult `task verify:routing` / `task swarm:routing-set`, populate `## Worker metadata` per §2.6, and pass `resolved_model` into the actual dispatch primitive when non-null. Never silently inherit the parent orchestrator's model.
- ⊗ Dispatch a worker without a recorded routing decision for its `(dispatch_provider, worker_role)` pair when backend routing applies — silent inheritance of the parent model is forbidden.
- ~ Deterministic gate enforcement for undecided routes is tracked in #1877; this subsection is the behavioral rule only.

Reference: issue #1880 (doctrine), #1877 (gate enforcement), #954 (multi-agent discipline). Cross-references: `skills/deft-directive-swarm/SKILL.md` Phase 3 dispatch + Phase 5→6, `skills/deft-directive-review-cycle/SKILL.md` Review Monitoring.

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

- Success: `DONE: <one-line summary> (commit <sha>, PR #N)` -- when the dispatch envelope carried `## Worker metadata` per §2.6, extend the parenthetical with `role <worker_role>` and `backend <selected_backend|routing_policy>` (e.g. `DONE: ... (commit <sha>, PR #N, role leaf-implementation, backend composer)`).
- Halted at cap: `BLOCKED: <reason> (review-cycle iter <i>/3, wall-clock <t>m/<cap>m)`
- Failure: `FAILED: <reason> + recovery hint`
- Stand-down: `STOOD-DOWN: <reason>` (e.g. user said "wait" with no follow-up dispatch)

Per-step acks during the run are noise. ONE start message, ONE final message; intermediate messages only on `BLOCKED` / `FAILED`. The final message lets the dispatcher distinguish a clean exit from a silent timeout when the lifecycle event arrives.

## 12. Session ritual + `task verify:cache-fresh` gates before `start_agent` (#1348 / #1127)

Dispatchers (this orchestrator, swarm Phase 4 dispatch, monitor agents, scheduled / cloud runs) run in a headless worker context and MUST set `DEFT_SESSION_RITUAL_SKIP=1` for dispatched implementation workers. The interactive parent session remains responsible for `task session:start`; worker processes bypass the local `.deft/ritual-state.json` gate explicitly so they do not need per-clone interactive ritual state. When the bypass would hide a stale/missing ritual state, `task verify:session-ritual` prints a warning to stderr; preserve that warning in the dispatch log.

Dispatchers MUST run `task verify:cache-fresh --for-issue <N>` immediately before any `start_agent` invocation that will dispatch an implementation sub-agent for upstream issue N, and MUST refuse dispatch on any non-zero exit. The cache gate follows the session ritual gate in the canonical pre-`start_agent` gate stack documented in `AGENTS.md` (`verify:session-ritual` -> Story Start Gate -> Implementation Intent Gate -> `verify:cache-fresh` -> branch-policy gate -> `start_agent`).

The gate is detection-bound and has three exit states (mirrors the #747 branch gate):

- `0` -- cache fresh, target issue's latest decision is `accept`, and the issue is inside the active `plan.policy.triageScope[]` subscription (D12 / #1131). Proceed to `start_agent`.
- `1` -- cache is stale OR a blocking condition was found (issue's latest decision is `defer` / `reject` / `needs-ac` / `mark-duplicate` / absent, OR the issue is outside the active subscription, OR no cached entry exists for the issue under the resolved subscription). The dispatcher MUST refuse `start_agent` and surface the printed remediation (cite `task triage:bootstrap` / `task cache:fetch-all` for staleness, `task triage:accept` / `task triage:scope --list` for the gating decision).
- `2` -- config error: `.deft-cache/` is absent or `xbrief/.eval/candidates.jsonl` is missing. The dispatcher MUST refuse `start_agent` and surface the bootstrap recovery line (`task triage:bootstrap`). This is the never-bootstrapped case and is distinct from the stale-cache case so the operator sees the right action.

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

This template is owned by `xbrief/active/2026-05-07-954-orchestrator-agents-md-preamble-template.xbrief.json` (lifecycle-moves to `xbrief/completed/` on PR merge) and may be revised via a #954-tagged PR.
