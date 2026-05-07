# Deft Files & Directory Structure

Top-level directory map and a per-area index of the files that live inside the deft framework. This file is a reference — start with [ARCHITECTURE.md](./ARCHITECTURE.md) for how the layers fit together.

> **📚 See also**: [ARCHITECTURE.md](./ARCHITECTURE.md) (layered architecture, rule hierarchy) • [CONCEPTS.md](./CONCEPTS.md) (key principles) • [RELEASING.md](./RELEASING.md)

## 📁 Directory Structure

```
deft/
├── README.md              # Top-level entry: TL;DR + Getting Started + pointers
├── AGENTS.md              # Canonical AI-agent entry surface
├── SKILL.md               # Alternate AI-agent entry surface (loader-specific)
├── QUICK-START.md         # Manual-clone bootstrap pointer
├── CHANGELOG.md           # Release history
├── CONTRIBUTING.md        # Contributor bootstrap guide
├── LICENSE.md             # MIT License
├── REFERENCES.md          # Lazy-loading reference system
├── ROADMAP.md             # Rendered backlog view (vbrief/pending/ + completed/)
├── UPGRADING.md           # Per-version upgrade procedure
├── glossary.md            # Canonical v0.20 vocabulary (one page, < 150 lines)
├── main.md                # Entry point — general AI guidelines
├── commands.md            # Available commands (run + task)
├── Taskfile.yml           # Task automation
├── run.bat                # Windows task runner shim
│
├── cmd/                   # Go installer source
│   └── deft-install/      # Cross-platform installer wizard
│
├── coding/                # Coding standards
│   ├── coding.md          # General coding guidelines
│   ├── hygiene.md         # Codebase hygiene
│   └── testing.md         # Testing standards
│
├── context/               # Context management strategies
│   ├── context.md         # Overview
│   ├── deterministic-split.md
│   ├── examples.md
│   ├── fractal-summaries.md
│   ├── long-horizon.md
│   ├── spec-deltas.md
│   ├── tool-design.md
│   └── working-memory.md
│
├── contracts/             # Interface contracts
│   ├── boundary-maps.md   # Produces/consumes between slices
│   └── hierarchy.md       # Dual-hierarchy framework (durability + generative axes)
│
├── conventions/           # Cross-cutting conventions (references, task caching, ...)
│
├── core/                  # Core framework files
│   ├── glossary.md        # Detailed terminology definitions (canonical)
│   ├── project.md         # Project template
│   ├── ralph.md           # Ralph loop concept
│   └── versioning.md      # Versioning guidelines
│
├── deployments/           # Platform-specific deployment guidance
│   ├── README.md          # Deployment overview
│   ├── agentuity/         # Agentuity platform
│   ├── aws/               # AWS (Lambda, ECS, App Runner, EB)
│   ├── azure/             # Azure (App Service, Functions, AKS, Container Apps)
│   ├── cloudflare/        # Cloudflare Workers/Pages
│   ├── cloud-gov/         # cloud.gov (FedRAMP)
│   ├── fly-io/            # Fly.io
│   ├── google/            # GCP (Cloud Run, Functions, App Engine, GKE)
│   ├── netlify/           # Netlify
│   └── vercel/            # Vercel
│
├── docs/                  # Documentation & articles (this directory)
│   ├── ARCHITECTURE.md    # Layered architecture, rule hierarchy, mermaid diagrams
│   ├── CONCEPTS.md        # Key principles: SDD, TDD, conventions, safety
│   ├── FILES.md           # Directory tree + file index (this file)
│   ├── RELEASING.md       # Release & testing workflow
│   ├── BROWNFIELD.md      # Adding Deft to an existing project
│   ├── ai-coding-trust-paradox.md
│   ├── claude-code-integration.md
│   ├── getting-started.md
│   └── superpowers.md
│
├── events/                # Framework event registry + schemas
│
├── history/               # Plan archives and change logs
│   ├── archive/
│   ├── changes/
│   └── proposals/
│
├── interfaces/            # Interface types
│   ├── cli.md             # Command-line interfaces
│   ├── rest.md            # REST APIs
│   ├── tui.md             # Terminal UIs
│   └── web.md             # Web UIs
│
├── languages/             # Language-specific standards (20+ languages)
│   ├── python.md, go.md, typescript.md, javascript.md
│   ├── cpp.md, c.md, csharp.md, rust.md, zig.md
│   ├── java.md, kotlin.md, swift.md, dart.md
│   ├── elixir.md, julia.md, r.md, sql.md
│   ├── delphi.md, visual-basic.md, vhdl.md
│   ├── 6502-DASM.md       # 6502 Assembly (DASM)
│   ├── markdown.md, mermaid.md
│   └── commands.md        # Language command reference
│
├── meta/                  # Meta/process files
│   ├── code-field.md      # Coding mindset
│   ├── ideas.md           # Future directions
│   ├── lessons.md         # Learnings (AI-updatable)
│   ├── morals.md          # Ethical guidelines
│   ├── SOUL.md            # Core philosophy
│   └── suggestions.md     # Improvements
│
├── platforms/             # Niche platform standards (deeper-dive only)
│   ├── 2600.md            # Atari 2600
│   └── unity.md           # Unity engine
│
├── resilience/            # Session continuity & recovery
│   ├── continue-here.md   # Interruption recovery protocol
│   └── context-pruning.md # Fresh context per task
│
├── scm/                   # Source control management
│   ├── changelog.md       # Changelog conventions
│   ├── git.md             # Git conventions
│   └── github.md          # GitHub workflows
│
├── scripts/               # Python scripts (validators, renderers, lint helpers)
│
├── skills/                # Agent skills (SKILL.md format)
│   ├── deft-directive-build/        # Build/implement skill
│   ├── deft-directive-interview/    # Deterministic structured Q&A interview
│   ├── deft-directive-pre-pr/       # Iterative pre-PR quality loop (RWLDL)
│   ├── deft-directive-refinement/   # Conversational backlog refinement
│   ├── deft-directive-release/      # Release pipeline workflow
│   ├── deft-directive-review-cycle/ # Greptile bot review cycle
│   ├── deft-directive-setup/        # Interactive setup skill
│   ├── deft-directive-swarm/        # Parallel agent orchestration
│   └── deft-directive-sync/         # Session-start framework sync
│
├── specs/                 # Per-feature specifications
│   ├── testbed/           # QA testbed Phase 1 spec
│   └── strategy-chaining/ # Strategy chaining feature spec
│
├── strategies/            # Development strategies
│   ├── README.md          # Strategy overview
│   ├── brownfield.md      # Redirect → map.md (deprecated)
│   ├── discuss.md         # Discussion mode
│   ├── interview.md       # Interview-driven development (default)
│   ├── map.md             # Codebase mapping
│   ├── research.md        # Research mode
│   ├── speckit.md         # Specification toolkit
│   └── yolo.md            # Rapid prototyping
│
├── swarm/                 # Multi-agent coordination guidelines
│   └── swarm.md           # Swarm guidelines (paired with skills/deft-directive-swarm/)
│
├── tasks/                 # Reusable Taskfile includes
│
├── taskfiles/             # Reusable Taskfile includes (deployments)
│   └── deployments.yml
│
├── templates/             # Templates and examples
│   ├── make-spec.md       # Spec generation guide
│   ├── make-spec-example.md
│   ├── specification.md   # Project spec template
│   └── agents-entry.md    # Canonical AGENTS.md entry block
│
├── tests/                 # Test fixtures and snapshots
│   ├── content/snapshots/ # Content validation baselines
│   └── fixtures/          # Mock configs
│
├── tools/                 # Tooling and workflow guidelines
│   ├── RWLDL.md           # Ralph Wiggum's Loop-de-Loop pattern (paired with skills/deft-directive-pre-pr/)
│   ├── taskfile.md        # Task automation
│   └── telemetry.md       # Observability
│
├── vbrief/                # vBRIEF document model
│   ├── vbrief.md          # Canonical vBRIEF usage reference
│   ├── PROJECT-DEFINITION.vbrief.json   # Project identity gestalt
│   ├── specification.vbrief.json        # Project spec source of truth
│   ├── proposed/          # Scope vBRIEFs: ideas, not committed to
│   ├── pending/           # Scope vBRIEFs: accepted backlog
│   ├── active/            # Scope vBRIEFs: in progress
│   ├── completed/         # Scope vBRIEFs: done
│   ├── cancelled/         # Scope vBRIEFs: rejected/abandoned
│   └── schemas/           # JSON schemas
│
└── verification/          # Agent work verification
    ├── verification.md    # 4-tier verification ladder
    ├── integration.md     # Integration testing
    ├── plan-checking.md   # Plan validation
    └── uat.md             # User acceptance testing
```

**Notes**

- `PROJECT.md` (top-level) is **deprecated** — replaced by `vbrief/PROJECT-DEFINITION.vbrief.json`. The file remains as a one-line redirect for backward compatibility and is removed by `task migrate:vbrief` on consumer projects.
- `SPECIFICATION.md` (top-level) is a **rendered view** of `vbrief/specification.vbrief.json` (regenerate via `task spec:render`); on migrated consumer projects it can also exist as a deprecation redirect.
- The legacy `user.md` file under `core/` has been removed — your USER.md now lives outside the framework at `~/.config/deft/USER.md` (Unix/macOS) or `%APPDATA%\deft\USER.md` (Windows).
- `glossary.md` (top-level) is the short canonical v0.20 vocabulary. `core/glossary.md` is the detailed terminology reference. Both are kept in sync; consumers should land on the top-level `glossary.md` first.
- `tools/RWLDL.md` describes the underlying *concept* (Ralph Wiggum's Loop-de-Loop, micro/macro alternation). The RFC2119-encoded *agent skill* form lives at `skills/deft-directive-pre-pr/SKILL.md` and is the canonical reference for the pre-PR quality loop. Likewise `swarm/swarm.md` is the prose reference and `skills/deft-directive-swarm/` is the canonical multi-agent orchestration skill.

## 🔧 Core Files

- **main.md** — Entry point, general AI guidelines
- **AGENTS.md** — Canonical AI-agent entry surface (this repo and installer-wired projects)
- **SKILL.md** — Alternate AI-agent entry surface (loader-specific)
- **coding/coding.md** — Software development standards
- **coding/testing.md** — Testing standards
- **vbrief/PROJECT-DEFINITION.vbrief.json** — Project identity gestalt (replaces deprecated `PROJECT.md`)
- **USER.md** — Your personal preferences (highest precedence) — `~/.config/deft/USER.md` (Unix/macOS) or `%APPDATA%\deft\USER.md` (Windows)

## 🐍 Languages

`languages/` contains standards for 20+ languages including:

- **python.md** — Python (≥85% coverage, mypy strict, ruff/black)
- **go.md** — Go (≥85% coverage, Testify)
- **typescript.md** / **javascript.md** — TS/JS (strict mode, Vitest)
- **cpp.md** / **c.md** / **csharp.md** — C family
- **rust.md** / **zig.md** — Systems languages
- **java.md** / **kotlin.md** / **swift.md** / **dart.md** — Mobile/JVM
- **elixir.md** / **julia.md** / **r.md** / **sql.md** — Specialized
- **markdown.md** / **mermaid.md** — Documentation formats
- Plus: `delphi.md`, `visual-basic.md`, `vhdl.md`, `6502-DASM.md`

## 💻 Interfaces

- **interfaces/cli.md** — Command-line interface patterns
- **interfaces/rest.md** — REST API design
- **interfaces/tui.md** — Terminal UI (Textual, ink)
- **interfaces/web.md** — Web UI (React, Tailwind)

## 🛠️ Tools

- **tools/taskfile.md** — Task automation best practices
- **tools/telemetry.md** — Logging, tracing, metrics
- **tools/RWLDL.md** — Ralph Wiggum's Loop-de-Loop concept (canonical RFC2119 form: `skills/deft-directive-pre-pr/SKILL.md`)

## 📂 SCM

- **scm/git.md** — Commit conventions, safety
- **scm/github.md** — GitHub workflows
- **scm/changelog.md** — Changelog conventions

## 🐝 Swarm

- **swarm/swarm.md** — Multi-agent coordination (canonical RFC2119 form: `skills/deft-directive-swarm/SKILL.md`)

## 🧭 Strategies

`strategies/` — development approach strategies:

- **interview.md** / **discuss.md** / **map.md** / **research.md** / **speckit.md** / **yolo.md** / **brownfield.md** (redirects to `map.md`)

## 🧠 Context

- **context/context.md** — Context management overview
- **context/fractal-summaries.md** / **working-memory.md** / **long-horizon.md** / **deterministic-split.md** / **spec-deltas.md** / **tool-design.md** / **examples.md**

## ✅ Verification

- **verification/verification.md** — 4-tier verification ladder, must-haves, stub detection
- **verification/integration.md** — Integration testing standards
- **verification/plan-checking.md** — Plan validation
- **verification/uat.md** — Auto-generated user acceptance test scripts

## 🛡️ Resilience

- **resilience/continue-here.md** — Interruption recovery protocol (vBRIEF-based)
- **resilience/context-pruning.md** — Fresh context per task, eliminating context rot

## 📋 vBRIEF

- **vbrief/vbrief.md** — Canonical vBRIEF usage reference (file taxonomy, lifecycle folders, scope vBRIEFs)
- **vbrief/schemas/** — JSON validation schemas
- **vbrief/PROJECT-DEFINITION.vbrief.json** — Project identity gestalt
- **vbrief/{proposed,pending,active,completed,cancelled}/** — Scope vBRIEF lifecycle folders

## 📜 Contracts

- **contracts/hierarchy.md** — Dual-hierarchy framework (durability axis + generative axis)
- **contracts/boundary-maps.md** — Explicit produces/consumes declarations between slices

## 🚀 Deployments

`deployments/` — deployment guides for 9 platforms: agentuity, aws, azure, cloudflare, cloud-gov, fly-io, google, netlify, vercel.

## 📖 Glossary

- **glossary.md** — Canonical v0.20 vocabulary (Scope vBRIEF, lifecycle folder, canonical narrative keys, rendered export, source of truth, ...) — one page under 150 lines.
- **core/glossary.md** — Detailed terminology reference (longer; for deeper dives).

## 🤖 Skills

- **skills/deft-directive-build/** — Build/implement skill
- **skills/deft-directive-interview/** — Deterministic structured Q&A interview skill
- **skills/deft-directive-pre-pr/** — Iterative pre-PR quality loop (Read-Write-Lint-Diff-Loop) — run before pushing a branch for PR creation
- **skills/deft-directive-refinement/** — Conversational backlog refinement (ingest, evaluate, promote/demote, prioritize)
- **skills/deft-directive-release/** — Release pipeline workflow (`task release` / `task release:publish` / `task release:rollback` / `task release:e2e`)
- **skills/deft-directive-review-cycle/** — Greptile bot reviewer response workflow (fetch findings, batch fix, exit on clean)
- **skills/deft-directive-setup/** — Interactive setup wizard skill
- **skills/deft-directive-swarm/** — Parallel local agent orchestration (worktrees, prompts, monitoring, merge)
- **skills/deft-directive-sync/** — Session-start framework sync (submodule update, project validation)

## 📝 Templates

- **templates/make-spec.md** — Specification generation
- **templates/specification.md** — Project spec template
- **templates/agents-entry.md** — Canonical AGENTS.md entry block (also embedded in the installer)

## 🧠 Meta

- **meta/code-field.md** — Coding mindset and philosophy
- **meta/SOUL.md** — Core philosophy
- **meta/morals.md** — Ethical guidelines
- **meta/lessons.md** — Codified learnings (AI-updatable)
- **meta/ideas.md** — Future directions
- **meta/suggestions.md** — Improvement suggestions

## 🎮 Niche Platforms

`platforms/` — standards for niche or specialized platforms. Most consumers can ignore this directory. The current entries are:

- **platforms/2600.md** — Atari 2600 development
- **platforms/unity.md** — Unity engine standards

## 📦 Your Artifacts (consumer projects)

When you use Deft in a consumer project, these are the key locations for user-generated artifacts:

- **`./vbrief/`** — vBRIEF document root
  - `PROJECT-DEFINITION.vbrief.json` — project identity gestalt (replaces deprecated `PROJECT.md`)
  - `plan.vbrief.json` — session-level tactical plan; carries `planRef` to scope vBRIEFs
  - `continue.vbrief.json` — interruption checkpoint (ephemeral)
  - `specification.vbrief.json` — project spec source of truth
  - `proposed/`, `pending/`, `active/`, `completed/`, `cancelled/` — scope vBRIEF lifecycle folders (individual units of work as `YYYY-MM-DD-slug.vbrief.json`)
- **`USER.md`** — personal preferences (`~/.config/deft/USER.md` on Unix/macOS, `%APPDATA%\deft\USER.md` on Windows)
- **`./deft/`** — installed framework files (cloned or installed by the installer)
