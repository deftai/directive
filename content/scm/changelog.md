# Changelog Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [git.md](./git.md) | [github.md](./github.md) | [versioning.md](../meta/versioning.md)

**Specification**: [Keep a Changelog 1.0.0](https://keepachangelog.com/en/1.0.0/)

## Scope

! CHANGELOG.md is maintained **on every PR** under `[Unreleased]` and published as a versioned entry at release time.

## Purpose

The changelog documents notable changes for **users and consumers** of the software between releases. Individual commits are tracked in git history for developers.

## Format

! Use Keep a Changelog format in `CHANGELOG.md`:

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- New features in development

### Changed
- Changes in existing functionality

### Deprecated
- Soon-to-be removed features

### Removed
- Removed features

### Fixed
- Bug fixes

### Security
- Security vulnerability fixes

## [1.0.0] - 2024-01-18

### Added
- Initial release

[Unreleased]: https://github.com/user/repo/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/user/repo/releases/tag/v1.0.0
```

## Sections

! Use exactly these section headings:

- **Added** - New features
- **Changed** - Changes in existing functionality
- **Deprecated** - Soon-to-be removed features
- **Removed** - Removed features
- **Fixed** - Bug fixes
- **Security** - Security vulnerability fixes

~ Include only sections with changes for each release.

## When to Update

! Update CHANGELOG.md **on every PR**, not just at release time:

1. Add your entry under `[Unreleased]` in the appropriate section (Added/Changed/Fixed/Removed)
2. Reference the issue number: `- **Feature Name**: description (#42)`
3. The PR template checklist enforces this — reviewers should verify

? Skip the changelog entry only for test-only, CI-only, or purely internal changes.

At release time, `[Unreleased]` is renamed to the new version (see Release Process below).

## What to Include

! Include changes that affect **users, integrations, or framework-level tooling/structure**:

**Include:**
- New features users can access
- Breaking changes requiring user action
- Deprecated features users should stop using
- Bug fixes users will notice
- Security fixes
- Important performance improvements

**Exclude:**
- Internal refactoring invisible to users
- Documentation typos
- Test-only changes
- CI-only pipeline tweaks

## Version Format

! Each release section takes the form:

```markdown
## [MAJOR.MINOR.PATCH] - YYYY-MM-DD
```

! Versions listed in reverse chronological order (newest first).

! Use semantic versioning for version numbers (see [versioning.md](../meta/versioning.md)).

## Optional Release Summary Blockquote

? An optional one-line Markdown blockquote may appear directly after the `## [MAJOR.MINOR.PATCH] - YYYY-MM-DD` heading, sandwiched by blank lines:

```markdown
## [1.1.0] - 2024-02-01

> Adds dark mode and CSV export, replacing the legacy theme picker.

### Added
- Dark mode support
- Export data to CSV format
```

The blockquote captures the operator's one-sentence release narrative (recommended 80-160 chars). It is authored once during the release flow (`task release -- <version> --summary "<text>"`; see `skills/deft-directive-release/SKILL.md` Phase 1) and propagates verbatim into the GitHub release body (auto-pickup via `task release --summary`) AND the Phase 8 Slack `*Summary*:` slot. The blockquote is inline Markdown -- `**bold**`, `[link](url)`, etc. are preserved verbatim. Omit the blockquote (no `--summary` flag) to keep the pre-existing Keep-a-Changelog shape.

⊗ Hand-write a different one-line narrative for each downstream surface (CHANGELOG / GitHub release / Slack) -- author once via `--summary` and let the pipeline propagate.

## Entry Format

~ Each change is a concise bullet point:

```markdown
### Added
- Dark mode support for web UI
- Export to CSV functionality in reports
```

~ Start each entry with a verb (Added, Fixed, Changed, etc. implied by section).

! Keep entries user-focused, not implementation-focused.

**Good examples:**
- "Added dark mode toggle in settings"
- "Fixed crash when opening large files"
- "Removed deprecated `--legacy` flag"
- "Bumped `black` to 26.3.1 (framework tooling update)"

**Bad examples:**
- "Refactored authentication module" (internal, not user-visible)
- "Fixed typo in README" (documentation, minor)
- "Updated ESLint to v8" (dev CI tooling, no impact on framework users)

## Unreleased Section

! Maintain an `[Unreleased]` section at the top.

~ Add notable changes to `[Unreleased]` as they're developed.

! Move items from `[Unreleased]` to versioned section during release.

## Fragments (`changelog.d/`, #6314)

A change can record its entry in its own fragment file instead of a line in `CHANGELOG.md`, so parallel PRs do not edit the same file.

- File: `changelog.d/<issue>-<slug>.md` (one level deep; lowercase letters, digits, `.`, `_`, `-`). Two changes for one issue use different slugs.
- Format: the first line is `section: <Subsection>` (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` or `Security`); then one or more entries, each starting with `- `, with indented continuation lines.
- Invalid: an empty file, an unknown section, a line that starts with `#`, a symlink, or a non-regular file.

```markdown
section: Added
- **Fragments**: parallel PRs add changelog entries without conflicts (#6314)
```

The unreleased entries are the `[Unreleased]` lines of `CHANGELOG.md` plus the entries of all valid fragments, by subsection. Every tool that reads `[Unreleased]` reads this effective view.

`plan.policy.changelog.mode` selects the form: `inline` (default, a line in `CHANGELOG.md`), `either` (cutover) or `fragments`. Inspect with `deft policy:show --field=plan.policy.changelog.mode`; set with `deft policy:set-changelog-mode -- --mode inline|either|fragments --confirm`.

### Gate and release (#6315)

- `verify:changelog-unreleased` compares the change set with the merge base. `inline`: it adds a `- ` line under `[Unreleased]`. `fragments`: it adds at least one valid fragment absent at the merge base, and does not change `CHANGELOG.md`. `either`: it adds exactly one of the two forms. Fragments that other changes put on the branch never count.
- ! In every mode, a change only adds fragments: it never modifies, renames or deletes a fragment present at the merge base, and every fragment it adds is valid. A lifecycle-only change set stays exempt (#680).
- ! A story that adds an entry lists its own fragment path (`changelog.d/<issue>-<slug>.md`) in `file_scope`. `swarm:readiness` is unchanged: a shared path, directory or glob still overlaps.
- The release folds the fragments into the promoted section (subsection order, then file name) and deletes them in the release commit. It refuses an invalid or symlinked fragment, an entry line held by two fragments, and a changelog that already holds the version. After a failure between the write and the commit, restore `CHANGELOG.md`, `ROADMAP.md` and `changelog.d/` to HEAD and rerun; `--allow-dirty` is not a recovery path.
- Cutover: this repository runs `either` (operator decision, 2026-11-15). The move to `fragments` comes later, after a release is cut with fragments, and is the operator's call.

## Breaking Changes

! Clearly mark breaking changes:

```markdown
## [2.0.0] - 2024-02-15

### Changed
- **BREAKING**: Renamed `--output` flag to `--file`
- **BREAKING**: Removed support for Python 3.8
```

~ Provide migration guidance for breaking changes:

```markdown
### Changed
- **BREAKING**: API endpoint `/api/v1/users` moved to `/api/v2/users`
  - Migration: Update all API calls to use `/api/v2/users`
  - Old endpoint will be removed in v3.0.0
```

## Links

~ Include comparison links at bottom:

```markdown
[Unreleased]: https://github.com/user/repo/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/user/repo/releases/tag/v1.0.0
```

! Update links when adding new versions.

## Examples

### Minimal Release

```markdown
## [1.0.1] - 2024-01-20

### Fixed
- Crash when opening files larger than 10MB
- Incorrect timezone display in logs
```

### Feature Release

```markdown
## [1.1.0] - 2024-02-01

### Added
- Dark mode support
- Export data to CSV format
- Keyboard shortcuts for common actions

### Fixed
- Memory leak in background sync
- Incorrect sorting in dashboard
```

### Breaking Changes Release

```markdown
## [2.0.0] - 2024-03-01

### Changed
- **BREAKING**: Removed `--legacy` flag (use `--format=legacy` instead)
- **BREAKING**: Minimum Node.js version now 18.x
  - Migration: Upgrade Node.js to 18.x or later

### Added
- New plugin system for extensibility
- Built-in support for PostgreSQL 15

### Removed
- Support for deprecated config file format (`.oldrc`)
```

## Release Process

! Follow these steps in order when cutting a release:

1. ! Rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` (add today's release date)
2. ! Add a fresh `## [Unreleased]` section above the new version
3. ! Add link reference at bottom: `[X.Y.Z]: https://github.com/deftai/directive/releases/tag/vX.Y.Z`
4. ! Update comparison link: `[Unreleased]: https://github.com/deftai/directive/compare/vX.Y.Z...HEAD`
5. ! Commit: `chore: release vX.Y.Z`
6. ! Open a PR for the release commit and merge to `master`
7. ! After merge, tag locally: `git tag -a vX.Y.Z -m "Release vX.Y.Z"`
8. ! Push the tag: `git push origin vX.Y.Z` (triggers release workflow)
9. ~ Verify GitHub Actions builds and publishes release artifacts

⊗ Tag without a corresponding changelog entry.
⊗ Write a versioned changelog entry without tagging.

## Compliance

- ! Maintain `CHANGELOG.md` in project root
- ! Update `[Unreleased]` on every PR; rename to versioned entry only at release
- ! Use Keep a Changelog format with exact section names
- ! Include user-facing changes and framework-level changes (repo structure, tooling, docs) that affect developers who use the framework directly
- ! Use semantic versioning for release numbers
- ! Mark breaking changes clearly
- ! Write entries from user perspective, not developer perspective
- ~ Provide migration guidance for breaking changes
- ~ Keep entries concise (1-2 lines per change)

---

**See also**:
- [Keep a Changelog 1.0.0](https://keepachangelog.com/en/1.0.0/) - Full specification
- [versioning.md](../meta/versioning.md) - Semantic versioning standards
- [git.md](./git.md) - Git workflow and tagging
- [github.md](./github.md) - GitHub releases
