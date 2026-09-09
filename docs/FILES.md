# Deft Files And Directory Structure

Current directory map and per-area index for the Deft Directive framework repository. This is an orientation guide; [ARCHITECTURE.md](./ARCHITECTURE.md) explains how the pieces fit together.

> **See also**: [ARCHITECTURE.md](./ARCHITECTURE.md) | [CONCEPTS.md](./CONCEPTS.md) | [RELEASING.md](./RELEASING.md)

## Path classes

Every path in a labeled-current tree below is one of:

- **repo-tracked** — present in this checkout (the default if a line does not name another class)
- **generated-on-demand** — produced by a task, not committed (MAP)
- **consumer-install** — created when Deft is installed into another project (`.deft/core/`, USER.md)
- **illustrative** — names a class of path, not a single tracked file

Python/run-era names appear only in historically labeled blocks.

## Top Level

```text
deft/
├── AGENTS.md              # Canonical AI-agent entry surface
├── SKILL.md               # Alternate skill-loader entry surface
├── main.md                # General AI behavior and rule-authority axiom
├── README.md              # User-facing overview and getting started
├── CONTRIBUTING.md        # Contributor setup and conventions
├── CHANGELOG.md           # Release notes
├── LICENSE                # MIT license (root file is LICENSE, not LICENSE.md)
├── REFERENCES.md          # Lazy-loading reference guidance
├── SECURITY.md            # Security policy
├── COST-ESTIMATE.md       # Pre-build cost transparency
├── Taskfile.yml           # Root deterministic command graph
├── go.mod                 # Frozen Go installer module
├── package.json           # TypeScript workspace scripts and package metadata
├── pnpm-lock.yaml         # TypeScript dependency lock
├── pnpm-workspace.yaml    # TypeScript workspace layout
├── tsconfig.base.json     # Shared TypeScript compiler configuration
├── tsconfig.json          # TypeScript project references
├── vitest.config.ts       # TypeScript test configuration
├── biome.json             # Formatter/linter config
├── PROJECT.md             # Deprecated redirect to xBRIEF project definition
├── PRD.md                 # Rendered PRD view
├── ROADMAP.md             # Rendered backlog view
└── SPECIFICATION.md       # Rendered spec view from xbrief/specification.xbrief.json
```

Guidance files `QUICK-START.md`, `UPGRADING.md`, and `commands.md` live under `content/`, not the repo root.

> **Historical (Python/run era):** root `run`, `run.py`, `run.bat`, `pyproject.toml`, and `uv.lock` were launchers and Python tooling manifests. They are not in the current tree.

## Framework Guidance

Shipped guidance lives under `content/`. Root `docs/`, `meta/`, and `incidents/` are repo-dev orientation, not the shipped guidance root.

```text
content/
├── coding/        # Coding, testing, hygiene, toolchain, and build-output rules
├── ci-cd/         # CI/CD runner notes
├── context/       # Context management patterns and spec-delta guidance
├── contracts/     # Boundary maps, hierarchy, deterministic question contracts
├── conventions/   # Cross-cutting conventions such as references and banners
├── deployments/   # Platform deployment guides
├── docs/          # Shipped user, maintainer, and process docs
├── doctor/        # Doctor session-coda payload
├── events/        # Event registry and schemas
├── incidents/     # Incident templates
├── interfaces/    # CLI, REST, TUI, and web interface guidance
├── languages/     # Language-specific standards
├── meta/          # Philosophy, morals, security, lessons, ideas, and suggestions
├── patterns/      # Reusable architectural and LLM-application patterns
├── platforms/     # Niche platform guidance
├── references/    # External/reference material
├── resilience/    # Continue-here and context-pruning protocols
├── scm/           # Git, GitHub, and changelog guidance
├── secrets/       # Secrets placeholders
├── skills/        # Current skill directories (see Skills)
├── strategies/    # Interview, map, research, speckit, yolo, and related strategies
├── swarm/         # Multi-agent coordination reference
├── templates/     # Agent prompt and project templates
├── tools/         # Tool-specific guidance such as Taskfile and telemetry
├── verification/  # Verification ladder and validation guidance
├── packs/         # Content-pack JSON sources
├── vbrief/        # Schemas and vBRIEF usage reference (legacy name on disk)
├── commands.md    # Command lifecycle and task references
├── glossary.md    # Glossary
├── QUICK-START.md # Manual bootstrap pointer
├── UPGRADING.md   # Upgrade and installer-state guidance
└── LICENSE.md     # Content-tree license copy; repo license is LICENSE
```

Repo-dev (not shipped as `content/`):

```text
docs/          # Maintainer orientation (ARCHITECTURE, CONCEPTS, FILES)
meta/          # Ideas, lessons, suggestions
incidents/     # Repo incident records
```

## Automation And Runtime

```text
cmd/deft-install/  # Frozen Go installer source and embedded payload logic
packages/          # TypeScript engine packages (types, core, content, cli)
scripts/           # Remaining JS helpers (not a Python validator layer)
tasks/             # Taskfile include fragments for command namespaces
.github/           # GitHub Actions workflows and PR template
.githooks/         # Local branch/commit/push hooks
tests/             # Content snapshots and fixtures
```

Important task include areas:

- `tasks/core.yml`, `tasks/verify.yml`, `tasks/vbrief.yml`, `tasks/xbrief.yml`, `tasks/spec.yml`, `tasks/project.yml`
- `tasks/scope.yml`, `tasks/scope-undo.yml`
- `tasks/triage-*.yml`, `tasks/cache.yml`
- `tasks/codebase.yml`, `tasks/architecture.yml`, `tasks/packs.yml`
- `tasks/pr.yml`, `tasks/swarm.yml`
- `tasks/policy.yml`, `tasks/capacity.yml`, `tasks/scm.yml`

Use `task --list` for the authoritative current command list. Release operations are `task release:*`.

## Skills

Current skill directories live under `content/skills/`:

```text
content/skills/deft-directive-article-review/
content/skills/deft-directive-build/
content/skills/deft-directive-cost/
content/skills/deft-directive-debug/
content/skills/deft-directive-decompose/
content/skills/deft-directive-design-critique/
content/skills/deft-directive-feedback/
content/skills/deft-directive-gh-arch/
content/skills/deft-directive-gh-slice/
content/skills/deft-directive-glossary/
content/skills/deft-directive-interview/
content/skills/deft-directive-issue-eval/
content/skills/deft-directive-portfolio-priority/
content/skills/deft-directive-pre-pr/
content/skills/deft-directive-probe/
content/skills/deft-directive-product-signal/
content/skills/deft-directive-refinement/
content/skills/deft-directive-release/
content/skills/deft-directive-review-cycle/
content/skills/deft-directive-setup/
content/skills/deft-directive-swarm/
content/skills/deft-directive-sync/
content/skills/deft-directive-triage/
content/skills/deft-directive-write-skill/
content/skills/deft-directive-xbrief/
```

> **Historical:** compatibility skill aliases such as `deft-build/`, `deft-setup/`, and `deft-swarm/` remain only for older loaders.

## xBRIEF State

Lifecycle state is `xbrief/`, not `vbrief/`.

```text
xbrief/
├── PROJECT-DEFINITION.xbrief.json   # Project identity, policy, scope registry, codeStructure
├── specification.xbrief.json        # Project specification source of truth
├── plan.xbrief.json                 # Plan envelope
├── proposed/                        # Candidate scope xBRIEFs
├── pending/                         # illustrative — created on first promote; may be absent when empty
├── active/                          # Running scope xBRIEFs; .gitkeep holds the folder when empty
├── completed/                       # Completed scope xBRIEFs
├── cancelled/                       # Cancelled or rejected scope xBRIEFs
├── decisions/                       # Structured decision log
├── migration/                       # Migration notes and manifests
├── .triage-cache/                   # generated-on-demand, gitignored
└── .eval/                           # generated-on-demand, gitignored
```

`PROJECT-DEFINITION.xbrief.json` replaces the old `PROJECT.md` authority role. `SPECIFICATION.md` is generated from `xbrief/specification.xbrief.json`; do not hand-edit it for durable changes.

> **Historical:** durable state used to live under `vbrief/` with `*.vbrief.json` names. New writes use `xbrief/` and xBRIEF 0.8.

## Content Packs

```text
content/packs/
```

Content packs package selected framework guidance into sliceable agent memory. The `task packs:*` namespace renders and checks pack drift.

## Planning And Generated Architecture

`.planning/codebase/STACK.md` and `.planning/codebase/CONVENTIONS.md` are residual planning notes, not current architecture authority.

```text
.planning/codebase/
├── ARCHITECTURE.md   # residual planning note
├── CONCERNS.md       # residual planning note
├── CONVENTIONS.md    # residual planning note, not current architecture authority
├── MAP.md            # generated-on-demand codebase orientation projection
└── STACK.md          # residual planning note, not current architecture authority
```

`xbrief/PROJECT-DEFINITION.xbrief.json` `plan.architecture.codeStructure` is the authored source of truth for codebase structure. `.planning/codebase/MAP.md` is generated by `task codebase:map` and checked by `task verify:codebase-map-fresh`.

## Consumer Project Artifacts

When Deft is installed into another project, the important locations are:

- `.deft/core/` -- consumer-install vendored framework payload
- `AGENTS.md` -- illustrative consumer entry point with a managed Deft section
- `xbrief/` -- consumer-install project xBRIEF root
- `xbrief/PROJECT-DEFINITION.xbrief.json` -- consumer-install project identity and policy
- `xbrief/{proposed,pending,active,completed,cancelled}/` -- illustrative consumer scope lifecycle folders
- `.deft-cache/` -- consumer-install local content cache, normally gitignored
- `~/.config/deft/USER.md` -- consumer-install personal preferences (Unix/macOS)
- `%APPDATA%\deft\USER.md` -- consumer-install personal preferences (Windows)

> **Historical (legacy consumer layout):** older installs used `vbrief/` as the lifecycle root and a tracked `deft/` payload. Current consumer writes use `xbrief/`; `.deft/core/` is the canonical installed framework path.

> **Historical:** `tasks/release.yml` was listed as a Taskfile include; that file is not in the current tree. Release work uses `task release:*`.

## Notes

- `PROJECT.md` is a deprecated redirect in this repository.
- `PRD.md`, `ROADMAP.md`, and `SPECIFICATION.md` are rendered views.
- `tasks/` is the current Taskfile include directory; there is no separate `taskfiles/` directory in the current tree.
- `xbrief/architecture/` is not a current directory. Authored architecture metadata lives in `xbrief/PROJECT-DEFINITION.xbrief.json`.
