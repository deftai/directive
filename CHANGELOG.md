# Changelog

All notable changes to the Deft framework will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.10.0] - 2026-04-02

### Added
- **Review Cycle Skill**: Added `skills/deft-review-cycle/SKILL.md` — Greptile bot reviewer response workflow covering Phase 1 deft process audit, Phase 2 review/fix loop (batch fixes, wait-for-bot, exit condition), GitHub review submission rules, and anti-patterns; enables cloud agents to run autonomous PR review cycles; thin pointer added at `.agents/skills/deft-review-cycle/SKILL.md` (#135)
- **Roadmap Refresh Skill**: Added `skills/deft-roadmap-refresh/SKILL.md` — structured contributor workflow for triaging open issues into the phased roadmap (discovery, one-at-a-time analysis with human review, cleanup)
- **Roadmap Maintenance Strategy**: Added `strategies/roadmap.md` — optional user-facing guide for maintaining a living roadmap with agent-assisted triage
- **Agent Skill Pointer**: Added `.agents/skills/deft-roadmap-refresh/SKILL.md` thin pointer for auto-discovery
- **Swarm Skill**: Added `skills/deft-swarm/SKILL.md` — parallel local agent orchestration workflow with 6 phases (Select, Setup, Launch, Monitor, Review, Close), proven prompt template, file-overlap audit gate, monitoring checkpoints, takeover triggers, and anti-patterns; thin pointer at `.agents/skills/deft-swarm/SKILL.md` (#152)
- **history/changes/ README**: Added `history/changes/README.md` documenting the change lifecycle artifact structure — directory layout, lifecycle stages, and rules (#59, t2.1.2)
- **Contract hierarchy**: Created `contracts/hierarchy.md` documenting two hierarchy lenses — durability axis (Standards > APIs > Specs > Code) and generative axis (Spec → Contracts → Code); includes RFC2119 legend, examples, and anti-patterns (#84 Phase 1, t2.2.1)
- **Adaptive teaching behavior**: Added three adaptive teaching rules to `main.md` Agent Behavior section — be concise when accepted, explain reasoning when questioned, never lecture unprompted (#84 Phase 1, t2.2.2)

### Fixed
- **commands.md vBRIEF vocabulary**: Status lifecycle rule and example now use canonical vBRIEF v0.5 vocabulary — plan-level `draft`/`proposed`/`approved`, task-level `pending`/`running`/`completed`/`blocked`/`cancelled`; added missing `narrative` to task t3 in example; no use of legacy `todo`/`doing`/`done` (#25, t2.1.5)
- **core/project.md cleanup**: Replaced leaked personal project content with generic template; added legacy-location redirect note pointing to `./PROJECT.md` as the canonical path (t2.1.6)

### Changed
- **Yolo Strategy Deduplication**: Refactored `strategies/yolo.md` to reference `interview.md` for shared Light/Full path flows, SPECIFICATION guidelines, and Artifacts Summary — reduced from 165 to ~115 lines (#23)
- **Chaining Gate Cleanup**: Removed "Brownfield" alias from `interview.md` chaining gate options — now just "Map"
- **SpecKit Cross-Reference**: Added **⚠️ See also** banner to `strategies/speckit.md` (#24)
- **Strategies README**: Removed redundant `brownfield.md` row from strategy table; added roadmap strategy
- **README.md**: Updated directory tree and strategies reference list to reflect `default.md` deletion and `brownfield.md` redirect
- **Baseline Snapshot**: Regenerated `tests/content/snapshots/baseline.json` to reflect strategy file changes
- **Roadmap Refresh**: Triaged 12 new issues (#124, #126, #127, #131, #133–#140) into roadmap phases; moved #67, #91, #92 to Completed; cleaned stale index entries; filed upstream deftai/vBRIEF#2 for #133
- **Roadmap Refresh (2026-04-02)**: Triaged 5 new issues — #142 (AGENTS.md onboarding gate blocks headless/cloud agents, Phase 1), #144 (vBRIEF wrong narrative type + items/subItems, Phase 1 with #126), #145 (deft-review-cycle Greptile signal bug, Phase 1), #146 (deft-sync session-start skill, Phase 2), #147 (skills undocumented in README/AGENTS.md, Phase 2); fixed index formatting

### Removed
- **Redundant Strategy Files**: Deleted `strategies/default.md` (fully superseded by `interview.md`) and replaced `strategies/brownfield.md` with a redirect to `map.md` (#31, #50)

## [0.9.0] - 2026-03-29

### Added
- **Minimal CI Workflow**: Added .github/workflows/ci.yml — runs 	ask check (ruff, mypy, pytest) on all PRs and master pushes; gates merges until lint + tests pass (#57 partial)
- **Toolchain Validation Directive**: Added `coding/toolchain.md` with RFC2119 pre-implementation gate — MUST verify task runner, language compiler/runtime, and platform SDK (if applicable) before beginning implementation, stop and report if any are missing; pointer added to `coding/coding.md`; toolchain check added to `strategies/interview.md` Acceptance Gate and `skills/deft-build/SKILL.md` Step 2; iOS/Swift incident codified in `meta/lessons.md` (#106)
- **Build Output Validation Directive**: Added `coding/build-output.md` with RFC2119 rules for post-build artifact verification — MUST verify expected output files exist and are structurally valid after custom build scripts, especially non-compiled assets bundlers don't track; referenced from `coding/coding.md`; added `### Build Output Tests` section to `coding/testing.md`; codified root cause in `meta/lessons.md` (#105)
- **AGENTS.md Development Process**: Added "Development Process (always follow)" section codifying pre-code spec review, pre-commit `task check` gate, CHANGELOG/PR-template requirements, and commit message conventions — ensures agents follow deft conventions automatically via Warp project rules (partially addresses #114)

### Fixed
- **vBRIEF Generation Chain**: Fixed five-component vBRIEF generation chain that produced invalid `specification.vbrief.json` files — validator now enforces vBRIEF v0.5 schema (`vBRIEFInfo` envelope + `plan` object with `title`/`status`/`items`); migrated `specification.vbrief.json` and `plan.vbrief.json` from legacy flat format to conformant v0.5; renderer reads from new structure; `make-spec.md` and `deft-setup/SKILL.md` now include concrete vBRIEF output examples; `CONVENTIONS.md` corrected from documenting wrong format; `working-memory.md` example and `long-horizon.md` status lifecycle updated to v0.5 vocabulary; vBRIEF file validation tests added (#72, t1.2.1, t1.2.2)
- **vBRIEF Repo Reference Inconsistency**: Normalized vBRIEF source repo URL from `visionik/vBRIEF` to `deftai/vBRIEF` across `REFERENCES.md` and `vbrief/vbrief.md`
- **CLI Command Chaining Loop**: `cmd_project` no longer falls through and re-runs the entire questionnaire after `cmd_install` chains through `cmd_project` → `cmd_spec` — the original call now returns cleanly (#117, closes #91)
- **Strategy Selection Infinite Loop**: Strategy selection in `cmd_bootstrap` and `cmd_project` no longer enters an unbreakable loop when `strategies/` is empty or unresolvable — callers now warn and default to Interview when no strategy files are found (#92)
- **Strategy Fallback Value**: Strategy parsing fallback changed from deprecated `("default", "Default")` to `("interview", "Interview")` in both `cmd_bootstrap` and `cmd_project`
- **Broken Strategy Link in Generated Files**: Generated USER.md/PROJECT.md no longer writes a broken markdown link to `strategies/interview.md` when `strategies/` is empty — uses plain text instead (PR #120 review fix)

### Changed
- **Roadmap Triage**: Triaged issues #101–#108 into roadmap phases; #101 absorbed into #56; #105/#106 (directive gaps) and #107/#108 (language selection UX) added to Phase 1; #102/#103/#104 (docs/standards) added to Phase 2

## [0.8.0] - 2026-03-22

### Added
- **Agent Skill Auto-Discovery**: Added `.agents/skills/deft/`, `deft-setup/`, `deft-build/` thin pointer files to the repo — Warp and other agents now auto-discover deft skills on startup without user prompting (#94)
- **WriteAgentsSkills**: Installer now creates `.agents/skills/` in user project root during install so agents auto-discover deft skills immediately (#94)
- **Prescriptive Change Lifecycle Rule**: Added `! Before implementing any planned change that touches 3+ files or has an accepted plan artifact, propose /deft:change <name> and wait for confirmation` to `main.md` Decision Making section (#94)

### Changed
- **PrintNextSteps**: Installer output updated to reflect auto-discovery — no longer tells users to manually say 'read AGENTS.md and follow it' (#94)
- **AGENTS.md** (in-repo): Removed redundant Skills line — `.agents/skills/` handles discovery (#94)
- **agentsMDEntry**: Removed Skills line from install-generated AGENTS.md — `.agents/skills/` handles discovery, resolving the TODO from #75 (#94)

## [0.7.1] - 2026-03-20

### Fixed
- **AGENTS.md Onboarding**: Install-generated `AGENTS.md` now contains self-contained bootstrap logic — first-session phase detection (USER.md → Phase 1, PROJECT.md → Phase 2, SPECIFICATION.md → Phase 3), returning-session guidance, and available commands reference (#54, closes #85)
- **Installer 'Next Steps' Output**: Removed false claim that agents read AGENTS.md automatically; users are now told to explicitly say `read AGENTS.md and follow it` with a note that auto-discovery is planned for a future release (#54, #85)
- **README Getting Started**: Removed false-automatic claims from Step 2 and manual clone path; added explicit agent kick-off instructions (#54, #85)
- **In-repo AGENTS.md**: Updated deft repo's own AGENTS.md with developer-focused content and correct root-relative paths (no `deft/` prefix) (#54)

## [0.7.0] - 2026-03-19

### Added
- **Go Installer**: Cross-platform self-contained installer in `cmd/deft-install/` with 5 platform binaries, interactive setup wizard, and platform-aware git installation paths (#34, #35)
- **Agent Skills**: Added `skills/deft-setup/SKILL.md` and `skills/deft-build/SKILL.md` for agent-driven setup and spec implementation workflows (#34, #35)
- **GitHub Actions Release Workflow**: Multi-platform release pipeline with cross-compilation, macOS universal binary creation, and smoke tests
- **Context Engineering Module**: Added `context/` guides for deterministic split, long-horizon context, fractal summaries, working memory, and tool design
- **Canonical vBRIEF Pattern**: Standardized vBRIEF workflow and persistence pattern in `vbrief/vbrief.md`
- **vBRIEF Schema and Validation Tests**: Added `vbrief/schemas/vbrief-core.schema.json` and schema/doc consistency checks (#28, #29)
- **Strategy Chaining Gates**: Added chaining and acceptance gates to support preparatory/spec-generating strategy composition (#39, #41)
- **Testbed Regression Suite**: Expanded content and CLI regression coverage in `tests/` with Taskfile integration (#21, #22)
- **AGENTS.md Project Entry Point**: Added project-level agent onboarding entry point and wiring guidance in docs (#10, #51, #66)
- **ROADMAP.md Consolidation**: Added consolidated roadmap replacing scattered planning artifacts

### Changed
- **Bootstrap Parity**: Aligned CLI and agentic setup paths to produce consistent USER.md output (#45, #14, #61, #65)
  - CLI strategy picker now shows one-line descriptions and a ★ RECOMMENDED marker for `interview`
  - CLI custom rules prompt now collects actual rules line-by-line instead of accepting a single silent string
  - CLI meta-guidelines (SOUL.md, morals.md, code-field.md) now default to **included** with paragraph descriptions; users can drop any they don't want
  - `deft-setup` SKILL.md strategies table corrected: `interview`, `yolo`, `map`, `discuss`, `research`, `speckit`
  - `deft-setup` Track 1 now presents all three meta-guidelines as included by default with descriptions; user can drop any; Tracks 2/3 include all silently
  - `deft-setup` USER.md template now includes `## Experimental Rules` section when rules are selected
  - `deft-setup` custom rules step now instructs agents to collect rules one per line
- **Interview Strategy Reconciliation**: Unified CLI and agent entry points around strategy-driven spec flow, including sizing gate behavior (#36, #35)
- **Repository URL Migration**: Updated hardcoded repository references from `visionik/deft` to `deftai/directive` across source and documentation (#63, #64)
- **Trunk-Based Workflow**: Updated docs/workflow to remove stale beta-branch model and reflect short-lived feature branches (#69, #70)
- **Bootstrap Defaults**: `cmd_project` defaults project name from current directory and defaults "run spec now" to Yes (#47, #66)
- **Bootstrap Strategy Default**: Default strategy now uses `interview` instead of alphabetical first match (#66)
- **Tooling Dependency**: Bumped `black` from `26.3.0` to `26.3.1` (#48)
- **CHANGELOG Cleanup**: Backfilled post-0.6.0 entries, corrected release links to `deftai/directive`, and added missing `[Unreleased]` link reference (#71)

### Fixed
- **Double Prompting in Bootstrap Chain**: `cmd_project` now reads USER.md defaults (languages/strategy/coverage) instead of re-asking from scratch (#7, #43)
- **Ctrl+C Resume Protection**: Bootstrap/project flows now persist progress and support resume after interruption (#8, #66)
- **Input Validation Gaps**: Added validation for project type, language/strategy selections, coverage bounds, and duplicate selections (#44, #47, #66)
- **USER.md Overwrite Flow**: Added explicit keep/overwrite behavior when USER.md already exists (#44, #66)
- **Installer Exit Prompt on Unix**: `pressEnterToExit()` is now Windows-only, removing extra pause on macOS/Linux (#60, #66)

### Removed
- **Stale `beta` Branch**: Removed legacy beta-branch workflow and references from active docs (#69, #70)
- **Leaked `old/` Directory**: Removed stale personal configuration artifacts from repository (#51, #66)

## [0.6.0] - 2026-03-11

### Added
- **Slash Commands**: `/deft:run:<name>` dispatches to `strategies/<name>.md` (#16)
  - `/deft:run:interview`, `/deft:run:yolo`, `/deft:run:map`, `/deft:run:discuss`, `/deft:run:research`, `/deft:run:speckit`
- **Yolo Strategy**: `strategies/yolo.md` — auto-pilot interview where the agent picks all recommended options via "Johnbot" (#16)
- **Change Lifecycle**: Scoped change proposals with `/deft:change` commands (#17, #20)
  - `/deft:change <name>` — create proposal in `history/changes/<name>/`
  - `/deft:change:apply` — implement tasks from active change
  - `/deft:change:verify` — verify against acceptance criteria
  - `/deft:change:archive` — archive to `history/archive/<date>-<name>/`
  - `commands.md` — full workflow documentation
- **History Directory**: `history/changes/` and `history/archive/` for change tracking (#17)
- **Spec Deltas**: `context/spec-deltas.md` — track how requirements evolve across changes (#19)
  - vBRIEF chain pattern linking deltas to baseline specs
  - GIVEN/WHEN/THEN scenario format for behavioral requirements
  - Reading protocol: baseline → active deltas in chronological order
- **Archive Merge Protocol**: Spec delta merge into main spec + CHANGELOG entry on archive (#20)
- **Session Commands**: `/deft:continue` and `/deft:checkpoint` for session management (#16, #20)
- **Glossary**: Added "Spec delta" term definition (#19)
- **Unity Platform Standards**: `platforms/unity.md` — Unity 6+ development standards covering project structure, MonoBehaviours, ScriptableObjects, performance, Addressables, testing, and source control (#27)

### Changed
- **Strategy Renames**: `default.md` → `interview.md`, `brownfield.md` → `map.md` (#16)
- **Command Prefix**: Change lifecycle uses `/deft:change` (not `/deft:run:change`); session uses `/deft:continue`/`/deft:checkpoint` (#20)
- **Cross-references updated** across PROJECT.md, REFERENCES.md, core/glossary.md, and all strategy files (#16)
- **strategies/README.md**: Added Command column to strategy table, updated selection examples (#16)

## [0.5.2] - 2026-03-09

### Changed
- **Branch sync**: Merged master (v0.2.3 through v0.4.3) into beta (v0.5.0/v0.5.1) to unify both branches after significant divergence from the v0.2.2 fork point

### Conflict Resolutions
- **CHANGELOG.md**: interleaved both sides chronologically (v0.5.1 → v0.2.3)
- **templates/make-spec.md**: kept beta's vBRIEF specification flow
- **templates/user.md.template**: kept beta's slim override-only template (v0.5.0 intentionally removed duplicated Workflow/AI Behavior sections)
- **core/project.md**: kept master's generic Iglesia template with Volatile Dependency Abstraction rules (beta had project-specific voxio-bot config)
- **docs/claude-code-integration.md**: kept beta's relocated paths (USER.md at ~/.config/deft/, PROJECT.md at project root)
- **run / run.bat**: kept beta's more evolved CLI (2500+ lines with strategies, vBRIEF, and expanded language/deployment support)
- **README.md**: hybrid — master's Mermaid diagrams and copyright notice combined with beta's updated file paths and next-steps text

### Removed
- **implementation-plan-phase-1.md**: completed, no longer needed
- **msadams-branch**: retired (all commits absorbed into merge)

## [0.5.1] - 2026-03-08

### Added
- **Phase 1 Testbed**: Implementation plan for intrinsic regression testing
- **SPECIFICATION.md**: Generated specification via deft beta workflow
- **todo.md**: Captured deferred work items and Phase 2 refactoring roadmap

## [0.5.0] - 2026-02-23

### Added
- **`run` CLI/TUI Tool**: Cross-platform Python wizard (2,500+ lines) replacing `warping.sh`
  - `run bootstrap` - User preferences setup (writes to `~/.config/deft/USER.md`)
  - `run project` - Project configuration (writes to `./PROJECT.md`)
  - `run spec` - PRD generation via AI interview
  - `run install` - Install deft in a project directory
  - `run reset` - Reset configuration files
  - `run validate` / `run doctor` - Configuration and system checks
  - TUI mode via Textual (interactive wizard with checkboxes, selects)
  - Rich output support with fallback to plain text
- **Strategies System**: Pluggable development workflows
  - `strategies/interview.md` - Interview (standard) workflow
  - `strategies/speckit.md` - SpecKit spec-driven workflow
  - Strategy selection in bootstrap and project commands
- **RWLDL Tool**: Ralph Wiggum's Loop-de-Loop (`tools/RWLDL.md`)
  - Iterative micro/macro code refinement loop with RFC2119 notation
- **Meta Files**: `meta/SOUL.md` (agent persona), `meta/morals.md` (ethical guidelines)
- **Docs**: `docs/claude-code-integration.md` (AgentSkills integration guide)

### Changed
- **USER.md relocated**: Default path moved from `core/user.md` to `~/.config/deft/USER.md`
  - Configurable via `DEFT_USER_PATH` env var
  - Legacy fallback to `core/user.md` preserved
- **PROJECT.md relocated**: Default path moved from `core/project.md` to `./PROJECT.md`
  - Configurable via `DEFT_PROJECT_PATH` env var
- **Templates slimmed to override-only**: `user.md.template` and `project.md.template`
  - Removed sections that duplicated core deft rules (Workflow Preferences, AI Behavior, Standards)
  - Coverage threshold only emitted when non-default (≠85%)
- **All path references updated** across main.md, REFERENCES.md, README.md, SKILL.md,
  core/project.md, and docs/claude-code-integration.md
- **Principles section** added to project.md template

### Removed
- Redundant Workflow Preferences and AI Behavior sections from generated user.md
- Redundant Workflow commands and Standards sections from generated project.md
- vBRIEF integration section from ideas.md (moved to future consideration)

## [0.4.3] - 2026-02-04

### Added
- **README Mermaid Diagrams**: Added 5 visual diagrams to improve documentation clarity
  - Layer Precedence: Visual hierarchy from user.md to specification.md
  - Continuous Improvement: Feedback loop showing framework evolution
  - TDD Cycle: Classic red-green-refactor loop visualization
  - SDD Flow: Spec-driven development from idea to multi-agent build
  - Example Workflows: Three parallel workflow diagrams for new projects, existing projects, and code review

## [0.4.2] - 2026-01-31

### Changed
- **TUI UX Improvements**: Enhanced form design and user experience
  - Replaced all y/n text inputs with checkboxes for boolean options
  - Converted multi-selection fields to checkboxes (programming languages, project types)
  - BootstrapScreen: Programming languages and experimental rules now use checkboxes
  - ProjectScreen: Project types and primary language now use checkboxes
  - Fixed button visibility: Moved Submit/Cancel buttons outside ScrollableContainer
  - Added CSS styling to make buttons auto-sized (not 50% of screen)
  - Consistent TUI pattern: checkboxes for boolean/multi-choice, buttons for actions, inputs for text only
- **TUI Navigation**: Fixed markdown viewer navigation for internal links
  - Added history tracking to README, CHANGELOG, and Main.md viewers
  - Fixed SKILL.md link issue (was being converted to http://SKILL.md domain)
  - Internal .md links now navigate within viewer instead of opening browser
  - External http/https URLs still open in browser as expected
  - ESC key navigates back through document history or returns to menu
  - 'q' key always returns to menu from any document
- **TUI Documentation**: Added CHANGELOG and Main.md viewers to menu
  - New menu options after README for viewing CHANGELOG.md and main.md
  - All three markdown viewers support full navigation and history

### Fixed
- **TUI Import Error**: Removed Slider widget import (not available in Textual 7.5.0)
  - Slider widget attempted but not available in current Textual version
  - Reverted coverage threshold back to Input fields
  - TUI now launches properly with `./run` command

## [0.4.1] - 2026-01-31

### Changed
- **Documentation Optimization**: Reduced token usage across core documentation files
  - SKILL.md: 451 → 170 lines (62% reduction) - Removed redundant workflow examples, kept core concepts
  - github.md: 640 → 254 lines (60% reduction) - Removed CLI command reference, kept best practices and templates
  - git.md: 378 → 139 lines (63% reduction) - Removed basic command examples, kept standards and safety rules
  - telemetry.md: 337 → 254 lines (25% reduction) - Condensed tool examples while keeping Sentry config
  - Total: ~989 lines removed (55% overall reduction) while preserving all essential standards
- **Testing Standards**: Enhanced test-first development requirements
  - Added "Test-First Development" section to testing.md with mandatory test coverage rules
  - Implementation now INCOMPLETE until tests written AND `task test:coverage` passes
  - New functions/classes MUST have tests in same commit
  - Modified functions MUST update existing tests
  - Added test coverage anti-patterns to coding.md and testing.md
- **GitHub Standards**: Added post-1.0.0 issue linking guidelines
  - MUST link commits to issues for: features, bugs, breaking changes, architecture decisions
  - SHOULD NOT create issues for: typos, formatting, dependency bumps, refactoring
  - SHOULD create issues for: searchable items or items needing discussion
- **Taskfile Standards**: Added common task commands reference
  - Moved from coding.md to tools/taskfile.md for better organization
  - Includes: fmt, lint, test, test:coverage, quality, check, build
- **SKILL.md Updates**: 
  - Changed all `./run` and `deft.sh` references to `deft/run` for consistency
  - Added first-use bootstrap guidance for existing projects
  - Reduced from 451 to 170 lines while keeping all essential information

### Fixed
- **Documentation Consistency**: Aligned command references across all files to use `deft/run` prefix

## [0.4.0] - 2026-01-31

### Added
- **TUI Wizard Mode**: Full Textual-based interactive wizard interface
  - Launches with `./run`, `./run tui`, or `./run wizard`
  - Interactive menu with 10 screens: Bootstrap, Project, Spec, Install, Reset, Validate, Doctor, README, Help, Exit
  - BootstrapScreen: User preferences form with name, coverage, languages, custom rules
  - ProjectScreen: Project configuration form with type, language, tech stack
  - SpecScreen: Specification generator with dynamic feature list (add/remove features)
  - InstallScreen: Framework installation with directory input
  - ResetScreen: Configuration reset with file status display
  - ValidateScreen: Configuration validation with scrollable results
  - DoctorScreen: System dependency check with scrollable results
  - ReadmeScreen: MarkdownViewer with table of contents and navigation
  - HelpScreen: Usage information display
  - Centered menu layout with aligned option descriptions
  - Consistent cyan accent theme matching CLI aesthetic
  - Navigation: Escape/Q to quit, context-specific keybindings
  - SuccessScreen: Reusable success messages with optional next-step navigation
- **Enhanced CLI UX**: Improved rich output formatting
  - Markdown ## headers for section titles (cleaner than horizontal rules)
  - Prompt_toolkit integration with colored prompts and arrow key editing
  - HTML-formatted prompts with cyan ? prefix
  - Graceful fallback when dependencies not installed

### Changed
- **Help System**: `-h`, `--help`, `-help` flags show usage (TUI no longer launches for `./run` with no args if textual not installed)
- **Menu Design**: Aligned option labels with minimal dots (longest command name sets alignment)
- **Empty Separators**: Replaced `---` separators with empty lines for cleaner menu

### Fixed
- **ANSI Codes**: Fixed raw ANSI escape codes displaying literally in prompt_toolkit prompts
- **Import Compatibility**: Fixed Separator import from textual (use Option with empty string instead)

## [0.3.7] - 2026-01-29

### Changed
- **README Getting Started**: Complete rewrite with clearer workflow
  - New structure: Install → Bootstrap → Generate Spec → Build with AI
  - Added git clone installation instructions
  - Streamlined command examples
  - Removed platform-specific sections

### Removed
- **Platform-specific content**: Removed "Integration with Warp AI" section
- **notes-keys.html**: Removed development file from repository

## [0.3.6] - 2026-01-29

### Changed
- **README Quick Start**: Updated run command examples
  - Changed from `run` to `deft/run` prefix for clarity
  - Removed `run install` command
  - Updated workflow to: bootstrap → project → spec

## [0.3.5] - 2026-01-29

### Changed
- **README Structure**: Moved copyright notice to end of file for better flow
  - Copyright and license info now appears at bottom after main content
  - Cleaner opening for new readers

## [0.3.4] - 2026-01-29

### Changed
- **README Formatting**: Consolidated file descriptions to one line per file for better readability
  - Core, Languages, Interfaces, Tools, Templates, and Meta sections now use single-line format
  - Improved scannability and reduced visual clutter

## [0.3.3] - 2026-01-29

### Changed
- **README TL;DR Enhancements**: 
  - Emphasized Deft as a SKILL.md format for AI coding effectiveness
  - Added platform compatibility note for systems without SKILL.md support (e.g. Warp.dev)
  - Added context efficiency explanation: RFC 2119 notation and lazy-loading keep context windows lean
  - Clarified that Deft is markdown-first with optional Python CLI for setup

## [0.3.2] - 2026-01-29

### Changed
- **README TL;DR**: Added note about professional-grade defaults
  - Highlights that Deft works out of the box without customization
  - Emphasizes built-in standards for Python, Go, TypeScript, C++

## [0.3.1] - 2026-01-29

### Changed
- **MIT License**: Updated from temporary usage terms to full MIT License
  - Users can now freely use, modify, distribute, and sell Deft
  - Only requirement: retain copyright notice and license text
  - Updated LICENSE.md with standard MIT text
- **Branding**: Updated copyright notices to include website
  - Copyright now reads: Jonathan "visionik" Taylor
  - Added https://deft.md reference in LICENSE.md and README.md
- **README Improvements**: Added TL;DR section
  - Quick summary of what Deft is and why it's valuable
  - Highlights key benefits before diving into details

## [0.3.0] - 2026-01-29

### Changed
- **Project renamed from Warping to Deft**: Complete rebrand across all files and documentation
  - CLI command renamed from `wrun` to `run`
  - All references to "Warping" replaced with "Deft" throughout documentation
  - GitHub repository renamed from `visionik/warping` to `visionik/deft`
  - Local directory renamed to match new project name
  - Updated LICENSE.md, README.md, and all markdown files
  - Updated Taskfile.yml project name variable

## [0.2.5] - 2026-01-23

### Added
- **`run reset` command**: Reset configuration files to default/empty state
  - Interactive mode: prompts for each file individually
  - Batch mode (`--all`): resets all files without prompting
  - Resets user.md to default template, deletes project.md/PRD.md/SPECIFICATION.md
- **Guided workflow prompts**: Commands now chain together interactively
  - `run install` asks to run `run project` after completion
  - `run bootstrap` asks to run `run project` after completion (if in deft directory)
  - `run project` asks to run `run spec` after completion
  - Creates smooth guided flow: install → bootstrap → project → spec
- **Enhanced command descriptions**: Each command now shows detailed explanation at startup
  - `run install`: Shows what will be created (deft/, secrets/, docs/, Taskfile.yml, .gitignore)
  - `run project`: Explains project.md purpose (tech stack, quality standards, workflow)
  - `run spec`: Explains PRD.md creation and AI interview process
- **Smart project name detection**: `run spec` reads project name from project.md
  - Auto-suggests project name if project.md exists
  - Falls back to manual input if not found
- **Improved prompt_toolkit installation**: Better detection and instructions
  - Shows exact Python interpreter path being used
  - Detects externally-managed Python (PEP 668)
  - Automatically includes `--break-system-packages` flag when needed
  - Provides clear explanation and alternatives (venv, pipx)
  - Links to PEP 668 documentation

### Changed
- **Renamed `run.py` → `run`**: Removed .py extension for cleaner command
  - Follows Unix convention for executables
  - More professional appearance
  - All documentation updated
- **Renamed `run init` → `run install`**: Better matches common tooling patterns
  - Aligns with Makefile/Taskfile conventions (make install, task install)
  - Clearer intent: "install deft framework"
  - Less confusion with bootstrap command
  - Updated all references: "initialized" → "installed", "Reinitialize" → "Reinstall"
- **Updated README.md**: Added Quick Start section with run commands
  - Shows complete workflow: install → bootstrap → project → spec
  - Lists all available commands with descriptions

### Fixed
- **prompt_toolkit installation issues**: Python version mismatch detection
  - Now uses `python -m pip` instead of bare `pip` command
  - Ensures package installs for correct Python interpreter
  - Prevents "module not found" errors when Python 3.x versions differ

## [0.2.4] - 2026-01-22

### Added
- **AgentSkills Integration**: Added `SKILL.md` for Claude Code and clawd.bot compatibility
  - Follows AgentSkills specification for universal AI assistant compatibility
  - Auto-invokes when working in deft projects or mentioning deft standards
  - Teaches AI assistants about rule precedence, lazy loading, TDD, SDD, and quality standards
  - Includes comprehensive "New Project Workflow" section with step-by-step guidance
  - Documents complete SDD process: PRD → AI Interview → Specification → Implementation
  - Compatible with both Claude Code (IDE) and clawd.bot (messaging platforms)
- **clawd.bot Support**: Added clawd.bot-specific metadata to SKILL.md
  - Requires `task` binary (specified in metadata)
  - Supports macOS and Linux platforms
  - Homepage reference to GitHub repository
  - Installation paths for shared and per-agent skills
- **Integration Documentation**: Created `docs/claude-code-integration.md` (renamed to include clawd.bot)
  - Installation instructions for both Claude Code and clawd.bot
  - Usage examples across IDE and messaging platforms
  - Publishing guidance for Skills Marketplace and ClawdHub
  - Multi-agent setup documentation
  - Cross-platform benefits and compatibility notes

### Changed
- **SKILL.md Structure**: Enhanced with detailed workflow sections
  - Step-by-step initialization workflow (init → bootstrap → project → spec)
  - Conditional logic for first-time user setup
  - Complete SDD workflow documentation with user review gates
  - Context-aware workflows for new projects vs existing projects vs new features
  - Integration notes expanded to cover multiple AI platforms

## [0.2.3] - 2026-01-22

### Added
- **Project Type Selection**: Added "Other" option (option 6) to project type selection in `deft.sh project`
  - Prompts for custom project type when selected
  - Allows flexibility for project types beyond CLI, TUI, REST API, Web App, and Library

### Changed
- **Spec Command Output**: Improved next steps messaging in `deft.sh spec`
  - Now displays full absolute paths to PRD.md and SPECIFICATION.md
  - Updated AI assistant references to "Claude, Warp.dev, etc."
  - Added steps 5-7 with guidance on reviewing, implementing, and continuing with AI
  - Clearer instructions: "Ask your AI to read and run {full_path}"

## [0.2.2] - 2026-01-21

### Added
- **LICENSE.md**: Added license file with temporary usage terms through 2026
  - Permission to use (but not distribute) for repository collaborators
  - Future plans for permissive license preventing resale
- **Copyright Notice**: Added copyright to README.md with contact email

## [0.2.1] - 2026-01-18

### Added
- **SCM Directory**: Created `scm/` directory for source control management standards
  - `scm/git.md` - Git workflow and conventions
  - `scm/github.md` - GitHub workflows and releases
  - `scm/changelog.md` - Changelog maintenance standards (releases only)
- **Versioning Standards**: Added `core/versioning.md` with RFC2119-style Semantic Versioning guide
  - Applies to all software types (APIs, UIs, CLIs, libraries)
  - Decision trees, examples, and FAQ
  - Integration with git tags and GitHub releases

### Changed
- **SCM Reorganization**: Moved `tools/git.md` and `tools/github.md` to `scm/` directory
- **Documentation Standards**: All technical docs now use strict RFC2119 notation
  - Use symbols (!, ~, ?, ⊗, ≉) only, no redundant MUST/SHOULD keywords
  - Minimizes token usage while maintaining clarity
- **Internal References**: All docs reference internal files instead of external websites
  - semver.org → `core/versioning.md`
  - keepachangelog.com → `scm/changelog.md`

### Fixed
- Removed all redundant MUST/SHOULD/MAY keywords from technical documentation
- Corrected RFC2119 syntax throughout framework (swarm.md, git.md, github.md)
- Fixed grammar issues in changelog.md

## [0.2.0] - 2026-01-18

### Added

#### Core Features
- **CLI Tool**: New `deft.sh` script for bootstrapping and project setup
  - `deft.sh bootstrap` - Set up user preferences
  - `deft.sh project` - Configure project settings
  - `deft.sh init` - Initialize deft in a new project
  - `deft.sh validate` - Validate configuration files
- **Task Automation**: Added `Taskfile.yml` with framework management tasks
  - `task validate` - Validate all markdown files
  - `task build` - Package framework for distribution
  - `task install` - Install CLI to /usr/local/bin
  - `task stats` - Show framework statistics
- **Template System**: User and project configuration templates
  - `templates/user.md.template` - Template for new users
  - Generic templates in `core/user.md` and `core/project.md`

#### Documentation
- **REFERENCES.md**: Comprehensive lazy-loading guide for when to read which files
- **Expanded Language Support**: Added detailed standards for:
  - C++ (cpp.md) - C++20/23, Catch2/GoogleTest, GSL
  - TypeScript (typescript.md) - Vitest/Jest, strict mode
- **Interface Guidelines**: New interface-specific documentation
  - `interfaces/cli.md` - Command-line interface patterns
  - `interfaces/rest.md` - REST API design
  - `interfaces/tui.md` - Terminal UI (Textual, ink)
  - `interfaces/web.md` - Web UI (React, Tailwind)

#### Organization
- **New `coding/` directory**: Reorganized coding-specific standards
  - `coding/coding.md` - General coding guidelines
  - `coding/testing.md` - Universal testing standards
- **Meta files**: Added self-improvement documentation
  - `meta/code-field.md` - Coding mindset and philosophy
  - `meta/lessons.md` - Codified learnings (AI-updatable)
  - `meta/ideas.md` - Future directions
  - `meta/suggestions.md` - Improvement suggestions

### Changed

#### Breaking Changes
- **Directory Restructure**: Moved files to new locations
  - `core/coding.md` → `coding/coding.md`
  - `tools/testing.md` → `coding/testing.md`
  - All cross-references updated throughout framework
- **User Configuration**: `core/user.md` now in `.gitignore`
  - Users should copy from `templates/user.md.template`
  - Prevents accidental commits of personal preferences

#### Improvements
- **Enhanced README.md**: Comprehensive overview with examples
- **Better Documentation**: Clearer hierarchy and precedence rules
- **Framework Philosophy**: Documented key principles (TDD, SDD, Task-centric workflows)
- **Coverage Requirements**: Standardized at ≥85% across all languages
- **Fuzzing Standards**: Added ≥50 fuzzing tests per input point requirement

### Removed
- **Pronouns Field**: Removed from user bootstrap process in `deft.sh`

### Fixed
- All internal references updated to reflect new directory structure
- Consistent path references across all markdown files
- Cross-reference links in language and interface files

## [0.1.0] - Initial Release

Initial release of the Deft framework with:
- Core AI guidelines (main.md)
- Python and Go language standards
- Basic project structure
- Taskfile integration guidelines
- Git and GitHub workflows

---

## Migration Guide: 0.1.0 → 0.2.0

### File Paths
If you have custom scripts or references to deft files, update these paths:
- `core/coding.md` → `coding/coding.md`
- `tools/testing.md` → `coding/testing.md`

### User Configuration
1. Copy `templates/user.md.template` to `core/user.md`
2. Customize with your preferences
3. Your `core/user.md` will be ignored by git

### New Features to Explore
- Run `deft.sh bootstrap` to set up user preferences interactively
- Check out `REFERENCES.md` for lazy-loading guidance
- Explore new interface guidelines if building CLIs, APIs, or UIs
- Review enhanced language standards for Python, Go, TypeScript, and C++

[Unreleased]: https://github.com/deftai/directive/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/deftai/directive/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/deftai/directive/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/deftai/directive/compare/v0.7.1...v0.8.0
[0.7.0]: https://github.com/deftai/directive/releases/tag/v0.7.0
<!-- [0.6.0] has no git tag — it was a beta-only version that was never tagged on master. -->
[0.5.2]: https://github.com/deftai/directive/releases/tag/v0.5.2
[0.5.1]: https://github.com/deftai/directive/releases/tag/v0.5.1
[0.5.0]: https://github.com/deftai/directive/releases/tag/v0.5.0
[0.4.3]: https://github.com/deftai/directive/releases/tag/v0.4.3
[0.4.2]: https://github.com/deftai/directive/releases/tag/v0.4.2
[0.4.1]: https://github.com/deftai/directive/releases/tag/v0.4.1
[0.4.0]: https://github.com/deftai/directive/releases/tag/v0.4.0
[0.7.1]: https://github.com/deftai/directive/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/deftai/directive/releases/tag/v0.7.0
[0.3.7]: https://github.com/deftai/directive/releases/tag/v0.3.7
[0.3.6]: https://github.com/deftai/directive/releases/tag/v0.3.6
[0.3.5]: https://github.com/deftai/directive/releases/tag/v0.3.5
[0.3.4]: https://github.com/deftai/directive/releases/tag/v0.3.4
[0.3.3]: https://github.com/deftai/directive/releases/tag/v0.3.3
[0.3.2]: https://github.com/deftai/directive/releases/tag/v0.3.2
[0.3.1]: https://github.com/deftai/directive/releases/tag/v0.3.1
[0.3.0]: https://github.com/deftai/directive/releases/tag/v0.3.0
[0.2.5]: https://github.com/deftai/directive/releases/tag/v0.2.5
[0.2.4]: https://github.com/deftai/directive/releases/tag/v0.2.4
[0.2.3]: https://github.com/deftai/directive/releases/tag/v0.2.3
[0.2.2]: https://github.com/deftai/directive/releases/tag/v0.2.2
[0.2.1]: https://github.com/visionik/warping/releases/tag/v0.2.1
[0.2.0]: https://github.com/visionik/warping/releases/tag/v0.2.0
[0.1.0]: https://github.com/visionik/warping/releases/tag/v0.1.0
