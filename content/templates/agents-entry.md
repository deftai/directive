<!-- deft:managed-section v3 -->
# Deft — AI Development Framework

Deft is installed in .deft/core/. Full guidelines: .deft/core/main.md

! If any .deft/core/.agents/skills/ path referenced in this file cannot be read (missing file, stale path from a previous framework version, or a deprecation redirect stub), read .deft/core/QUICK-START.md instead and follow it. QUICK-START refreshes this section idempotently for the current framework version.

## Session routing (#2176)

! **Read-only default** until mutation intent (Q&A, Plan Mode, ticket-shaping): load AGENTS.md, main.md, USER.md, `xbrief/PROJECT-DEFINITION.xbrief.json`; confirm Deft alignment ("Deft Directive active" + addressing-name from USER.md); ⊗ do not run mutable `deft session:start`, triage welcome, sync, or branch-policy ceremony unless the operator asks or the task is implementation-ready (#2176). Full contract: `.deft/core/commands.md` § Session routing.

**Bootstrap card** (before answering):
- `deft` / `directive` won't run → README.md § Cold-start bootstrap (#2273); ⊗ never `.deft/core/`
- Pre-cutover artifacts → `.deft/core/.agents/skills/deft-directive-setup/SKILL.md` § Pre-Cutover Detection Guard (#2068)
- USER.md missing → setup SKILL Phase 1; `xbrief/PROJECT-DEFINITION.xbrief.json` missing → setup SKILL Phase 2 (#1813); ⊗ respond before phase completes
- Config complete → read main.md → USER.md → PROJECT-DEFINITION (USER.md wins on conflicts); ~ `deft-directive-sync` on return

**Mutation boundary:** code-writing, scope lifecycle, `start_agent`, commits, push, or release → `deft session:start` then `deft verify:session-ritual -- --tier=gated` per `.deft/core/commands.md` § Session-start ritual (#1149).
- ? `deft session:start -- --read-only` — alignment only, no ritual-state (#2176)

## Session-start ritual (#1149)

! On **mutation** session start, run `deft session:start`; before code-writing or `start_agent` dispatch run `deft verify:session-ritual -- --tier=gated` (stale after `plan.policy.sessionRitualStalenessHours`; records `deft verify:tools` / `deft doctor` / `deft verify:cache-fresh` / `deft agents:refresh` / `npm i -g @deftai/directive@latest`; #1149 / #1348) — `.deft/core/commands.md` § Session-start ritual.

## WIP cap

! Respect `plan.policy.wipCap` (default 20) — at cap `deft scope:promote` refuses; relief via `deft scope:demote --batch --older-than-days 30` (#2319 / #1121). Full WIP workflow: `.deft/core/.agents/skills/deft-directive-swarm/SKILL.md`.

## xBRIEF layout (#2034 / #2110)

Projects on legacy `vbrief/` still read-accepted; run `deft migrate:xbrief` for `xbrief/` (v0.6→v0.8). `x-vbrief/` tokens read-accepted until migrated.

## Unmanaged project header (#2065)

! Do NOT treat the unmanaged AGENTS.md header as the work queue; ⊗ Do NOT add `Status`, `Next:`, or `Known Issues` blocks — they rot silently. See UPGRADING.md § AGENTS.md: managed vs unmanaged header for the Session orientation pointer and rationale.

## Cache-as-authoritative work selection (#1149)

! "what next?" / cohort / queue → `deft triage:queue --limit=10` (D11 / #1128); present ranked list first — `.deft/core/commands.md` § Backlog Triage.

⊗ Recommend issue or xBRIEF without `deft triage:queue` (or showing its result).

## Umbrella status reading (#1152 / #2066)

! `issues/<N>/comments` via REST → `## Current shape (as of pass-N)` + linked context (claim-cites-state-surface, #2066); body → shape → amendments. Prefer `deft umbrella:current-shape <N>` — full contract: `.deft/core/templates/agent-prompt-preamble.md` § 5.6.

⊗ Conclude umbrella or epic status from the issue body alone — cite current-shape or another state artifact (#2066).

## Deterministic questions runtime obligation (#1470)

! Any agent-initiated structured question MUST include `Discuss` and `Back` as the final two options — full Discuss-pause semantic in `.deft/core/contracts/deterministic-questions.md` (#1470 / #767).

## Issue body→comments reading (#2143)

! Fetch body + `issues/<N>/comments` via REST before requirements or dispatch — `.deft/core/templates/agent-prompt-preamble.md` § 5.6 / `deft issue:ingest` (#2143).

⊗ Build a dispatch envelope from the issue body alone when the issue has comments.

## Content packs

! Before improvising, discover packs with `deft packs:slice --list-packs`, then load via `deft packs:slice <pack> --list` / `deft packs:slice <pack> <slice>` — full pack surface in `.deft/core/commands.md` (§ packs); never enumerate pack or slice names here.

## Codebase MAP Projection (#1595 / #1498)

! `plan.architecture.codeStructure` is durable SoT; `.planning/codebase/MAP.md` is generated orientation — use `deft codebase:map` / `deft verify:codebase-map-fresh` (`.deft/core/commands.md` § Project And Architecture). ⊗ Do not hand-edit the MAP, block unrelated work on stale/absent MAP, or treat the projection as more authoritative than the xBRIEF metadata (#1595 / #1498).

## Skills

! Skill routing lives in the **Skills Index** (Level-0) in `.deft/core/REFERENCES.md` — scan it before improvising; read a `SKILL.md` only on index match. `welcome` / `onboard triage` → `deft triage:welcome --onboard` (N3 / #1143); `lessons` / `prior art` → Content packs `packs:slice` above.

## Review-surface precedence (#2308)

! Route review work through `deft-directive-review-cycle` — `.deft/core/.agents/skills/deft-directive-review-cycle/SKILL.md`; host tools (`bugbot`, `security-review`, `review-*` skills) advisory-only (#2308).

## Value feedback and attribution (#1709)

! `plan.policy.valueFeedback.enabled` defaults OFF — opt-in via `deft policy:show --field=valueFeedback` / `deft policy:enable-value-feedback -- --confirm`; detail via `deft value:show`; gaps via `deft feedback:file`; rules in `.deft/core/.agents/skills/deft-directive-feedback/SKILL.md` (#1709).

## Eval and framework health (#1703)

! Run `deft eval:health` when orienting or after gate/policy changes (Tier 0; 4-hour debounce). Maintainer release eval: `deft eval:run` / `deft eval:report` (#1703).

## Branch policy & branch verification

! Work on feature branches — `deft verify:branch`, `deft verify:forward-coverage`, hooks, and `deft check` enforce default-branch protection (#746 / #747); full surfaces in `.deft/core/scm/github.md` § Branch policy.

## Branch Policy Disclosure (#746)

! When `plan.policy.allowDirectCommitsToMaster = true`, surface policy at session start via `deft policy:show --field=allowDirectCommitsToMaster` (#746) — full phrasing and override paths in `.deft/core/scm/github.md` § Branch policy.

## Contextual guardrails (runtime-detect lazy-load)

! Lazy-load `.deft/core/scm/github.md` sections before risky ops (#2157 / #2369): PowerShell → `deft verify:encoding` (#798); TS capture (#1366); cascade → `deft pr:wait-mergeable-and-merge` (#1369); SCM → `deft verify:scm-boundary` (#884).

## Development Process

### Implementation Intent Gate (#810)

! `deft xbrief:preflight -- <path>` on `xbrief/active/` before code-writing; action-verb directive (`build`, `implement`, `ship`, `swarm`, `run agents`, `start agent`) (#810) — `.deft/core/commands.md` § Scope xBRIEF Lifecycle.

### Story Start Gate

! `git status --short --branch` + `deft verify:story-ready`; lifecycle via `deft scope:promote -- <path>` / `deft scope:activate -- <path>` / `deft scope:complete -- <active-story-path>` (#1378) — `.deft/core/commands.md` § Scope xBRIEF Lifecycle.

## Commands

! Directive product commands use the `/deft:directive:*` namespace (#418 / #1670); the full command and alias table lives in `.deft/core/commands.md` — load on demand, not rendered here.
<!-- /deft:managed-section -->
