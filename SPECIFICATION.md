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

**Traces**: #199

## t2.1.1: Update all stale core/user.md and core/project.md references to canonical paths (FR-13)  `[pending]`

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

## t3.1.1: Write .github/workflows/ci.yml — lint + test on PRs and master pushes (FR-25, FR-26)  `[pending]`

GitHub Actions CI workflow triggering on pull_request and push to master. Jobs: (1) Python: ruff check, mypy tests/ (the shim run.py cannot be typed directly - exclude run and run.py from mypy per pyproject.toml, type-check the test suite instead), pytest tests/ with coverage. (2) Go: go test ./cmd/deft-install/ + go build ./cmd/deft-install/ for each platform matrix (linux/amd64, darwin/arm64, windows/amd64). main_test.go already exists so go test is zero-cost. Use current action versions. Closes #57.

- .github/workflows/ci.yml exists and is valid YAML
Python job runs: ruff, mypy tests/ (run and run.py excluded via pyproject.toml), pytest with coverage
Go job runs go test and builds installer for linux/amd64, darwin/arm64, and windows/amd64 (per NFR-3)
Workflow triggers on pull_request and push to master
CI passes on a clean branch

**Traces**: FR-25, FR-26, NFR-3

## t3.1.2: Open GitHub issue for run CLI coverage tracking (NFR-2)  `[pending]`

Open a new GitHub issue titled 'Bring run CLI into test coverage measurement' in the Phase 4/5 backlog. Reference the exclusion in pyproject.toml. Include the rationale: run is terminal-only, excluded for now, refactor needed before coverage is meaningful.

- GitHub issue exists with title containing 'run CLI' and 'coverage'
Issue is assigned to Phase 4 or Phase 5 milestone/label

**Traces**: NFR-2

## t2.6.6: Create scm/github.md with gh CLI rules, PR workflow conventions, and Windows/PS encoding guidance (#197, absorbs #201)  `[pending]`

Rewrite scm/github.md with standing gh CLI rules (--body-file for multi-line bodies, immediate post-create verification), PR workflow conventions (squash-merge default, single-purpose branches, branch lifecycle, closing keywords), Windows/PowerShell 5.x encoding guidance (UTF-8 without BOM, avoid emoji and special characters in machine-edited files), and post-merge issue verification. Closes #197, absorbs #201.

- scm/github.md exists with RFC2119 legend
- Contains ! rules for: --body-file for PR/issue bodies longer than one line, immediate verification after create/edit operations
- Contains PR workflow conventions: squash-merge default, single-purpose branches, branch lifecycle, closing keywords
- Contains Windows/PS 5.x encoding guidance: UTF-8 without BOM, avoid emoji/special chars in machine-edited files
- Contains post-merge issue verification section

**Traces**: #197, #201

## t2.6.7: Document ASCII convention for machine-editable structured sections (#202)  `[pending]`

Add convention rules for ASCII punctuation in machine-editable structured sections (ROADMAP.md phase bodies, CHANGELOG.md entries, Open Issues Index rows). Prefer -- instead of em-dash, -> instead of arrow, avoid emoji in body text. Never use Unicode em-dashes, curly quotes, or non-ASCII arrows in these sections. Rationale: prevents edit_files tool failures on Windows (warpdotdev/warp#9022). Closes #202.

- scm/github.md or meta/conventions.md contains ~ rule: prefer ASCII punctuation in machine-editable structured sections
- Contains ! rule: never use Unicode em-dashes, curly quotes, or non-ASCII arrows in CHANGELOG.md entries or ROADMAP.md index rows
- Rationale references warpdotdev/warp#9022

**Traces**: #202

## t2.6.8: Create skills/deft-rwldl/SKILL.md -- iterative pre-PR quality improvement loop (#182)  `[pending]`

Create skills/deft-rwldl/SKILL.md with RFC2119 legend and frontmatter. Structured self-review loop agents run before submitting a PR: Read (re-read changed files), Write (fix issues), Lint (run task check), Diff (review full diff), Loop (restart if changes made). Exit when full cycle produces zero changes. Create .agents/skills/deft-rwldl/SKILL.md thin pointer. Closes #182.

- skills/deft-rwldl/SKILL.md exists with RFC2119 legend and frontmatter
- Contains 5 loop phases: Read, Write, Lint, Diff, Loop
- Exit condition: full cycle with zero changes
- Anti-patterns section present
- .agents/skills/deft-rwldl/SKILL.md thin pointer exists

**Traces**: #182

## t3.1.3: Raise pyproject.toml coverage threshold to 85% and document run exclusion (NFR-1, NFR-2, FR-27)  `[pending]`

**Depends on**: t3.1.1, t3.1.2

Update pyproject.toml: fail_under = 85. Add comment in [tool.coverage.run] omit section explaining why run and run.py are excluded (terminal-only CLI path; pending dedicated refactor issue). Resolves stated-vs-enforced coverage gap.

- pyproject.toml fail_under = 85
omit entries for run and run.py include inline comment: '# terminal-only CLI
- excluded pending #<issue>'
task test:coverage passes at >=85% threshold on the current test suite

**Traces**: NFR-1, NFR-2, FR-27
