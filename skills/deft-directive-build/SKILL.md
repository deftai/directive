---
name: deft-directive-build
description: >
  Build a project from scope vBRIEFs following Deft Directive framework standards.
  Use after deft-directive-setup has generated the project definition, or when the
  user has story vBRIEFs in vbrief/active/ ready to implement. Handles scaffolding,
  implementation, testing, and quality checks phase by phase.
---

# Deft Directive Build

Implements a project from its scope vBRIEFs following Deft Directive standards.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## When to Use

- After `deft-directive-setup` completes and generates `PROJECT-DEFINITION.vbrief.json`
- User says "build this", "implement the spec", or "start building"
- Resuming a partially-built project that has story vBRIEFs in `vbrief/active/`

## Platform Detection

! Before resolving any config paths, detect the host OS from your environment context:

| Platform           | USER.md default path                                              |
|--------------------|-------------------------------------------------------------------|
| Windows            | `%APPDATA%\deft\USER.md` (e.g. `C:\Users\{user}\AppData\Roaming\deft\USER.md`) |
| Unix (macOS/Linux) | `~/.config/deft/USER.md`                                          |

- ! If `$DEFT_USER_PATH` is set, it takes precedence on any platform

## Pre-Cutover Detection Guard

! Before proceeding with any build step, detect whether the project uses the pre-v0.20 document model and redirect to migration if so.

### Detection Criteria

A project is **pre-cutover** if ANY of the following are true:

1. `SPECIFICATION.md` exists and does NOT contain the `<!-- deft:deprecated-redirect -->` sentinel (real content, not a deprecation redirect)
2. `PROJECT.md` exists and does NOT contain the `<!-- deft:deprecated-redirect -->` sentinel (real content, not a deprecation redirect)
3. `vbrief/specification.vbrief.json` exists but the lifecycle folders (`vbrief/proposed/`, `vbrief/pending/`, `vbrief/active/`, `vbrief/completed/`, `vbrief/cancelled/`) do NOT exist

### Action on Detection

! If pre-cutover state is detected, **stop immediately** and display an actionable message:

> "This project uses the pre-v0.20 document model. Run `task migrate:vbrief` to upgrade to the vBRIEF-centric model."

! Include specific details about what was detected:

- Missing lifecycle folders: "Run `task migrate:vbrief` to create the lifecycle folder structure"
- `SPECIFICATION.md` with real content: "SPECIFICATION.md contains non-redirect content -- this file is deprecated; use scope vBRIEFs in `vbrief/` instead"
- `PROJECT.md` with real content: "PROJECT.md contains non-redirect content -- this file is deprecated; use `PROJECT-DEFINITION.vbrief.json` instead"
- Missing `PROJECT-DEFINITION.vbrief.json`: "Run `task project:render` to generate the project definition"
- Scope vBRIEF in wrong folder: "Status is '{status}' but file is in {folder}/ -- run `task scope:activate <file>` to fix"

⊗ Proceed with build when pre-cutover artifacts are detected -- always redirect to migration first.
⊗ Silently ignore pre-cutover artifacts -- the user must be informed with an actionable command to fix the state.

## USER.md Gate

! Before proceeding, verify USER.md exists at the platform-appropriate path
(resolved via Platform Detection above, or `$DEFT_USER_PATH` if set).

- ! If USER.md is not found: inform the user and redirect to `deft-directive-setup`
  Phase 1 before continuing -- do not proceed without user preferences
- ! Once USER.md exists, continue with the Cost Phase Gate below

## Cost Phase Gate (#739)

! Before proceeding to File Reading, verify the project has gone through the
pre-build cost & budget transparency phase from `skills/deft-directive-cost/SKILL.md`.
This closes the adoption-blocker surfaced by issue #739 (refs #151 umbrella) where
users finished the spec flow and stopped at build because deft offered no cost
signal.

### Detection

- ! Check for `COST-ESTIMATE.md` in the project root.
- ! Check that the file contains a recorded decision (the **Decision recorded**
  block populated with one of: `build`, `rescope`, `no-build`, `skip`).
- ! For `skip`, `rescope`, or `no-build` decisions: the **Reason** field MUST be
  populated (one or two sentences in plain language). A skip with no reason
  recorded is treated the same as no decision.

### Action

- ! If `COST-ESTIMATE.md` is missing OR the **Decision recorded** block is
  unpopulated OR a `skip`/`rescope`/`no-build` decision has no reason recorded:
  stop immediately and redirect the user:

  > "This project has not gone through the pre-build cost & budget transparency
  > phase. Run `skills/deft-directive-cost/SKILL.md` to produce a plain-English
  > `COST-ESTIMATE.md`, then re-run the build skill once the user has chosen
  > build / rescope / no-build / skip(+reason)."

- ! On a `build` or `skip` decision: continue with File Reading below.
- ! On a `rescope` decision: stop and redirect the user back to spec edits
  (chain to `skills/deft-directive-refinement/SKILL.md` to pull spec scope
  back, or the interview), then re-run `skills/deft-directive-cost/SKILL.md`
  before re-attempting build.
- ! On a `no-build` decision: stop and exit; do NOT proceed to File Reading.
  The user has explicitly stopped the project at the cost phase.
- ⊗ Proceed to File Reading or any subsequent phase when `COST-ESTIMATE.md` is
  missing, when the decision is unpopulated, or when a skip / rescope / no-build
  decision has no reason recorded.
- ⊗ Treat a `rescope` or `no-build` decision as if it were a `build` -- the
  build skill MUST honor the recorded decision.

## File Reading

- ! Read in order, lazy load:
  1. `./vbrief/active/` -- scope vBRIEFs for work items to build (required)
  2. `./vbrief/PROJECT-DEFINITION.vbrief.json` -- project identity, tech stack, architecture
  3. USER.md at the platform-appropriate path (see Platform Detection) -- Personal section is highest precedence; Defaults are fallback
  4. `deft/main.md` -- framework guidelines
  5. `deft/coding/coding.md` -- coding standards
  6. `deft/coding/testing.md` -- testing requirements
  7. `deft/coding/toolchain.md` -- toolchain validation rules
  8. `deft/languages/{language}.md` -- only for languages this project uses
- ⊗ Read all language/interface/tool files upfront

## Rule Precedence

```
USER.md Personal                  <- HIGHEST (name, custom rules -- always wins)
PROJECT-DEFINITION.vbrief.json   <- Project-specific (tech stack, architecture, config)
USER.md Defaults                  <- Fallback defaults (used when PROJECT-DEFINITION doesn't specify)
{language}.md                     <- Language standards
coding.md                         <- General coding
main.md                           <- Framework defaults
Scope vBRIEFs                     <- LOWEST
```

- ! USER.md Personal section always wins over any other file
- ! For project-scoped settings, PROJECT-DEFINITION.vbrief.json overrides USER.md Defaults

## Change Lifecycle Gate

! Before any implementation that touches 3+ files, verify that a `/deft:change <name>` proposal exists and has been confirmed by the user:

- ! Check `history/changes/` for an active `proposal.vbrief.json` matching this work
- ! If no proposal exists: propose `/deft:change <name>` and present the change name for explicit confirmation (e.g. "Confirm? yes/no")
- ! The user must reply with an affirmative (`yes`, `confirmed`, `approve`) — a general 'proceed', 'do it', or 'go ahead' does NOT satisfy this gate
- ? For solo projects: this gate is RECOMMENDED but not mandatory for changes fully covered by `task check`; it remains mandatory for cross-cutting, architectural, or high-risk changes
- ⊗ Skip this gate because the user has already said "proceed" or "go ahead"

## Build Process

All vBRIEFs (including those read from `vbrief/active/` and any new vBRIEFs this skill emits) MUST use `"vBRIEFInfo": { "version": "0.6" }`. The validator rejects any other version (see [`../../conventions/references.md`](../../conventions/references.md)).

### Step 1: Understand the Scope

- ! Read story vBRIEFs from `vbrief/active/` and `PROJECT-DEFINITION.vbrief.json`
- ! Identify phases, dependencies, starting point from scope vBRIEF acceptance criteria
- ! Present brief summary to user:

> "Here's what I see: {N} story vBRIEFs in active/. I'll start with {name}. Ready?"

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
task test:coverage  # >=85% or PROJECT-DEFINITION.vbrief.json override
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
2. ! **Unintended duplication** -- accidental double entries in CHANGELOG.md, scope vBRIEF files, or structured data files
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
- ! Scope vBRIEF ambiguous -> ask user; ⊗ guess
- ! Scope needs changes -> propose, get approval, update the scope vBRIEF first

## Completion

- ! When all phases pass and `task check` is green:

> "The project is built and all quality checks pass. Describe any new features you'd like to add — I'll follow the deft standards we've set up."

## Anti-Patterns

- ⊗ Skip tests or write them after implementation
- ⊗ Ignore `task check` failures
- ⊗ Implement things not in scope vBRIEF without asking
- ⊗ Read every deft file upfront
- ⊗ Move to next phase before current passes checks
- ⊗ Make commits without running `task check`
- ⊗ Proceed without USER.md -- always run the USER.md Gate first
- ⊗ Proceed without `COST-ESTIMATE.md` and a recorded build / rescope / no-build / skip(+reason) decision -- always run the Cost Phase Gate (#739) first
- ⊗ Proceed with implementation when the build or test toolchain is unavailable -- always run the Toolchain Gate (Step 2) first
- ⊗ Proceed to next task or phase without tests passing -- testing is a hard gate, not a cleanup step
- ⊗ Skip the Change Lifecycle Gate because the user said "proceed" -- broad approval does not satisfy the confirmation gate
- ⊗ Commit or push directly to the default branch -- always create a feature branch first. Exception: user explicitly instructs a direct commit, or `PROJECT-DEFINITION.vbrief.json` narratives contain `Allow direct commits to master: true`
- ⊗ Add a prohibition (`!` or `⊗`) without scanning the same file for conflicting softer-strength rules (`~`, `≉`) that reference the same term
