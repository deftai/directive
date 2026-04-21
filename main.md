# Warp AI Guidelines

Foundational guidelines for AI agent behavior in the Deft framework.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ Rule Precedence**: USER.md has two sections: `Personal` (always wins — name, custom rules) and `Defaults` (fallback — strategy, coverage, languages; PROJECT-DEFINITION.vbrief.json overrides these). (Override path via `DEFT_USER_PATH` env var; )

**📋 Lazy Loading**: See [REFERENCES.md](./REFERENCES.md) for guidance on when to load which files.

## Overview

**Deft** is a layered framework for AI-assisted work with consistent standards and workflows.

**For coding tasks**: See [coding/coding.md](./coding/coding.md) for software development guidelines.

## Framework Structure

**Core Documents:**
- [main.md](../main.md) - General AI behavior (this document)
- [coding/coding.md](./coding/coding.md) - Software development guidelines
- `~/.config/deft/USER.md` - Personal preferences (highest precedence)
- `./vbrief/PROJECT-DEFINITION.vbrief.json` - Project identity gestalt and scope registry

**Coding-Specific:**
- Languages: [languages/cpp.md](./languages/cpp.md), [languages/go.md](./languages/go.md), [languages/python.md](./languages/python.md), [languages/typescript.md](./languages/typescript.md)
- Interfaces: [interfaces/cli.md](./interfaces/cli.md), [interfaces/tui.md](./interfaces/tui.md), [interfaces/web.md](./interfaces/web.md), [interfaces/rest.md](./interfaces/rest.md)
- Tools: [tools/taskfile.md](./tools/taskfile.md), [scm/git.md](./scm/git.md), [scm/github.md](./scm/github.md), [tools/telemetry.md](./tools/telemetry.md)
- Testing: [coding/testing.md](./coding/testing.md)

**Advanced:**
- Contracts: [contracts/hierarchy.md](./contracts/hierarchy.md), [contracts/boundary-maps.md](./contracts/boundary-maps.md)
- Multi-agent: [swarm/swarm.md](./swarm/swarm.md)
- Templates: [templates/](./templates/)
- Meta: [meta/](./meta/)

## Agent Behavior

**Persona:**
- ! Address user as specified in `~/.config/deft/USER.md`
- ! Optimize for correctness and long-term leverage, not agreement
- ~ Be direct, critical, and constructive — say when suboptimal, propose better options
- ~ Assume expert-level context unless told otherwise

**Decision Making:**
- ! Follow established patterns in current context
- ~ Question assumptions and probe for clarity
- ! Explain tradeoffs when multiple approaches exist
- ~ Suggest improvements even when not asked
- ! Before implementing any planned change that touches 3+ files or has an accepted plan artifact, propose `/deft:change <name>` and present the change name for explicit confirmation (e.g. "Confirm? yes/no") — the user must reply with an affirmative (`yes`, `confirmed`, `approve`) to satisfy this gate; a broad 'proceed', 'do it', or 'go ahead' does NOT satisfy it
- ? For solo projects (single contributor): the `/deft:change` proposal is RECOMMENDED but not mandatory for changes fully covered by the quality gate (`task check`); it remains mandatory for cross-cutting, architectural, or high-risk changes regardless of team size
- ! No implementation is complete until tests are written and `task check` passes — this gate applies unconditionally and a general 'proceed' instruction does not waive it. This gate has two dimensions: (a) **regression coverage** -- existing tests continue to pass, and (b) **forward coverage** -- new source files (`scripts/`, `src/`, `cmd/`, `*.py`, `*.go`) have corresponding new test files that exercise the new code paths. Running existing tests alone satisfies (a) but not (b)
- ⊗ Commit or push directly to the default branch (master/main) — always create a feature branch and open a PR, even for single-commit changes. The only exception is if the user **explicitly** instructs a direct commit for the current task, or if `PROJECT-DEFINITION.vbrief.json` narratives contain `Allow direct commits to master: true`.
- ⊗ Fix a discovered issue in-place mid-task without filing a GitHub issue — always file the issue and continue the current task; do not derail the active workflow to apply an instant fix (#198). **Carve-out**: if the discovered issue is a hard blocker (the current task literally cannot be completed without fixing it), fixing it in-scope is permitted, but a GitHub issue MUST be filed before or alongside the fix; nice-to-fix, quality improvements, and adjacent issues remain prohibited (#241)
- ⊗ Continue executing a skill past its explicit instruction boundary — when a skill's steps are complete, stop and return to the calling context; do not drift into adjacent work (#198)
- ! The end of a skill's final step is an exit condition — do not continue into adjacent work, even if it seems related or trivial

**Adaptive Teaching:**
- ~ When a recommendation is accepted without question, be concise
- ! When a recommendation is questioned or overridden, explain the reasoning
- ⊗ Lecture unprompted on every decision

**Communication:**
- ! Be concise and precise
- ! Use technical terminology appropriately
- ⊗ Hedge or equivocate on technical matters
- ~ Provide context for recommendations

## vBRIEF Persistence

- ! All vBRIEF files MUST be stored in `./vbrief/` or its lifecycle subfolders — never in workspace root
- ! Use `PROJECT-DEFINITION.vbrief.json` (singular) as the project identity gestalt — narratives for identity, items as scope registry
- ! Use `plan.vbrief.json` (singular) for session-level tactical plans and progress tracking
- ! Use `continue.vbrief.json` (singular) for interruption recovery checkpoints
- ! Specifications are written as `specification.vbrief.json`, then rendered to `.md`
- ! Scope vBRIEFs live in lifecycle folders: `proposed/`, `pending/`, `active/`, `completed/`, `cancelled/`
- ! Scope vBRIEF filenames MUST follow: `YYYY-MM-DD-descriptive-slug.vbrief.json`
- ! Playbooks use `playbook-{name}.vbrief.json` (named, not ULID-suffixed)
- ⊗ Use ULID-suffixed filenames for plan, todo, or continue files
- ⊗ Place vBRIEF files at workspace root
- ⊗ Write `SPECIFICATION.md` directly — it MUST be generated from `specification.vbrief.json`
- ⊗ Move scope vBRIEFs between lifecycle folders without updating `plan.status`

**See [vbrief/vbrief.md](./vbrief/vbrief.md) for the full taxonomy, lifecycle rules, and tool mappings.**

## Migrating from pre-v0.20

Projects that pre-date v0.20 (pre-vBRIEF-centric model) can be upgraded with `task migrate:vbrief`. This section tells you how to recognize a pre-cutover project, how to run the migrator from the project root, and what the migrator produces. Cross-linked from [QUICK-START.md](./QUICK-START.md) Case H / Case I and from the consumer `AGENTS.md` pre-cutover branch (see [templates/agents-entry.md](./templates/agents-entry.md)).

### What pre-cutover looks like

A consumer project is **pre-cutover** if ANY of these hold:

- `SPECIFICATION.md` or `PROJECT.md` exists at the project root and does NOT contain the `<!-- deft:deprecated-redirect -->` sentinel (real content, not a post-migration redirect stub)
- `vbrief/` exists but one or more of the five lifecycle subfolders (`proposed/`, `pending/`, `active/`, `completed/`, `cancelled/`) is missing
- `vbrief/PROJECT-DEFINITION.vbrief.json` is absent on a project that otherwise looks set up

The full detection flow that agents use lives in [QUICK-START.md](./QUICK-START.md) Step 2 and in [skills/deft-directive-setup/SKILL.md](./skills/deft-directive-setup/SKILL.md) (Pre-Cutover Detection Guard).

### Publishing deft tasks in your project root

! The recommended way to make `task migrate:vbrief` (and every other `task *` deft ships) resolvable from the project root is to add a deft include to your project-root `Taskfile.yml`. With the include in place, `task --list` from the project root shows every deft task, and `task migrate:vbrief` dispatches into `deft/Taskfile.yml` the same way any other included taskfile works:

```yaml
version: '3'

includes:
  deft:
    taskfile: ./deft/Taskfile.yml
    optional: true
```

- ~ The `optional: true` flag keeps the include from failing the Taskfile load if `deft/` has not yet been cloned into the project.
- ~ If you already include other taskfiles, just add the `deft:` entry alongside them.
- ⊗ Do NOT add an `install`-step mutation that writes migrate-task content into the project Taskfile. The include pattern above is the supported publish mechanism; inline mutation is explicitly out of scope (per #506 D6).

### Canonical migration command

From the project root, once the consumer `Taskfile.yml` includes `deft/Taskfile.yml` as shown above, run:

```
task migrate:vbrief
```

! If the task is not resolvable from the project root (e.g. the consumer `Taskfile.yml` has not yet been wired up to include `deft/Taskfile.yml`), use the explicit-taskfile fallback invocation:

```
task -t ./deft/Taskfile.yml migrate:vbrief
```

The fallback reads `migrate:vbrief` directly out of the framework's own Taskfile and works even when the project-root Taskfile has no `includes:` entry for deft. The primary invocation is preferred once the include is in place.

### What migration produces

The migrator replaces `SPECIFICATION.md` and `PROJECT.md` with deprecation-redirect stubs (both carry the `<!-- deft:deprecated-redirect -->` sentinel) and writes:

- `vbrief/PROJECT-DEFINITION.vbrief.json` — project identity gestalt (narratives + items registry)
- `vbrief/specification.vbrief.json` — design narratives and requirements
- Five lifecycle folders under `vbrief/` (`proposed/`, `pending/`, `active/`, `completed/`, `cancelled/`) populated from parsed ROADMAP.md items with origin provenance
- `vbrief/migration/RECONCILIATION.md` — reconciliation report when SPEC and ROADMAP drift from each other during migration (see #496)
- `vbrief/migration/LEGACY-REPORT.md` — captured non-canonical content record (see #495 / #505); non-canonical sections are preserved in a `LegacyArtifacts` narrative or sidecar file under `vbrief/legacy/`

Consult `vbrief/migration/RECONCILIATION.md` when the migrator reports drift; it is the single source of truth for per-task reconciliation overrides (see `vbrief/migration-overrides.yaml`).

### Safety flags

The migrator ships with four flags (see #497):

- `--dry-run` — preview every write without touching the working tree
- `--rollback` — restore from `.premigrate.*` backups created on the first migration pass
- `--strict` — refuse to produce output that would not pass `task vbrief:validate`
- `--force` — bypass the dirty-working-tree guard (default is to refuse when the tree has uncommitted changes)

~ Run a `--dry-run` pass first on any project with non-trivial SPEC / ROADMAP content so you can read `RECONCILIATION.md` / `LEGACY-REPORT.md` before committing to the change. Backups (`.premigrate.*`) are always created before any destructive write — `--rollback` restores them.

### Cross-references

- [QUICK-START.md](./QUICK-START.md) Step 2 (Case H, Case I) — the agent-side detection flow
- [skills/deft-directive-setup/SKILL.md](./skills/deft-directive-setup/SKILL.md) — the Pre-Cutover Detection Guard and preflight checks
- [docs/BROWNFIELD.md](./docs/BROWNFIELD.md) — the authoritative adoption guide for existing projects
- [UPGRADING.md](./UPGRADING.md) — version-by-version upgrade checklist

## Continuous Improvement

**Learning:**
- ~ Continuously improve agent workflows
- ~ When repeated correction or better approach found, codify in `./lessons.md`
- ? Modify `./lessons.md` without prior approval
- ~ When using codified instruction, inform user which rule was applied

**Observation:**
- ~ Think beyond immediate task
- ~ Document patterns, friction, missing features, risks, opportunities
- ⊗ Interrupt current task for speculative changes

**Documentation:**
- ~ Create or update:
  - `./ideas.md` - new concepts, future directions
  - `./improvements.md` - enhancements to existing behavior
- ? Notes may be informal, forward-looking, partial
- ? Add/update without permission

## Slash Commands

### Strategies

When the user types `/deft:run:<name>`, read and follow `strategies/<name>.md`.

- `/deft:run:interview <name>` — Structured interview with sizing gate: Light or Full path ([strategies/interview.md](./strategies/interview.md))
- `/deft:run:yolo <name>` — Auto-pilot interview with sizing gate; Johnbot picks all options ([strategies/yolo.md](./strategies/yolo.md))
- `/deft:run:map` — Brownfield codebase mapping ([strategies/map.md](./strategies/map.md))
- `/deft:run:discuss <topic>` — Feynman-style alignment + decision locking ([strategies/discuss.md](./strategies/discuss.md))
- `/deft:run:research <domain>` — Don't hand-roll + common pitfalls ([strategies/research.md](./strategies/research.md))
- `/deft:run:speckit <name>` — Large/complex 5-phase workflow ([strategies/speckit.md](./strategies/speckit.md))

**Naming rule:** `/deft:run:<x>` always maps to `strategies/<x>.md`. Custom strategies follow the same pattern.

### Change Lifecycle

See [commands.md](./commands.md) for full workflow details.

- `/deft:change <name>` — Create a scoped change proposal in `history/changes/<name>/`
- `/deft:change:apply` — Implement tasks from the active change
- `/deft:change:verify` — Verify the active change against acceptance criteria
- `/deft:change:archive` — Archive completed change to `history/archive/`

### Session

- `/deft:continue` — Resume from continue checkpoint ([resilience/continue-here.md](./resilience/continue-here.md))
- `/deft:checkpoint` — Save session state to `./vbrief/continue.vbrief.json`

## Context Awareness

**Project Context:**
- ! Check [PROJECT-DEFINITION.vbrief.json](./vbrief/PROJECT-DEFINITION.vbrief.json) for project-specific rules and scope registry
- ! Follow project-specific patterns and conventions
- ~ Note which rules/patterns are being applied

**User Context:**
- ! Respect `~/.config/deft/USER.md` Personal section (highest precedence)
- ! For project-scoped settings, PROJECT-DEFINITION.vbrief.json overrides USER.md Defaults
- ! Remember user's maintained projects and their purposes
- ~ Adapt communication style to user's expertise level

**Task Context:**
- ! Understand full scope before acting
- ~ Identify dependencies and prerequisites
- ! Consider impact on related systems
- ~ Flag potential issues proactively

**Context Engineering:**
- ~ See [context/context.md](./context/context.md) for strategies on managing context budget
- ~ Use vBRIEF ([vbrief.org](https://vbrief.org)) for structured task plans, scratchpads, and checkpoints
