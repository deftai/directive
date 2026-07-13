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

! On **mutation** session start (implementation intent or explicit operator request), run `deft session:start`; before any code-writing or `start_agent` dispatch run `deft verify:session-ritual -- --tier=gated` (stale after `plan.policy.sessionRitualStalenessHours`; records `deft verify:tools` / `deft doctor` / `deft agents:refresh` / `npm i -g @deftai/directive@latest` entrypoints; #1149 / #1348) — full quick/gated tiers, defer steps, headless bypass, and read-only default in `.deft/core/commands.md` § Session-start ritual.

## WIP cap

! Respect `plan.policy.wipCap` (default 20) — at cap `deft scope:promote` refuses; relief via `deft scope:demote --batch --older-than-days 30` (#2319 / #1121). Full WIP workflow: `.deft/core/.agents/skills/deft-directive-swarm/SKILL.md`.

## xBRIEF layout (#2034 / #2110)

Projects on the legacy `vbrief/` tree are still read-accepted; run `deft migrate:xbrief` to convert safely to `xbrief/` with semantic v0.6→v0.8 transforms. Legacy `x-vbrief/` reference tokens remain read-accepted until you migrate.

## Unmanaged project header (#2065)

! Do NOT treat the unmanaged AGENTS.md header as the work queue; ⊗ Do NOT add `Status`, `Next:`, or `Known Issues` blocks — they rot silently. See UPGRADING.md § AGENTS.md: managed vs unmanaged header for the Session orientation pointer and rationale.

## Cache-as-authoritative work selection (#1149)

! When the operator asks "what should I work on next?" / "build a cohort" / "what's the queue?", run `deft triage:queue --limit=10` (D11 / #1128) and present the ranked list before suggesting anything else. The agent MUST NOT recommend work from memory or open-GitHub-issue intuition. This is the consumer-side mirror of the maintainer rule of the same name; the triage queue is the source of truth for what to work on next.

⊗ Recommend a specific issue or xBRIEF without consulting `deft triage:queue` (or showing the operator the result of the consultation).

## Umbrella status reading (#1152 / #2066)

- ! Fetch issue comments via REST (`gh api repos/<owner>/<repo>/issues/<N>/comments`), read the `## Current shape (as of pass-N)` comment, and any linked context or `LockedDecisions` xBRIEF referenced there — following the reading order body -> current-shape comment -> amendment comments (claim-cites-state-surface, #2066). Prefer the deterministic read path: `deft umbrella:current-shape <N>` (or `task umbrella:current-shape <N>`) — it locates the canonical comment, validates #1152 sections, and never falls back to the issue body.
- ⊗ Conclude umbrella or epic status from the issue body alone. Any "X is done" / "X is the blocker" assertion about an umbrella MUST cite the current-shape comment or another state artifact, not the body.

## Deterministic questions runtime obligation (#1470)

! Any agent-initiated structured question MUST include `Discuss` and `Back` as the final two options — full Discuss-pause semantic in `.deft/core/contracts/deterministic-questions.md` (#1470 / #767).

## Issue body→comments reading (#2143)

Rationale + cross-references: preamble § 5.6 in `.deft/core/templates/agent-prompt-preamble.md` (#2143).

- ! Fetch both the issue body and `repos/<owner>/<repo>/issues/<N>/comments` via REST before concluding what the issue asks for or building a worker dispatch envelope. Read body first, then the comment thread in chronological order.
- ! `deft issue:ingest` / `task issue:ingest` fetches `/comments` by default and folds the thread into the ingested overview (#2143).
- ⊗ Build a dispatch envelope from the issue body alone when the issue has comments.

## Content packs

Deft ships versioned content packs (e.g. lessons learned from prior work) under `.deft/core/packs/`. Discover and LOAD pack content via the slice surface instead of reading whole pack files into context:

- `deft packs:slice --list-packs` -- discover which packs exist (short-name + version + one-line description). Registry-driven, so new packs appear automatically with no edit here.
- `deft packs:slice <pack> --list` -- discover the named slices a pack exposes.
- `deft packs:slice <pack> <slice> [-- <filters>]` -- load just the slice you need; read the slice, not the whole file.

! Before improvising on a problem, discover packs with `deft packs:slice --list-packs`, then load the relevant slice. This wiring references the discovery commands on purpose -- it never enumerates pack or slice names, so new packs/slices need no change here.

## Codebase MAP Projection (#1595 / #1498)

`xbrief/PROJECT-DEFINITION.xbrief.json` `plan.architecture.codeStructure` is the durable codebase-structure source. `.planning/codebase/MAP.md` is a generated orientation projection from that metadata plus provider/code-derived facts.

- ~ If `.planning/codebase/MAP.md` exists, read it as orientation before broad codebase scanning.
- ~ If it is absent or may be stale, run `deft codebase:map` and `deft verify:codebase-map-fresh` when those commands resolve; treat the result as advisory unless the current task edits `plan.architecture.codeStructure`, a configured provider artifact, or the generated MAP itself.
- ! When the MAP is wrong, update `plan.architecture.codeStructure` or the selected provider artifact, then regenerate the MAP.
- ⊗ Treat a stale or absent MAP as an unrelated implementation blocker, hand-edit `.planning/codebase/MAP.md`, or make the generated projection more authoritative than the xBRIEF metadata.

## Skills

Skill routing (which skill answers which trigger) is not a table in this policy section. To pick a skill, scan the **Skills Index** (Level-0) in `.deft/core/REFERENCES.md` — it lists every skill under `.deft/core/.agents/skills/` with a one-sentence description and trigger keywords, unified with the framework doc routing so you consult one place to decide what to load. Read a `SKILL.md` (Level-1) only when the index indicates a match. Before improvising a multi-step workflow, scan the skills catalog first — skills are versioned and tested. The `welcome` / `onboard triage` trigger invokes `deft triage:welcome --onboard` (N3 / #1143); for `lessons` / `prior art`, discover packs with `deft packs:slice --list-packs` then load the relevant slice (see Content packs above).

## Review-surface precedence (#2308)

! Route review work through `deft-directive-review-cycle` — full workflow in `.deft/core/.agents/skills/deft-directive-review-cycle/SKILL.md`; host review tools (`bugbot`, `security-review`, `review-*` skills) are advisory-only inputs, not the review of record (#2308 / #1862 / #2261 / #2019).

## Value feedback and attribution (#1709)

! `plan.policy.valueFeedback.enabled` defaults OFF — opt-in via `deft policy:show --field=valueFeedback` / `deft policy:enable-value-feedback -- --confirm`; pull-based detail via `deft value:show`; full rules in `.deft/core/.agents/skills/deft-directive-feedback/SKILL.md` (#1709). Trusted-org auto-enable uses `source=org-auto` (#2376); gap escalation via `deft feedback:file` is confirmation-gated.

## Eval and framework health (#1703)

! Run `deft eval:health` when orienting or after gate/policy changes (Tier 0; 4-hour debounce). Maintainer release eval: `deft eval:run` / `deft eval:report` (#1703).

## Branch policy & branch verification

! Work on feature branches — `deft verify:branch`, `deft verify:forward-coverage`, hooks, and `deft check` enforce default-branch protection (#746 / #747); full surfaces in `.deft/core/scm/github.md` § Branch policy.

## Branch Policy Disclosure (#746)

! When `plan.policy.allowDirectCommitsToMaster = true`, surface policy at session start via `deft policy:show --field=allowDirectCommitsToMaster` (#746) — full phrasing and override paths in `.deft/core/scm/github.md` § Branch policy.

## Contextual guardrails (runtime-detect lazy-load)

Contextual / platform-specific rules lazy-load from `.deft/core/scm/github.md` — load the matching section **before** the risky operation when your session matches a trigger (#2157 / #2369):

- ! **PowerShell / Windows** → § PowerShell platform-conditional rules (#798 / #1353); encoding gate: `deft verify:encoding`.
- ! **TS subprocess capture** → § Safe subprocess capture (#1366).
- ! **Cascade / batch merge** → § Cascade automation surface (#1369); canonical `deft pr:wait-mergeable-and-merge`.
- ! **GitHub CLI / SCM shim** → § SCM tooling (#884 / #1145); boundary gate: `deft verify:scm-boundary`.

## Development Process

### Implementation Intent Gate (#810)

! Run `deft xbrief:preflight -- <path>` before code-writing (`xbrief/active/` + `plan.status == "running"`); require explicit action-verb directive (`build`, `implement`, `ship`, `swarm`, `run agents`, `start agent`) (#810) — full rules in `.deft/core/commands.md` § Scope xBRIEF Lifecycle; `deft verify:cache-fresh` is gate-stack step 3 in `.deft/core/commands.md` § Session-start ritual.

### Story Start Gate

! Before starting stories run `git status --short --branch` and Gate 0 `deft verify:story-ready`; lifecycle via `deft scope:promote -- <path>` / `deft scope:activate -- <path>` / `deft scope:complete -- <active-story-path>` (#1378) — full workflow in `.deft/core/commands.md` § Scope xBRIEF Lifecycle.

## Commands

! Directive product commands use the `/deft:directive:*` namespace (#418 / #1670); the full command and alias table lives in `.deft/core/commands.md` — load on demand, not rendered here.
<!-- /deft:managed-section -->
