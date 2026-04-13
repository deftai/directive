# Deft Directive — Phases 1–3 SPECIFICATION

Deft Directive is a Markdown framework for AI agents to use when generating software. It defines layered behavioral rules, workflow strategies, and quality gates across four components: (1) the Markdown framework (primary product — .md files consumed by agents at runtime), (2) the Python CLI (`run` — terminal setup and spec generation), (3) the Go installer (`cmd/deft-install/` — standalone binary for end-user install), and (4) the test suite (`tests/` — CLI and content validation). This specification covers Phase 1 (bug fixes and adoption blockers), Phase 2 (content fixes), and Phase 3 (CI). Phases 4–5 are deferred; see PRD.md and #67 for scope boundaries. References: PRD.md, .planning/codebase/ARCHITECTURE.md, docs/research/deft-directive-research.md.

## t1.1.1: Add inference boundary guards to deft-setup SKILL.md Phase 2 (FR-1, FR-2)  `[completed]`

Add ⊗ rules to the Inference section of Phase 2 in skills/deft-setup/SKILL.md: never scan ./deft/ for build files; never run git commands inside ./deft/. Only inspect project root and non-deft subdirectories. Closes #79.

- SKILL.md Phase 2 Inference section contains ⊗ rule: MUST NOT scan ./deft/ for go.mod, package.json, pyproject.toml, Cargo.toml, *.csproj
SKILL.md Phase 2 Inference section contains ⊗ rule: MUST NOT run git commands inside ./deft/
tests/content/test_skills.py passes

**Traces**: FR-1, FR-2

## t1.1.2: Add project name fallback prompt when no build files detected (FR-3)  `[completed]`

**Depends on**: t1.1.1

Update deft-setup SKILL.md Phase 2 to prompt the user for a project name when codebase inference finds no build files at the project root. Currently falls through to deft internals. Closes #80.

- Phase 2 Inference section includes explicit fallback: if no build files found at project root, default to directory name and ask for confirmation
Fallback rule applies to all tracks via the global Inference section
- Track 1 and Track 2 Step 1 text references "directory name" explicitly
tests/content/test_skills.py covers no-build-files fallback presence in SKILL.md

**Traces**: FR-3

## t1.1.3: Remove Primary Languages from USER.md template and Phase 1 interview (FR-4)  `[completed]`

Language is a project-level concern determined per-project via codebase inference, not a user preference. Remove from USER.md template, Phase 1 Track 1 Step 2, Track 2 Step 2. Update Phase 2 Step 3 to always infer first. Closes #107.

- USER.md template in SKILL.md no longer includes **Primary Languages** field
Phase 1 Track 1 has no Step 2 asking about languages
Phase 1 Track 2 has no language step
Phase 2 Step 3 infers from codebase
falls back to open ask (no USER.md default pre-fill)
tests/content/test_skills.py covers: USER.md template has no Primary Languages field, Phase 1 Track 1 has no language step

**Traces**: FR-4

## t1.1.4: Add deployment platform question before language in deft-setup Phase 2 (FR-5)  `[completed]`

**Depends on**: t1.1.3

Ask deployment platform (web, mobile, desktop, embedded, CLI, cloud service, other) before asking about language. Platform context narrows language shortlist. Track 1 only. Closes #108.

- Phase 2 Track 1 Question Sequence: deployment platform question precedes language question
Platform answer informs language shortlist shown in next question
Track 2 and Track 3 unaffected (simplified paths)

**Traces**: FR-5

## t1.1.5: Add headless/cloud agent bypass to AGENTS.md First Session gate (FR-30)  `[completed]`

Add a bypass instruction at the top of the First Session block in AGENTS.md so cloud agents, CI agents, and scheduled tasks skip the interactive onboarding flow when dispatched with an explicit task. Closes #142.

- AGENTS.md First Session section contains a bypass rule: if dispatched with a specific task, skip onboarding and proceed directly
Bypass rule appears before the USER.md/PROJECT.md/SPECIFICATION.md checks
tests/content/test_agents_md.py covers bypass presence

**Traces**: FR-30

## t1.2.1: Audit and fix vBRIEF generation in cmd_spec (FR-6)  `[completed]`

The run script's cmd_spec generates specification.vbrief.json. Audit the output format against spec_validate.py and vbrief/vbrief.md. Ensure: vBRIEFInfo envelope with version 0.5; plan object with title, status, items; task status values from valid enum (pending/running/completed/blocked/cancelled). The legacy 'todo'/'doing'/'done' values from old vBRIEF must not be used. Closes #72 (CLI path).

- task spec:validate passes on all cmd_spec output
task spec:render succeeds on approved spec
tests/cli/test_spec.py covers vBRIEF output format

**Traces**: FR-6, NFR-4

## t1.2.2: Audit and fix vBRIEF generation in deft-setup Phase 3 (FR-6)  `[completed]`

**Depends on**: t1.2.1

The deft-setup skill Phase 3 also generates specification.vbrief.json. Same audit as t1.2.1 for the agent-skill path. Update skills/deft-setup/SKILL.md Output sections to reference the correct schema. Closes #72 (agent skill path).

- SKILL.md Phase 3 Output sections reference correct vBRIEF field names (vBRIEFInfo envelope with plan object containing title, status, items
- pending/running/completed/blocked/cancelled for task status, not legacy todo/doing/done)
tests/content/test_vbrief_schema.py assertions strengthened to catch field name violations

**Traces**: FR-6, NFR-4

## t1.3.1: Fix run bootstrap infinite loop when strategies/ is empty (FR-7)  `[completed]`

cmd_bootstrap enters an infinite loop when get_available_strategies() returns an empty list or the strategies/ directory is unresolvable. Add a guard: if no strategies found, default to 'interview' and warn rather than looping. Closes #91, #92.

- cmd_bootstrap completes without looping when strategies/ is empty
Fallback to 'interview' strategy is logged as a warning
tests/cli/test_bootstrap.py covers empty-strategies-dir scenario

**Traces**: FR-7

## t1.3.2: Add version display to all run CLI commands on startup (FR-10)  `[completed]`

All cmd_* functions should print the VERSION on entry (e.g. 'Deft CLI v0.4.2'). Note: VERSION in run is currently 0.4.2; this value is provisional and will display behind the framework's 0.5.2 until version unification is addressed (see PRD Open Question 1). Closes #49.

- All cmd_* functions print version string on startup
Version string format: 'Deft CLI v{VERSION}'
tests/cli/test_import_smoke.py or per-command tests assert version output

**Traces**: FR-10

## t1.4.1: Merge strategies/default.md into strategies/interview.md and remove default.md (FR-8)  `[completed]`

default.md is a duplicate of interview.md. Merge any unique content into interview.md, then delete default.md. Update any references to default.md. Closes #31.

- strategies/default.md no longer exists
strategies/interview.md contains all content from former default.md (or supersedes it)
No .md file in the repo references strategies/default.md
tests/content/test_structure.py updated to not assert default.md exists
test passes

**Traces**: FR-8

## t1.4.2: Update strategies/brownfield.md to redirect to strategies/map.md (FR-9)  `[completed]`

brownfield.md is a legacy alias for map.md. Replace content with a short redirect note pointing to map.md. Do not delete (backward compatibility for any existing references). Closes #50 (brownfield portion).

- strategies/brownfield.md contains only a redirect to strategies/map.md
strategies/map.md is the canonical document
tests/content/test_standards.py passes

**Traces**: FR-9

## t1.5.1: Write coding/build-output.md — build output validation directive (FR-11)  `[completed]`

New file documenting rules for validating build output (dist/, bin/, artifacts). Agents must: verify expected artifacts exist post-build, check artifact sizes are non-zero, fail loudly on silent build failures. Closes #105.

- coding/build-output.md exists with RFC2119 legend
Contains ! rules for: verifying artifact existence, checking non-zero size, failing on missing expected outputs
Referenced from coding/coding.md

**Traces**: FR-11

## t1.5.2: Document toolchain validation gate in framework (FR-12)  `[completed]`

Create a new coding/toolchain.md requiring agents to verify required tools are installed before beginning implementation. Reference it from coding/coding.md. Closes #106.

- Framework contains ! rule: before implementation begins, verify all required tools are available (e.g. go version, uv --version, task --version)
Rule lives in a new coding/toolchain.md, referenced (linked) from coding/coding.md

**Traces**: FR-12

## t1.6.1: Strengthen testing enforcement as a hard gate (#68) (FR-30)  `[completed]`

Agents treat testing as a cleanup step rather than a gate. Add a MUST rule to main.md Decision Making section requiring tests to pass before any implementation is considered complete. Add testing anti-pattern to deft-build SKILL.md. A general 'proceed' instruction does not waive the testing gate. Closes #68.

- main.md Decision Making section contains ! rule: no implementation is complete until tests are written and `task check` passes
deft-build SKILL.md Anti-Patterns contains ⊗ rule: proceed to next task or phase without tests passing
tests/content/test_standards.py passes

**Traces**: FR-30

## t1.6.2: Strengthen change lifecycle gate against broad 'proceed' instructions (#123) (FR-31)  `[completed]`

Agents skip the `/deft:change` proposal when the user says 'proceed'. Strengthen the rule in main.md to explicitly state broad approval does NOT satisfy the gate. Add checklist item to PR template. Add pre-flight gate to deft-build SKILL.md. Add `/deft:change` verification to deft-review-cycle Phase 1 audit. Batch Phase 1 audit gaps with Phase 2 fixes. Closes #123.

- main.md Decision Making `/deft:change` rule explicitly states: a broad 'proceed' does NOT satisfy this gate
- user must acknowledge the named change
.github/PULL_REQUEST_TEMPLATE.md checklist contains `/deft:change <name>` item (or N/A for <3 file changes)
deft-build SKILL.md contains change lifecycle pre-flight gate before Step 1
deft-review-cycle SKILL.md Phase 1 audit includes `/deft:change` verification step
deft-review-cycle SKILL.md Step 3 explicitly requires Phase 1 audit gaps to be batched with Phase 2 fixes
tests/content/test_standards.py passes

**Traces**: FR-31

## t1.6.3: Context-aware branching for solo projects (#138) (FR-32)  `[completed]`

The mandatory branch + change-proposal rule is too prescriptive for single-author projects. Add conditional wording to main.md: team projects (2+ contributors) keep mandatory branch; solo projects may commit directly for changes covered by the quality gate, but SHOULD branch for risky/architectural changes. Full config-driven approach deferred to Phase 5 with #77. Closes #138.

- main.md Decision Making change lifecycle rule has context-aware qualifier: mandatory for team projects, recommended for solo projects with quality gate as enforcement
tests/content/test_standards.py passes

**Traces**: FR-32

## t1.6.4: Strengthen vBRIEF source step prohibition (#139) (FR-33)  `[completed]`

Agent writes SPECIFICATION.md directly instead of creating the vbrief source file first. Add explicit ⊗ rule to main.md vBRIEF Persistence section. Add anti-pattern to deft-build SKILL.md. Closes #139.

- main.md vBRIEF Persistence section contains ⊗ rule: Write SPECIFICATION.md directly — it MUST be generated from specification.vbrief.json
deft-build SKILL.md Anti-Patterns contains ⊗ rule against writing SPECIFICATION.md directly
tests/content/test_standards.py passes

**Traces**: FR-33

## t1.7.1: Add Greptile pre-flight check and integration guide (#166)  `[completed]`

Add pre-flight check to deft-review-cycle SKILL.md verifying triggerOnUpdates is enabled before entering the review/fix loop. Create tools/greptile.md documenting recommended Greptile dashboard and per-repo settings, covering triggerOnUpdates/statusCheck configuration, check runs vs. commit statuses distinction, troubleshooting, and anti-patterns. Closes #166.

- skills/deft-review-cycle/SKILL.md contains Pre-Flight Check section verifying triggerOnUpdates is enabled
tools/greptile.md exists documenting Greptile configuration, check runs vs. commit statuses, troubleshooting, and anti-patterns
tests/content/test_skills.py passes

**Traces**: #166

## t1.7.2: Add hard gate against direct-to-master agent commits (#171)  `[completed]`

Add ⊗ hard gate to main.md, AGENTS.md, and skills/deft-build/SKILL.md prohibiting agents from committing or pushing directly to master. PROJECT.md `Allow direct commits to master: true` under `## Branching` provides opt-in escape hatch for solo/trunk-based projects. Add branching preference question to cmd_project and deft-setup Phase 2 Track 1. Closes #171.

- main.md Decision Making contains ⊗ rule: commit or push directly to the default branch
AGENTS.md Branching section contains the same ⊗ rule
skills/deft-build/SKILL.md contains the same ⊗ rule
PROJECT.md `Allow direct commits to master: true` documented as opt-in escape hatch
cmd_project and deft-setup Phase 2 Track 1 ask branching preference
tests/content/test_standards.py passes

**Traces**: #171

## t1.7.3: Review cycle push discipline and polling cadence (#175)  `[completed]`

Add ⊗ rule to skills/deft-review-cycle/SKILL.md Step 4 prohibiting additional commits while Greptile is reviewing current head. Add ~ 60s minimum poll interval guidance. Codify both as meta/lessons.md Review Cycle Monitoring lessons. Closes #175.

- skills/deft-review-cycle/SKILL.md Step 4 contains ⊗ rule: do not push additional commits while Greptile is reviewing
skills/deft-review-cycle/SKILL.md Step 4 contains ~ 60s minimum poll interval guidance
meta/lessons.md contains Review Cycle Monitoring lessons #2 and #3
tests/content/test_skills.py passes

**Traces**: #175

## t1.7.4: Correct oz agent run/run-cloud distinction in deft-swarm (#172)  `[completed]`

Correct skills/deft-swarm/SKILL.md Phase 3 — oz agent run is local (preferred automated launch path), oz agent run-cloud is the cloud path. Rewrite launch options A/B/C, fix prerequisites and anti-patterns. Add correction addenda to meta/lessons.md lessons #1 and #7. Closes #172.

- skills/deft-swarm/SKILL.md Phase 3 correctly states oz agent run is local, oz agent run-cloud is cloud
Launch options A/B/C accurately reflect local vs. cloud paths
meta/lessons.md lessons #1 and #7 contain correction addenda
tests/content/test_skills.py passes

**Traces**: #172

## t1.7.5: Document Option A (oz agent run) context limitations in deft-swarm (#179)  `[completed]`

Update skills/deft-swarm/SKILL.md Phase 3 to accurately reflect that Option A (oz agent run) does not receive global Warp Drive rules, MCP server UUIDs, or auto-injected context. Demote Option A from preferred, elevate Option B as recommended launch method. Document inline MCP JSON workaround. Add anti-patterns. Record finding in meta/lessons.md. Closes #179.

- skills/deft-swarm/SKILL.md Phase 3 Option A marked as currently limited with known-limitations callout referencing #179
Option B marked as recommended with explicit list of context advantages over Option A
Inline MCP JSON workaround documented in Option A section
Anti-patterns section contains entry about assuming Option A gets global Warp Drive rules
Default launch changed from Option A to Option B
meta/lessons.md contains Option A context limitations lesson
tests/content/test_skills.py passes

**Traces**: #179

## t1.8.1: vBRIEF conformance audit — remaining issues post-PR #130 (#126, #144)  `[completed]`

**Depends on**: t1.2.1, t1.2.2

Agent-generated specification.vbrief.json files have remaining conformance issues beyond the #72 fix (PR #130): wrong narrative value type (object instead of string per #144), wrong child key (`items` instead of `subItems` per #144). Verify current state post-PR #130 and fix any remaining violations in the generation chain (cmd_spec, deft-setup Phase 3, templates). Closes #126, #144.

- task spec:validate passes on freshly agent-generated specification.vbrief.json
narrative values conform to vBRIEF schema type expectations
Nested items use correct key name per vBRIEF schema
tests/content/test_vbrief_schema.py updated to catch these specific violations

**Traces**: #126, #144

## t1.8.2: Fix invalid vBRIEF reference types (#133)  `[completed]`

Generated vBRIEF files use invalid reference types (`x-vbrief/context`, `x-vbrief/research`) that fail schema validation. Upstream deftai/vBRIEF#2 resolved — reference type expanded from enum to pattern. Vendor updated schema. Closes #133.

- vbrief/schemas/vbrief-core.schema.json updated with expanded reference type pattern from upstream
Generated vBRIEF files pass schema validation for reference types
tests/content/test_vbrief_schema.py covers reference type validation

**Traces**: #133

## t1.9.3: Remove defensive vBRIEF reference-type workarounds (#191)  `[completed]`

Upstream deftai/vBRIEF#2 resolved — remove any defensive workarounds that were added while the reference type enum was restricted to `x-vbrief/plan`. Verify no interim callouts remain in vbrief/vbrief.md, templates/make-spec.md, or spec_validate.py. Closes #191.

- No defensive reference-type workarounds remain in vbrief/vbrief.md, templates/make-spec.md, or scripts/spec_validate.py
- vbrief/schemas/vbrief-core.schema.json uses expanded reference type pattern (prerequisite: t1.8.2)

**Traces**: #191

## t1.9.4: Add autonomous polling imperative to deft-review-cycle (#184)  `[completed]`

Agents stop and ask the user after pushing instead of autonomously polling for the Greptile review. Add ! rule to Step 4 requiring autonomous polling without stopping. Add anti-pattern. Add candidate meta/lessons.md entry. Closes #184.

- skills/deft-review-cycle/SKILL.md Step 4 contains ! rule: after pushing, agent MUST autonomously poll for review updates without stopping to ask the user
- skills/deft-review-cycle/SKILL.md Anti-Patterns contains ⊗ entry: stopping and asking the user whether to continue after pushing
- meta/lessons.md contains candidate entry about autonomous polling

**Traces**: #184

## t1.9.5: Add proactive test coverage step to deft-review-cycle (#192)  `[completed]`

After committing Greptile fixes, agents re-trigger CI without checking test coverage of changed lines. Add explicit step between fix commit and CI re-trigger to scan changed lines, identify untested code paths, and write tests in the same batch. Eliminates one CI round-trip per fix cycle. Closes #192.

- skills/deft-review-cycle/SKILL.md contains explicit step (between Step 3 fix commit and Step 4 push) to scan changed lines, identify untested code paths, and write tests
- Step is positioned to eliminate one CI round-trip per fix cycle
- skills/deft-review-cycle/SKILL.md Anti-Patterns contains ⊗ entry: push fix commits without scanning changed lines for untested code paths

**Traces**: #192

## t1.8.3: Consistent ./deft/ installation path (#116)  `[completed]`

All deft files must be installed consistently under ./deft/ — placement is currently inconsistent across projects. Audit the installer and documentation to ensure consistent placement. Closes #116.

- deft-install places all framework files under ./deft/ consistently
- No framework files installed outside ./deft/ (except AGENTS.md and .agents/ at project root)
- Installer tests cover consistent path placement

**Traces**: #116

## t1.8.4: PR merge hygiene — issues not closed and roadmap not updated (#167)  `[completed]`

PRs merged but issues not closed and roadmap not updated. Root cause investigation needed (closing keywords, squash merge, ROADMAP convention). Update PR template and review cycle skill. Closes #167.

- Root cause identified and documented (closing keywords vs. squash merge behavior)
.github/PULL_REQUEST_TEMPLATE.md updated with closing keyword guidance
skills/deft-review-cycle/SKILL.md updated with post-merge verification step
AGENTS.md or CONTRIBUTING.md documents ROADMAP update convention

**Traces**: #167

## t1.9.1: Change gate UX — replace name-echo with yes/no confirmation (#185)  `[completed]`

The /deft:change confirmation gate requires users to retype the full change name, which is tedious for long descriptive names. Replace with a simple yes/no confirmation prompt — the agent presents the change name and asks for explicit confirmation (yes/confirmed/approve). Still rejects vague 'proceed'/'do it'/'go ahead'. Closes #185.

- main.md Decision Making /deft:change rule uses yes/no confirmation instead of name echo
skills/deft-build/SKILL.md Change Lifecycle Gate uses same yes/no confirmation semantics
skills/deft-review-cycle/SKILL.md Phase 1 audit updated to match
.github/PULL_REQUEST_TEMPLATE.md checklist reflects new confirmation wording
tests/content/test_standards.py passes

**Traces**: #185

## t1.9.2: Add enforcement markers to AGENTS.md pre-implementation checklist (#186)  `[completed]`

AGENTS.md 'Before code changes' checklist uses plain language without RFC2119 enforcement markers. Agent treated it as advisory and skipped spec coverage check, branch creation, and /deft:change proposal when user said 'yes'. Add ! (MUST) markers to all pre-implementation items and add a new anti-pattern. Closes #186.

- AGENTS.md 'Before code changes' items prefixed with ! (MUST) markers
AGENTS.md contains anti-pattern: Begin editing files before checking spec coverage and creating a feature branch
tests/content/test_agents_md.py passes

**Traces**: #186

## t1.9.3: Replace static launch options with runtime capability detection in deft-swarm (#188)  `[completed]`

Replace the static Option A/B/C launch path selection in skills/deft-swarm/SKILL.md Phase 3 with runtime capability detection. The agent probes for `start_agent` tool availability at runtime, uses it directly if available (Warp orchestration support), falls back to manual Warp tabs if not. A Warp environment gate detects whether running inside Warp (`WARP_*` environment variables or `start_agent` presence) before offering Warp-specific launch paths. Cloud via `oz agent run-cloud` preserved as explicit user-requested escape hatch only. Closes #188.

- skills/deft-swarm/SKILL.md Phase 3 uses runtime detection instead of static Option A/B/C presentation
- `start_agent` availability probed at runtime; if available, used as preferred launch path
- Warp environment detected via `WARP_*` environment variables or `start_agent` tool presence
- Manual Warp tabs used as fallback when `start_agent` not available but Warp detected
- Cloud (`oz agent run-cloud`) preserved as explicit user-requested escape hatch only
- Anti-patterns updated to reflect dynamic detection approach
- tests/content/test_skills.py passes

**Traces**: #188

## t1.9.4: Add mandatory analyze phase to deft-swarm before task selection (#199)  `[completed]`

Add Phase 0 — Analyze to skills/deft-swarm/SKILL.md before Phase 1 (Select). The new phase reads ROADMAP.md and SPECIFICATION.md, surfaces blockers (blocked spec tasks, missing spec coverage, dependency conflicts), presents analysis summary to the user, and requires explicit user approval before proceeding to task selection. Closes #199.

- skills/deft-swarm/SKILL.md contains Phase 0 — Analyze before Phase 1 — Select
- Phase 0 reads ROADMAP.md and SPECIFICATION.md
- Phase 0 surfaces blockers: blocked spec tasks, missing spec coverage, dependency conflicts
- Phase 0 presents analysis summary with candidate items, blockers, and missing spec tasks
- Phase 0 requires explicit user approval (yes/confirmed/approve) before proceeding
- Anti-patterns section contains entry prohibiting proceeding to Phase 1 without Phase 0 completion
- tests/content/test_skills.py passes

**Traces**: #241

## t1.12.2: Strengthen batch-fix enforcement in deft-review-cycle (#250)  `[completed]`

Agents push one fix commit per Greptile finding instead of batching all findings into a single commit, causing N re-review cycles instead of 1. Add explicit pre-commit gate to Phase 2 Step 3 requiring full review re-read before committing. Add anti-patterns against per-finding fix commits. Closes #250.

- skills/deft-review-cycle/SKILL.md Phase 2 Step 3 contains ! pre-commit gate requiring full Greptile review re-read before committing fixes
- Anti-Patterns section contains ⊗ entry: push a fix commit that addresses fewer findings than the current review surfaces
- Anti-Patterns section contains ⊗ entry: push after fixing a P1 without checking for additional P0 or P1 findings in the same review
- tests/content/test_skills.py passes

**Traces**: #250

## t2.1.1: Update all stale core/user.md and core/project.md references to canonical paths (FR-13)  `[completed]`

Find all .md references to core/user.md and core/project.md legacy paths.

- grep for 'core/user.md' returns zero matches in non-history .md files (except legacy fallback note in SKILL.md)
grep for 'core/project.md' returns zero matches in non-history .md files (except legacy fallback note in SKILL.md)
tests/content/test_contracts.py passes

**Traces**: FR-13

## t2.1.2: Create history/changes/ directory with README.md (FR-14)  `[completed]`

commands.md references history/changes/<name>/ but the directory doesn't exist. Create it with a README.md documenting the change lifecycle artifact structure. Closes #59.

- history/changes/ directory exists
history/changes/README.md documents: what /deft:change creates, directory structure per change, lifecycle from proposal to archive
tests/content/test_structure.py passes

**Traces**: FR-14

## t2.1.3: Refactor strategies/yolo.md to reference interview.md shared phases (FR-15)  `[completed]`

yolo.md duplicates ~80% of interview.md. Replace duplicated sections (sizing gate, chaining gate, acceptance gate, SPECIFICATION structure) with references to interview.md. Keep only yolo-specific content (Johnbot persona, auto-pick rules). Closes #23.

- yolo.md references interview.md for: Sizing Gate, Chaining Gate, Acceptance Gate, SPECIFICATION structure
yolo.md is ≤60% of its current line count
Functional behavior unchanged (yolo still selects recommended options)

**Traces**: FR-15

## t2.1.4: Add See also banner to strategies/speckit.md (FR-16)  `[completed]`

speckit.md is missing the standard **⚠️ See also** cross-reference banner at the top. Add it with links to interview.md and relevant strategy files. Closes #24.

- speckit.md line 3-4 contains **⚠️ See also**: [...] banner
Banner links to at minimum: interview.md, discuss.md

**Traces**: FR-16

## t2.1.5: Fix commands.md vBRIEF example vocabulary (FR-17)  `[completed]`

commands.md vBRIEF examples use status vocabulary that diverges from vbrief/vbrief.md. Update to use the canonical status enum. Closes #25.

- commands.md vBRIEF file-level status examples use: draft | proposed | approved
commands.md vBRIEF task-level status examples use: pending | running | completed | blocked | cancelled
No use of 'todo', 'doing', 'done' in commands.md examples
no use of 'approved' as a task-level status

**Traces**: FR-17

## t2.1.6: Clean core/project.md — remove Voxio Bot private content (FR-18)  `[completed]`

core/project.md contains private project config (Voxio Bot). Replace with a generic template showing example project config, or note it as a legacy location with a pointer to PROJECT.md.

- core/project.md contains no reference to 'Voxio' or any private project
Content is either a generic template or a redirect to ./PROJECT.md
tests/content/test_standards.py Voxio xfail flips to passing

**Traces**: FR-18

## t2.2.1: Create contracts/hierarchy.md — dual-hierarchy framework (FR-19)  `[completed]`

Document the two hierarchy lenses from #84/#89 debate: (1) durability axis (Standards > APIs > Specs > Code — what to invest in maintaining); (2) generative axis (Spec → Contracts → Code — what to write first). Explain when each applies. Closes #84 Phase 1 (hierarchy doc portion).

- contracts/hierarchy.md exists with RFC2119 legend
Both axes documented with examples
File referenced from main.md or contracts/ README

**Traces**: FR-19

## t2.2.2: Add adaptive teaching behavior to main.md (FR-20)  `[completed]`

Add to Agent Behavior section of main.md: ~ When a recommendation is accepted without question, be concise. ! When a recommendation is questioned or overridden, explain the reasoning. ⊗ Lecture unprompted on every decision. Closes #84 Phase 1 (adaptive teaching portion).

- main.md Agent Behavior section contains the three adaptive teaching rules
Rules use RFC2119 symbols correctly

**Traces**: FR-20

## t2.2.3: Add State WHY rule to strategies/interview.md (FR-21)  `[completed]`

Add ! rule to interview.md Interview Rules section: when making an opinionated recommendation, state the underlying principle in one sentence. Closes #84 Phase 1 (State WHY portion).

- interview.md Interview Rules contains: ! When making an opinionated recommendation, state the principle (1 sentence)
Rule positioned near existing RECOMMENDED marker rule

**Traces**: FR-21

## t2.3.1: Write CONTRIBUTING.md with full contributor bootstrap (FR-22, NFR-5)  `[completed]`

Create CONTRIBUTING.md at repo root. Must cover: prerequisites (Go 1.22+, Python 3.11+, uv, task), dev environment setup, running tests (task test, task check), running CLI locally (python run or uv run python run), building the Go installer (go build ./cmd/deft-install/). Closes #67 AC item 3.

- CONTRIBUTING.md exists at repo root
Contains sections: Prerequisites, Dev Environment Setup, Running Tests, Running CLI Locally, Building the Installer
All commands listed are accurate and runnable
CONTRIBUTING.md documents `task check` as the authoritative pre-commit gate
explicitly states that a passing `task check` is the definition of ready-to-commit

**Traces**: FR-22, NFR-5

## t2.4.1: Reframe README.md — remove Warping references (FR-23, depends on #89)  `[blocked]`

Remove 'Warping Process', 'What is Warping?', 'Contributing to Warping' from README.md. Update tagline per #89 resolution. Cannot proceed until #89 decides the framework's positioning and tagline. Closes part of #84 Phase 2.

- README.md contains no reference to 'Warping'
Tagline reflects #89 resolution
tests/content/test_standards.py Warping xfail flips to passing

**Traces**: FR-23

## t2.4.2: Create meta/philosophy.md (FR-24, depends on #89)  `[blocked]`

Create meta/philosophy.md with full contract hierarchy narrative per #84 Phase 2. Framing depends on #89 resolution (SDD vs. CDE vs. hybrid tagline).

- meta/philosophy.md exists with RFC2119 legend
Covers: spec as primary IP, contracts as derived artifacts, code as renewable output
Consistent with #89 resolved framing

**Traces**: FR-24

## t2.5.1: Create skills/deft-review-cycle/SKILL.md — Greptile review cycle skill (FR-28)  `[completed]`

Add a versioned, repo-local skill for running Greptile bot reviewer response cycles on PRs. Currently the review cycle rules live only in local Warp global rules, making them inaccessible to cloud agents. Moving them into the repo as a skill enables fully autonomous PR workflows: cloud agent creates PR → Greptile reviews → agent runs review cycle → agent resolves findings. Closes #135.

- skills/deft-review-cycle/SKILL.md exists with RFC2119 legend
Skill covers: Phase 1 deft process audit (spec coverage, changelog, task check, PR template)
- Phase 2 review/fix loop (fetch both MCP + gh, analyze all, batch commit, wait, exit condition)
- GitHub review submission rules
- interface selection guidance
- anti-patterns
.agents/skills/deft-review-cycle/SKILL.md thin pointer exists for auto-discovery
AGENTS.md PR conventions section references skills/deft-review-cycle/SKILL.md

**Traces**: FR-28

## t2.5.2: Update deft-review-cycle SKILL.md — handle Greptile edited issue comments (FR-30)  `[completed]`

Update skills/deft-review-cycle/SKILL.md Step 4 to explicitly document that Greptile may advance its review by editing an existing PR issue comment rather than creating a new PR review object. Add guidance to check issue comments via `gh api repos/<owner>/<repo>/issues/<number>/comments` or `gh pr view --comments`, parse the `Last reviewed commit` field and `updated_at` from the comment body, and treat an edited issue comment as a valid new review pass. Add anti-pattern for relying solely on `pulls/{number}/reviews`. Closes #145.

- Step 4 documents both review detection methods: PR review objects and edited issue comments
Guidance includes parsing `Last reviewed commit` and `updated_at` from issue comments
Anti-patterns section includes entry about relying solely on PR review API
tests/content/test_skills.py passes

**Traces**: FR-30

## t2.5.3: README — move startup instructions higher and clarify installer location (FR-31)  `[completed]`

Move the Getting Started section in README.md to appear immediately after the TL;DR section, before detailed architecture/layer documentation. Add a prominent callout near the top directing users to the GitHub Releases page for installers. Closes #137.

- Getting Started section appears within the first ~40 lines of README.md
Installer download link is visible without scrolling past architecture details
All existing content preserved, just reordered
No broken internal links

**Traces**: FR-31

## t2.5.4: Create skills/deft-swarm/SKILL.md — parallel local agent orchestration (FR-29)  `[completed]`

Add a versioned skill for orchestrating multiple parallel local agents working on roadmap items. A monitor agent reads the skill to set up worktrees, generate action-first prompts, launch agents, poll for progress, handle stalled review cycles, and close out PRs. Codifies the workflow proven in PRs #149/#150 and lessons from meta/lessons.md. Closes #152.

- skills/deft-swarm/SKILL.md exists with RFC2119 legend and frontmatter
Skill covers 6 phases: Select (task assignment + file-overlap audit), Setup (worktrees + prompt generation), Launch (oz agent run preferred automated local path
- manual Warp tabs for interactive monitoring
- oz agent run-cloud for cloud), Monitor (polling cadence + checkpoints + takeover triggers), Review (Greptile cycle completion verification), Close (merge + issue close + worktree cleanup)
Prompt template included with action-first structure (imperative first line, numbered STEPs, CONSTRAINTS)
File-overlap audit is a MUST gate before launch
Anti-patterns section covers: context-first prompts, MCP from standalone terminals, overlapping file assignments, merging without Greptile exit condition
.agents/skills/deft-swarm/SKILL.md thin pointer exists for auto-discovery
Cross-references swarm/swarm.md for general multi-agent guidelines and skills/deft-review-cycle/SKILL.md for review cycle

**Traces**: FR-29

## t2.5.5: Codify Mermaid GitHub/Gist sequence rendering guidance (#102)  `[completed]`

Codify issue #102 in `languages/mermaid.md` using explicit RFC2119 MUST/SHOULD rules that are scoped to `sequenceDiagram` behavior on GitHub/Gist renderers. Document that `init.background` and `themeCSS` are insufficient on their own for reliable readability, require the participant-only `box ... end` pattern for gist-safe sequence diagrams, and preserve black text with grayscale fills. Add focused content tests so these rules and example pattern are regression-protected. Closes #102.

- `languages/mermaid.md` contains explicit GitHub/Gist `sequenceDiagram` MUST guidance: do not rely on `init.background` or `themeCSS` alone
- require grey `box ... end` around participant declarations
- require messages and notes outside the `box ... end` block
`languages/mermaid.md` includes a concrete gist-safe sequence example with `box rgb(192, 192, 192)` and message flow outside the box
Guidance explicitly states diagram-type specificity (`sequenceDiagram` workarounds SHOULD NOT be generalized without testing)
`tests/content/test_mermaid_guidance.py` asserts rule presence and safe example structure

**Traces**: #102

## t2.6.1: Holzmann Power of Ten rules adaptation (#104)  `[completed]`

Add coding/holzmann.md adapting JPL/NASA Power of Ten rules (Holzmann, 2006) for the Deft framework with RFC2119 notation. Covers simple control flow, bounded loops, fixed resource allocation, small functions, runtime checks, minimal data scope, error/return checking, restricted metaprogramming/indirection, and maximum static checking. Closes #104.

- coding/holzmann.md exists with RFC2119 legend
All 10 Holzmann rules adapted with Deft-appropriate MUST/SHOULD/MAY modifiers
Referenced from coding/coding.md or discoverable via directory listing

**Traces**: #104

## t2.6.2: Move ROADMAP.md updates from merge-time to release-time (#170)  `[completed]`

The AGENTS.md PR conventions section says 'ROADMAP.md updates happen on merge' — in practice this is routinely skipped, especially during swarm runs. Change the convention so ROADMAP.md is batch-updated during the CHANGELOG promotion commit (the release commit) instead. Update AGENTS.md, add a Phase 6 Step 5 and ⊗ anti-pattern to skills/deft-swarm/SKILL.md. Closes #170.

- AGENTS.md PR conventions line reads: 'ROADMAP.md updates happen at release time — batch-move merged issues to Completed during the CHANGELOG promotion commit'
skills/deft-swarm/SKILL.md Phase 6 contains Step 5 instructing monitor to update ROADMAP.md at release time, not during swarm close
skills/deft-swarm/SKILL.md Phase 1 Step 2 contains ⊗ rule: MUST NOT include ROADMAP.md as a shared exception for swarm agents
skills/deft-swarm/SKILL.md Anti-Patterns contains ⊗ entry: update ROADMAP.md during swarm close

**Traces**: #170

## t2.6.3: Add close-out orchestration rules for start_agent monitor workflow (#206)  [completed]

The deft-swarm skill lacks orchestration-specific close-out rules for the start_agent monitor workflow. Add merge authority, rebase cascade ownership, GIT_EDITOR override, post-merge issue verification, MCP fallback, and push autonomy carve-out. Closes #206.

- skills/deft-swarm/SKILL.md Phase 6 Step 1 contains ! rules for: monitor proposes merge order (user approves), monitor owns rebase cascade, GIT_EDITOR=true before non-interactive rebase
- skills/deft-swarm/SKILL.md Phase 6 contains post-merge issue verification step
- skills/deft-swarm/SKILL.md contains push autonomy carve-out for swarm agents
- skills/deft-review-cycle/SKILL.md contains ~ MCP fallback note (gh-only when MCP unavailable)
- tests/content/test_skills.py passes

**Traces**: #206

## t1.10.1: Move dev deps to [dependency-groups] (PEP 735) (#217)  `[completed]`

Move dev dependencies from `[project.optional-dependencies]` to `[dependency-groups]` (PEP 735 style, supported by uv). Fixes silent test-suite skip in fresh worktrees where `uv sync` does not install optional deps by default. Closes #217.

- `pyproject.toml` uses `[dependency-groups]` instead of `[project.optional-dependencies]` for dev deps
- `uv.lock` regenerated
- `languages/python.md` template updated to show `[dependency-groups]` pattern
- `task check` passes in a fresh worktree

**Traces**: #217

## t1.10.2: Add explicit release decision checkpoint to deft-swarm Phase 0 and Phase 5->6 gate (#218)  `[completed]`

Add a tentative version bump suggestion to Phase 0 Step 3 analysis summary — agent surfaces current version and proposes next version (patch/minor/major) based on scope. Add explicit confirmation gate at Phase 5→6 transition — agent presents proposed version bump and release scope, requires user approval before merge cascade begins. Add anti-pattern prohibiting merge cascade without version bump proposal and user approval. Closes #218.

- skills/deft-swarm/SKILL.md Phase 0 Step 3 includes tentative version bump suggestion (current version + proposed next version based on scope)
- skills/deft-swarm/SKILL.md contains Phase 5→6 confirmation gate requiring user approval of version bump and release scope before merge cascade
- skills/deft-swarm/SKILL.md Anti-Patterns contains ⊗ entry: begin merge cascade without presenting version bump proposal and receiving explicit user approval

**Traces**: #218

## t1.10.3: Document Greptile re-review latency on force-push after rebase in swarm merge cascade (#207)  `[completed]`

Document in skills/deft-swarm/SKILL.md Phase 6 that force-pushing a rebased branch triggers a full Greptile re-review (not incremental), with expected latency of ~2-5 minutes per PR. Add guidance for rebase-only force-pushes (MAY note in PR comment to give Greptile context). Update merge cascade warning with time cost. Record finding in meta/lessons.md. Closes #207.

- skills/deft-swarm/SKILL.md Phase 6 documents force-push rebase triggers full Greptile re-review with ~2-5 min latency
- skills/deft-swarm/SKILL.md Phase 6 contains guidance for rebase-only force-push PR comments
- skills/deft-swarm/SKILL.md merge cascade warning includes Greptile re-review time cost
- meta/lessons.md contains Greptile rebase re-review latency lesson

**Traces**: #207

## t3.1.1: Write .github/workflows/ci.yml — lint + test on PRs and master pushes (FR-25, FR-26)  `[completed]`

GitHub Actions CI workflow triggering on pull_request and push to master. Jobs: (1) Python: ruff check, mypy tests/ (the shim run.py cannot be typed directly - exclude run and run.py from mypy per pyproject.toml, type-check the test suite instead), pytest tests/ with coverage. (2) Go: go test ./cmd/deft-install/ + go build ./cmd/deft-install/ for each platform matrix (linux/amd64, darwin/arm64, windows/amd64). main_test.go already exists so go test is zero-cost. Use current action versions. Closes #57.

- .github/workflows/ci.yml exists and is valid YAML
Python job runs: ruff, mypy tests/ (run and run.py excluded via pyproject.toml), pytest with coverage
Go job runs go test and builds installer for linux/amd64, darwin/arm64, and windows/amd64 (per NFR-3)
Workflow triggers on pull_request and push to master
CI passes on a clean branch

**Traces**: FR-25, FR-26, NFR-3

## t3.1.2: Open GitHub issue for run CLI coverage tracking (NFR-2)  `[completed]`

Open a new GitHub issue titled 'Bring run CLI into test coverage measurement' in the Phase 4/5 backlog. Reference the exclusion in pyproject.toml. Include the rationale: run is terminal-only, excluded for now, refactor needed before coverage is meaningful.

- GitHub issue exists with title containing 'run CLI' and 'coverage'
Issue is assigned to Phase 4 or Phase 5 milestone/label

**Traces**: NFR-2

## t2.6.6: Create scm/github.md with gh CLI rules, PR workflow conventions, and Windows/PS encoding guidance (#197, absorbs #201)  `[completed]`

Rewrite scm/github.md with standing gh CLI rules (--body-file for multi-line bodies, immediate post-create verification), PR workflow conventions (squash-merge default, single-purpose branches, branch lifecycle, closing keywords), Windows/PowerShell 5.x encoding guidance (UTF-8 without BOM, avoid emoji and special characters in machine-edited files), and post-merge issue verification. Closes #197, absorbs #201.

- scm/github.md exists with RFC2119 legend
- Contains ! rules for: --body-file for PR/issue bodies longer than one line, immediate verification after create/edit operations
- Contains PR workflow conventions: squash-merge default, single-purpose branches, branch lifecycle, closing keywords
- Contains Windows/PS 5.x encoding guidance: UTF-8 without BOM, avoid emoji/special chars in machine-edited files
- Contains post-merge issue verification section

**Traces**: #197, #201

## t2.6.7: Document ASCII convention for machine-editable structured sections (#202)  `[completed]`

Add convention rules for ASCII punctuation in machine-editable structured sections (ROADMAP.md phase bodies, CHANGELOG.md entries, Open Issues Index rows). Prefer -- instead of em-dash, -> instead of arrow, avoid emoji in body text. Never use Unicode em-dashes, curly quotes, or non-ASCII arrows in these sections. Rationale: prevents edit_files tool failures on Windows (warpdotdev/warp#9022). Closes #202.

- scm/github.md or meta/conventions.md contains ~ rule: prefer ASCII punctuation in machine-editable structured sections
- Contains ! rule: never use Unicode em-dashes, curly quotes, or non-ASCII arrows in CHANGELOG.md entries or ROADMAP.md index rows
- Rationale references warpdotdev/warp#9022

**Traces**: #202

## t2.6.8: Create skills/deft-rwldl/SKILL.md -- iterative pre-PR quality improvement loop (#182)  `[completed]`

Create skills/deft-rwldl/SKILL.md with RFC2119 legend and frontmatter. Structured self-review loop agents run before submitting a PR: Read (re-read changed files), Write (fix issues), Lint (run task check), Diff (review full diff), Loop (restart if changes made). Exit when full cycle produces zero changes. Create .agents/skills/deft-rwldl/SKILL.md thin pointer. Closes #182.

- skills/deft-rwldl/SKILL.md exists with RFC2119 legend and frontmatter
- Contains 5 loop phases: Read, Write, Lint, Diff, Loop
- Exit condition: full cycle with zero changes
- Anti-patterns section present
- .agents/skills/deft-rwldl/SKILL.md thin pointer exists

**Traces**: #182

## t3.2.1: Validate USER.md against current schema + artifact format versioning (#270)  `[completed]`

Add a `deft_version` field to all Deft-generated artifact templates (USER.md, PROJECT.md, etc.). When deft-setup or CLI bootstrap finds an existing USER.md, validate it against the current expected field set using the version field. If fields are missing, query the user for missing fields only (do not re-run full interview). Targeted subset of #78.

- All Deft-generated artifact templates include a `deft_version` field
- deft-setup skill detects stale USER.md via missing or outdated version field
- Missing fields are queried individually without re-running full interview
- Updated USER.md includes current version field after migration

**Traces**: #270

## t3.1.3: Raise pyproject.toml coverage threshold to 85% and document run exclusion (NFR-1, NFR-2, FR-27)  `[completed]`

**Depends on**: t3.1.1, t3.1.2

Update pyproject.toml: fail_under = 85. Add comment in [tool.coverage.run] omit section explaining why run and run.py are excluded (terminal-only CLI path; pending dedicated refactor issue). Resolves stated-vs-enforced coverage gap.

- pyproject.toml fail_under = 85
omit entries for run and run.py include inline comment: '# terminal-only CLI
- excluded pending #<issue>'
task test:coverage passes at >=85% threshold on the current test suite

**Traces**: NFR-1, NFR-2, FR-27

## t1.10.4: Add rules against mid-task instant-fix drift and skill-context bleed to main.md (#198)  `[completed]`

Agents fix discovered issues in-place during an unrelated task instead of filing an issue, and continue executing past a skill's explicit instruction boundary into adjacent work. Add ⊗ rules to main.md Decision Making section prohibiting both patterns, and add companion entry to meta/lessons.md. Closes #198.

- main.md Decision Making contains ⊗ rule: Fix a discovered issue in-place mid-task without filing a GitHub issue
- main.md Decision Making contains ⊗ rule: Continue executing a skill past its explicit instruction boundary
- main.md Decision Making contains ! rule: The end of a skill's final step is an exit condition
- meta/lessons.md contains companion entry documenting these as learned patterns (xrefs #159, #167, #184)

**Traces**: #198

## t1.10.5: Add mandatory skills/ scan rule to AGENTS.md before improvising multi-step workflows (#200)  `[completed]`

Agents improvise multi-step workflows from scratch without checking whether a skill already covers the task. Add ! rule and ⊗ anti-pattern to AGENTS.md requiring a skills/ scan before designing workflows. Add companion meta/lessons.md entry. Closes #200.

- AGENTS.md contains ! rule: Before designing a multi-step workflow from scratch, scan skills/ for an existing skill
- AGENTS.md contains ⊗ anti-pattern: Improvise a multi-step workflow without first checking skills/
- meta/lessons.md contains companion entry

**Traces**: #200

## t2.6.4: Add keyword-to-skill routing table in AGENTS.md and add 3 missing skills to README (#147)  `[completed]`

Skills are undiscoverable — agents don't know which skill to use for common keywords. Add a keyword→skill routing table to AGENTS.md mapping trigger phrases to skill paths. Add deft-review-cycle, deft-roadmap-refresh, and deft-swarm entries to README.md Skills section. Closes #147.

- AGENTS.md contains keyword→skill routing table near Commands section
- Table maps: "review cycle" → deft-review-cycle, "swarm" → deft-swarm, "roadmap refresh" → deft-roadmap-refresh, "build" → deft-build
- README.md Skills section lists deft-review-cycle, deft-roadmap-refresh, deft-swarm with brief descriptions

**Traces**: #147

## t2.6.5: Fix stale README content: add CONTRIBUTING.md, contracts/hierarchy.md, update directory tree and Skills section (#219)  `[completed]`

README.md directory tree is missing CONTRIBUTING.md, contracts/hierarchy.md, and 3 skills (deft-review-cycle, deft-roadmap-refresh, deft-swarm). Update directory tree and relevant sections. Closes #219.

- README.md directory tree includes CONTRIBUTING.md
- README.md directory tree includes contracts/hierarchy.md
- README.md skills/ subtree includes deft-review-cycle, deft-roadmap-refresh, deft-swarm
- README.md Contracts section references contracts/hierarchy.md
- No broken internal links introduced

**Traces**: #219

## t2.7.1: deft-roadmap-refresh: add MUST rule to confirm analysis comment posting to user (#168)  `[completed]`

Add ! rule to skills/deft-roadmap-refresh/SKILL.md Phase 2 Step 4 (Apply): after posting the analysis comment on a GitHub issue, the agent MUST confirm to the user that the comment was posted (including issue number and a link). Ensures transparency -- the user always knows when their GitHub issues are being commented on. Closes #168.

- skills/deft-roadmap-refresh/SKILL.md Phase 2 Step 4 contains ! rule: after posting the analysis comment, confirm to the user with the issue number and a link to the comment
- Rule is positioned after the existing '! Post the analysis as a comment on the GitHub issue' line
- tests/content/test_skills.py passes

**Traces**: #168

## t2.7.2: deft-roadmap-refresh: add Phase 4 -- PR & review cycle (#174)  `[completed]`

**Depends on**: t2.7.1

Add Phase 4 -- PR & Review Cycle to skills/deft-roadmap-refresh/SKILL.md. When triage is complete and user confirms readiness, run pre-flight BEFORE pushing: verify CHANGELOG.md has an [Unreleased] entry, run task check, verify PR template checklist is satisfiable. Then commit, push, create PR, and automatically sequence into skills/deft-review-cycle/SKILL.md. The Phase 1 audit from deft-review-cycle is the reason pre-flight must happen before push. Closes #174.

- SKILL.md contains Phase 4 -- PR & Review Cycle after Phase 3 Cleanup
- Phase 4 asks user: "Ready to commit and create a PR?"
- Phase 4 pre-flight steps run BEFORE pushing: CHANGELOG [Unreleased] entry, task check, PR template checklist
- Phase 4 commits, pushes, creates PR, then sequences automatically into skills/deft-review-cycle/SKILL.md
- User is informed of the handoff to review cycle
- tests/content/test_skills.py passes

**Traces**: #174

## t2.7.3: deft-roadmap-refresh: explicit cleanup convention -- remove from phase body, not strike through (#196)  `[completed]`

Replace the ambiguous Phase 3 cleanup instruction ('Strike through or move any stale entries') with explicit rules. ! Remove the entry from the phase section body entirely -- do NOT leave a struck-through line in place. The Completed section is the sole record for closed issues. ! In the Open Issues Index, strike through the row (keep for history) and update Phase column to 'completed -- YYYY-MM-DD'. Add anti-pattern: striking through in the phase body AND adding to Completed creates a duplicate and breaks the single-record convention. Closes #196.

- SKILL.md Phase 3 contains ! rule: remove the entry from the phase section body entirely -- do NOT leave a struck-through line in place
- SKILL.md Phase 3 contains ⊗ rule: strike through an entry in the phase body and also add it to Completed -- this creates a duplicate
- SKILL.md Phase 3 contains ! rule for Open Issues Index: strike through the row (keep for history), update Phase column to 'completed -- YYYY-MM-DD'
- Anti-Patterns section contains ⊗ entry matching the duplicate-record prohibition
- tests/content/test_skills.py passes

**Traces**: #196

## t2.7.4: deft-review-cycle: replace blocking polling with start_agent orchestration (#195)  `[completed]`

Replace the blocking shell polling loop in the review monitor with a tiered approach. Approach 1 (preferred, start_agent available): spawn a sub-agent review monitor that polls gh pr view/checks on a cadence and sends a message to the parent agent when the exit condition is met -- main conversation pane stays interactive. Approach 2 (fallback): use discrete run_shell_command (wait mode) calls with a yield (no tool calls) between checks -- no shell pane lock. Capability detection reuses the start_agent tool-presence pattern from #188. Existing exit conditions preserved. Closes #195.

- skills/deft-review-cycle/SKILL.md contains tiered monitoring: start_agent sub-agent (preferred) vs. tool-call polling with yield (fallback)
- Approach 1: spawn sub-agent via start_agent to poll; sub-agent sends message to parent agent when exit condition met
- Approach 2: discrete run_shell_command (wait mode) + yield between checks -- no blocking shell
- Capability detection: start_agent tool presence = Approach 1; absent = Approach 2
- Blocking Start-Sleep shell guidance removed
- Existing exit conditions preserved (review current, no P1/P2 issues, Greptile confidence > 3)
- tests/content/test_skills.py passes

**Traces**: #195

## t2.7.5: Add skills/deft-sync/SKILL.md -- session-start framework sync skill (#146)  `[completed]`

Create skills/deft-sync/SKILL.md with RFC2119 legend and frontmatter. Triggered by 'good morning', 'update deft', 'update vbrief', or 'sync frameworks'. Phases: (1) pre-flight dirty check on deft/ submodule and record current version; (2) submodule update (git submodule update --remote --merge deft); (3) project sync: validate ./vbrief/*.vbrief.json against vendored schema, check AGENTS.md freshness against deft template, list new skills; (4) summary with commit prompt. Do NOT include separate vBRIEF schema fetch from upstream (CI concern per #128). Create .agents/skills/deft-sync/SKILL.md thin pointer. Update AGENTS.md Returning Sessions section and Skill Routing table. Closes #146.

- skills/deft-sync/SKILL.md exists with RFC2119 legend and frontmatter
- Triggers: 'good morning', 'update deft', 'update vbrief', 'sync frameworks'
- Covers: pre-flight dirty check, submodule update, vBRIEF file validation, AGENTS.md freshness check, new skills listing, summary with commit prompt
- Does NOT include separate vBRIEF schema fetch from upstream
- Anti-patterns: auto-commit without approval, skip dirty check, overwrite project vbrief files
- .agents/skills/deft-sync/SKILL.md thin pointer exists
- AGENTS.md Returning Sessions section references skills/deft-sync/SKILL.md
- AGENTS.md Skill Routing table contains 'sync' / 'good morning' / 'update deft' -> deft-sync entry
- tests/content/test_skills.py updated to cover new skill

**Traces**: #146

## t2.7.6: Add behavioral rule for Deft alignment confirmation at session start (#134)  `[completed]`

Add a behavioral rule to AGENTS.md requiring the agent to confirm Deft Directive is active at session start and after context resets. Confirmation should be unambiguous (e.g. agent states 'Deft Directive active' or equivalent at start of each session after loading AGENTS.md). Covers context reset recovery. True UI indicators deferred to Phase 5. Closes #134.

- AGENTS.md contains a rule requiring the agent to confirm Deft alignment at session start
- Rule specifies the confirmation form (e.g. agent states that Deft Directive is active and AGENTS.md was loaded)
- Rule covers context reset recovery (agent re-confirms after context window shifts)
- tests/content/test_agents_md.py passes

**Traces**: #134

## t2.7.7: Document deterministic > probabilistic design principle (#159)  `[completed]`

Create meta/philosophy.md documenting the 'prefer deterministic components for repeatable actions' design principle. The principle extends Directive's use of Taskfile tasks for repeatable work to any domain where a deterministic component (fixed command, schema validator, CI check) replaces a probabilistic one (LLM inference). Content: definition, rationale, examples (Taskfile tasks, spec_validate.py, CI checks as deterministic components), and scope note (ongoing application across CLI/skills/workflows is Phase 5 -- do not implement now). Reference from contracts/hierarchy.md or main.md. Closes #159.

- meta/philosophy.md exists with RFC2119 legend
- Documents deterministic > probabilistic principle: definition, rationale, concrete examples
- Scope note explicitly defers broad application to Phase 5
- Referenced from contracts/hierarchy.md or main.md
- tests/content/test_structure.py or test_standards.py passes

**Traces**: #159

## t2.7.8: Add BDD/acceptance-test-first strategy -- strategies/bdd.md (#81)  `[completed]`

Create strategies/bdd.md: a Behaviour-Driven Development strategy where failing acceptance tests drive requirements. Triggered when features are better expressed as examples than written requirements. Workflow: (1) identify user scenarios (Given/When/Then), (2) write failing acceptance tests, (3) let failures surface missing decisions and ambiguity, (4) lock decisions (feeds context.md like discuss strategy), (5) generate spec from test+decision artifacts, (6) chain into interview sizing gate. Output: specs/{feature}/acceptance-tests/ + {feature}-bdd-context.md. Include standard See also banner. Update strategies/README.md. Closes #81.

- strategies/bdd.md exists with RFC2119 legend and standard See also banner
- Workflow covers 6 steps: scenario identification, failing test writing, ambiguity surfacing, decision locking, spec generation, sizing gate chaining
- Output artifacts defined: acceptance-tests/ directory + bdd-context.md
- strategies/README.md lists bdd.md (removes 'future' annotation if present)
- tests/content/test_structure.py updated to assert strategies/bdd.md exists

**Traces**: #81

## t1.11.1: Document Get-Content -Raw UTF-8 footgun and BOM-safe round-trip pattern for PS 5.1 (#236)  `[completed]`

PowerShell 5.1's Get-Content (without -Raw) reads files line-by-line and can inject BOM characters or silently mangle em-dashes when agents read then re-write files. Add ! rules to scm/github.md PS 5.1 section covering Get-Content -Raw for safe reads and BOM-safe round-trip write pattern. Closes #236.

- scm/github.md PS 5.1 section contains ! rule: use Get-Content -Raw to read files as a single string, avoiding line-by-line BOM injection
- scm/github.md PS 5.1 section contains ! rule for BOM-safe write pattern ([System.IO.File]::WriteAllText with UTF8Encoding BOM-free constructor) when writing files read by agents
- tests/content/test_standards.py passes

**Traces**: #236

## t1.11.2: Document multi-line PS string literal Warp terminal block splitting -- always use temp file (#240)  `[completed]`

**Depends on**: t1.11.1

Warp terminal splits multi-line PowerShell string literals (here-strings) across input blocks, causing syntax errors or silent truncation. Add ! rule to scm/github.md and a meta/lessons.md entry: always write multi-line PS content to a temp file first, never paste multi-line here-strings directly into the Warp agent input. Closes #240.

- scm/github.md contains ! rule: always use a temp file for multi-line PS string content -- never paste multi-line here-strings directly into Warp terminal input
- meta/lessons.md contains corresponding lesson entry documenting the root cause and fix
- tests/content/test_standards.py passes

**Traces**: #240

## t1.11.3: deft-roadmap-refresh: write one batch changelog line at end of full triage session (#238)  `[completed]`

deft-roadmap-refresh currently adds one CHANGELOG.md entry per issue triaged, producing verbose noise. Change to one batch entry at the end of the full triage session summarizing all issues triaged. Add anti-pattern. Closes #238.

- skills/deft-roadmap-refresh/SKILL.md contains ! rule: write one batch CHANGELOG.md entry at the end of the full triage session, not one per issue triaged
- skills/deft-roadmap-refresh/SKILL.md Anti-Patterns contains ⊗ rule: add a CHANGELOG entry per individual issue during triage
- tests/content/test_skills.py passes

**Traces**: #238

## t1.11.4: Add mandatory pre-commit file review step to deft-roadmap-refresh and deft-build (#239)  `[completed]`

**Depends on**: t1.11.3

Add a mandatory pre-commit file review step to deft-roadmap-refresh Phase 4 pre-flight and to deft-build pre-commit checklist. The step requires the agent to re-read all modified files before committing, checking for encoding errors, unintended duplication, and structural issues. Closes #239.

- skills/deft-roadmap-refresh/SKILL.md Phase 4 pre-flight contains mandatory file review step: re-read all modified files before committing, check for encoding errors, duplication, and structural issues
- skills/deft-build/SKILL.md pre-commit checklist contains equivalent mandatory file review step
- tests/content/test_skills.py passes

**Traces**: #239

## t1.11.5: Add skill completion gate to prevent missing chaining instructions at skill exit (#243)  `[completed]`

Skills sometimes exit without stating they are done or providing chaining instructions, leaving the agent in an undefined state. Add ! rule to AGENTS.md requiring explicit skill exit confirmation and chaining. Add EXIT block to deft-roadmap-refresh. Add chaining annotations to AGENTS.md Skill Routing table entries. Closes #243.

- AGENTS.md contains ! rule: when a skill's final step is complete, explicitly confirm skill exit and provide chaining instructions if applicable
- skills/deft-roadmap-refresh/SKILL.md contains explicit EXIT block at the end of Phase 4 with chaining instructions
- AGENTS.md Skill Routing table entries include chaining annotations where applicable
- tests/content/test_skills.py passes

**Traces**: #243

## t1.11.6: Migrate ROADMAP.md em-dashes to ASCII -- to enable edit_files on Windows (#237)  `[completed]`

ROADMAP.md phase bodies and Open Issues Index rows contain Unicode em-dashes that cause edit_files tool failures on Windows (warpdotdev/warp#9022). Perform one-time migration: replace all em-dashes in ROADMAP.md with ASCII -- (double hyphen). This unblocks all future ROADMAP.md edits without requiring PowerShell fallbacks. Closes #237.

- ROADMAP.md contains no Unicode em-dash characters in phase body lines or Open Issues Index rows
- All former em-dashes replaced with ASCII -- (double hyphen)
- ROADMAP.md is structurally valid after migration (no broken entries)

**Traces**: #237

## t1.11.7: Add blocker carve-out to main.md instant-fix drift rule (#241)  `[completed]`

The main.md instant-fix drift rule (⊗: fix a discovered issue in-place mid-task) is too broad -- it inadvertently prohibits fixing genuine blockers discovered mid-task. Add a carve-out: blocking discoveries are in-scope with mandatory issue filing. Non-blocking discoveries remain prohibited (must file issue, do not fix in-place). Addresses ambiguity surfaced in #198 post-implementation. Closes #241.

- main.md Decision Making instant-fix drift ⊗ rule includes carve-out: if a discovered issue is a hard blocker to completing the current task, fixing it in-scope is permitted with mandatory GitHub issue filing
- Carve-out explicitly scoped to blocking discoveries only -- non-blocking nice-to-fix issues remain prohibited
- tests/content/test_standards.py passes

**Traces**: #241

## t1.12.1: Add autonomous Greptile re-review monitoring to deft-swarm Phase 6 rebase cascade (#249)  `[completed]`

During Phase 6 merge cascade, after each --force-with-lease push of a rebased branch, the monitor stalls waiting for human input to check the Greptile re-review. Add a ! rule to skills/deft-swarm/SKILL.md Phase 6 Step 1 requiring the monitor to autonomously wait for Greptile re-review using the tiered approach from skills/deft-review-cycle/SKILL.md Step 4. Do NOT proceed to the next merge until the Greptile review for the rebased branch is current (SHA match) and exit condition is met (confidence > 3, no P0/P1). Closes #249.

- skills/deft-swarm/SKILL.md Phase 6 Step 1 contains ! rule for autonomous re-review monitoring after force-push
- Rule references skills/deft-review-cycle/SKILL.md Step 4 tiered monitoring approach (pointer, not duplication)
- ! gate: do NOT proceed to next merge until Greptile review is current (SHA match) and exit condition met
- Anti-patterns section contains entry prohibiting proceeding to next merge without re-review confirmation
- CHANGELOG entry under [Unreleased]

**Traces**: #249
## t1.12.3: Add semantic contradiction check for !/⊗ rules to deft-build and deft-rwldl (#251)  `[completed]`

When an agent adds a new ! (MUST) or ⊗ (MUST NOT) rule, it does not check whether existing ~ (SHOULD) or ≉ (SHOULD NOT) rules in the same file recommend the exact thing now being prohibited. This creates silent contradictions that Greptile catches post-PR. Add contradiction-check rules to both skills. Closes #251.

- skills/deft-build/SKILL.md pre-commit checklist contains 2 new ! rules for contradiction checking (semantic contradictions + strength duplicates)
- skills/deft-rwldl/SKILL.md Read phase contains 2 new ! rules for contradiction checking (semantic contradictions + strength duplicates)
- Both skills' Anti-Patterns contain ⊗ entry for adding prohibition without scanning for conflicts
- CHANGELOG entry under [Unreleased]
- tests/content/test_skills.py passes

**Traces**: #251

## t1.13.1: Harden deft-swarm Phase 5->6 gate and add crash recovery (#261, #263)  `[completed]`

Strengthen the Phase 5->6 confirmation gate against context-pressure bypass and add checkpoint/crash recovery guidance to skills/deft-swarm/SKILL.md.

- skills/deft-swarm/SKILL.md Phase 5->6 gate contains explicit context-pressure callout: even under long-context or time pressure, the gate MUST NOT be bypassed
- Phase 5->6 gate requires monitor to emit a structured merge-readiness checklist before any gh pr merge call: for each PR confirm Greptile score > 3, no P0/P1, task check passed, CHANGELOG present, and user approval confirmed
- skills/deft-swarm/SKILL.md Phase 4 Monitor Takeover Triggers contains ! rule: before spawning a replacement agent, verify the original is truly unresponsive by waiting for an idle/blocked lifecycle event; do not spawn a replacement based solely on message timing or absence of recent commits
- skills/deft-swarm/SKILL.md Phase 6 Step 1 contains ! rule: before acting on any PR (merge, force-push, status check), query the specific sub-agent responsible for that PR for live status; do not infer status from a different agent or from message timing
- skills/deft-swarm/SKILL.md documents the duplicate-tab failure mode: original tabs may resume after apparent failure; spawning a new agent creates two concurrent agents on the same worktree, corrupting tool_use/tool_result chains
- skills/deft-swarm/SKILL.md recovery guidance: keep original agent tabs open until PR is merged; if an agent appears stalled, go to its original tab and tell it to resume rather than spawning a new agent
- skills/deft-swarm/SKILL.md Phase 6 contains checkpoint guidance: at each major milestone (PR merged, rebase done, review passed) record progress so a new session can reconstruct state via gh pr list and gh pr view
- skills/deft-swarm/SKILL.md contains a Crash Recovery section with idempotent recovery steps: on fresh session, inspect gh pr list and gh pr view to reconstruct where the cascade was; verify what is merged, what is rebased, what needs action
- skills/deft-swarm/SKILL.md Phase 6 merge steps note idempotent pre-check pattern: before each action verify current PR/branch state (already merged? already rebased?) so recovery re-runs are safe
- skills/deft-swarm/SKILL.md Phase 4 Monitor contains context-length warning: long monitoring sessions accumulate large conversation history and are susceptible to conversation corruption; offload rebase/review/merge sub-tasks to ephemeral sub-agents (per deft-review-cycle tiered approach) to keep monitor context shallow
- Anti-Patterns section contains (MUST NOT) entry: spawn a replacement sub-agent without confirming the original is unresponsive via lifecycle events
- Anti-Patterns section contains (MUST NOT) entry: skip Phase 5 or the Phase 5->6 gate under time pressure or due to long context
- meta/lessons.md contains companion entries for the duplicate-tab failure mode and crash-recovery pattern
- tests/content/test_skills.py passes

**Traces**: #261, #263

## t1.13.2: Update --body-file convention to use system temp directory (#256)  `[completed]`

Update `scm/github.md` to instruct agents to write `--body-file` temp files to the OS temp directory instead of the worktree, eliminating the `rm` denylist collision that blocks autonomous swarm agents.

- scm/github.md --body-file convention updated: write temp files to OS temp directory, not the worktree
- scm/github.md includes PowerShell example using [System.IO.Path]::GetTempFileName() or Join-Path $env:TEMP "pr-body.md"
- scm/github.md includes Unix example using mktemp or $TMPDIR
- scm/github.md notes no explicit rm needed -- OS handles cleanup, eliminates rm denylist collision in Warp autonomous agents
- skills/deft-swarm/SKILL.md Prompt Template Step 5 references OS temp directory pattern for --body-file
- tests/content/test_standards.py covers OS temp dir guidance presence in scm/github.md

**Traces**: #256

## t1.14.1: Clarify Approach 2 idle-stoppage limitation in deft-review-cycle (#279)  `[completed]`

Approach 2 (yield-between-polls) silently breaks for swarm agents because yielding ends the agent's turn with no self-wake mechanism. Add guidance clarifying the limitation, a ! rule directing swarm agents to prefer Approach 1, and an anti-pattern against assuming Approach 2 is self-sustaining.

- skills/deft-review-cycle/SKILL.md Approach 2 section contains warning that Approach 2 requires the monitor to detect idle lifecycle events and re-trigger -- it is NOT autonomous for swarm agents
- skills/deft-review-cycle/SKILL.md contains ! rule: swarm agents launched via start_agent SHOULD prefer Approach 1 (spawn their own review-monitor sub-agent) when start_agent is available
- Anti-Patterns section contains entry: assume Approach 2 produces a self-sustaining polling loop

**Traces**: #279

## t1.15.1: Add semantic accuracy check to mandatory pre-commit file review (#274)  `[completed]`

Extend the mandatory pre-commit file review step in deft-roadmap-refresh and deft-build with a fourth check category: verify that counts, claims, and summaries in CHANGELOG entries and ROADMAP changelog lines match the actual data in the commit.

- skills/deft-roadmap-refresh/SKILL.md Phase 4 pre-flight mandatory file review step contains semantic accuracy check: verify counts and claims in CHANGELOG entries and ROADMAP changelog lines match actual data
- skills/deft-build/SKILL.md pre-commit checklist contains equivalent semantic accuracy check

**Traces**: #274

## t1.16.1: Anchor deft-setup path resolution to pwd at skill entry (#272)  `[completed]`

When directive is cloned into a project subdirectory, deft-setup reads ./PROJECT.md relative to the framework clone instead of the user's pwd, silently concluding bootstrap is complete. Add a ! rule to skills/deft-setup/SKILL.md Phase 2 explicitly anchoring all path resolution to pwd at skill entry.

- skills/deft-setup/SKILL.md Phase 2 contains ! rule: resolve all paths relative to pwd at skill entry -- never relative to the skill file, AGENTS.md, or any framework directory
- tests/content/test_skills.py: test coverage deferred -- constraint prohibits modifying test file in this PR; existing tests pass

**Traces**: #272

## t1.17.1: Add post-interview confirmation gate to deft-setup and document Warp auto-approve setting (#269)  `[completed]`

Warp auto-approve silently self-answers the deft-setup interview, producing garbage USER.md/PROJECT.md with no error or warning. Add a post-interview confirmation gate to deft-setup/SKILL.md that displays all captured values and requires explicit yes/no before writing files. Also document the Warp "Always ask" setting. Absorbs #271.

- skills/deft-setup/SKILL.md contains post-interview confirmation gate: after completing the interview, display a summary of all captured values and require explicit yes/no confirmation before writing USER.md, PROJECT.md, or any other artifacts
- skills/deft-setup/SKILL.md documents the Warp "Always ask" setting (AI -> Profile Settings) as the recommended configuration for running deft-setup
- tests/content/test_skills.py: test coverage deferred -- constraint prohibits modifying test file in this PR; existing tests pass

**Traces**: #269

## t1.18.1: Fix WinError 448 -- pytest-current symlink cleanup fails on Windows 11 24H2+ (#281)  `[completed]`

pytest creates a pytest-current symlink in the temp directory tree; Windows 11 24H2+ security policy flags it as an untrusted mount point and raises WinError 448 during cleanup, causing task check to fail locally even when all tests pass. Fix: add tmp_path_retention_count = 0 to [tool.pytest.ini_options] in pyproject.toml.

- pyproject.toml [tool.pytest.ini_options] contains tmp_path_retention_count = 0

**Traces**: #281

## t1.19.1: Add MCP capability detection and task check pre-existing failure carve-out to deft-review-cycle (#282)  `[completed]`

Two gaps in deft-review-cycle/SKILL.md: (1) Phase 2 Step 1 has no capability detection for MCP -- when MCP is unavailable the agent can silently skip the second review source with no rule violation; (2) Step 3 has no carve-out for pre-existing task check failures unrelated to the PR, causing agents to rationalize partial test runs without documentation requirements.

- skills/deft-review-cycle/SKILL.md Phase 2 Step 1 contains MCP capability probe mirroring deft-swarm Phase 3 pattern: if MCP unavailable, use gh api as explicit fallback and document why
- skills/deft-review-cycle/SKILL.md Phase 2 Step 1 Anti-Patterns contains entry: skip the second review source without probing for capability and documenting fallback
- skills/deft-review-cycle/SKILL.md Phase 2 Step 3 contains carve-out: partial test suite acceptable only if (a) task check failure is pre-existing with open issue number AND (b) PR description explicitly notes the failure and issue reference
- skills/deft-review-cycle/SKILL.md Anti-Patterns contains entry: run partial test suite instead of task check without documenting pre-existing failure reason and issue number in PR body

**Traces**: #282

## t1.20.1: Add ! rule to AGENTS.md for BOM-safe PowerShell file writes (#283)  `[completed]`

Agents on Windows writing files via PowerShell reach for [System.Text.Encoding]::UTF8 (writes a BOM) instead of the BOM-free constructor documented in scm/github.md. The rule exists in a reference document but is absent from AGENTS.md -- the always-loaded behavioral document. Add a ! rule to AGENTS.md making BOM-safe writes a hard gate at the decision point.

- AGENTS.md contains ! rule: when writing files using PowerShell, MUST use New-Object System.Text.UTF8Encoding $false -- never [System.Text.Encoding]::UTF8 (writes BOM); see scm/github.md PS 5.1 section

**Traces**: #283

## t1.21.1: deft-swarm Phase 6 -- require read-back verification after rebase conflict resolution (#288)  `[completed]`

Add ! rule to skills/deft-swarm/SKILL.md Phase 6 Step 1: after resolving any rebase conflict and before running git add, re-read the resolved file and verify structural integrity (no conflict markers, no collapsed lines, no encoding artifacts). Prefer edit_files over shell regex for CHANGELOG.md and SPECIFICATION.md conflict resolution. Mirrors mandatory pre-commit file review from t1.11.4, targeted at the rebase conflict resolution path. Closes #288.

- skills/deft-swarm/SKILL.md Phase 6 Step 1 contains ! rule for read-back verification after conflict resolution: re-read file, check no conflict markers, no collapsed lines, no encoding artifacts
- skills/deft-swarm/SKILL.md Phase 6 Step 1 contains ! rule preferring edit_files over shell regex for CHANGELOG.md and SPECIFICATION.md conflict resolution
- skills/deft-swarm/SKILL.md Anti-Patterns contains entry prohibiting git add without read-back verification
- tests/content/test_skills.py passes

**Traces**: #288

## t1.22.1: deft-swarm Phase 6 -- auto-generate Slack release announcement after swarm release (#292)  `[completed]`

Add a step to skills/deft-swarm/SKILL.md Phase 6 (after creating the GitHub release) that generates a standard Slack announcement block and presents it to the user. Include version, release title, summary, key changes, swarm agent count, approximate duration, PR numbers, and GitHub release URL. Closes #292.

- skills/deft-swarm/SKILL.md Phase 6 contains Step 6: Generate Slack Release Announcement after GitHub release
- Announcement template includes: version, release title, summary, key changes, agent count, duration, PR numbers, GitHub release URL
- Step uses ! rules for all required fields
- tests/content/test_skills.py passes

**Traces**: #292

## t1.23.1: Strengthen test-with-code rule -- new source files must include tests (#294)  `[completed]`

Strengthen the testing enforcement gate across 4 surfaces: (1) AGENTS.md Before committing: ! rule -- new source files (scripts/, src/, cmd/, *.py, *.go) MUST include corresponding test files in the same PR; running existing tests is not sufficient. (2) main.md Decision Making: update t1.6.1 testing gate to distinguish regression (existing tests pass) from forward coverage (new code has new tests). (3) deft-swarm SKILL.md prompt template CONSTRAINTS: new source files must have corresponding tests. (4) deft-build SKILL.md pre-commit checklist: for each new source file in this PR, verify a corresponding test file exists. Future deterministic gate (task verify:test-coverage) deferred to #233 Phase 5. Closes #294.

- AGENTS.md Before committing section contains ! rule: new source files MUST include corresponding test files in the same PR
- main.md Decision Making testing gate distinguishes regression coverage (existing tests pass) from forward coverage (new code has new tests)
- skills/deft-swarm/SKILL.md Prompt Template CONSTRAINTS contains new source files must have corresponding tests
- skills/deft-build/SKILL.md pre-commit checklist contains forward test coverage check
- tests/content/test_skills.py passes

**Traces**: #294

## t1.24.1: Resolve 5 untracked xfail gaps in known_failures.json (#295)  `[completed]`

Fix all 5 untracked xfail gaps in a single cleanup PR: (1) remove or replace leaked PROJECT.md at repo root with generic template; (2) create tools/taskfile-migration.md or remove broken See also link; (3) add RFC2119 legend to 6 files (context/context.md, context/examples.md, context/long-horizon.md, context/tool-design.md, context/working-memory.md, languages/commands.md); (4) add missing shape sections to 8 files (languages/6502-DASM.md, languages/markdown.md, languages/mermaid.md, strategies/discuss.md, strategies/research.md, interfaces/cli.md, interfaces/rest.md, interfaces/web.md); (5) investigate deprecated-path-testbed-spec xfail and either flip to false or fix the missed file. Closes #295.

- <first acceptance criterion placeholder>

**Traces**: #295

## t2.11.1: Create skills/deft-interview/SKILL.md (#296)  `[completed]`

Create skills/deft-interview/SKILL.md with RFC2119 legend and frontmatter encoding a deterministic interview loop any skill can invoke: one-question-per-turn rule, numbered options with stated default (e.g. [default: 3]), explicit other/IDK escape option, depth gate (! keep asking until no material ambiguity remains), default-acceptance rule (bare enter/yes/default accepts stated default), confirmation gate (display all captured answers and require yes/no before proceeding), and structured handoff contract (answers map for calling skill). Create .agents/skills/deft-interview/SKILL.md thin pointer. Update AGENTS.md Skill Routing table with trigger keywords (interview, ask questions, structured interview). Update deft-setup SKILL.md Phase 1 and Phase 2 to reference deft-interview for Q&A loops. Add tests/content/test_skills.py coverage. Anti-patterns: asking multiple questions at once, proceeding without confirmation gate, omitting defaults, omitting other escape. Closes #296.

- skills/deft-interview/SKILL.md exists with RFC2119 legend and YAML frontmatter
- Contains 7 rules: one-question-per-turn, numbered options with stated default, other/IDK escape, depth gate, default acceptance, confirmation gate, structured handoff contract
- Anti-patterns section covers: multiple questions, missing confirmation gate, missing defaults, missing escape option
- .agents/skills/deft-interview/SKILL.md thin pointer exists
- AGENTS.md Skill Routing table contains interview / ask questions / structured interview entry
- skills/deft-setup/SKILL.md Phase 1 and Phase 2 reference deft-interview
- tests/content/test_skills.py covers new skill with 12 tests

**Traces**: #296

## t2.8.1: Add explicit row format template to deft-roadmap-refresh skill (#221)  `[completed]`
Add an explicit `| #NNN | title | Phase |` row format template to skills/deft-roadmap-refresh/SKILL.md at the step that creates or updates Open Issues Index rows. Add 2 anti-patterns: one against creating index rows without using the template format, one against double-pipe `||` entries from omitting a column value. Closes #221.

- skills/deft-roadmap-refresh/SKILL.md Phase 2 Step 4 contains explicit row format template: `| #NNN | title | Phase |`
- Template includes ! rule: every column MUST have a value
- Anti-Patterns section contains ⊗ entry: create Open Issues Index rows without using the template format
- Anti-Patterns section contains ⊗ entry: leave empty columns between pipes (double-pipe `||`)
- tests/content/test_skills.py passes

**Traces**: #221

## t2.8.2: Strengthen spec task scaffolding in roadmap-refresh and swarm Phase 0 (#248)  `[completed]`

Roadmap refresh triages issues into the roadmap but does not create or surface spec task coverage. Add an explicit step to skills/deft-roadmap-refresh/SKILL.md: for each newly triaged issue, create a skeleton spec task in SPECIFICATION.md if one does not exist. Add a transparency note to the roadmap-refresh analysis output showing which issues lack spec coverage. Add a reminder to skills/deft-swarm/SKILL.md Phase 0 Step 2 to check and create skeleton spec tasks for roadmap candidates that are missing spec coverage before proceeding. Closes #248.

- skills/deft-roadmap-refresh/SKILL.md Phase 2 Step 4 contains ! step for skeleton spec task creation when no spec task exists
- Skeleton format includes task ID, title, issue reference, pending status, traces, and acceptance criterion placeholder
- skills/deft-roadmap-refresh/SKILL.md Phase 2 Step 2 analysis includes "Spec coverage" transparency note (existing task ID or "no spec task" callout)
- skills/deft-swarm/SKILL.md Phase 0 Step 2 contains ! rule to create skeleton spec tasks for candidates missing spec coverage before proceeding to Phase 1
- tests/content/test_skills.py passes

**Traces**: #248

## t2.8.3: Rename deft-rwldl skill to deft-pre-pr for clarity (#226)  `[completed]`

The acronym "RWLDL" is opaque and collides with the RWLDL tool pattern name. Rename skills/deft-rwldl/ to skills/deft-pre-pr/ across all surfaces: skill directory, frontmatter, .agents/skills/ thin pointer, AGENTS.md Skill Routing table, tests/content/test_skills.py, and README.md directory tree + Skills listing. Add auto-suggestion to AGENTS.md Development Process section. Add keyword routing entry for "pre-pr" / "quality loop" / "rwldl" / "self-review". Closes #226.

- skills/deft-pre-pr/SKILL.md exists (renamed from skills/deft-rwldl/SKILL.md)
- .agents/skills/deft-pre-pr/SKILL.md thin pointer exists (old deft-rwldl pointer removed)
- AGENTS.md Skill Routing table maps "pre-pr" / "quality loop" / "rwldl" / "self-review" to skills/deft-pre-pr/SKILL.md
- AGENTS.md Development Process section contains auto-suggestion for deft-pre-pr
- README.md directory tree and Skills listing reference deft-pre-pr (not deft-rwldl)
- tests/content/test_skills.py updated and passes

**Traces**: #226

## t2.8.4: Add "Your Artifacts" section to README.md documenting user-generated artifact locations (#234)  `[completed]`

New users have no quick reference for where user-generated artifacts live in a consumer project. Add a concise bulleted section to README.md listing: ./vbrief/, SPECIFICATION.md, PROJECT.md, USER.md, and ./deft/. Closes #234.

- README.md contains "Your Artifacts" section with bulleted list of artifact locations
- Lists: ./vbrief/, SPECIFICATION.md, PROJECT.md, USER.md, ./deft/
- Section is positioned near other project structure documentation

**Traces**: #234

## t2.10.1: Move installer asset links to top of README near install instructions (#266)  `[completed]`

Move or duplicate installer download links (GitHub Releases / platform binaries) to the top of README.md adjacent to the Getting Started / install instructions section, reducing friction for new users.

- README.md installer asset links are prominently placed near install instructions at the top

**Traces**: #266

## t2.10.2: Wrap install commands in fenced code blocks for GitHub copy button (#268)  `[completed]`

Wrap all install/run commands in README.md Getting Started section in fenced code blocks with appropriate language tags so GitHub renders a copy button. Bundle with #266.

- All install commands in README.md Getting Started section use fenced code blocks with language tags

**Traces**: #268

## t2.9.1: Inventory Warp Drive global rules and document in CONTRIBUTING.md (#258)  `[pending]`

Inventory all Warp Drive global rules used for deft directive development and document them in CONTRIBUTING.md under a Warp-specific section with rationale for each rule. Blocked on #89 (positioning) and #114 (project-scope rule migration).

- <first acceptance criterion placeholder>

**Traces**: #258

## t3.3.1: Restructure Taskfile.yml into modular tasks/ directory (#233)  `[completed]`

Restructure the monolithic Taskfile.yml into a minimal root with includes pointing to modular task files under tasks/. Move existing tasks into tasks/core.yml (validate, fmt, lint, test, test:coverage, check, build, clean, stats), tasks/spec.yml (spec:validate, spec:render, new spec:pipeline), tasks/install.yml (install, uninstall), tasks/deployments.yml (moved from taskfiles/). Fix stale VERSION var (currently 0.14.0, should be 0.17.0). Root Taskfile.yml becomes version + vars + includes + default task only.

- Taskfile.yml is minimal root with includes only
- tasks/core.yml contains all existing build/test/lint tasks
- tasks/spec.yml contains spec:validate, spec:render, spec:pipeline
- tasks/install.yml contains install, uninstall
- tasks/deployments.yml moved from taskfiles/
- VERSION var updated to 0.17.0
- task check passes after restructure

**Traces**: #233

## t3.3.2: Add toolchain:check, verify:stubs, validate:links, and enhanced check deps (#233, #235)  `[completed]`

Create tasks/toolchain.yml with toolchain:check (reads PROJECT.md for declared tech stack, verifies each tool is installed -- go version, uv --version, task --version, git --version, gh --version -- exits non-zero on failure). Create tasks/verify.yml with verify:stubs (rg-based or findstr/Select-String scan for TODO, FIXME, HACK, "return null", bare "pass" in .py/.go/.sh source files, excluding tests/, vendor/, .git/, backup/, history/, node_modules/) and validate:links (scan all .md files for internal links [text](path), verify target file exists, exclude history/archive/ and external URLs). Wire toolchain:check, verify:stubs, and validate:links as deps of enhanced check in tasks/core.yml.

- tasks/toolchain.yml exists with toolchain:check task
- tasks/verify.yml exists with verify:stubs and validate:links tasks
- toolchain:check verifies go, uv, task, git, gh
- verify:stubs scans source files for stub patterns, exits non-zero if found
- validate:links checks .md internal link targets exist
- Enhanced check includes toolchain:check, verify:stubs, validate:links as deps
- task check passes

## t3.3.3: Add changelog:check, change:init, and commit:lint tasks (#233, #235)  `[completed]`

Create tasks/change.yml with changelog:check (verify CHANGELOG.md has an [Unreleased] section with at least one entry since the last release tag; exit non-zero if missing) and change:init (takes a name via CLI_ARGS, creates history/changes/<name>/ directory with proposal.md, design.md, tasks.vbrief.json, and specs/ subdirectory using deterministic templates per commands.md). Create tasks/commit.yml with commit:lint (validate HEAD commit message against conventional commit format -- type(scope): description; accepted types: feat, fix, docs, chore, refactor, test, style, perf, ci, build; exit non-zero on violation).

- tasks/change.yml exists with changelog:check and change:init tasks
- tasks/commit.yml exists with commit:lint task
- changelog:check verifies [Unreleased] section has entries
- change:init creates correct directory structure per commands.md
- commit:lint validates conventional commit format
- All tasks exit non-zero on failure

**Traces**: #233, #235

## t3.3.4: Add unit tests for v0.17.0 deterministic task scripts (#293)  `[completed]`

Add tests/cli/test_task_scripts.py with subprocess-based unit tests for all scripts added in v0.17.0: toolchain-check.py (missing tool, non-zero exit, timeout, happy path), verify-stubs.py (patterns detected, clean, excluded dirs, encoding), validate-links.py (broken link, all valid, external URL skip, archive exclusion, strict mode), change:init (correct structure, path traversal rejection, empty name, duplicate), commit:lint (valid passes, missing type fails, breaking change supported). Closes #293.

- tests/cli/test_task_scripts.py exists with 25 subprocess-based test cases
- TestToolchainCheck: happy path (exit 0), missing tool (exit 1), reports NOT FOUND, timeout parameter present
- TestVerifyStubs: clean (exit 0), TODO/FIXME/HACK/bare-pass detected (exit 1), excluded dirs skipped, encoding edge case handled
- TestValidateLinks: valid links (exit 0), broken strict (exit 1), broken warning (exit 0), external URL skipped, archive excluded, --strict argv
- TestChangeInit: correct structure (proposal.md, design.md, tasks.vbrief.json, specs/), path traversal rejected, empty name rejected, duplicate rejected
- TestCommitLint: valid conventional commit passes, missing type fails, breaking change (!) accepted, all 11 types accepted
- Coverage remains >=85% after adding the new test file

**Traces**: #293

## t2.12.1: vBRIEF-centric document model -- RFC + stories A-O (#309, #310-#324)  `[pending]`

Big-bang cutover to the vBRIEF-centric document model. RFC #309 defines 18 design decisions. Implementation in 5 tiers: Tier 1 foundation (vbrief.md update, roadmap:render + drift detection, migration script, project:render, scope lifecycle tasks); Tier 2 core doc updates (main.md, AGENTS.md); Tier 3 skill renames and rewrites (deft-directive-setup/build/review-cycle/pre-pr/refinement/swarm/sync/interview); Tier 4 CLI and test coverage; Tier 5 post-cutover reconciliation. All skills renamed from deft-* to deft-directive-*. SPECIFICATION.md and PROJECT.md replaced by PROJECT-DEFINITION.vbrief.json. ROADMAP.md becomes generated artifact.

- <first acceptance criterion placeholder>

**Traces**: #309, #310, #311, #312, #313, #314, #315, #316, #317, #318, #319, #320, #321, #322, #323, #324

## t1.31.1: deft-review-cycle Approach 3 -- interactive blocking fallback when start_agent unavailable (#307)  `[completed]`

Approach 2 (yield-between-polls) silently stalls in interactive sessions with no start_agent and no scheduler. Add a third detection tier: Approach 3 uses a blocking Start-Sleep loop as a last resort, gated by a ! rule requiring the user be warned before activation. Update capability detection to distinguish three states: start_agent available (Approach 1), no start_agent but timer available (Approach 2), no start_agent + no timer + interactive (Approach 3).

- skills/deft-review-cycle/SKILL.md Review Monitoring section contains 3-tier capability detection: Tier 1 (start_agent -> Approach 1), Tier 2 (no start_agent + scheduler/timer -> Approach 2), Tier 3 (interactive + no start_agent + no timer -> Approach 3)
- skills/deft-review-cycle/SKILL.md contains Approach 3 section with blocking Start-Sleep loop using adaptive cadence (25s / 60s / 90s)
- Approach 3 contains ! user warning gate: agent MUST warn user that conversation will be locked before activating
- Anti-Patterns section contains entry: activate Approach 3 without warning user
- Anti-Patterns section updates blocking loop prohibition to exclude Approach 3 as permitted last resort

**Traces**: #307

## t1.32.1: Add Select-String fallback for oversized gh pr view output in deft-review-cycle (#328)  `[completed]`

When `do_not_summarize_output: true` produces output too large to process in deft-review-cycle Phase 2 Step 1, agents have no documented fallback. Add a Select-String fallback command to extract the "Comments Outside Diff" section with surrounding context. Note Windows/PowerShell context.

- skills/deft-review-cycle/SKILL.md Phase 2 Step 1 contains ~ fallback guidance for oversized output: `gh pr view <number> --comments | Select-String "Outside Diff" -Context 50`
- Fallback is positioned after the `do_not_summarize_output: true` rule
- Guidance notes Windows/PowerShell context (Select-String is PowerShell-native)

**Traces**: #328

## t1.30.1: Greptile review cycle optimization -- 5-change bundle (#305)  `[completed]`

Fix all 5 active review cycle bottlenecks in one PR: (1) mandate deft-pre-pr before PR creation -- AGENTS.md ! rule + deft-review-cycle Phase 1 verification gate; (2) PR scope gate warning in deft-review-cycle Phase 1 for PRs spanning 3+ unrelated surfaces; (3) adaptive poll cadence -- 20-30s first check, 60s second, 90s thereafter; (4) parallel rebase + review monitoring in deft-swarm Phase 6 via start_agent sub-agents; (5) .greptile/rules.md starter template in tools/greptile.md elevated to SHOULD.

- AGENTS.md Development Process section contains ! rule: Before opening a PR, run skills/deft-pre-pr/SKILL.md (upgraded from ~)
- skills/deft-review-cycle/SKILL.md Phase 1 contains verification gate: verify deft-pre-pr was run before PR creation
- skills/deft-review-cycle/SKILL.md Phase 1 contains ~ PR scope gate warning for PRs spanning 3+ unrelated surfaces
- skills/deft-review-cycle/SKILL.md Approach 1 and Approach 2 use adaptive poll cadence: ~20-30s first check, ~60s second, ~90s thereafter (replaces fixed 60s)
- skills/deft-swarm/SKILL.md Phase 6 Step 1 contains ~ guidance for parallel rebase + review monitoring via start_agent sub-agents
- tools/greptile.md .greptile/rules.md elevated from ? to ~ (SHOULD) with starter template
- Anti-Patterns section contains entry: create PR without running deft-pre-pr first
- Anti-Patterns section updated: poll frequency minimum changed from 60s to 20s with adaptive cadence

**Traces**: #305

## t1.29.1: Add regression test for deft-setup Phase 1/2 referencing deft-interview (#304)  `[completed]`

No test in tests/content/test_skills.py verifies that skills/deft-setup/SKILL.md Phase 1 and Phase 2 actually reference deft-interview. Add 1-2 assertions covering both phases.

- tests/content/test_skills.py contains `test_deft_setup_phase1_references_deft_interview` asserting Phase 1 section references deft-interview
- tests/content/test_skills.py contains `test_deft_setup_phase2_references_deft_interview` asserting Phase 2 section references deft-interview
- Both tests pass

**Traces**: #304

## t1.28.1: Fix deft-interview Rule 5 vs Rule 6 inconsistency -- 'ok' at confirmation gate (#303)  `[completed]`

Rule 5 (default-acceptance) lists ``ok`` as a valid response but Rule 6's confirmation gate acceptance list omits it, creating inconsistent UX. Either add ``ok`` to Rule 6's affirmative list or add a clarifying note that the confirmation gate is intentionally stricter.

- skills/deft-interview/SKILL.md Rule 6 contains clarifying note explaining the confirmation gate is intentionally stricter than Rule 5
- Note explains the asymmetry: Rule 5 accepts casual `ok` for individual defaults (low-cost, correctable at gate), Rule 6 requires explicit affirmative for entire artifact (high-cost, guards against auto-fill)
- Rule 5 acceptance list unchanged (`yes`, `y`, `ok`, `default`, `keep`)
- Rule 6 acceptance list unchanged (`yes`, `confirmed`, `approve`)

**Traces**: #303

## t1.27.1: Clarify deft-interview invocation contract -- embedded vs delegation usage modes (#302)  `[completed]`

The Invocation Contract section of skills/deft-interview/SKILL.md requires callers to supply a formal contract object, but deft-setup currently embeds the rules inline without one. Add a clarifying note distinguishing embedded mode (calling skill quotes/references rules inline -- no contract object needed) from delegation mode (explicit sub-skill invocation with a contract object).

- skills/deft-interview/SKILL.md Invocation Contract section restructured into two subsections: Embedded Mode and Delegation Mode
- Embedded Mode documents that calling skills reference rules inline without a formal contract object (current deft-setup approach)
- Delegation Mode documents explicit sub-skill invocation with formal contract object (required fields, question definitions, optional fields)
- Formal contract requirements (MUST provide) scoped to Delegation Mode only

**Traces**: #302

## t1.26.1: Tighten deft-interview routing keyword -- fix collision with spec-creation intent (#301)  `[completed]`

The bare ``interview`` keyword in AGENTS.md Skill Routing routes to deft-interview (generic Q&A loop), but users starting a spec session also say ``interview`` and expect strategies/interview.md. Tighten the trigger phrases to remove ambiguity.

- AGENTS.md Skill Routing table entry changed from ``"interview" / "ask questions" / "structured interview"`` to ``"interview loop" / "q&a loop" / "run interview loop"``
- Route still points to skills/deft-interview/SKILL.md
- Bare ``interview`` keyword no longer collides with strategies/interview.md spec-creation intent

**Traces**: #301

## t1.25.1: Flip all stale [pending] spec task statuses to [completed] in SPECIFICATION.md (#298)  `[completed]`

SPECIFICATION.md had 24 spec tasks showing `[pending]` status that were completed and shipped in prior releases but never synced. Full audit against CHANGELOG.md and ROADMAP.md identified stale statuses from v0.14.0, v0.16.0, v0.17.0, and v0.18.0. Flipped all 24 in one pass.

- All 24 stale `[pending]` task statuses flipped to `[completed]`: t3.1.1, t3.1.2, t3.1.3, t2.7.1, t2.7.2, t2.7.3, t2.7.4, t2.7.5, t2.7.6, t2.7.7, t2.7.8, t1.14.1, t1.15.1, t1.18.1, t1.19.1, t1.20.1, t1.21.1, t1.22.1, t1.23.1, t1.24.1, t2.11.1, t3.3.1, t3.3.2, t3.3.3
- No remaining `[pending]` tasks in SPECIFICATION.md that have shipped per CHANGELOG.md or ROADMAP.md Completed section
- Task body content unchanged -- only heading status markers edited

**Traces**: #298
