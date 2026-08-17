<!-- deft:managed-section v3 -->
# Deft — AI Development Framework

Deft is installed in .deft/core/. Full guidelines: .deft/core/main.md

! If any .deft/core/.agents/skills/ path referenced in this file cannot be read (missing file, stale path from a previous framework version, or a deprecation redirect stub), read .deft/core/QUICK-START.md instead and follow it. QUICK-START refreshes this section idempotently for the current framework version.

## Temporary test kill-switch (#3039)

! Before further Directive process load, check root `.deft-directive-disable` (presence = flag). If present → stop DD load; recovery = delete file + NEW agent session. Deposit OK; not `.no-deft-directive` (#2926). Docs: `.deft/core/docs/deft-directive-disable.md`.
⊗ Claim full operation while the flag exists or after delete without a NEW agent session.

## Session routing (#2176)

! **Read-only default** until mutation intent: load AGENTS.md / main.md / USER.md / `xbrief/PROJECT-DEFINITION.xbrief.json`; resolve USER.md via `deft session:start` (`USER.md resolved …`; win32 `%APPDATA%\deft\USER.md`; unix `~/.config/deft/USER.md`; ⊗ invent `~/.config/deft` on Windows #2544); confirm Deft alignment + addressing-name; ⊗ no mutable `deft session:start` / triage welcome / sync / branch-policy unless asked or implementation-ready (#2176) — `.deft/core/commands.md` § Session routing. Bootstrap: cold-start → README § Cold-start (#2273) ⊗ never `.deft/core/`; pre-cutover → setup Pre-Cutover (#2068); missing USER.md / PROJECT-DEFINITION → setup Phase 1/2 (#1813) ⊗ before answering; else main → USER → PROJECT-DEFINITION; ~ sync. Mutation → `deft session:start` then `deft verify:session-ritual -- --tier=gated` (#1149). ? `deft session:start -- --read-only` (#2176).

## Session-start ritual (#1149)

! On **mutation** session start, run `deft session:start`; before code-writing or `start_agent` dispatch run `deft verify:session-ritual -- --tier=gated` (stale after `plan.policy.sessionRitualStalenessHours`; records `deft verify:tools` / `deft doctor` / `deft verify:cache-fresh` / `deft agents:refresh` / `npm i -g @deftai/directive@latest`; #1149 / #1348) — `.deft/core/commands.md` § Session-start ritual. ! SCM mirror tip (#3124): restate existence + get-the-most user-visible when tip fires (depth `commands.md`). ⊗ Absorb tip without restating.

## WIP cap

! Respect `plan.policy.wipCap` (default 20) — at cap `deft scope:promote` refuses; relief via `deft scope:demote --batch --older-than-days 30` (#2319 / #1121). Full WIP: `.deft/core/.agents/skills/deft-directive-swarm/SKILL.md`.

## xBRIEF layout (#2034 / #2110)

Legacy `vbrief/` read-accepted; `deft migrate:xbrief` for `xbrief/` (v0.6→v0.8). `x-vbrief/` tokens read-accepted until migrated.
! Completed xBRIEFs are record of *what is*, zero authority over *what to build next* (#3383). Current contract = active xBRIEF + human operator live instruction. Depth: `main.md` Persistence; build skill declare-the-contract / halt-and-ask.
⊗ Treat a completed xBRIEF as the next-build contract.

## Unmanaged project header (#2065)

! Do NOT treat the unmanaged AGENTS.md header as the work queue; ⊗ Do NOT add `Status`, `Next:`, or `Known Issues` blocks — they rot silently. See UPGRADING.md § AGENTS.md: managed vs unmanaged header for the Session orientation pointer and rationale.

## Cache-as-authoritative work selection (#1149)

! "what next?" → two work-selection modes (#2402): **ordered plan** (`deft plan-sequence:*`) or **ranked queue** (`deft triage:queue`) — `commands.md` § Backlog Triage → Two paths. ordered-plan first; else `deft-directive-triage` + `deft triage:queue --limit=10` (D11). Empty cache auto-populates from GitHub (#2575).

⊗ Recommend work without queue/plan consult; ⊗ widen past an exhausted plan; ⊗ conclude "nothing to do" from `xbrief/{pending,active}` folder scans or GitHub-only reads without `deft triage:queue` (#2576).

## Umbrella status reading (#1152 / #2066)

! `issues/<N>/comments` via REST → `## Current shape (as of pass-N)` + linked context (claim-cites-state-surface, #2066); body → shape → amendments. Prefer `deft umbrella:current-shape <N>` — full contract: `.deft/core/templates/agent-prompt-preamble.md` § 5.6.

⊗ Conclude umbrella or epic status from the issue body alone — cite current-shape or another state artifact (#2066).

## Deterministic questions runtime obligation (#1470)

! Structured questions MUST end with `Discuss` and `Back` — `.deft/core/contracts/deterministic-questions.md` (#1470 / #767).

## Issue body→comments reading (#2143)

! Fetch body + `issues/<N>/comments` via REST before requirements or dispatch — `.deft/core/templates/agent-prompt-preamble.md` § 5.6 / `deft issue:ingest` (#2143). ⊗ Build a dispatch envelope from the issue body alone when the issue has comments.

## Content packs

! Before improvising: `deft packs:slice --list-packs`, then `deft packs:slice <pack> --list` / `deft packs:slice <pack> <slice>` — `commands.md` (§ packs); never enumerate names here.
## Codebase MAP Projection (#1595 / #1498)

! `plan.architecture.codeStructure` is durable SoT; `.planning/codebase/MAP.md` is generated — `deft codebase:map` / `deft verify:codebase-map-fresh` (`commands.md`). ⊗ Do not hand-edit MAP, block on stale/absent MAP, or elevate projection above xBRIEF (#1595 / #1498).

## Skills

! **Skills Index** (Level-0) in `.deft/core/REFERENCES.md` — scan before improvising; read `SKILL.md` only on index match. `welcome` / `onboard triage` → `deft triage:welcome --onboard` (N3 / #1143); lessons → packs:slice.
## Skill pin policy (#2508)

! Process-critical skills with false-negative risk MUST be named in AGENTS.md (always-pin tier) — tier definitions: `.deft/core/docs/skill-pin-policy.md` (#2508).
! **Default always-pins:** `deft-directive-build`, `deft-directive-pre-pr`, `deft-directive-review-cycle`, `deft-directive-swarm` — read each `SKILL.md` when that work type starts.
⊗ Pin entire language packs, deployment docs, or framework bulk into AGENTS.md — pins are for false-negative-sensitive process gates only (#2508).
! **Dual stop (#2442):** multi-iteration work MUST have success + failure/budget stop (max iters / no-progress / budget); single-turn exempt; halt with operator-visible report; ⊗ thrash. Defaults: build, swarm, review-cycle skills. See main.md Dual Stop Rule. Ledger #3143 (`packages/core/src/delivery-attempt/`).
## Rule Authority [AXIOM]
! Prefer `task deft:*` over AGENTS.md prose. See main.md.
## Thin Fail-Closed Design (#3265)
! One fail-closed `task deft:*` check + one remediation. See main.md.
## Writing bar (#3368)
! Clarity, simplicity, brevity in documents and user communications, including sub-agent status and handbacks. Cut ceremony, not required fields. STE how: `.deft/core/docs/writing-ste100.md` (#2927). ⊗ Full STE; ⊗ historical rewrite; ⊗ red CI style gate; ⊗ prefacing the rule.

## Continuous Improvement Learning (#607 / #3164)

! After a failure: ask if it could recur with a different query or session. One-off → write and later re-read `./lessons.md` inbox (also load packs:slice; ⊗ hand-edit generated `meta/lessons.md`); recurrable structural → propose skill/directive via issue/PR under Self-Improving gates — never mid-run constitution self-edit. Depth: Continuous Improvement in main.md; stance #3164; optional #666.

## Through-merge worker dispatch (#3032)

! On **through merge** / **drive to merge** / land-ship / **drive-to: merge-ready** story intent: parent MUST dispatch a `drive-to: merge-ready` worker (worktree, preflight, pre-pr, review-cycle, merge/`scope:complete`) via the **swarm/solo-worker launch path** even if **cohort size is 1** — parent MUST NOT implement as the leaf. Depth: swarm Phase 0 + skill-pin-policy (#3032 / #1880 Gap C).
⊗ Parent conversation implements or babysits product fix/CI loops for drive-to:merge-ready work when background subagent/worktree dispatch is available (#3032).
! After leaf announce: tool-first / yield / one short non-repeated answer; ⊗ N>2 near-identical zero-tool (FC14 / #3131). Machine: `evaluateParentTurnShape` (`parent-turn-shape`). Depth: preamble §11 + `docs/openclaw-agent-host.md`.

## Envelope selection SLA (#3153)

! Default story / through-merge unit of work is `drive-to: merge-ready`. Deliberate `stop-at: pr-open` is allowed only when a **partner merge-path owner** is planned (review-cycle babysit / Approach 1 lease / parent-retained) for Greptile + CI + post-merge `scope:complete` — triggers: capacity stall, wall-clock budget, large multi-gate, host nest limits (swarm Phase 0 decision tree). Depth: `deft-directive-swarm` + `deft-directive-review-cycle` partner merge-path.
! Under human-merge policy, a **durable** owner (parent/monitor sticky lease or Phase 6 closer) MUST remain for post-merge `scope:complete` — CLEAN alone is not lifecycle complete.
⊗ Silent PR-open handback for a worker already scoped `drive-to: merge-ready`.
⊗ `stop-at: pr-open` without a named babysit / merge-path owner, or dual review-monitor leases on recovery (#3044 / #2261).
⊗ Stand down at CLEAN under human-merge with no reachable post-merge `scope:complete` owner.

## Nuclear-family A2A topology (#3155)

! Agent-to-agent messaging is **nuclear-family** only: parent / sibling (same cohort) / child. Cross-cohort or cross-session coordination goes through a shared parent or durable parent-owned artifacts — not peer mesh. Depth: `.deft/core/swarm/swarm.md` `## Communication Topology (#3155)`; security: `.deft/core/meta/security.md` `## Unbounded A2A graphs (#3155)`; ADR: `docs/decisions/ADR-003-a2a-nuclear-family-topology.md` (decision input to #2705; client-posture ADR remainder stays on #2705). Pair: retained children #3158; parent epic #3179.
⊗ Open-mesh agent-to-agent messaging across cohorts or sessions ("agents everywhere").
⊗ Treat retained / re-addressable children as license to mesh outside the nuclear family.

## Mid-scope gate capability tier (#3158 / #954)

! Mid-scope gates: **split-dispatch** when `agent_id` is terminal; retain-capable hosts (continue-by-agent-id / message-later / steer-mid-flight) MAY re-message the live child. Retention = orchestration only — not constitution self-edit (#3164). Depth: preamble §10; `deft-directive-swarm`. Topology: #3155 nuclear-family. ⊗ Invent retain on one-shot hosts.

## Review-surface precedence (#2308)

! Route PR shepherding / review work through `deft-directive-review-cycle` — `.deft/core/.agents/skills/deft-directive-review-cycle/SKILL.md`; host `babysit` / `bugbot` / `security-review` advisory-only (#2308 / #2261).

## Value feedback and attribution (#1709)

! `plan.policy.valueFeedback.enabled` defaults OFF — `deft policy:show --field=valueFeedback` / `deft policy:enable-value-feedback -- --confirm`; `deft value:show`; `deft feedback:file`; `.deft/core/.agents/skills/deft-directive-feedback/SKILL.md` (#1709).

## Structured decision log (#1396 / #3211)
! Significant choices → `deft decision:write`; re-load → `deft decision:list` / `xbrief/decisions/`; depth `.deft/core/docs/decision-log.md` (not triage/ADRs/lessons).
## Eval and framework health (#1703)

! `deft eval:health` when orienting or after gate/policy changes (Tier 0; 4-hour debounce). Release: `deft eval:run` / `deft eval:report`; skill routing: `deft eval:triggers` (#1586 / #1703).

## Branch policy & branch verification

! Feature branches — `deft verify:branch`, `deft verify:forward-coverage`, `deft coverage:hotspots`, hooks, `deft check` (#746 / #747) — `.deft/core/scm/github.md` § Branch policy.
! Test placement + scope provenance (#3145) — `deft verify:test-boundary`, `deft verify:scope-provenance`, `deft verify:consumer-check-contract` (docs: `docs/test-boundary.md`, `docs/scope-provenance.md`, `docs/consumer-check-contract.md`); defaults warn-only until authored policy.

## Branch Policy Disclosure (#746)

! When `plan.policy.allowDirectCommitsToMaster = true`, surface via `deft policy:show --field=allowDirectCommitsToMaster` (#746) — `.deft/core/scm/github.md` § Branch policy.

## Windows PowerShell: multi-line git/gh bodies (#2646 / #2744)

! Multi-line git commit / gh issue|pr|comment bodies: write UTF-8 (no BOM) to OS temp, then `git commit -F` / `gh --body-file` / `deft scm:body:* --body-file`. Issue-body RMW on win32: `deft scm:body:issue:fetch --out-file` then edit the file then `deft scm:body:issue:edit --body-file` (#2607 postcondition verify). ⊗ bash heredocs, `<<<`, inline multi-line `--body`, or PS capture-concat of `gh api --jq .body` (string[]/$OFS destroys bodies — #2087, #2741, #1492). Detail: `.deft/core/scm/github.md` § #2646 / #2744. `ghx` is read-only — mutations stay on live `gh`.

## Contextual guardrails (runtime-detect lazy-load)

! Detect OS/shell; use portable syntax or explicit shell (#2568). `.deft/core/scm/github.md` (#2157/#2369): PS encoding→`deft verify:encoding` (#798); TS capture; cascade→`deft pr:wait-mergeable-and-merge`; SCM→`deft verify:scm-boundary`.
! Forge outage (#3422): drop GitHub I/O on attributed outage or repeated 429/502/503; report once to the human; re-probe on `plan.policy.forgeOutageRetryMinutes` (default 30; USER.md Personal wins). Depth: `scm/github.md` § #3180. Complements #3167 / #3180.

## Development Process

### Gate integrity (#3156)

! When a quality gate fails, fix the product/process/test under test — ⊗ clear red by editing the gate definition, verifier, reward, required check, coverage floor, or policy flag solely to go green. Deliberate gate changes go through issue/PR + review. Depth: `.deft/core/docs/gate-integrity.md` (refine-internal SkillOpt stays on #2436).

### Implementation Intent Gate (#810 / #1193)

! `deft xbrief:preflight -- <path>` on `xbrief/active/` before code-writing; action-verb (`build`, `implement`, `ship`, `swarm`, `run agents`, `start agent`) (#810). Slash-command sessions inherit only that verb (`DEFT_SESSION_SLASH_VERB`); non-implement verbs (`/github-issue`, `/triage`, …) MUST NOT authorize implement/push/PR/merge/deploy (#1193) — `commands.md` / `contracts/intent-ceiling.md`.

## Human merge gate (#1193)

! When `plan.policy.requireHumanMerge` is true (default if `autoDeployOnMerge`), agents may open PRs, may not merge. Override: `deft policy:allow-bot-merge -- --confirm` or `DEFT_ALLOW_BOT_MERGE=1` — `commands.md` / `contracts/intent-ceiling.md`.

### Story Start Gate

! `git status --short --branch` + `deft verify:story-ready`; `deft scope:promote -- <path>` / `deft scope:activate -- <path>` / `deft scope:complete -- <active-story-path>` (#1378) — `commands.md` § Scope xBRIEF Lifecycle.

## Commands

! `/deft:directive:*` namespace (#418 / #1670); full table in `.deft/core/commands.md` — load on demand.
<!-- /deft:managed-section -->
