# Deft Files And Directory Structure

Current directory map and per-area index for the Deft Directive framework repository. This is an orientation guide; [ARCHITECTURE.md](./ARCHITECTURE.md) explains how the pieces fit together.

> **See also**: [ARCHITECTURE.md](./ARCHITECTURE.md) | [CONCEPTS.md](./CONCEPTS.md) | [RELEASING.md](./RELEASING.md)

## Top Level

```text
deft/
├── AGENTS.md              # Canonical AI-agent entry surface
├── SKILL.md               # Alternate skill-loader entry surface
├── main.md                # General AI behavior and rule-authority axiom
├── README.md              # User-facing overview and getting started
├── QUICK-START.md         # Manual bootstrap pointer
├── CONTRIBUTING.md        # Contributor setup and conventions
├── CHANGELOG.md           # Release notes
├── LICENSE.md             # MIT license
├── REFERENCES.md          # Lazy-loading reference guidance
├── UPGRADING.md           # Upgrade and installer-state guidance
├── commands.md            # Command lifecycle and task references
├── Taskfile.yml           # Root deterministic command graph
├── run                    # Compatibility / interactive Python launcher
├── run.py                 # Import shim for tests and tooling
├── run.bat                # Windows launcher for run
├── go.mod                 # Go installer module
├── package.json           # TypeScript workspace scripts and package metadata
├── pnpm-lock.yaml         # TypeScript dependency lock
├── pnpm-workspace.yaml    # TypeScript workspace layout
├── pyproject.toml         # Python tooling and test configuration
├── tsconfig.base.json     # Shared TypeScript compiler configuration
├── tsconfig.json          # TypeScript project references
├── vitest.config.ts       # TypeScript test configuration
├── uv.lock                # Python dependency lock
├── PROJECT.md             # Deprecated redirect to vBRIEF project definition
├── PRD.md                 # Rendered PRD view
├── ROADMAP.md             # Rendered backlog view
└── SPECIFICATION.md       # Rendered spec view from vbrief/specification.vbrief.json
```

## Framework Guidance

```text
coding/        # Coding, testing, hygiene, toolchain, and build-output rules
context/       # Context management patterns and spec-delta guidance
contracts/     # Boundary maps, hierarchy, deterministic question contracts
conventions/   # Cross-cutting conventions such as references and banners
core/          # Detailed glossary, project template, versioning, Ralph concepts
deployments/   # Platform deployment guides
docs/          # User, maintainer, audit, architecture, and research docs
events/        # Event registry and schemas
incidents/     # Incident records and analyses
interfaces/    # CLI, REST, TUI, and web interface guidance
languages/     # Language-specific standards
meta/          # Philosophy, morals, security, lessons, ideas, and suggestions
patterns/      # Reusable architectural and LLM-application patterns
platforms/     # Niche platform guidance
references/    # External/reference material
resilience/    # Continue-here and context-pruning protocols
scm/           # Git, GitHub, and changelog guidance
strategies/    # Interview, map, research, speckit, yolo, and related strategies
swarm/         # Multi-agent coordination reference
tools/         # Tool-specific guidance such as Taskfile and telemetry
verification/  # Verification ladder and validation guidance
```

## Automation And Runtime

```text
cmd/deft-install/  # Go installer source and embedded payload logic
packages/          # TypeScript engine packages, CLI shims, and parity tests
scripts/           # Python validators, renderers, lifecycle tools, triage/cache/scm/release helpers
tasks/             # Taskfile include fragments for command namespaces
.github/           # GitHub Actions workflows and PR template
.githooks/         # Local branch/commit/push hooks
tests/             # CLI, content, contract, fixture, and regression tests
```

Important task include areas:

- `tasks/core.yml`, `tasks/verify.yml`, `tasks/vbrief.yml`, `tasks/spec.yml`, `tasks/project.yml`
- `tasks/scope.yml`, `tasks/scope-undo.yml`
- `tasks/triage-*.yml`, `tasks/cache.yml`
- `tasks/codebase.yml`, `tasks/architecture.yml`, `tasks/packs.yml`
- `tasks/pr.yml`, `tasks/release.yml`, `tasks/swarm.yml`
- `tasks/policy.yml`, `tasks/capacity.yml`, `tasks/scm.yml`

Use `task --list` for the authoritative current command list.

## Skills

Current skill directories include:

```text
skills/deft-directive-article-review/
skills/deft-directive-build/
skills/deft-directive-cost/
skills/deft-directive-debug/
skills/deft-directive-decompose/
skills/deft-directive-gh-arch/
skills/deft-directive-gh-slice/
skills/deft-directive-glossary/
skills/deft-directive-interview/
skills/deft-directive-pre-pr/
skills/deft-directive-probe/
skills/deft-directive-refinement/
skills/deft-directive-release/
skills/deft-directive-review-cycle/
skills/deft-directive-setup/
skills/deft-directive-swarm/
skills/deft-directive-sync/
skills/deft-directive-triage/
skills/deft-directive-write-skill/
```

Compatibility skill aliases such as `deft-build/`, `deft-setup/`, `deft-swarm/`, and related legacy names remain for older loaders.

## vBRIEF State

```text
vbrief/
├── PROJECT-DEFINITION.vbrief.json   # Project identity, policy, scope registry, codeStructure
├── specification.vbrief.json        # Project specification source of truth
├── vbrief.md                        # Canonical vBRIEF usage reference
├── schemas/                         # JSON schemas
├── proposed/                        # Candidate scope vBRIEFs
├── pending/                         # Accepted backlog scope vBRIEFs
├── active/                          # Running scope vBRIEFs
├── completed/                       # Completed scope vBRIEFs
├── cancelled/                       # Cancelled or rejected scope vBRIEFs
├── .triage-cache/                   # Local triage audit/working-set, gitignored
└── .eval/                           # Framework eval results (`.eval/results/`), gitignored
```

`PROJECT-DEFINITION.vbrief.json` replaces the old `PROJECT.md` authority role. `SPECIFICATION.md` is generated from `vbrief/specification.vbrief.json`; do not hand-edit it for durable changes.

## Content Packs

```text
packs/
```

Content packs package selected framework guidance into sliceable agent memory. The `task packs:*` namespace renders and checks pack drift.

## Planning And Generated Architecture

```text
.planning/codebase/
├── ARCHITECTURE.md   # Historical planning note unless generated banner says otherwise
├── CONCERNS.md       # Planning note
├── CONVENTIONS.md    # Historical planning note unless generated banner says otherwise
├── MAP.md            # Generated codebase orientation projection
└── STACK.md          # Planning note
```

`vbrief/PROJECT-DEFINITION.vbrief.json` `plan.architecture.codeStructure` is the authored source of truth for codebase structure. `.planning/codebase/MAP.md` is generated by `task codebase:map` and checked by `task verify:codebase-map-fresh`.

## Consumer Project Artifacts

When Deft is installed into another project, the important locations are:

- `.deft/core/` -- vendored framework payload installed by `deft-install`.
- `AGENTS.md` -- consumer entry point with a managed Deft section.
- `vbrief/` -- consumer project vBRIEF root.
- `vbrief/PROJECT-DEFINITION.vbrief.json` -- consumer project identity and policy.
- `vbrief/{proposed,pending,active,completed,cancelled}/` -- consumer scope lifecycle folders.
- `.deft-cache/` and `<lifecycle-root>/.triage-cache/` -- local content cache and triage audit/working-set, normally gitignored; `<lifecycle-root>/.eval/results/` holds framework-eval ledgers (#1703).
- `~/.config/deft/USER.md` on Unix/macOS or `%APPDATA%\deft\USER.md` on Windows -- personal preferences.

Legacy `deft/` installs can appear during migration, but `.deft/core/` is the canonical installed framework path.

## Notes

- `PROJECT.md` is a deprecated redirect in this repository.
- `PRD.md`, `ROADMAP.md`, and `SPECIFICATION.md` are rendered views.
- `run`, `run.py`, and `run.bat` are retained compatibility surfaces.
- `tasks/` is the current Taskfile include directory; there is no separate `taskfiles/` directory in the current tree.
- `vbrief/architecture/` is not a current directory. Authored architecture metadata lives in `vbrief/PROJECT-DEFINITION.vbrief.json`.
