# Directive

Directive keeps AI coding agents honest in your repository. It gives your agent standards to follow, saves what you plan to build as files in the repo, and checks risky actions (for example, editing code with no planned scope) through hooks in your agent host. It works with Claude Code, Cursor, Codex and Grok.

Directive is a practice layer for a repo, not a coding host or an app builder. Deft is the company; Directive is the product.

**Stuck?** [Support hub](./content/docs/SUPPORT.md). **First project:** [getting-started](./content/docs/getting-started.md). **Known limits:** [known-limitations](./content/docs/known-limitations.md).

## The two packages

- **`@deftai/directive`** gives you the `directive` command (also `deft`). Install it once per machine.
- **`@deftai/directive-runtime`** is the exact Directive version your project uses. Your project's `package.json` pins it, and it installs into `node_modules` like any other dependency.

The `directive` command finds your project's pinned runtime and runs it, so every project uses its own version. More: [launcher.md](./content/docs/launcher.md).

## 🚀 Getting Started

### Install

You need Node ≥ 20 (22 and 24 are tested; 20 works with a warning), Git, and npm or pnpm. Most workflows also use the GitHub CLI (`gh`).

```bash
npm i -g @deftai/directive        # once per machine
cd your-project                   # a Git repository
directive install                 # pins the runtime and sets up the project
directive doctor                  # checks the install
directive toolchain:check --consumer
```

With pnpm, use `pnpm add -g @deftai/directive` and make sure `PNPM_HOME` is on your `PATH` (`pnpm setup`).

**Tracked vs ignored:** the exact `@deftai/directive-runtime` pin and Directive's wiring files are committed; `node_modules` and the per-checkout `.deft/directive/wiring-ready.*.json` files are ignored. There is no copied `.deft/core/` content.

### Windows

The same two steps: `npm i -g @deftai/directive`, then `directive …`.

- If PowerShell refuses to run npm's own script, use `npm.cmd i -g @deftai/directive`.
- Directive tries to remove its own `.ps1` shims when it installs. If PowerShell still refuses `directive`, type `directive.cmd`. It is the same command.

### Everyday commands

| Situation | Command | Result |
| --- | --- | --- |
| New project | `directive install` | Pins the runtime and sets up hooks, skills and `AGENTS.md` |
| After clone, pull or a new worktree | `npm install`, or `pnpm install --frozen-lockfile` for pnpm | Installs the pinned runtime; the first Directive command or hook finishes local setup |
| Move to a new version, or migrate project data | `npm i -g @deftai/directive@latest`, then `directive upgrade` | Updates the pin and converts project data |
| Wiring damaged (hooks, skills), right runtime installed | `directive install --repair` | Restores Directive's wiring; never changes the version |
| `directive` command missing | `npm i -g @deftai/directive` | Installs the command |
| Remove Directive from a project | `directive uninstall` | Removes the runtime and wiring; keeps your `xbrief/` data and settings |
| Not sure | `directive doctor` | Read-only check; names one next command |

Projects on the older Directive layout (pre-split pin plus a copied `.deft/core`) keep working with their own installed copy; run `directive upgrade` when you want to convert. See [UPGRADING.md](./content/UPGRADING.md). **Agents:** ! Read UPGRADING on the first session after a framework update.

CI and agent images: `directive install --yes` for a new project, or `directive install --repair --yes` with a valid pin. Corporate mirror or offline: see [UPGRADING.md](./content/UPGRADING.md#corporate-or-mirrored-npm-registry).

> **📦 Existing project?** Adding Directive to a project with pre-v0.20 `SPECIFICATION.md` / `PROJECT.md`: see [docs/BROWNFIELD.md](./content/docs/BROWNFIELD.md) and UPGRADING.md § Frozen pre-v0.20 document-model migration (#2068).

## Work with your agent

### Set Up Your Preferences

Tell your agent `read AGENTS.md and follow it`. The setup skill asks one question at a time and writes `USER.md` and `xbrief/PROJECT-DEFINITION.xbrief.json`. `USER.md` lives outside the repo: `~/.config/deft/USER.md` on Unix / macOS, `%APPDATA%\deft\USER.md` on Windows (override: `DEFT_USER_PATH`). Agents without a setup flow can start from [QUICK-START.md](./content/QUICK-START.md).

### Generate a Scope xBRIEF

The same setup flow then interviews you about what to build and writes a **scope xBRIEF** to `xbrief/proposed/`. `xbrief/*.xbrief.json` files are the source of truth; `.md` files (`PRD.md`, `SPECIFICATION.md`, `ROADMAP.md`) are a rendered view generated on demand via `task *:render`. Edits to the rendered `.md` files are overwritten on the next render, so edit the `.xbrief.json` instead.

### Build With AI

```
Read xbrief/PROJECT-DEFINITION.xbrief.json and the scope xBRIEFs in
xbrief/active/ (or xbrief/pending/ if none are active yet) and implement
the project following node_modules/@deftai/directive-runtime/main.md.
```

## Getting help

- [Support hub](./content/docs/SUPPORT.md): symptoms mapped to `directive doctor --full`
- [First-project tutorial](./content/docs/getting-started.md)
- [Known limitations](./content/docs/known-limitations.md) and [UPGRADING.md](./content/UPGRADING.md)
- [Training course](https://github.com/deftai/directive-training)

## Advanced

- Capabilities: [capabilities.md](./content/docs/capabilities.md). Category map: [docs/CATEGORY.md](./docs/CATEGORY.md). Vocabulary: [glossary.md](./content/glossary.md).
- Framework maintainers (this repository): [CONTRIBUTING.md](./CONTRIBUTING.md) and [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md). Install design history: [`docs/installer-refactor-ovpr/`](./docs/installer-refactor-ovpr/).
- Content packs: `task packs:slice -- --list-packs`. Full agent guidelines: [main.md](./main.md).

**Notation:** **!** = MUST · **~** = SHOULD · **≉** = SHOULD NOT · **⊗** = MUST NOT · **?** = MAY

#### Legacy Go installer — RETIRED (#1912 / AC10.10)

The Go installer (`cmd/deft-install/`, platform `install-*` binaries) is deleted. Do not download or run it. Install and upgrade use npm or pnpm only (above).

### Rule Hierarchy

Rules cascade with precedence (highest first):

1. **USER.md** — your personal overrides
2. **xbrief/PROJECT-DEFINITION.xbrief.json** — project rules and identity
3. **Language files** (`languages/python.md`, `languages/go.md`, ...)
4. **Tool files** (`tools/taskfile.md`, ...)
5. **main.md** — general AI behavior

Project **requirements** (`xbrief/specification.xbrief.json` plus scope xBRIEFs in `xbrief/{proposed,pending,active,completed,cancelled}/`) say **what to build** and sit on a separate ladder from these rules. `ROADMAP.md` is the rendered backlog view.

### 🌲 Branch policy

Directive blocks direct commits to `master`/`main` by default (#746, #747), and CI refuses PRs whose `head_ref` equals `base_ref`. A typed flag in `xbrief/PROJECT-DEFINITION.xbrief.json` controls it:

```json
{
  "plan": {
    "policy": { "allowDirectCommitsToMaster": false }
  }
}
```

Enforced by Git hooks (`.githooks/pre-commit`, `.githooks/pre-push`; activate with `task setup`, check with `task verify:hooks-installed`), by `task verify:branch` in `task check`, and by `.github/workflows/branch-gate.yml`.

Change it with audited tasks (logged to `meta/policy-changes.log`): `task policy:show`, `task policy:enforce-branches`, `task policy:allow-direct-commits -- --confirm`.

Emergency bypass: set `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1` for the current shell.

**GitHub** is the main supported SCM; core features work without it. **vBRIEF** is the legacy name for xBRIEF: see [UPGRADING.md — xBRIEF rename](./content/UPGRADING.md#xbrief-rename-2034--2110--2907).

## If tools won't run (for agents)

<!-- deft:cold-start-bootstrap v2 (#5490 / AC13.8) -->
> **New clone, or `directive` / `deft` won't run?** The version that counts is the exact `@deftai/directive-runtime` pin in the project's `package.json`. Doctor exit 0 is not skip for bootstrap.
>
> 1. **Launcher on PATH?** Run `directive --version` / `deft --version`. If missing: `npm i -g @deftai/directive` (or `pnpm add -g @deftai/directive`, with `PNPM_HOME` on `PATH` via `pnpm setup`).
> 2. **New project (no runtime pin):** `directive install` pins `@deftai/directive-runtime` and runs setup.
> 3. **Clone / pull / new worktree, or runtime not the pinned version:** a person runs `npm install` (or `pnpm install --frozen-lockfile`); the first eligible runtime command or registered hook then completes local setup.
> 4. **Wiring damaged, right runtime installed:** `directive install --repair`.
> 5. **Move version / migrate data, or an older layout:** `directive upgrade`.
> 6. **Not sure:** `directive doctor` (read-only). CI / swarm: `directive install --repair --yes` with a valid pin.
> 7. **Corporate mirror / offline:** see [UPGRADING.md](./content/UPGRADING.md#corporate-or-mirrored-npm-registry).
> 8. **Codex ritual git:** approve outside-sandbox / `Environment: local` ritual `git` once per session (or via `/approvals` workspace trust — not repeated per-verb). Do not invent an in-process git substitute. Symptom: `spawnSync git EPERM`.
> 9. **Abandoned occupancy lease.** Only the session that owns a lease releases it, live or quiet (`occupancy:release` / `session:end` with its own session id). A release by another session is refused and leaves the lease in place. Never copy a lease's `session_id` into a release command. A quiet (heartbeat-stale or age-capped) lease blocks no write, and the next `session:start` may claim over it after the TTL, subject to the existing claim rules. Do not invent a new unlock verb (#3954 / #4667 / #6679).
>
> Never use `npx` / `pnpm exec` as day-to-day identity. There is no copied `.deft/core/` content — pointers resolve under `node_modules/@deftai/directive-runtime/`. Once `directive` runs, continue with `AGENTS.md`.
<!-- /deft:cold-start-bootstrap v2 -->

---

Copyright © 2025-2026 Jonathan "visionik" Taylor — https://deft.md
License: [MIT](./LICENSE)
