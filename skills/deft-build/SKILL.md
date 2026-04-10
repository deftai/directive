---
name: deft-build
description: >
  Build a project from a SPECIFICATION.md following Deft framework standards.
  Use after deft-setup has generated the spec, or when the user has a
  SPECIFICATION.md ready to implement. Handles scaffolding, implementation,
  testing, and quality checks phase by phase.
---

# Deft Build

Implements a project from its SPECIFICATION.md following deft standards.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## When to Use

- After `/deft-setup` completes and generates SPECIFICATION.md
- User says "build this", "implement the spec", or "start building"
- Resuming a partially-built project that has a spec

## Platform Detection

! Before resolving any config paths, detect the host OS from your environment context:

| Platform           | USER.md default path                                              |
|--------------------|-------------------------------------------------------------------|
| Windows            | `%APPDATA%\deft\USER.md` (e.g. `C:\Users\{user}\AppData\Roaming\deft\USER.md`) |
| Unix (macOS/Linux) | `~/.config/deft/USER.md`                                          |

- ! If `$DEFT_USER_PATH` is set, it takes precedence on any platform

## USER.md Gate

! Before proceeding, verify USER.md exists at the platform-appropriate path
(resolved via Platform Detection above, or `$DEFT_USER_PATH` if set).

- ! If USER.md is not found: inform the user and redirect to `deft-setup`
  Phase 1 before continuing — do not proceed without user preferences
- ! Once USER.md exists, continue with File Reading below

## File Reading

- ! Read in order, lazy load:
  1. `./SPECIFICATION.md` — what to build (required)
  2. `./PROJECT.md` — project config, tech stack, strategy
  3. USER.md at the platform-appropriate path (see Platform Detection) — Personal section is highest precedence; Defaults are fallback
  4. `deft/main.md` — framework guidelines
  5. `deft/coding/coding.md` — coding standards
  6. `deft/coding/testing.md` — testing requirements
  7. `deft/coding/toolchain.md` — toolchain validation rules
  8. `deft/languages/{language}.md` — only for languages this project uses
- ⊗ Read all language/interface/tool files upfront

## Rule Precedence

```
USER.md Personal  ← HIGHEST (name, custom rules — always wins)
PROJECT.md        ← Project-specific (strategy, coverage, languages, tech stack)
USER.md Defaults   ← Fallback defaults (used when PROJECT.md doesn't specify)
{language}.md      ← Language standards
coding.md          ← General coding
main.md            ← Framework defaults
SPECIFICATION.md   ← LOWEST
```

- ! USER.md Personal section always wins over any other file
- ! For project-scoped settings, PROJECT.md overrides USER.md Defaults

## Change Lifecycle Gate

! Before any implementation that touches 3+ files, verify that a `/deft:change <name>` proposal exists and has been confirmed by the user:

- ! Check `history/changes/` for an active change proposal matching this work
- ! If no proposal exists: propose `/deft:change <name>` and present the change name for explicit confirmation (e.g. "Confirm? yes/no")
- ! The user must reply with an affirmative (`yes`, `confirmed`, `approve`) — a general 'proceed', 'do it', or 'go ahead' does NOT satisfy this gate
- ? For solo projects: this gate is RECOMMENDED but not mandatory for changes fully covered by `task check`; it remains mandatory for cross-cutting, architectural, or high-risk changes
- ⊗ Skip this gate because the user has already said "proceed" or "go ahead"

## Build Process

### Step 1: Understand the Spec

- ! Read SPECIFICATION.md
- ! Identify phases, dependencies, starting point
- ! Present brief summary to user:

> "Here's what I see: Phase 1: {name} ({N} tasks), Phase 2: {name} (depends on Phase 1). I'll start with Phase 1. Ready?"

### Step 2: Verify Toolchain

- ! Before any implementation, verify all tools required by this project are installed and functional — see `deft/coding/toolchain.md` for full rules
- ! At minimum: confirm task runner (`task --version`), language compiler/runtime, and platform SDK (if applicable) are available
- ! If any required tool is missing, stop and report — do not proceed to Step 3
- ⊗ Assume tools are available because the spec references them

### Step 3: Build Phase by Phase

For each phase:

1. ! **Scaffold** — file structure, dependencies, config
2. ! **Test first** — write tests before implementation (TDD)
3. ! **Implement** — make tests pass, following deft coding standards
4. ! **Verify** — run `task check`, fix any issues
5. ! **Checkpoint** — tell user what's done, what's next

- ⊗ Move to next phase until current phase passes all checks

### Step 4: Quality Gates

After EVERY phase:

```bash
task check          # Format, lint, type check, test, coverage
task test:coverage  # ≥85% or PROJECT.md override
```

- ! Phase is NOT done until `task check` passes
- ⊗ Skip quality gates or claim they passed without running

## Coding Standards (Summary)

Read full files when you need detail:

- ! TDD: write tests first — implementation incomplete without passing tests
- ! Coverage: ≥85% lines, functions, branches, statements
- ~ Files: <300 lines ideal, <500 recommended, ! <1000 max
- ~ Naming: hyphens for filenames unless language idiom dictates otherwise
- ! Contracts first: define interfaces/types before implementation
- ! Secrets: in `secrets/` dir with `.example` templates; ⊗ secrets in code
- ! Commits: Conventional Commits format; ! run `task check` before every commit

See `deft/coding/coding.md` and `deft/coding/testing.md` for full rules.

## Pre-Commit File Review

! Before every commit, re-read ALL modified files and explicitly check for:

1. ! **Encoding errors** -- em-dashes corrupted to replacement characters, BOM artifacts, mojibake from round-trip read/write
2. ! **Unintended duplication** -- accidental double entries in CHANGELOG.md, SPECIFICATION.md, or structured data files
3. ! **Structural issues** -- malformed CHANGELOG entries, broken table rows, mismatched index entries, invalid JSON/YAML
4. ! **Semantic accuracy** -- verify that counts, claims, and summaries in CHANGELOG entries and ROADMAP changelog lines match the actual data in the commit (e.g. "triaged 4 issues" must match the number actually triaged, issue numbers cited must match the issues actually added)
5. ! **Semantic contradictions** -- when adding a `!` or `⊗` rule that prohibits a specific command, pattern, or behavior, search the same file for any `~`, `≉`, or prose that recommends or permits the same command/pattern -- resolve all contradictions in the same commit before pushing
6. ! **Strength duplicates** -- when strengthening a rule (e.g. upgrading `~` to `!`), grep for the term in the full file and verify no weaker-strength duplicate remains
7. ! **Forward test coverage** -- for each new source file in this PR (`scripts/`, `src/`, `cmd/`, `*.py`, `*.go`), verify a corresponding test file exists in the same PR; running existing tests is not sufficient for new code

⊗ Commit without re-reading all modified files first.

## Commit Strategy

- ~ Commit after each meaningful unit of work (per subphase or task)
- ! Run `task check` before committing
- ⊗ Claim checks passed without running them

```
feat(phase-1): scaffold project structure
feat(phase-1): implement core data models with tests
feat(phase-2): add REST API endpoints with integration tests
```

## Error Recovery

- ! Tests fail → fix them; ⊗ skip or weaken assertions
- ! Coverage drops → write more tests; ⊗ exclude files
- ! Lint/type errors → fix them; ≉ add ignore comments without documented reason
- ! Spec ambiguous → ask user; ⊗ guess
- ! Spec needs changes → propose, get approval, update SPECIFICATION.md first

## Completion

- ! When all phases pass and `task check` is green:

> "The project is built and all quality checks pass. Describe any new features you'd like to add — I'll follow the deft standards we've set up."

## Anti-Patterns

- ⊗ Skip tests or write them after implementation
- ⊗ Ignore `task check` failures
- ⊗ Implement things not in spec without asking
- ⊗ Read every deft file upfront
- ⊗ Move to next phase before current passes checks
- ⊗ Make commits without running `task check`
- ⊗ Proceed without USER.md — always run the USER.md Gate first
- ⊗ Proceed with implementation when the build or test toolchain is unavailable — always run the Toolchain Gate (Step 2) first
- ⊗ Proceed to next task or phase without tests passing — testing is a hard gate, not a cleanup step
- ⊗ Skip the Change Lifecycle Gate because the user said "proceed" — broad approval does not satisfy the confirmation gate
- ⊗ Write `SPECIFICATION.md` directly — always create `specification.vbrief.json` first and render from it
- ⊗ Commit or push directly to the default branch -- always create a feature branch first. Exception: user explicitly instructs a direct commit, or `PROJECT.md` contains `Allow direct commits to master: true` under `## Branching`
- ⊗ Add a prohibition (`!` or `⊗`) without scanning the same file for conflicting softer-strength rules (`~`, `≉`) that reference the same term
