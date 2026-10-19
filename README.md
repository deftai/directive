<!-- deft:cold-start-bootstrap v2 (#5490 / AC13.8) -->
> ## ⚡ Cold-start bootstrap (read this first)
>
> **New clone, or `directive` / `deft` won't run?** Install the global launcher once, then use project install / repair. The version authority is the exact `@deftai/directive-runtime` pin in the project's `package.json`. Doctor exit 0 is not skip for bootstrap.
>
> 1. **Launcher on PATH?** Run `directive --version` / `deft --version`. If missing or broken: `npm i -g @deftai/directive` (or `pnpm add -g @deftai/directive` — ensure `PNPM_HOME` is on `PATH` via `pnpm setup`).
> 2. **New project (no runtime pin):** `directive install` / `directive init` — pins `@deftai/directive-runtime` and runs setup.
> 3. **Clone / pull / new worktree:** `pnpm install` or `npm install`, then the first eligible runtime command or registered host hook completes local activation.
> 4. **Wiring broken; keep the pin:** `npm i -g @deftai/directive`, then `directive install --repair`.
> 5. **Move version / migrate data:** `directive upgrade` (alias `update`).
> 6. **Not sure:** `directive doctor` (read-only). CI / swarm: `directive install --repair --yes` with a valid pin.
> 7. **Corporate mirror / offline:** see [UPGRADING.md](./content/UPGRADING.md#corporate-or-mirrored-npm-registry).
> 8. **Codex ritual git:** approve outside-sandbox / `Environment: local` ritual `git` once per session (or via `/approvals` workspace trust — not repeated per-verb). Do not invent an in-process git substitute. Symptom: `spawnSync git EPERM`.
> 9. **Abandoned occupancy lease.** Only when the lease is abandoned (stale/expired owner, not a live peer session): `occupancy:release --session-id=<id from .deft/occupancy.json>` or wait for TTL claim-over. Do not release another session's live lease. Do not invent a new unlock verb (#3954 / #4667).
>
> Never use `npx` / `pnpm exec` as day-to-day identity. There is no copied `.deft/core/` content — pointers resolve under `node_modules/@deftai/directive-runtime/`. Once `directive` runs, continue with the guidance below and in `AGENTS.md`.
<!-- /deft:cold-start-bootstrap v2 -->

**Stuck?** [Support hub](./content/docs/SUPPORT.md) — symptom index to `directive doctor --full` or this cold-start. **First project:** [getting-started](./content/docs/getting-started.md).

# Deft

**One-shot, anti-slop** — a layered framework for AI-assisted development.

**What it is:** Directive is a **repo practice layer** (standards + durable work state + gates), not a coding host or an app orchestrator. Capability index: [content/docs/capabilities.md](./content/docs/capabilities.md). Category map: [docs/CATEGORY.md](./docs/CATEGORY.md).

Agents Lie, Cheat, and Steal (LCS). Directive is the practice layer that helps prevent that.

**Deft is the company; Directive is the product.** The published package is `@deftai/directive`; `deft` is the CLI alias.

**📚 Public docs:** [https://deftai.github.io/directive/](https://deftai.github.io/directive/) — What, Install, Concepts, Gates, Upgrade, License.

## 📝 Notation Legend

- **!** = MUST · **~** = SHOULD · **≉** = SHOULD NOT · **⊗** = MUST NOT · **?** = MAY

## 🚀 Getting Started

Two packages: global **`@deftai/directive`** (launcher) and project-pinned **`@deftai/directive-runtime`**. Installation management: `install`, `upgrade`, `uninstall`, `doctor` (aliases `init` / `update` / `remove`). Walk the [first-project tutorial](./content/docs/getting-started.md). Launcher details: [launcher.md](./content/docs/launcher.md). Limitations: [known-limitations.md](./content/docs/known-limitations.md).

| Your situation | Run this | What it does |
| --- | --- | --- |
| New project | `directive install` | Exact runtime pin + setup (alias: `init`) |
| Clone / new worktree | `pnpm install` / `npm install`, then any eligible command | Materializes the runtime; first eligible invocation completes local activation |
| Wiring broken; keep pin | `directive install --repair` | Restores pin + owned wiring |
| Move version / migrate data | `directive upgrade` | Alias: `update` |
| Remove project wiring | `directive uninstall` | Alias: `remove`; preserves xbrief/settings/user prose |
| Not sure | `directive doctor` | Read-only diagnosis |
| Supported latest legacy (pre-split + `.deft/core`) | `directive upgrade` | Converts to runtime pin |

### 1. Install and initialize

```bash
npm i -g @deftai/directive
# or: pnpm add -g @deftai/directive
directive install          # alias: directive init
directive doctor
directive toolchain:check --consumer
```

**Node runtime (AC16.2):** Supported (tested as a gate) Node lines are **22 and 24**. Node 20 is best-effort with a warning; Node &lt; 20 is refused. Also need **Git**, **GitHub CLI (`gh`)**, and **npm or pnpm**. Framework maintainers: see [CONTRIBUTING.md](./CONTRIBUTING.md).

**Tracked vs ignored:** the exact `@deftai/directive-runtime` pin and owned wiring are committed; `node_modules` and per-checkout `.deft/directive/wiring-ready.*.json` are ignored. There is no copied `.deft/core/` content.

> **🔄 Upgrading?** `npm i -g @deftai/directive@latest`, then `directive upgrade`. Wiring-only: `directive install --repair`. See [UPGRADING.md](./content/UPGRADING.md). **Agents:** ! Read UPGRADING on the first session after a framework update.

> **📦 Brownfield adoption:** Adding Deft to an existing project with pre-v0.20 `SPECIFICATION.md` / `PROJECT.md`? See [docs/BROWNFIELD.md](./content/docs/BROWNFIELD.md) and UPGRADING.md § Frozen pre-v0.20 document-model migration (#2068).

> **📢 Cloned manually (no installer)?** Tell your agent: `Read deft/QUICK-START.md and follow it.` It creates your project's `AGENTS.md` and starts the setup flow automatically.

#### Legacy Go installer — RETIRED (#1912 / AC10.10)

> **Historical only.** The Go installer (`cmd/deft-install/`, platform `install-*` binaries) is **deleted**. Do not download or run it. Current install/upgrade is npm/pnpm only (above). Supported latest-legacy layouts convert with `directive upgrade`; see [UPGRADING.md](./content/UPGRADING.md).

#### Agent / headless install

```bash
npm i -g @deftai/directive
directive install --yes
```

Supported Node lines are **22 and 24** (Node 20 best-effort). Offline / air-gapped: use your corporate npm mirror for `@deftai/directive` + `@deftai/directive-runtime` (see UPGRADING corporate-registry notes). Do not fall back to deleted Go installer binaries.

#### Framework maintainers (this repository)

Maintainer setup uses the Node/pnpm workspace documented in [CONTRIBUTING.md](./CONTRIBUTING.md). The Go installer path is deleted — do not run `go run ./cmd/deft-install/` or `deft-install`.

### 2. Set Up Your Preferences

Tell your agent `read AGENTS.md and follow it`, or run `directive bootstrap`. Output is `USER.md` + `xbrief/PROJECT-DEFINITION.xbrief.json` + scope xBRIEFs. Unix / macOS: `~/.config/deft/USER.md`. Windows: `%APPDATA%\deft\USER.md`. Override: `DEFT_USER_PATH`. Full walkthrough: [getting-started](./content/docs/getting-started.md).

### 3. Generate a Scope xBRIEF

`directive bootstrap` walks user preferences → project definition → scope interview. The interview writes a **scope xBRIEF** to `xbrief/proposed/`. `xbrief/*.xbrief.json` files are the source of truth; `.md` files (`PRD.md`, `SPECIFICATION.md`, `ROADMAP.md`) are rendered views generated on demand via `task *:render`. Direct edits to the rendered `.md` files are overwritten on the next render — edit the underlying `.xbrief.json` instead.

```bash
directive bootstrap --strategy interview   # Phase 3 — scope xBRIEF interview
directive bootstrap --project              # Phase 2 — project configuration only
directive doctor                           # Check install integrity
directive agents:refresh                   # Refresh AGENTS.md managed section
```

### 4. Build With AI

```
Read xbrief/PROJECT-DEFINITION.xbrief.json and the scope xBRIEFs in
xbrief/active/ (or xbrief/pending/ if none are active yet) and implement
the project following deft/main.md standards.
```

## Owners

Extra roles live with their owners — this README does not re-author them.

| Role | Owner |
| --- | --- |
| First project / tutorial | [content/docs/getting-started.md](./content/docs/getting-started.md) |
| Support | [content/docs/SUPPORT.md](./content/docs/SUPPORT.md) |
| Capabilities | [content/docs/capabilities.md](./content/docs/capabilities.md) |
| Maintainer | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Architecture (maintainer-tier) | [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) |
| Vocabulary | [glossary.md](./content/glossary.md) |

Backlog triage, slicing, and swarming are in the getting-started tutorial and CONTRIBUTING. Content packs: `task packs:slice -- --list-packs`.

### Rule Hierarchy

Rules cascade with precedence (highest first):

1. **USER.md** (highest) — your personal overrides (`~/.config/deft/USER.md` on Unix/macOS, `%APPDATA%\deft\USER.md` on Windows)
2. **xbrief/PROJECT-DEFINITION.xbrief.json** — project-specific rules and identity gestalt
3. **Language files** (`languages/python.md`, `languages/go.md`, ...) — language standards
4. **Tool files** (`tools/taskfile.md`, ...) — tool guidelines
5. **main.md** (lowest) — general AI behavior

Note: project **requirements** (`xbrief/specification.xbrief.json` + scope xBRIEFs in `xbrief/{proposed,pending,active,completed,cancelled}/`) describe **what to build** and are deliberately kept on a separate ladder from the rule cascade above. `ROADMAP.md` is the rendered backlog view of those requirements.

## 🌲 Branch policy

Deft enforces a feature-branch policy by default (#746, #747): direct commits to `master`/`main` are blocked and PRs whose `head_ref` equals `base_ref` are refused at the CI gate. The policy is governed by a typed flag on `xbrief/PROJECT-DEFINITION.xbrief.json`:

```json
{
  "plan": {
    "policy": { "allowDirectCommitsToMaster": false }
  }
}
```

Three enforcement surfaces back the rule:

1. **Git hooks** — `.githooks/pre-commit` and `.githooks/pre-push`. Activate them with `task setup`; verify with `task verify:hooks-installed`.
2. **Pre-commit gate** — `task verify:branch` is wired into the `task check` aggregate.
3. **CI** — `.github/workflows/branch-gate.yml` refuses PRs whose `head_ref` equals `base_ref`.

Reconfigure via deterministic tasks (audited to `meta/policy-changes.log`):

- `task policy:show` — display the resolved policy and its source.
- `task policy:enforce-branches` — set `allowDirectCommitsToMaster=false`.
- `task policy:allow-direct-commits -- --confirm` — set the typed flag to `true` after the capability-cost disclosure.

Emergency bypass: set `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1` for the current shell.

**GitHub** is the primary supported SCM. Core features work without it. **vBRIEF** is legacy — see [UPGRADING.md — xBRIEF rename](./content/UPGRADING.md#xbrief-rename-2034--2110--2907).

---

**Next Steps**: Read [main.md](./main.md) for comprehensive AI guidelines, then run `npm i -g @deftai/directive` (Node ≥ 20) to get started.

---

Copyright © 2025-2026 Jonathan "visionik" Taylor — https://deft.md
License: [MIT](./LICENSE)
