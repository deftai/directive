# Deft Architecture

How the Deft framework is wired today: authority layers, command surfaces, xBRIEF state, automation modules, generated artifacts, and the boundary between authored source of truth and derived views.

> **Naming (#2907):** **xBRIEF** / `xbrief/` is the sole public work-state name; **vBRIEF** is legacy. See [UPGRADING.md — xBRIEF rename](../content/UPGRADING.md#xbrief-rename-2034--2110--2907).

> **See also**: [CONCEPTS.md](./CONCEPTS.md) (operating principles) | [FILES.md](./FILES.md) (directory map) | [code-structure-profile.md](./code-structure-profile.md) | [codebase-map-source-of-truth.md](./codebase-map-source-of-truth.md) | [../README.md](../README.md)

## What Deft Is

Deft Directive is a self-dogfooded framework for AI-assisted software work. It is not just Markdown guidance and not just a CLI. The implemented system combines:

- Agent-consumed rules, skills, standards, strategies, and templates.
- TypeScript packages under `packages/` as the implementation and runtime owner (validation, rendering, lifecycle, cache/triage/scope, doctor, release support, CLI).
- Taskfile as the repository command facade (`task --list`, `task check`, `task verify:*`).
- `deft` / `directive` as the installed consumer CLI.
- `deft-hook` and native CLI verbs as host and Git-hook entrypoints.
- Two published npm packages: `@deftai/directive` (global launcher) and `@deftai/directive-runtime` (project pin). Private workspace packages `types` / `core` / `content` are bundled into the runtime at publish time. Consumer install: `directive install` / `upgrade` / `uninstall` / `doctor` (aliases `init` / `update` / `remove`). No copied `.deft/core/`; wiring is package-relative under `node_modules/@deftai/directive-runtime/`. The Go installer is removed. See [launcher.md](../content/docs/launcher.md) and [known-limitations.md](../content/docs/known-limitations.md).
- xBRIEF files as durable project, specification, lifecycle, policy, and architecture metadata.
- Local cache/audit surfaces for backlog triage and GitHub issue ingestion.
- PR, release, swarm, branch-policy, and verification gates.
- Content packs for sliceable agent memory.
- Tests, hooks, and CI workflows that enforce the stronger rules.

`task --list` is the repository command discovery surface. New deterministic automation enters through Taskfile, which dispatches the TypeScript CLI in this checkout.

> **Historical (Python/run era):** root `run`, `run.py`, and `run.bat` launchers, plus `scripts/*.py` validators, were the previous automation layer. They are removed from the current tree. Do not add work there.

The original Deft intent still matters: move from one-off, vibe-level agent prompting toward a repeatable practice where standards are modular, context is loaded on demand, work is specified before implementation, tests anchor behavior, and the framework improves from its own lessons.

## System Shape

```mermaid
flowchart LR
    A["Agent entry<br/>AGENTS.md, SKILL.md, main.md"] --> B["Guidance layer<br/>skills, standards, strategies, templates"]
    B --> C["Taskfile command graph<br/>task --list, task check, task verify:*"]
    C --> D["Automation layer<br/>launcher + pinned runtime, Taskfile engine"]
    D --> E["Durable state<br/>PROJECT-DEFINITION, specification, scope xBRIEFs"]
    E --> F["Generated views<br/>SPECIFICATION.md, PRD.md, ROADMAP.md, MAP.md"]
    E --> C
    C --> G["Enforcement surfaces<br/>tests, hooks, CI, release and PR gates"]
    G --> B
```

The loop is deliberate. Guidance tells agents how to behave, tasks make that behavior executable, xBRIEF files preserve state, generated views make state readable, and gates feed back into the guidance when the framework learns a better rule.

## Entry Surfaces

- `AGENTS.md` is the canonical agent entry point in this repository and in installer-wired consumer projects.
- `SKILL.md` is the alternate loader convention for platforms that discover skills directly.
- `main.md` holds general AI behavior and the current rule-authority axiom.
- `~/.config/deft/USER.md` stores personal preferences, with its Personal section taking precedence for user-defined preferences.
- `xbrief/PROJECT-DEFINITION.xbrief.json` stores project identity, policy, lifecycle registry, and authored architecture metadata.

Consumer installs point agents at `node_modules/@deftai/directive-runtime/main.md` (and related package-relative paths). Happy path: global launcher + `directive install` writing an exact runtime pin. Clone/worktree: project PM install, then first eligible runtime invocation completes local activation. Supported latest-legacy conversion: `directive upgrade`. See [README.md](../README.md).

## Rule Authority

Rules use the strongest applicable layer:

```mermaid
flowchart TD
    D["Deterministic checks<br/>tests, scripts, hooks, CI"] --> T["Taskfile targets<br/>task check, verify:*, xbrief:preflight"]
    T --> V["xBRIEF metadata<br/>project policy, lifecycle state"]
    V --> R["RFC2119 rules<br/>AGENTS.md, main.md, skills"]
    R --> P["Plain prose<br/>explanation and rationale"]
```

This is the current `main.md` rule-authority axiom: deterministic > Taskfile > xBRIEF > RFC2119 > prose. Prose explains rules but does not outrank executable gates.

Personal preferences from `USER.md` still matter, but when a rule has an executable check, the check is the rule body. For example, branch policy is described in prose, exposed by `task verify:branch`, enforced by hooks, and repeated in CI.

## Requirements Are Separate From Rules

Requirements describe what to build. Rules describe how agents should behave while doing the work.

- `xbrief/specification.xbrief.json` is the project specification source of truth.
- `SPECIFICATION.md` is a rendered view generated by `task spec:render`.
- `PRD.md` is a rendered stakeholder view generated by `task prd:render`.
- `ROADMAP.md` is a rendered forward-looking backlog view (`pending/` + `proposed/` + `active/`, completed capped) generated by `task roadmap:render`. Orientation only — work selection still uses `triage:queue` / plan-sequence.
- Scope xBRIEFs live in `xbrief/{proposed,pending,active,completed,cancelled}/`.

Generated markdown files carry machine-generated banners. Edit the xBRIEF source first, then render.

```mermaid
flowchart LR
    S["xbrief/specification.xbrief.json"] -->|"task spec:render"| SM["SPECIFICATION.md"]
    S -->|"task prd:render"| PRD["PRD.md"]
    L["Lifecycle scope xBRIEFs"] -->|"task roadmap:render"| RM["ROADMAP.md"]
    P["PROJECT-DEFINITION<br/>codeStructure"] -->|"task codebase:map"| MAP[".planning/codebase/MAP.md"]
    Skills["Skills and standards"] -->|"task packs:render"| Packs["Rendered content packs"]
```

## Implemented Modules

| Area | Primary paths | Current responsibility |
| --- | --- | --- |
| Framework content | `AGENTS.md`, `main.md`, `content/`, `docs/` | Agent guidance, skills, standards, and documentation. Shipped guidance lives under `content/`; `docs/` is repo-dev orientation. |
| Task runner | `Taskfile.yml`, `tasks/*.yml` | Repository command facade: deterministic command contract and composable namespaces. |
| TypeScript packages | `packages/`, `package.json`, `pnpm-workspace.yaml`, `tsconfig*.json`, `vitest.config.ts` | Implementation and runtime owner for gates, the `deft` / `directive` CLI, and `deft-hook`. |
| Go installer (deleted) | `cmd/deft-install/` (absent), `go.mod` (husk) | **Deleted / archaeology only (AC10.10).** Do not run `deft-install` or teach it as a current path. Current install is OVPR: global `@deftai/directive` + `directive install` / `upgrade` / `uninstall` / `doctor`. Standard recovery: `npm i -g @deftai/directive` then `directive install --repair` (AC9.7). |
| xBRIEF metadata | `xbrief/**/*.json`, `xbrief/**/*.md` | Project identity, scope lifecycle, schemas, policy, specification source, and authored `codeStructure`. |
| Content packs | `content/packs/` | Curated agent memory packs rendered and checked through `task packs:*`. |
| CI/release automation | `.github/`, `.githooks/`, `tasks/pr.yml` | Branch policy, PR readiness, release, publish, rollback, and local hook enforcement. |
| Tests | `tests/`, `packages/*/src/**/*.test.ts` | CLI, content, contract, lifecycle, and regression coverage. |

> **Historical (Python/run era):** `scripts/*.py`, `run`, `run.py`, and `run.bat` used to own validators and compatibility routing. They are not current modules.

## npm-Native Distribution (current)

This section is the canonical package and installation topology (OVPR / #5490). Two labeled facts stay separate: **published package membership** comes from non-private `packages/*/package.json`; **publish sequence** comes from `.github/workflows/npm-publish.yml` and is an ordered list, not a topological sort of the workspace graph. This document records the observed sequence; it does not change the workflow. Install commands live in [README.md](../README.md). Default `directive install` / `upgrade` / `uninstall` plans describe package-manager effects in plain language; the exact package-manager argv is available at `-v`/`--verbose` (AC5.1). Node run requirements for consumers versus maintainers are not this topology.

The repository **publishes two npm packages**. `@deftai/directive` is the global launcher (`directive` / `deft`). `@deftai/directive-runtime` is the exact project pin. Private workspace packages `types` / `core` / `content` are bundled into the runtime at publish time and are not separately published consumer packages.

### Published workspace

| Package | Role | Support | Workspace dependencies (published) |
| --- | --- | --- | --- |
| `@deftai/directive-runtime` | project-pinned runtime (engine + content) | supported | (none among published packages; private workspace packages are bundled) |
| `@deftai/directive` | global launcher | supported | (none — empty deps) |

Workspace dependency edges among **published** packages (from non-private `packages/*/package.json`): none. The launcher does not depend on the runtime at install time; it resolves the project's exact pin on each run.

```mermaid
flowchart LR
    Launcher["@deftai/directive<br/>global launcher"]
    Runtime["@deftai/directive-runtime<br/>project pin"]
    Launcher -.->|"resolves pin at runtime"| Runtime
```

### Observed publish sequence

Observed publish sequence from `.github/workflows/npm-publish.yml` (ordered list, not dependency order, not a topological sort of the workspace graph):

1. `@deftai/directive-runtime`
2. `@deftai/directive`

### Consumer install path (OVPR)

Happy-path consumer materialization is the global launcher plus project install verbs — not a copied `.deft/core/` deposit and not the deleted Go installer.

```mermaid
flowchart LR
    Global["npm i -g @deftai/directive"] --> Install["directive install<br/>exact runtime pin + setup"]
    Install --> Ready["package-relative wiring<br/>node_modules/@deftai/directive-runtime/"]
    Ready --> Upgrade["directive upgrade<br/>move pin / migrate data"]
    Ready --> Repair["directive install --repair<br/>AC9.7 wiring recovery"]
```

Key properties:

- **Global launcher ≠ project pin.** `npm i -g @deftai/directive` only places the launcher on PATH. `directive install` writes the exact `@deftai/directive-runtime` pin and runs setup (alias `init`).
- **No copied `.deft/core/`.** Agent pointers and hooks are package-relative under `node_modules/@deftai/directive-runtime/`.
- **Ordinary upgrade:** `npm i -g @deftai/directive@latest`, then `directive upgrade` (alias `update`) to move the pin and migrate project data when needed.
- **Wiring broken; keep the pin (AC9.7):** `npm i -g @deftai/directive`, then `directive install --repair`.
- **Remove / diagnose:** `directive uninstall` (alias `remove`); `directive doctor` (read-only).
- **Do not teach** `npx` / `pnpm exec` as day-to-day identity, and do not teach the deleted Go installer (`deft-install`) as a current path (AC10.10).

### Go installer — deleted (AC10.10)

> **Historical / archaeology only.** `cmd/deft-install/` and the Go installer binaries (`deft-install`, platform `install-*`) are **deleted**. Do not download, run, or teach `deft-install gate` (or any Go installer command) as a current path. Repo-root `go.mod` may remain as a husk for legacy CI pins; it is not a current installer module. Current recovery is OVPR only: `npm i -g @deftai/directive` then `directive install --repair` (AC9.7).

## Command Surface

These are separate lanes. Do not collapse them into "Taskfile-first runtime."

| Lane | Owner | Role |
| --- | --- | --- |
| TypeScript packages | `packages/` | Implementation and runtime owner |
| Taskfile | `Taskfile.yml`, `tasks/*.yml` | Repository command facade for maintainers, agents, and CI in this checkout |
| Installed consumer CLI | `deft` / `directive` | What consumer projects run after `npm i -g @deftai/directive` |
| Git-hook entrypoints | `.githooks/_deft-run.sh` → `deft` / native CLI verbs (`verify:branch`, `verify:encoding`, `preflight-gh`, ...) | What tracked `.githooks/` invoke |
| Host integrations | `deft-hook` | Agent-host hook runtime; not the Git-hook resolver |

The command graph is broad; use `task --list` for the exact current surface. The important architectural groups are:

- `task check`, `task check:framework-source`, `task check:consumer`, `task check:slow` for quality gates.
- `task verify:*` for branch, hooks, encoding, xBRIEF conformance, session ritual, story readiness, capacity, cache freshness, and investigation gates.
- `task vbrief:validate`, `task xbrief:preflight` (prefer; `vbrief:preflight` remains as alias), `task spec:*`, `task project:*`, `task roadmap:*`, and `task prd:*` for source validation and generated views.
- `task scope:*` and `task scope:undo:*` for lifecycle movement.
- `task triage:*` and `task cache:*` for cache-backed backlog work.
- `task codebase:*` for authored `codeStructure` validation, default extraction, provider-map validation, MAP generation, and projection registry lookup.
- `task packs:*` for content-pack rendering and drift checks.
- `task pr:*`, `task release:*`, and `task swarm:*` for PR readiness, release operations, and multi-agent orchestration.
- `task policy:*`, `task capacity:*`, and `task scm:*` for project policy, work allocation, and SCM helpers.

New deterministic automation should enter through Taskfile in this checkout, or through `deft` / `directive` in a consumer install. Tracked Git hooks invoke native CLI verbs through `.githooks/_deft-run.sh` (the `deft` resolver), not `deft-hook` and not Python launchers. `deft-hook` is the agent-host integration binary.

## Session Ritual And Gate Stack

Interactive sessions start with a quick ritual and become eligible for implementation only after the gated verifier records the heavier checks. The same state then feeds the story and implementation gates.

```mermaid
flowchart TD
    Start["Interactive session starts"] --> Read["Read AGENTS.md, USER.md, PROJECT-DEFINITION"]
    Read --> Confirm["Confirm Deft alignment and addressing name"]
    Confirm --> Quick["task session:start<br/>quick tier"]
    Quick --> State[".deft/ritual-state.json<br/>worktree, HEAD, freshness window"]
    State --> Intent["Implementation intent or start_agent dispatch?"]
    Intent --> Gated["task verify:session-ritual -- --tier=gated"]
    Gated --> Story["task verify:story-ready<br/>active scope and clean/allowed tree"]
    Story --> Preflight["task xbrief:preflight<br/>active + running"]
    Preflight --> Cache["task verify:cache-fresh"]
    Cache --> Branch["task verify:branch"]
    Branch --> Work["Implement or dispatch agent"]
```

The ordering is architectural, not ceremony. Each gate can assume the previous one already proved its part of the state: session freshness, scope readiness, implementation intent, cache freshness, and branch policy.

## Lifecycle State

Work moves through xBRIEF lifecycle folders:

- `xbrief/proposed/` -- candidate work.
- `xbrief/pending/` -- accepted backlog.
- `xbrief/active/` -- running work.
- `xbrief/completed/` -- completed work.
- `xbrief/cancelled/` -- rejected or abandoned work.

The folder and `plan.status` must agree. The scope tasks update both together. `task verify:story-ready` and `task xbrief:preflight` are the implementation-intent gates for active work.

```mermaid
flowchart LR
    Proposed["proposed<br/>candidate"] -->|"task scope:promote"| Pending["pending<br/>accepted backlog"]
    Pending -->|"task scope:activate"| Active["active<br/>running"]
    Active -->|"task scope:complete"| Completed["completed<br/>done"]
    Proposed -->|"task scope:cancel"| Cancelled["cancelled<br/>rejected"]
    Pending -->|"task scope:cancel"| Cancelled
    Active -->|"task scope:fail or cancel"| Cancelled
    Completed -.->|"task scope:restore"| Pending
```

## Triage And Cache

Deft's backlog workflow is cache-backed:

- `.deft-cache/` stores fetched external content.
- `<lifecycle-root>/.triage-cache/` (e.g. `xbrief/.triage-cache/`) stores triage decisions and audit records; `<lifecycle-root>/.eval/results/` stores framework-eval ledgers (#1703).
- `task triage:bootstrap` seeds the local cache and audit layer.
- `task triage:queue`, `task triage:accept`, `task triage:reject`, `task triage:defer`, and related verbs turn external issues into auditable scope decisions.

Agents should not choose backlog work from memory when the cache workflow applies. They should consult the cache/task surface first.

```mermaid
flowchart TD
    GH["External backlog<br/>GitHub issues"] --> Fetch["task triage:bootstrap<br/>task cache:fetch-all"]
    Fetch --> Cache[".deft-cache/<source>/<key>"]
    Cache --> Queue["task triage:queue<br/>ranked candidates"]
    Queue --> Decision{"Operator or agent decision"}
    Decision -->|"accept"| Scope["task triage:accept<br/>proposed scope xBRIEF"]
    Decision -->|"reject/defer/needs-ac"| Audit["xbrief/.eval<br/>decision audit"]
    Scope --> Audit
```

## Codebase Architecture Metadata

`xbrief/PROJECT-DEFINITION.xbrief.json` contains `plan.architecture.codeStructure`, the authored codebase-structure profile. That profile is the durable source of truth for intended module boundaries.

Implemented today:

- `task codebase:validate-structure`
- `task codebase:extract-default`
- `task codebase:provider-map`
- `task codebase:map`
- `task codebase:projection-registry`
- `task verify:codebase-map-fresh`
- Consumer-facing MAP guidance in `AGENTS.md`, `templates/agents-entry.md`,
  and the build/sync/pre-pr skills.

Not implemented yet:

- Generated source headers
- Local indexes or mandatory consumer hard-gates for MAP consumption

The generated MAP is a projection. It must not become the canonical architecture source.

## Generated And Historical Artifacts

- `SPECIFICATION.md`, `PRD.md`, and `ROADMAP.md` are generated views.
- `.planning/codebase/MAP.md` is a generated codebase orientation projection.
- `.planning/codebase/ARCHITECTURE.md`, `CONVENTIONS.md`, and related files are historical planning notes unless they carry a generated-source banner.
- `PROJECT.md` is a deprecated redirect; current project identity lives in `xbrief/PROJECT-DEFINITION.xbrief.json`.

When in doubt, prefer the xBRIEF source and the Taskfile gate over a prose file.
