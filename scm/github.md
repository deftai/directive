# GitHub Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**See also**: [main.md](../main.md) | [git.md](./git.md) | [changelog.md](./changelog.md)

**Stack**: gh CLI 2.0+, GitHub Actions, Conventional Commits, issue/PR workflows

## Standing gh CLI Rules

Rules that apply to every `gh` invocation, regardless of context.

- ! Use `--body-file` for PR and issue bodies longer than one line -- inline `--body` strings break on special characters, newlines, and shell escaping across platforms
- ! Write `--body-file` temp files to the OS temp directory, not the worktree -- writing temp files inside the worktree triggers `rm` denylist collisions that block autonomous swarm agents in Warp (the agent cannot delete files via `rm` in autonomous mode)
  - **PowerShell:**
    ```powershell
    $bodyFile = [System.IO.Path]::GetTempFileName()
    [System.IO.File]::WriteAllText($bodyFile, $content, [System.Text.UTF8Encoding]::new($false))
    gh pr create --title "feat: example" --body-file $bodyFile
    ```
  - **Unix (bash/zsh):**
    ```bash
    bodyFile=$(mktemp)
    echo "$content" > "$bodyFile"
    gh pr create --title "feat: example" --body-file "$bodyFile"
    ```
  - No explicit `rm` is needed after `gh pr create` -- the file lives outside the worktree, which is the key advantage: it eliminates the `rm` step that collides with the Warp autonomous agent `rm` denylist. (OS temp directories are eventually cleaned by the OS on Unix/macOS; on Windows they persist until manually purged, but agent cleanup is not required.)
- ! Immediately verify after every create or edit operation:
  - After `gh pr create`: run `gh pr view <number>` to confirm title, body, and labels rendered correctly
  - After `gh issue create`: run `gh issue view <number>` to confirm body content
  - After `gh pr edit`: re-fetch and verify the edited field
- ~ Prefer `gh api` for structured/programmatic queries (filtering, bulk reads, JSON output) and `gh pr`/`gh issue` for quick ad-hoc commands
- ⊗ Construct multi-line `--body` strings inline in shell commands -- always write to a temp file and use `--body-file`
- ⊗ Write `--body-file` temp files inside the worktree or repository directory -- always use the OS temp directory (`$env:TEMP` on PowerShell, `$TMPDIR` or `/tmp` on Unix)

## PR Workflow Conventions

### Merge Strategy

- ! Use squash-merge as the default merge method: `gh pr merge --squash --delete-branch`
- ~ Squash-merge keeps the mainline history linear and readable -- one commit per PR
- ? Use merge commits only when preserving individual commit history is explicitly required (e.g., vendor imports)
- ⊗ Use rebase-merge on PRs with multiple commits unless the author explicitly requests it

### Branch Lifecycle

- ! Create feature branches from `master` (or the project's default branch)
- ! Each branch serves a single purpose -- one issue or one cohesive change
- ! Include closing keywords in the PR body (`Closes #N`, `Fixes #N`) so GitHub auto-closes issues on merge
- ! Delete the branch after merge (`--delete-branch` flag on `gh pr merge`)
- ⊗ Reuse a branch for a second PR after the first has merged
- ~ Name branches descriptively: `docs/add-github-guide`, `fix/bootstrap-loop`, `feat/swarm-phase0`

### PR Standards

- ! Use Conventional Commits format for PR titles
- ~ Keep PRs small (< 400 lines changed ideal)
- ! Ensure all CI checks pass before requesting review
- ~ Link to related issues using closing keywords
- ~ Explain "why" not just "what" in the PR description
- ! Run `task check` before opening a PR

### Review Guidelines

**Approval criteria (MUST be met)**:

- Code follows language standards (python.md, go.md, cpp.md)
- Tests pass with required coverage threshold
- Conventional Commits format
- No security vulnerabilities
- Documentation updated
- No breaking changes (or properly documented)

**Review tone (SHOULD follow)**:

- Be constructive and specific
- Explain "why" not just "what"
- Suggest alternatives when requesting changes
- Focus on correctness, maintainability, performance (in that order)

## Post-Merge Issue Verification

! After a PR is squash-merged, verify that all referenced issues were actually closed. Squash merges can silently fail to process closing keywords (`Closes #N`, `Fixes #N`) from the PR body (#167).

1. ! For each issue referenced with a closing keyword in the PR body, run:
   ```
   gh issue view <N> --json state --jq .state
   ```
2. ! If the issue state is not `CLOSED`, close it manually with a comment referencing the merged PR:
   ```
   gh issue close <N> --comment "Closed by #<PR> (squash merge -- auto-close did not trigger)"
   ```
3. ~ This applies to ALL PR merges, not just swarm runs. See also: `skills/deft-review-cycle/SKILL.md` Post-Merge Verification, `skills/deft-swarm/SKILL.md` Phase 6 Step 2.

## Windows / PowerShell Encoding Guidance

PowerShell 5.x (Windows default) uses UTF-16LE internally and may inject a BOM or transcode `gh` CLI output unexpectedly. These issues are silent -- files look correct in the editor but fail on `edit_files` or `git diff`.

- ! Use UTF-8 without BOM for all `--body-file` content written from scripts or agents
- ! On PowerShell 5.x, set encoding before writing temp files:
  ```powershell
  [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))
  ```
- ~ Avoid piping `gh` output through PowerShell 5.x redirection (`>`, `Out-File`) -- these default to UTF-16LE; use .NET `WriteAllText` with the BOM-free constructor instead (see rule below)
- ~ Prefer PowerShell 7+ (`pwsh`) which defaults to UTF-8 without BOM
- ! Use `Get-Content -Raw` to read a file as a single string -- reading without `-Raw` processes line-by-line and can inject BOM characters or silently mangle Unicode characters (em-dashes, curly quotes) when the file is re-written
- ! For BOM-safe file writes after agent reads, use `[System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))` -- never use `Set-Content` (even with `-Encoding UTF8`) or `Out-File` in PS 5.1, as both inject a BOM regardless of the `-Encoding` flag (`Out-File -Encoding utf8NoBOM` requires PS 7+ and is unavailable in PS 5.1)

**Rationale**: PS 5.1 defaults to UTF-16LE for `Set-Content` and UTF-8-with-BOM for some paths, causing silent mojibake on round-trip. The combination of `Get-Content -Raw` for reads and `[System.IO.File]::WriteAllText` for writes is the only reliable BOM-safe round-trip pattern.

### Warp Terminal Multi-Line String Handling

- ! Never paste multi-line PowerShell string literals (here-strings `@" ... "@`) directly into the Warp agent input box -- Warp splits multi-line input across separate command blocks, causing syntax errors or silent truncation. Always write multi-line PS content to a temp file first (e.g. `[System.IO.File]::WriteAllText($tmpFile, $content, [System.Text.UTF8Encoding]::new($false))`), then use the temp file path in subsequent commands

## Windows / ASCII Conventions for Machine-Editable Sections

Agent `edit_files` operations can fail when structured file sections contain Unicode characters that do not round-trip cleanly through Windows toolchains (xref warpdotdev/warp#9022). The following rules apply to **machine-editable structured sections**: ROADMAP.md phase bodies, CHANGELOG.md entries, and Open Issues Index rows.

- ~ In machine-editable structured sections, prefer ASCII punctuation:
  - Use `--` instead of em-dash
  - Use `->` instead of arrow characters
  - Avoid emoji in body text (emoji in headings or decorative positions are acceptable)
- ! Never use Unicode em-dashes, curly quotes, or non-ASCII arrow characters in CHANGELOG.md entries or ROADMAP.md index rows -- these cause `edit_files` search/replace mismatches when the tool's internal encoding differs from the file's byte representation
- ~ Use straight quotes (`"`, `'`) rather than curly/smart quotes in all machine-edited files
- ? Prose-only sections (README narrative, philosophy docs) may use Unicode freely since they are rarely machine-edited

**Rationale**: The `edit_files` tool performs exact byte-string matching. When Windows agents write files through encoding layers that silently substitute characters (e.g., em-dash `\u2014` vs. `--`), subsequent search/replace operations fail because the stored bytes no longer match the search string. Sticking to ASCII in structured sections eliminates this class of failure.

## Issue Workflow

**Best practices**:
- ~ Search for duplicates before creating
- ! Include reproduction steps, expected/actual behavior, environment details
- ~ Apply appropriate labels and assign when taking ownership
- ~ Link related issues and PRs

### Issue Labels

**Priority**: `priority:critical` (production down), `priority:high` (major broken), `priority:medium` (important, not blocking), `priority:low` (nice to have)

**Type**: `bug`, `feat`, `docs`, `refactor`, `test`, `chore`

**Status**: `status:blocked`, `status:in-progress`, `status:needs-info`, `status:wontfix`

### Post-1.0.0 Issue Linking

Following a v1.0.0 release, commits:

- ! link to existing or new issues for: Features, bugs, breaking changes, architecture decisions
- ≉ create issues for: Typos, formatting, dependency bumps, refactoring same code
- ~ create issues for: Anything someone might search for later, or that needs discussion

**Format**: Reference issues in commit messages using `Closes #123`, `Fixes #456`, or `Relates to #789`

## GitHub Actions Best Practices

**CI Workflows**:
- ~ Provide fast feedback (fail fast, cache dependencies)
- ~ Use matrix testing for multiple versions
- ! Run `task check` for quality gates
- ~ Upload coverage reports

**Security**:
- ! Use GitHub Secrets for CI/CD credentials
- ⊗ Commit secrets to repo
- ~ Keep secrets in `secrets/` dir locally (gitignored)
- ~ Rotate secrets regularly

## Branch Protection

**Recommended settings** for `main`:
- ! Require PR reviews (1+ approvals)
- ! Require status checks to pass
- ! Require branches to be up to date
- ~ Require conversation resolution
- ~ Require linear history
- ⊗ Allow force pushes
- ⊗ Allow deletions

## Release Workflow (UCCPR)

**UCCPR** = Update Changelog, Commit, Push, Release

Standard workflow for releasing new versions:

1. Update `CHANGELOG.md` -- move `[Unreleased]` entries to new version section with date
2. Update `VERSION` constant in main script/package file
3. Commit: `git commit -m "chore: release v<X.Y.Z>"`
4. Push to default branch
5. Tag: `git tag v<X.Y.Z> && git push origin v<X.Y.Z>`
6. Release: `gh release create v<X.Y.Z> --title "Deft v<X.Y.Z>" --notes-file release-notes.md`

## Compliance

- ! Use Conventional Commits for all PR titles
- ! Maintain CHANGELOG.md following [Keep a Changelog](./changelog.md) format
- ! Use [Semantic Versioning](../core/versioning.md) for releases
- ! Include CHANGELOG.md content in release notes
- ! Maintain test coverage at or above PROJECT.md threshold
- ! Pass all CI checks before merge
- ~ Request reviews from appropriate team members
- ~ Link PRs to related issues
- ~ Use gh CLI for automation where possible
- ⊗ Force-push to protected branches
- ! Keep PR scope focused and size reasonable
- ! Update documentation with code changes
