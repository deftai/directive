# Deterministic > Probabilistic: Task Audit & Recommendations

Principle: anything enforced by a prompt is probabilistic — an agent might skip it,
do it inconsistently, or hallucinate that it passed. Anything enforced by a task is
deterministic — it either passes or fails with a non-zero exit code.

This document catalogs opportunities to move deft enforcement from prompts to tasks.

Fundamentally this is the start of a new ground rule:

If something CAN be done by a task file task, it MUST be done by a task file task.


## 1. Current State

The root `Taskfile.yml` has ~13 tasks. One included sub-taskfile exists
(`taskfiles/deployments.yml`, 2 tasks). Many framework operations described in
directives (`toolchain.md`, `verification.md`, `build-output.md`, `commands.md`)
are enforced only by instructing agents to do the right thing.

---

## 2. Prompt-Driven Operations That Should Become Tasks

### A. Toolchain Verification (`coding/toolchain.md`)

**Today**: Agent is _told_ to run `task --version`, `go version`, etc.
**Risk**: Agent skips it or checks inconsistently (the Xcode/Swift incident).

**Proposed**: `task toolchain:check`
- Reads `PROJECT.md` for declared languages/tools
- Verifies each is installed and functional
- Exits non-zero on any failure
- Becomes a `dep` of `check` and the build skill's Step 2

### B. Stub Detection (`verification/verification.md`)

**Today**: Agent is _instructed_ to scan for `TODO`, `FIXME`, `return null`, `pass`, etc.
**Risk**: Most common agent shortcut — leaving stubs and calling it done.

**Proposed**: `task verify:stubs`
- `rg`-based scan for patterns listed in `verification.md`
- Non-zero exit if stubs found in source files (excludes tests, vendor, etc.)
- Can be a dep of `check`

### C. Build Output Validation (`coding/build-output.md`)

**Today**: Agent is _told_ to verify files exist and are non-empty after `task build`.
**Risk**: Zero-exit-code build with stale or missing artifacts goes unnoticed.

**Proposed**: `task build:verify`
- Runs after `build`
- Checks `dist/` contents against a manifest (could be a `generates:` list or a
  separate `.build-manifest.yml`)
- Fails if expected artifacts are missing or empty

### D. Spec Validation + Render Pipeline

**Today**: `spec:validate` and `spec:render` exist but are standalone. The interview
strategy says "run `task spec:render` if available" — no unified pipeline.

**Proposed**: `task spec:pipeline`
- Runs `spec:validate` then `spec:render` as deps
- Single deterministic command for the full spec flow

### E. vBRIEF Schema Compliance

**Today**: Agent is _told_ to generate compliant vBRIEF (FR-6). `spec_validate.py`
exists but only validates one file at a time.

**Proposed**: `task vbrief:validate`
- Finds all `*.vbrief.json` in `./vbrief/`
- Validates each against the schema
- Fails on any non-conforming file

### F. Change Lifecycle Scaffolding (`commands.md`)

**Today**: `/deft:change <name>` is prompt-driven — the agent creates
`history/changes/<name>/` with `proposal.md`, `design.md`, `tasks.vbrief.json`,
and `specs/`. Agent might forget a file or use wrong structure.

**Proposed**: `task change:init`
- Takes a name via `{{.CLI_ARGS}}`
- Creates directory structure from a template
- Scaffolds all required files deterministically

### G. Change Archival

**Today**: `/deft:change:archive` is agent-driven (move folder, date prefix, merge
spec deltas, validate pre-conditions).

**Proposed**: `task change:archive`
- Moves the folder with correct date prefix
- Validates pre-conditions (all tasks completed)
- Exits non-zero if any task is not `completed`

### H. Cross-Reference Integrity

**Today**: Stale references are found during manual audits (t2.1.1, legacy paths).

**Proposed**: `task validate:links`
- Checks all `.md` files for internal links (`[text](path)`)
- Verifies the target file exists
- Prevents link rot deterministically
- Excludes `history/archive/` from checking

### I. CHANGELOG Entry Validation

**Today**: AGENTS.md says "Add CHANGELOG.md entry under `[Unreleased]`" — purely
agent honor system.

**Proposed**: `task changelog:check`
- Verifies `CHANGELOG.md` has an `[Unreleased]` section
- Verifies at least one entry exists since the last release tag
- Can be a dep of `check`

### J. Conventional Commit Validation

**Today**: Commit format is a rule in the agent prompt. No enforcement.

**Proposed**: `task commit:lint`
- Runs a commit message linter against HEAD (or a range)
- Can be a git hook or CI check
- Simple regex-based validation or `commitlint` if available

---

## 3. Phase 0 — Deterministic Scaffolding Per Spec Iteration

### Concept

Every time deft generates a `SPECIFICATION.md`, before Phase 1 implementation
begins, a **Phase 0** creates the task infrastructure for that specific spec.

### What Phase 0 Generates

For a project with Phases 1–3 in its spec, `task spec:phase0` generates:

```
tasks/
└── {project-name}.yml     # Spec-specific taskfile (included from root)
```

Contents of `{project-name}.yml`:

- **`setup`** — Scaffold project structure per spec (directories, empty files, config)
- **`toolchain`** — Verify all tools the spec requires (reads from PROJECT.md)
- **`test:scaffold`** — Generate test file skeletons for each phase's tasks
  (empty test functions named after acceptance criteria)
- **`gate:phase-N`** — Per-phase quality gate that runs the subset of tests and
  checks relevant to that phase
- **`verify:phase-N`** — Per-phase verification (stub scan + acceptance criteria
  check for that phase's tasks)

### How It Works

1. After `SPECIFICATION.md` is approved (acceptance gate passes), agent runs
   `task spec:phase0` (or it auto-runs as a dep of the build handoff)
2. `spec:phase0` reads the spec's phases and tasks, generates `tasks/{project-name}.yml`
3. Root `Taskfile.yml` includes the generated taskfile
4. Implementation uses `task gate:phase-1`, `task gate:phase-2`, etc. instead of
   relying on the agent to remember quality gates

### Benefits

- **Deterministic gates per phase** — can't "forget" to run tests for Phase 2
- **Incremental** — `sources`/`generates` means unchanged phases don't re-run
- **Auditable** — `task --list` shows exactly what gates exist
- **Composable** — multiple agents working on different phases each have their own gate

---

## 4. Task Directory Restructuring

### Current State

```
Taskfile.yml              # Root (13 tasks — monolithic)
taskfiles/
  deployments.yml         # Cloud-gov sync/export (2 tasks)
```

### Proposed Structure

```
Taskfile.yml              # Root: includes + default only
tasks/
  core.yml                # validate, fmt, lint, test, test:coverage, check, build, clean, stats
  spec.yml                # spec:validate, spec:render, spec:pipeline, spec:phase0, vbrief:validate
  toolchain.yml           # toolchain:check
  verify.yml              # verify:stubs, verify:links, build:verify
  change.yml              # change:init, change:archive, changelog:check
  install.yml             # install, uninstall
  commit.yml              # commit:lint
  deployments.yml         # (moved from taskfiles/)
  {project-name}.yml      # Generated by Phase 0 per spec iteration
```

### Root Taskfile Becomes Minimal

```yaml
version: '3'

vars:
  PROJECT_NAME: deft
  VERSION: 0.5.2

includes:
  core:      { taskfile: ./tasks/core.yml }
  spec:      { taskfile: ./tasks/spec.yml }
  toolchain: { taskfile: ./tasks/toolchain.yml }
  verify:    { taskfile: ./tasks/verify.yml }
  change:    { taskfile: ./tasks/change.yml }
  install:   { taskfile: ./tasks/install.yml }
  commit:    { taskfile: ./tasks/commit.yml }
  deploy:    { taskfile: ./tasks/deployments.yml, optional: true }

tasks:
  default:
    desc: List all available tasks
    cmds: [task --list]
    silent: true
```

### Task Visibility

Use `internal: true` for plumbing tasks that support other tasks but shouldn't
clutter `task --list`. These are still callable directly and as dependencies.

```yaml
verify:stubs:
  desc: Scan for TODO/FIXME/stub placeholders
  # (visible in task --list)

verify:stubs:build-patterns:
  internal: true
  # (hidden from task --list, but callable and usable as a dep)
```

No namespace prefix (like `directive:`) is needed — the file boundary (`tasks/*.yml`)
provides organizational clarity. Contributors run `task --list` and see a clean,
categorized list. Internal tasks exist in the same file but are hidden from output.

---

## 5. Internal vs User-Facing Tasks

### Internal to Directive (framework development only)

These tasks only deft contributors use when working _on_ the framework:

- `validate` — markdown validation of framework files
- `spec:validate` / `spec:render` / `spec:pipeline` — framework's own spec
- `vbrief:validate` — framework's vBRIEF files
- `verify:links` — framework cross-reference integrity
- `stats` — framework statistics
- `install` / `uninstall` — deft installer management
- `build` / `clean` — framework distribution packaging
- `deploy:cloudgov:*` — cloud-gov export
- `commit:lint` — framework repo commit linting
- `changelog:check` — framework CHANGELOG

### User-Facing (projects that use deft)

These tasks appear in end-user project Taskfiles:

- `check` — pre-commit gate (universal)
- `test` / `test:coverage` — universal
- `fmt` / `lint` — universal
- `toolchain:check` — verify project tools installed
- `verify:stubs` — scan for incomplete implementations
- `build:verify` — post-build artifact validation
- `change:init` / `change:archive` — change lifecycle
- `doctor` — system health check
- `ci:local` — local CI mirror

### Dual-Purpose

Same pattern in both contexts, different project-specific config:

- `check`, `test`, `fmt`, `lint` — same shape, different project
- `toolchain:check`, `verify:stubs` — same concept, project-specific patterns

---

## 6. Additional Opportunities

### A. `task doctor` — System Health Check

Combines toolchain verification, link validation, vBRIEF schema check, stub scan,
and coverage threshold into a single diagnostic. Like `brew doctor` for the project.

### B. `task new:strategy` — Strategy Scaffolding

When someone creates a custom strategy, scaffold the file with the correct
front-matter, type declaration, and register it in `strategies/README.md`.

### C. `task ci:local` — Run CI Locally

Mirror the GitHub Actions workflow locally. Instead of pushing to find out CI fails,
`task ci:local` runs the same matrix (Python lint/test, Go build) deterministically.

### D. `task release` — Version Bump + CHANGELOG

The three version numbers (Taskfile `0.5.2`, framework `0.5.0`, CLI `0.4.2`) are a
known open question (PRD OQ-1). A `task release` could manage version unification
deterministically.

### E. Enhanced `task check`

Current `check` has `deps: [validate, lint, test]`. Proposed enhanced deps:

```yaml
check:
  desc: Run all pre-commit checks
  deps:
    - toolchain:check
    - validate
    - verify:links
    - verify:stubs
    - lint
    - test
    - changelog:check
```

This turns `check` into a truly comprehensive deterministic gate.

---

## 7. Priority Order

Biggest wins, ordered by impact:

1. **Phase 0 generation** — makes every spec iteration self-enforcing via generated task targets
2. **`tasks/` directory split** — scales the task surface without a monolithic Taskfile
3. **`toolchain:check`** — the single most impactful individual task (prevents the Xcode/Swift incident deterministically)
4. **`verify:stubs`** — catches the most common agent shortcut without relying on self-policing
5. **`change:init` / `change:archive`** — the change lifecycle is too complex to leave prompt-driven
6. **Enhanced `check`** — adding link validation, stub detection, changelog, and toolchain as deps makes the pre-commit gate comprehensive
