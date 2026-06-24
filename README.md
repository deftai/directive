# Deft

**One-shot, anti-slop**

*A layered framework for AI-assisted development with consistent standards and workflows.*

## 📝 Notation Legend

Deft uses compact RFC 2119-based notation for requirements. You will see these markers throughout `main.md`, language standards, skills, and the docs below:

- **!** = MUST (required, mandatory)
- **~** = SHOULD (recommended, strong preference)
- **≉** = SHOULD NOT (discouraged, avoid unless justified)
- **⊗** = MUST NOT (forbidden, never do this)

## TL;DR

Deft is a **layered set of standards files plus deterministic `task` tooling** that makes AI-assisted coding significantly more effective. Instead of repeating the same instructions in every AI session, you define your preferences once — from general coding style to project-specific rules — and AI agents follow them. The result: higher-quality code, reproducible workflows, and AI that gets better over time by learning from your patterns.

**Key benefits:** No more "AI forgot my preferences", no more inconsistent code style across AI sessions, no more re-explaining your stack every time.

**Don't have preferences yet?** Deft ships with professional-grade defaults for Python, Go, TypeScript, C++, and common workflows. Use it out of the box and customize later.

**Context-efficient:** Deft keeps AI context windows lean through the [Notation Legend](#-notation-legend) above and lazy-loading — agents only read the files relevant to the current task, not everything at once.

**📍 Roadmap:** See [ROADMAP.md](./ROADMAP.md) for the development timeline, open issues, and planned work.

## Deft & Directive (naming)

**Deft is the company; Directive is the product.** In docs and on npm, *Deft* names the organization and the on-disk footprint (`.deft/`, `@deftai/*` scope, `deft.md`). *Directive* names the framework you install and run — the published npm package is `@deftai/directive`, and the primary CLI command is `directive` (`deft` is retained as an alias). Existing `deft-install` / `deft` wording in older paths refers to the same product during the staged transition to the npm-first channel ([#423](https://github.com/deftai/directive/issues/423), [#11](https://github.com/deftai/directive/issues/11)).

## 🚀 Getting Started

### 1. Install Directive

Install Directive globally with npm (Node ≥ 20 required):

```bash
npm i -g @deftai/directive
```

Run `directive` (or the `deft` alias) from any project directory — for example `directive doctor`, `directive session:start`, or `npx @deftai/directive <verb>` without a global install.

**Where your project lands:** the global install above is location-independent, but project **setup** writes `.deft/` and your project's `AGENTS.md` into the **current working directory**. Before you run setup (or ask your agent to set the project up), `cd` into the folder you want the project to live in — create it first if it doesn't exist yet.

**Node runtime (required):** Live deft gates run through the TypeScript engine. Install **Node 20+** (see `.nvmrc` in the framework payload) and **pnpm** (`corepack enable && corepack prepare pnpm@latest --activate`). Run `task toolchain:check` to confirm Node, pnpm, Python (`uv`), git, and gh are on PATH. See [UPGRADING.md § Node runtime](./content/UPGRADING.md#node-runtime-1828--1530) for details.

> **🔄 Upgrading?** Run `npm i -g @deftai/directive@latest`. Read [UPGRADING.md](./content/UPGRADING.md) before proceeding if coming from a Go-installer install. **Agents:** ! Read [UPGRADING.md](./content/UPGRADING.md) on the first session after a framework update.

> **📦 Brownfield adoption:** Adding Deft to an existing project with pre-v0.20 `SPECIFICATION.md` / `PROJECT.md`? See [docs/BROWNFIELD.md](./content/docs/BROWNFIELD.md) for the migration path (`task migrate:vbrief`) and what to expect.

> **📢 Cloned manually (no installer)?** Tell your agent: `Read deft/QUICK-START.md and follow it.` It creates your project's `AGENTS.md` and starts the setup flow automatically.

#### Legacy and offline install (Go installer, #1912)

> **Node is always required to *run* Deft.** Its live gates run through the TypeScript engine, so there is no Node-free way to actually use the framework — the Go installer only deposits files on disk. On a machine without Node, install **Node 20+** first (via [nvm](https://github.com/nvm-sh/nvm), your OS package manager, or [nodejs.org](https://nodejs.org/)), then run the `npm i -g @deftai/directive` command above.

The Go installer is a **legacy bridge**, not the first-start installer — npm is canonical (above). Reach for it only when npm isn't an option: an **offline / air-gapped** deposit, or **migrating an existing old on-disk layout** (git-clone / submodule / legacy `deft/`-prefixed install) to the canonical `.deft/core/` layout so the npm path can take over. The final Go installer release will be frozen as the permanent stage-1 bridge (#1912).

> **⬇️ Legacy binaries** — from the [latest GitHub Release](https://github.com/deftai/directive/releases/latest):
> - **Windows:** [`install-windows-amd64.exe`](https://github.com/deftai/directive/releases/latest/download/install-windows-amd64.exe) | [`install-windows-arm64.exe`](https://github.com/deftai/directive/releases/latest/download/install-windows-arm64.exe) (Surface / Copilot+ PCs)
> - **macOS:** [`install-macos-universal`](https://github.com/deftai/directive/releases/latest/download/install-macos-universal) (Intel + Apple Silicon)
> - **Linux:** [`install-linux-amd64`](https://github.com/deftai/directive/releases/latest/download/install-linux-amd64) | [`install-linux-arm64`](https://github.com/deftai/directive/releases/latest/download/install-linux-arm64) (Raspberry Pi / ARM)

**Windows:**
- Download `install-windows-amd64.exe` (or `install-windows-arm64.exe` for Surface / Copilot+ PCs)
- Run it — Windows SmartScreen may warn about an unrecognised publisher; click "More info" then "Run anyway"

**macOS:**
- Download `install-macos-universal` (works on all Macs — Intel and Apple Silicon)
- Make it executable and run:
  ```bash
  chmod +x install-macos-universal && ./install-macos-universal
  ```
- If macOS Gatekeeper blocks the file: right-click then Open, or remove the quarantine attribute:
  ```bash
  xattr -d com.apple.quarantine install-macos-universal
  ```

**Linux:**
- Download `install-linux-amd64` (or `install-linux-arm64` for Raspberry Pi / ARM cloud)
- Make it executable and run:
  ```bash
  chmod +x install-linux-amd64 && ./install-linux-amd64
  ```

The legacy Go installer deposits a tarball payload into `.deft/core/` on disk. For normal installs, use npm (`npm i -g @deftai/directive`) and then `directive init` in your project — init resolves the locally installed `@deftai/directive-content` package and copies it into gitignored `.deft/core/`, renders `AGENTS.md`, scaffolds `vbrief/`, and creates your user config directory.

#### Agent / headless install

Asked to **"install Deft into this directory"** — for example by an AI agent or a CI job? Use npm:

```bash
npm i -g @deftai/directive
```

Node 20+ is required to run Deft (see the note above). For **offline / air-gapped** deposits or **migrating a legacy on-disk layout**, the Go-installer binaries remain available from [GitHub Releases](https://github.com/deftai/directive/releases/latest) (see the [Legacy and offline install](#legacy-and-offline-install-go-installer-1912) section above) — Node is still required to run the framework afterward.

**Building from source (developers only):** requires Go 1.22+

```bash
go run ./cmd/deft-install/
```

Framework maintainers working in a clone of `deftai/directive` should use the
maintainer installer mode when bootstrapping tools from a published binary:

```bash
deft-install --yes --upgrade --maintainer --repo-root /path/to/directive --json
```

This mode checks maintainer tooling without projecting consumer-managed files
such as `AGENTS.md`, `.gitignore`, `.gitattributes`, guard workflows, or
consumer `vbrief/` scaffolding into the framework repository. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md) for maintainer setup details.

### 2. Set Up Your Preferences

Deft offers two setup paths that produce the same output (`USER.md` + `vbrief/PROJECT-DEFINITION.vbrief.json`) but adapt to different users:

- **Agent-driven** (recommended for most users) — Tell your agent `read AGENTS.md and follow it` to start the Deft setup flow. The agent will ask how technical you are and adapt accordingly.
- **CLI** (for technical users) — `.deft/core/run bootstrap` runs an interactive setup for `USER.md` and `vbrief/PROJECT-DEFINITION.vbrief.json`.

**User config location:**

- Unix / macOS: `~/.config/deft/USER.md`
- Windows: `%APPDATA%\deft\USER.md`
- Override: set `DEFT_USER_PATH` environment variable

### 3. Generate a Scope vBRIEF

`.deft/core/run bootstrap` can chain into the scope-vBRIEF interview, or you can create one anytime:

```bash
.deft/core/run spec            # AI-assisted interview -> vbrief/proposed/YYYY-MM-DD-<slug>.vbrief.json
```

The interview writes a **scope vBRIEF** to `vbrief/proposed/`. `vbrief/*.vbrief.json` files are the source of truth; `.md` files (`PRD.md`, `SPECIFICATION.md`, `ROADMAP.md`) are rendered views generated on demand via `task *:render`. Direct edits to the rendered `.md` files are overwritten on the next render — edit the underlying `.vbrief.json` instead.

Other commands:

```bash
.deft/core/run reset           # Reset config files
.deft/core/run validate        # Check deft configuration
.deft/core/run doctor          # Check system dependencies
.deft/core/run upgrade         # Record the current framework version after updating deft
```

### 4. Build With AI

Ask your AI to build the product/project from your scope vBRIEFs and away you go:

```
Read vbrief/PROJECT-DEFINITION.vbrief.json and the scope vBRIEFs in
vbrief/active/ (or vbrief/pending/ if none are active yet) and implement
the project following deft/main.md standards.
```

### 5. Backlog triage (working an existing backlog)

Already have a populated backlog — an existing project, a brownfield migration, or an upstream issue tracker that has been accumulating? Trigger the refinement workflow's pre-ingest **Phase 0 action menu** with words like **"triage"**, **"work the cache"**, or **"pre-ingest"**. The agent walks each cached candidate through the menu (`accept | reject | defer | needs-ac | mark-duplicate`) and only **accepted** items land in `vbrief/proposed/` — rejected and deferred items are recorded in the audit log without polluting the backlog.

First populate is scoped via flags so the upstream rate limit does not bite:

```bash
task triage:bootstrap -- --limit 50 --state open
```

Why scoped flags? An unbounded populate against a real-sized backlog can drain the shared GitHub GraphQL bucket (see [#976](https://github.com/deftai/directive/issues/976)); the `--limit` / `--state` / `--batch-size` / `--delay-ms` surface keeps the populate inside the REST budget with batched delays. The cache (`task cache:fetch-all`) is REST-backed and reproducible across re-runs — no live `gh issue view` per decision.

Full walkthrough — including the three-tier model (cache → audit log → accepted backlog), the action menu, and how to re-enter triage on subsequent passes — lives in [`docs/getting-started.md` § Working an existing backlog](./content/docs/getting-started.md#working-an-existing-backlog). The verb-to-outcome reference for every `task triage:*` and `task cache:*` command is in [`commands.md`](./content/commands.md#backlog-triage--cache-tasks).

### 6. Feature slicing (breaking a plan into parallel-grabbable issues)

When a spec, PRD, or plan is ready to hand off — especially to multiple agents or collaborators working in parallel — slice it into **tracer-bullet vertical slices**. Trigger the workflow with words like **"slice this into tickets"** or **"break this into GitHub issues"** (the [`deft-directive-gh-slice`](./content/skills/deft-directive-gh-slice/SKILL.md) skill).

- **Vertical, not horizontal** — each slice cuts a narrow but *complete* path through every layer (schema → API → UI → tests) so it is independently demoable. "Implement all the data models" is a horizontal slice and an anti-pattern.
- **AFK vs HITL** — each slice is tagged AFK (mergeable with no human interaction — preferred) or HITL (needs a decision/review first), and declares what blocks it so issues are filed in dependency order.
- **Durable cohorts** — when a plan slices into an umbrella + child issues, the cohort is recorded in `vbrief/.eval/slices.jsonl` (tracked in git, with per-child wave numbers). This lets `task triage:audit --orphans | --slice-stalled | --slice-coverage` detect children stranded when an umbrella closes early, stalled siblings, and per-umbrella completion. Hand-filed cohorts are backfilled with `task slice:record-existing`; list recorded cohorts with `task slice:list`.

Slices become GitHub issues, which triage into vBRIEFs, which flow through the `proposed/ → pending/ → active/ → completed/` lifecycle and can be allocated to parallel agents (the [`deft-directive-swarm`](./content/skills/deft-directive-swarm/SKILL.md) skill). Architectural refactors follow the same slicing path via [`deft-directive-gh-arch`](./content/skills/deft-directive-gh-arch/SKILL.md).

## 🪜 Layered Architecture (at a glance)

Deft separates **how the AI behaves** (the rule ladder) from **what to build** (project requirements). Both are summarised here; the full diagram and rationale live in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

### Rule Hierarchy

Rules cascade with precedence (highest first). This is the **how-the-AI-behaves** ladder:

1. **USER.md** (highest) — your personal overrides (`~/.config/deft/USER.md` on Unix/macOS, `%APPDATA%\deft\USER.md` on Windows)
2. **vbrief/PROJECT-DEFINITION.vbrief.json** — project-specific rules and identity gestalt
3. **Language files** (`languages/python.md`, `languages/go.md`, ...) — language standards
4. **Tool files** (`tools/taskfile.md`, ...) — tool guidelines
5. **main.md** (lowest) — general AI behavior

Note: project **requirements** (`vbrief/specification.vbrief.json` + scope vBRIEFs in `vbrief/{proposed,pending,active,completed,cancelled}/`) describe **what to build** and are deliberately kept on a separate ladder from the rule cascade above. `ROADMAP.md` is the rendered backlog view of those requirements.

## 🌲 Branch policy

Deft enforces a feature-branch policy by default (#746, #747): direct commits to `master`/`main` are blocked and PRs whose `head_ref` equals `base_ref` are refused at the CI gate. The policy is governed by a typed flag on `vbrief/PROJECT-DEFINITION.vbrief.json`:

```json
{
  "plan": {
    "policy": { "allowDirectCommitsToMaster": false }
  }
}
```

Three enforcement surfaces back the rule:

1. **Git hooks** — `.githooks/pre-commit` and `.githooks/pre-push` invoke `scripts/preflight_branch.py`. Activate them with `task setup` (idempotent `git config core.hooksPath .githooks`); verify with `task verify:hooks-installed`.
2. **Pre-commit gate** — `task verify:branch` is wired into the `task check` aggregate so any local pre-commit pass flags a default-branch commit before it lands.
3. **CI** — `.github/workflows/branch-gate.yml` refuses PRs whose `head_ref` equals `base_ref` (catches `master->master` PRs that the local hooks cannot see).

Reconfigure via deterministic tasks (audited to `meta/policy-changes.log`):

- `task policy:show` — display the resolved policy and its source.
- `task policy:enforce-branches` — set `allowDirectCommitsToMaster=false`.
- `task policy:allow-direct-commits -- --confirm` — set the typed flag to `true` after the capability-cost disclosure (branch-protection turns OFF). The deft-directive-setup interview Phase 2 Step 9 elicits the same choice with the same disclosure.

Emergency bypass: set `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1` for the current shell. The legacy `Allow direct commits to master:` narrative key is recognised at read time with a deprecation warning and is migrated to the typed surface on the next `task policy:*` write.

See [`glossary.md`](./content/glossary.md) (Branch-protection policy / Policy audit log entries) for the canonical vocabulary and `skills/deft-directive-setup/SKILL.md` Phase 2 Step 9 for the interview disclosure copy.

## 🔒 Security

Security posture, audit cadence, and vulnerability-reporting flow live in [`docs/security.md`](./docs/security.md). The 2026-05-12 supply-chain hygiene cohort (#1069) recorded the inaugural baseline; future quarterly + event-driven audits append new sections rather than rewrite history. To report a vulnerability, file a private advisory at <https://github.com/deftai/directive/security/advisories/new>.

## ⚙️ Platform Requirements

**GitHub** is the primary supported SCM platform. Skills that interact with issues and PRs (`deft-directive-sync`, `deft-directive-swarm`, `deft-directive-review-cycle`, `deft-directive-refinement`, `deft-directive-release`, `deft-directive-gh-slice`, `deft-directive-gh-arch`) require the [GitHub CLI (`gh`)](https://cli.github.com/) to be installed and authenticated. Core framework features (setup, build, rendering, validation) work independently of any SCM platform.

The migration script (`task migrate:vbrief`) defaults origin provenance to `x-vbrief/github-issue` type. Non-GitHub users should manually adjust `references[].type` in generated vBRIEFs after migration.

## 📦 Content packs

Deft ships versioned **content packs** — structured JSON projections of the framework's own corpus (lessons, skills, rules, strategies, patterns, the swarm spec). They let an agent pull just the slice it needs into context instead of reading a whole `.md` file, and they keep the rendered `.md` files drift-checked against a single canonical source.

```bash
task packs:slice -- --list-packs          # discover packs (name, version, one-line description)
task packs:slice lessons -- --list        # list the named slices a pack exposes
task packs:slice lessons by-tag -- --tag testing   # load just that slice (add --json for structured output)
```

Slices are addressed by a **stable, versioned slice name** (e.g. `recent`, `by-tag`, `by-trigger`, `by-tier`) — never a JSONPath — and read the canonical pack source directly, so a slice never drifts from what an agent sees. New packs and slices appear automatically in `--list-packs` / `--list` with no rewiring. See [`strategies/README.md`](./content/strategies/README.md) and the pack sources under `packs/` for details.

## 📚 Learn More

- **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** — Current Taskfile-first architecture, rule authority, vBRIEF state, installer layout, and codeStructure projection boundary
- **[docs/CONCEPTS.md](./docs/CONCEPTS.md)** — Current operating concepts: vBRIEF source of truth, deterministic gates, cache-backed triage, lifecycle folders, and projections
- **[docs/FILES.md](./docs/FILES.md)** — Current directory tree, task includes, skills, vBRIEF state, and consumer artifact locations
- **[docs/RELEASING.md](./docs/RELEASING.md)** — Release & smoke-test workflow
- **[docs/BROWNFIELD.md](./content/docs/BROWNFIELD.md)** — Brownfield adoption (pre-v0.20 → vBRIEF migration)
- **[docs/security.md](./docs/security.md)** — Security posture, audit baseline, cadence, vulnerability-reporting flow
- **[main.md](./main.md)** — Comprehensive AI guidelines (general behavior layer)
- **[commands.md](./content/commands.md)** — Taskfile-first command lifecycle with compatibility `run` surfaces
- **[glossary.md](./content/glossary.md)** — Canonical v0.20 vocabulary

## 🎓 Philosophy

Deft embodies:

- **Correctness over convenience** — Optimize for long-term quality
- **Standards over flexibility** — Consistent patterns across projects
- **Evolution over perfection** — Continuously improve through learning
- **Clarity over cleverness** — Direct, explicit, maintainable code

---

**Next Steps**: Read [main.md](./main.md) for comprehensive AI guidelines, then run `npm i -g @deftai/directive` (Node ≥ 20) to get started.

---

Copyright © 2025-2026 Jonathan "visionik" Taylor — https://deft.md
Licensed under the [MIT License](./content/LICENSE.md)
