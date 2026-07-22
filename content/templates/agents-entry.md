<!-- deft:managed-section v3 -->
# Deft — AI Development Framework

Deft is installed in .deft/core/. Full guidelines: .deft/core/main.md

! If any .deft/core/.agents/skills/ path referenced in this file cannot be read (missing file, stale path from a previous framework version, or a deprecation redirect stub), read .deft/core/QUICK-START.md instead and follow it. QUICK-START refreshes this section idempotently for the current framework version.

## Session routing (#2176)

! **Read-only default** until mutation intent: load AGENTS.md / main.md / USER.md / `xbrief/PROJECT-DEFINITION.xbrief.json`; resolve USER.md via `deft session:start` (`USER.md resolved …`; win32 `%APPDATA%\deft\USER.md`; unix `~/.config/deft/USER.md`; ⊗ invent `~/.config/deft` on Windows #2544); confirm Deft alignment + addressing-name; ⊗ no mutable `deft session:start` / triage welcome / sync / branch-policy unless asked or implementation-ready (#2176) — `.deft/core/commands.md` § Session routing. Bootstrap: cold-start → README § Cold-start (#2273) ⊗ never `.deft/core/`; pre-cutover → setup Pre-Cutover (#2068); missing USER.md / PROJECT-DEFINITION → setup Phase 1/2 (#1813) ⊗ before answering; else main → USER → PROJECT-DEFINITION; ~ sync. Mutation → `deft session:start` then `deft verify:session-ritual -- --tier=gated` (#1149). ? `deft session:start -- --read-only` (#2176).

## Session-start ritual (#1149)

! On **mutation** session start, run `deft session:start`; before code-writing or `start_agent` dispatch run `deft verify:session-ritual -- --tier=gated` (stale after `plan.policy.sessionRitualStalenessHours`; records `deft verify:tools` / `deft doctor` / `deft verify:cache-fresh` / `deft agents:refresh` / `npm i -g @deftai/directive@latest`; #1149 / #1348) — `.deft/core/commands.md` § Session-start ritual.

## WIP cap

! Respect `plan.policy.wipCap` (default 20) — at cap `deft scope:promote` refuses; relief via `deft scope:demote --batch --older-than-days 30` (#2319 / #1121). Full WIP: `.deft/core/.agents/skills/deft-directive-swarm/SKILL.md`.

## xBRIEF layout (#2034 / #2110)

Legacy `vbrief/` read-accepted; `deft migrate:xbrief` for `xbrief/` (v0.6→v0.8). `x-vbrief/` tokens read-accepted until migrated.

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

## Review-surface precedence (#2308)

! Route PR shepherding / review work through `deft-directive-review-cycle` — `.deft/core/.agents/skills/deft-directive-review-cycle/SKILL.md`; host `babysit` / `bugbot` / `security-review` advisory-only (#2308 / #2261).

## Value feedback and attribution (#1709)

! `plan.policy.valueFeedback.enabled` defaults OFF — `deft policy:show --field=valueFeedback` / `deft policy:enable-value-feedback -- --confirm`; `deft value:show`; `deft feedback:file`; `.deft/core/.agents/skills/deft-directive-feedback/SKILL.md` (#1709).

## Eval and framework health (#1703)

! `deft eval:health` when orienting or after gate/policy changes (Tier 0; 4-hour debounce). Release: `deft eval:run` / `deft eval:report`; skill routing: `deft eval:triggers` (#1586 / #1703).

## Branch policy & branch verification

! Feature branches — `deft verify:branch`, `deft verify:forward-coverage`, `deft coverage:hotspots`, hooks, `deft check` (#746 / #747) — `.deft/core/scm/github.md` § Branch policy.

## Branch Policy Disclosure (#746)

! When `plan.policy.allowDirectCommitsToMaster = true`, surface via `deft policy:show --field=allowDirectCommitsToMaster` (#746) — `.deft/core/scm/github.md` § Branch policy.

## Windows PowerShell: multi-line git/gh bodies (#2646 / #2744)

! Multi-line git commit / gh issue|pr|comment bodies: write UTF-8 (no BOM) to OS temp, then `git commit -F` / `gh --body-file` / `deft scm:body:* --body-file`. Issue-body RMW on win32: `deft scm:body:issue:fetch --out-file` then edit the file then `deft scm:body:issue:edit --body-file` (#2607 postcondition verify). ⊗ bash heredocs, `<<<`, inline multi-line `--body`, or PS capture-concat of `gh api --jq .body` (string[]/$OFS destroys bodies — #2087, #2741, #1492). Detail: `.deft/core/scm/github.md` § #2646 / #2744. `ghx` is read-only — mutations stay on live `gh`.

## Contextual guardrails (runtime-detect lazy-load)

! Detect OS/shell; use portable syntax or explicit shell (#2568). `.deft/core/scm/github.md` (#2157/#2369): PS encoding→`deft verify:encoding` (#798); TS capture; cascade→`deft pr:wait-mergeable-and-merge`; SCM→`deft verify:scm-boundary`.

## Development Process

### Implementation Intent Gate (#810)

! `deft xbrief:preflight -- <path>` on `xbrief/active/` before code-writing; action-verb (`build`, `implement`, `ship`, `swarm`, `run agents`, `start agent`) (#810) — `commands.md` § Scope xBRIEF Lifecycle.

### Story Start Gate

! `git status --short --branch` + `deft verify:story-ready`; `deft scope:promote -- <path>` / `deft scope:activate -- <path>` / `deft scope:complete -- <active-story-path>` (#1378) — `commands.md` § Scope xBRIEF Lifecycle.

## Commands

! `/deft:directive:*` namespace (#418 / #1670); full table in `.deft/core/commands.md` — load on demand.
<!-- /deft:managed-section -->
