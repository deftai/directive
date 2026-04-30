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

## 🚀 Getting Started

Download the installer for your platform from [GitHub Releases](https://github.com/deftai/directive/releases), run it, and follow the prompts.

> **⬇️ Quick Download** — direct binaries from the [latest GitHub Release](https://github.com/deftai/directive/releases/latest):
> - **Windows:** [`install-windows-amd64.exe`](https://github.com/deftai/directive/releases/latest/download/install-windows-amd64.exe) | [`install-windows-arm64.exe`](https://github.com/deftai/directive/releases/latest/download/install-windows-arm64.exe) (Surface / Copilot+ PCs)
> - **macOS:** [`install-macos-universal`](https://github.com/deftai/directive/releases/latest/download/install-macos-universal) (Intel + Apple Silicon)
> - **Linux:** [`install-linux-amd64`](https://github.com/deftai/directive/releases/latest/download/install-linux-amd64) | [`install-linux-arm64`](https://github.com/deftai/directive/releases/latest/download/install-linux-arm64) (Raspberry Pi / ARM)

> **📢 Cloned manually (no installer)?** Tell your agent: `Read deft/QUICK-START.md and follow it.` It creates your project's `AGENTS.md` and starts the setup flow automatically.

> **🔄 Upgrading from a previous version?** Read [UPGRADING.md](./UPGRADING.md) before proceeding. **Agents:** ! Read [UPGRADING.md](./UPGRADING.md) on the first session after a framework update.

> **📦 Brownfield adoption:** Adding Deft to an existing project with pre-v0.20 `SPECIFICATION.md` / `PROJECT.md`? See [docs/BROWNFIELD.md](./docs/BROWNFIELD.md) for the migration path (`task migrate:vbrief`) and what to expect.

### 1. Install Deft

**Windows:**
- Download `install-windows-amd64.exe` (or `install-windows-arm64.exe` for Surface / Copilot+ PCs)
- Run it — Windows SmartScreen may warn about an unrecognised publisher; click "More info" then "Run anyway" (code signing is planned for a future release)

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

The installer guides you through choosing a project directory, installs git if needed, clones deft, wires it into your project's `AGENTS.md`, and creates your user config directory.

**Building from source (developers only):** requires Go 1.22+

```bash
go run ./cmd/deft-install/
```

### 2. Set Up Your Preferences

Deft offers two setup paths that produce the same output (`USER.md` + `vbrief/PROJECT-DEFINITION.vbrief.json`) but adapt to different users:

- **Agent-driven** (recommended for most users) — Tell your agent `read AGENTS.md and follow it` to start the Deft setup flow. The agent will ask how technical you are and adapt accordingly.
- **CLI** (for technical users) — `deft/run bootstrap` runs an interactive setup for `USER.md` and `vbrief/PROJECT-DEFINITION.vbrief.json`.

**User config location:**

- Unix / macOS: `~/.config/deft/USER.md`
- Windows: `%APPDATA%\deft\USER.md`
- Override: set `DEFT_USER_PATH` environment variable

### 3. Generate a Scope vBRIEF

`deft/run bootstrap` can chain into the scope-vBRIEF interview, or you can create one anytime:

```bash
deft/run spec            # AI-assisted interview -> vbrief/proposed/YYYY-MM-DD-<slug>.vbrief.json
```

The interview writes a **scope vBRIEF** to `vbrief/proposed/`. `vbrief/*.vbrief.json` files are the source of truth; `.md` files (`PRD.md`, `SPECIFICATION.md`, `ROADMAP.md`) are rendered views generated on demand via `task *:render`. Direct edits to the rendered `.md` files are overwritten on the next render — edit the underlying `.vbrief.json` instead.

Other commands:

```bash
deft/run reset           # Reset config files
deft/run validate        # Check deft configuration
deft/run doctor          # Check system dependencies
deft/run upgrade         # Record the current framework version after updating deft
```

### 4. Build With AI

Ask your AI to build the product/project from your scope vBRIEFs and away you go:

```
Read vbrief/PROJECT-DEFINITION.vbrief.json and the scope vBRIEFs in
vbrief/active/ (or vbrief/pending/ if none are active yet) and implement
the project following deft/main.md standards.
```

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

## ⚙️ Platform Requirements

**GitHub** is the primary supported SCM platform. Skills that interact with issues and PRs (`deft-directive-sync`, `deft-directive-swarm`, `deft-directive-review-cycle`, `deft-directive-refinement`, `deft-directive-release`) require the [GitHub CLI (`gh`)](https://cli.github.com/) to be installed and authenticated. Core framework features (setup, build, rendering, validation) work independently of any SCM platform.

The migration script (`task migrate:vbrief`) defaults origin provenance to `x-vbrief/github-issue` type. Non-GitHub users should manually adjust `references[].type` in generated vBRIEFs after migration.

## 📚 Learn More

- **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** — Layered architecture, rule hierarchy, vBRIEF tooling, mermaid diagrams, `run` vs `task` lifecycle
- **[docs/CONCEPTS.md](./docs/CONCEPTS.md)** — Spec-Driven Development, Test-Driven Development, Convention-Over-Configuration, Safety/Reversibility, example workflows
- **[docs/FILES.md](./docs/FILES.md)** — Directory tree and per-area file index
- **[docs/RELEASING.md](./docs/RELEASING.md)** — Release & smoke-test workflow
- **[docs/BROWNFIELD.md](./docs/BROWNFIELD.md)** — Brownfield adoption (pre-v0.20 → vBRIEF migration)
- **[main.md](./main.md)** — Comprehensive AI guidelines (general behavior layer)
- **[commands.md](./commands.md)** — Full `run` and `task` command reference
- **[glossary.md](./glossary.md)** — Canonical v0.20 vocabulary

## 🎓 Philosophy

Deft embodies:

- **Correctness over convenience** — Optimize for long-term quality
- **Standards over flexibility** — Consistent patterns across projects
- **Evolution over perfection** — Continuously improve through learning
- **Clarity over cleverness** — Direct, explicit, maintainable code

---

**Next Steps**: Read [main.md](./main.md) for comprehensive AI guidelines, then [download the installer](https://github.com/deftai/directive/releases) for your platform to get started.

---

Copyright © 2025-2026 Jonathan "visionik" Taylor — https://deft.md
Licensed under the [MIT License](./LICENSE.md)
