# Changelog

All notable changes to the Warping framework will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
  - `strategies/default.md` - DEFaulT 5-phase workflow
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
- **CLI Tool**: New `warping.sh` script for bootstrapping and project setup
  - `warping.sh bootstrap` - Set up user preferences
  - `warping.sh project` - Configure project settings
  - `warping.sh init` - Initialize warping in a new project
  - `warping.sh validate` - Validate configuration files
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
- **Pronouns Field**: Removed from user bootstrap process in `warping.sh`

### Fixed
- All internal references updated to reflect new directory structure
- Consistent path references across all markdown files
- Cross-reference links in language and interface files

## [0.1.0] - Initial Release

Initial release of the Warping framework with:
- Core AI guidelines (main.md)
- Python and Go language standards
- Basic project structure
- Taskfile integration guidelines
- Git and GitHub workflows

---

## Migration Guide: 0.1.0 → 0.2.0

### File Paths
If you have custom scripts or references to warping files, update these paths:
- `core/coding.md` → `coding/coding.md`
- `tools/testing.md` → `coding/testing.md`

### User Configuration
1. Copy `templates/user.md.template` to `core/user.md`
2. Customize with your preferences
3. Your `core/user.md` will be ignored by git

### New Features to Explore
- Run `warping.sh bootstrap` to set up user preferences interactively
- Check out `REFERENCES.md` for lazy-loading guidance
- Explore new interface guidelines if building CLIs, APIs, or UIs
- Review enhanced language standards for Python, Go, TypeScript, and C++

[0.5.1]: https://github.com/visionik/deft/releases/tag/v0.5.1
[0.5.0]: https://github.com/visionik/deft/releases/tag/v0.5.0
[0.2.2]: https://github.com/visionik/deft/releases/tag/v0.2.2
[0.2.1]: https://github.com/visionik/warping/releases/tag/v0.2.1
[0.2.0]: https://github.com/visionik/warping/releases/tag/v0.2.0
[0.1.0]: https://github.com/visionik/warping/releases/tag/v0.1.0
