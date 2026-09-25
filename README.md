<!-- deft:cold-start-bootstrap v1 (#2273) -->
> ## ⚡ Cold-start bootstrap (read this first)
>
> **New clone, or `deft` / `directive` won't run, or PATH version is behind the pin?** Directive runs from an npm-installed engine — there is no committed shell shim, so *you* (agent or human) are the interpreter. Work the **global-first ladder** below top-down and stop at the first rung that yields a working `directive` admitted by the pin compare on rung 1. Exact PATH-version equality is the check after repairing a behind-pin engine, not the stop for every case. The version to install is always the one pinned in the project's committed `package.json`. Doctor exit 0 is not skip.
>
> 1. **Already on PATH?** Compare `directive --version` / `deft --version` to the committed `package.json` pin (outside the doctor binary). Matching pin: proceed, then run `directive doctor --full` (or the `deft` alias) and follow its `Next command:`. Behind pin: `npm i -g @deftai/directive@<pin>`, then re-probe that same PATH executable for the pin version — success is that match, not install exit 0. Supported ahead: proceed with the existing `update` / `align-pin` next step; far ahead stays fail-closed. No pin and no deposit: `npx @deftai/directive init`, then return to this compare against the pin init wrote. Bare `directive doctor` may skip (24h clean / 4h dirty); `--full` bypasses that throttle. A process that starts is not bootstrap success.
> 2. **Local engine.** If `.deft/.cli/<platform>` holds an intact engine at or above the `package.json` pin, use it.
> 3. **Global install (canonical).** With a pin: `npm i -g @deftai/directive@<pin>` (Node ≥ 20), then re-run `directive doctor --full`. No pin and no deposit: `npx @deftai/directive init`, then return to step 1. Using pnpm? `pnpm add -g @deftai/directive@<pin>` (same package, same registry) — make sure `PNPM_HOME` is on your `PATH` (`pnpm setup` if not).
> 4. **Sandbox install.** If the global npm prefix isn't writable (sandboxed environment), install into the project instead: `npm install --prefix .deft/.cli/<platform> @deftai/directive@<pinned>`. (This internal `.deft/.cli/` layout is always npm-shaped, regardless of your project's package manager.)
> 5. **Corporate mirror symptoms.** If install returns `E404` / `ETARGET`, or `@latest` silently stays behind the public release, follow the [corporate or mirrored npm registry recovery](./content/UPGRADING.md#corporate-or-mirrored-npm-registry).
> 6. **Offline.** If the npm registry is unreachable, install from a staged tarball / vendored payload. If none exists, stage one — recovery cannot proceed without a payload.
>
> Old deposits missing this compare line: `npx -y @deftai/directive@<pin> agents:refresh`, then assert the every-session compare (`directive --version` vs pin) is present in the managed AGENTS.md section. Refresh exit 0 is not that evidence. When the pin predates this compare, that `@<pin>` refresh cannot add the line — obtain current bootstrap content with `directive update` on a repaired engine, or `npx -y @deftai/directive@latest agents:refresh`, then re-assert presence. Full deposit currency (main.md, SKILL.md) is `directive update` on the repaired engine.
>
> This block is always committed (never gitignored) and does **not** depend on the `.deft/core/` payload being present, so it is reachable on a fresh clone even when the vendored framework is missing. Once `directive` runs, continue with the guidance below and in `AGENTS.md`.
<!-- /deft:cold-start-bootstrap v1 -->

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

Directive is three commands — `init`, `update`, and `doctor`. After install, walk the [first-project tutorial](./content/docs/getting-started.md).

| Your situation | Run this one command | What it does |
| --- | --- | --- |
| New, empty project directory | `directive init` | Scaffolds a fresh Directive deposit (`.deft/core/`, the `AGENTS.md` managed section, the `xbrief/` layout, and a committed `package.json` pin). |
| Existing codebase (app code, no Directive yet) | `directive init` | Installs Directive support beside your code without disturbing it, then points you at brownfield spec extraction. |
| Existing Directive project (already initialized) | `directive update` | Refreshes the vendored payload and self-heals the engine. (`init` detects this state and delegates to `update` with a disclosure line — it never re-scaffolds an existing install.) |
| Not sure, or something looks broken | `directive doctor --full` | Read-only diagnosis. Bare `directive doctor` may throttle-skip (24h clean / 4h dirty); `--full` re-probes and prints exactly one next step. |
| Legacy / pre-v0.20 layout | `directive init` (or `directive doctor`) | Classifies the layout and routes you to the specific migration path (see [UPGRADING.md](./content/UPGRADING.md)). |

`directive init` is the **universal entrypoint**. `directive` (the `deft` alias also works) runs any verb; `npx @deftai/directive <verb>` or `pnpm dlx @deftai/directive <verb>` runs one without a global install.

### 1. Install and initialize

```bash
npm i -g @deftai/directive
```

**Using pnpm?** Same package, same registry:

```bash
pnpm add -g @deftai/directive
```

Make sure pnpm's global bin directory is on your `PATH` (run `pnpm setup` once to configure `PNPM_HOME`). Then:

```bash
directive init      # classify this directory and set up (or route) accordingly
directive doctor --full    # confirm the install; --full bypasses throttle
directive toolchain:check --consumer
```

**Node runtime (required):** Install **Node 20+**, **Git**, **GitHub CLI (`gh`)**, and the package manager you use (`npm` is bundled with Node; pnpm is an alternative). After `directive init`, confirm with `directive doctor --full` and `directive toolchain:check --consumer`. That consumer probe always checks Node, git, gh, and the selected manager (`npm` or `pnpm`). It does not require Python, uv, Go, or Task. Framework maintainers building this repository use a separate Node 24 pin plus pnpm, Go, and Task; see [CONTRIBUTING.md](./CONTRIBUTING.md). See [UPGRADING.md § Node runtime](./content/UPGRADING.md#node-runtime-1828--1530) for details.

**What gets tracked vs ignored:** `init` and `update` add Directive's local-only artifacts to your `.gitignore` — the reconstitutable deposit `.deft/core/`, the per-platform engine cache `.deft/.cli/`, session/ritual state such as `.deft/ritual-state.json`, and the `.deft-cache/` content cache. Your committed `package.json` pin is **never** ignored: it is the anchor that lets `directive init` / `directive update` reconstitute `.deft/core/` on a fresh clone, so it stays tracked in version control.

> **🔄 Upgrading an existing Directive project?** The ordinary path is `directive update` from your project root (after `npm i -g @deftai/directive@latest`, or `pnpm add -g @deftai/directive@latest` on pnpm). See [UPGRADING.md](./content/UPGRADING.md) for the canonical steps and the advanced/big-jump detail. On **npm v12**, install scripts and non-registry sources are opt-in — [UPGRADING.md § npm v12 install-time security defaults](./content/UPGRADING.md#npm-v12-install-time-security-defaults) (Directive packages need no allowlist; app trees may). **Agents:** ! Read [UPGRADING.md](./content/UPGRADING.md) on the first session after a framework update.

> **📦 Brownfield adoption:** Adding Deft to an existing project with pre-v0.20 `SPECIFICATION.md` / `PROJECT.md`? See [docs/BROWNFIELD.md](./content/docs/BROWNFIELD.md) and UPGRADING.md § Frozen pre-v0.20 document-model migration (#2068).

> **📢 Cloned manually (no installer)?** Tell your agent: `Read deft/QUICK-START.md and follow it.` It creates your project's `AGENTS.md` and starts the setup flow automatically.

#### Legacy and offline install (Go installer, #1912)

> **Node is always required to *run* Deft.** The Go installer is a **legacy bridge**, not the first-start installer — npm is canonical (above). Reach for it only when npm isn't an option: an **offline / air-gapped** deposit, or **migrating an existing old on-disk layout**.

> **⬇️ Legacy binaries** — from the [latest GitHub Release](https://github.com/deftai/directive/releases/latest):
> - **Windows:** [`install-windows-amd64.exe`](https://github.com/deftai/directive/releases/latest/download/install-windows-amd64.exe) | [`install-windows-arm64.exe`](https://github.com/deftai/directive/releases/latest/download/install-windows-arm64.exe)
> - **macOS:** [`install-macos-universal`](https://github.com/deftai/directive/releases/latest/download/install-macos-universal)
> - **Linux:** [`install-linux-amd64`](https://github.com/deftai/directive/releases/latest/download/install-linux-amd64) | [`install-linux-arm64`](https://github.com/deftai/directive/releases/latest/download/install-linux-arm64)

**Windows:** Download `install-windows-amd64.exe` (or `install-windows-arm64.exe`) and run it — SmartScreen may warn; click "More info" then "Run anyway".

**macOS:** Download `install-macos-universal`, then `chmod +x install-macos-universal && ./install-macos-universal`. If Gatekeeper blocks it: right-click then Open, or `xattr -d com.apple.quarantine install-macos-universal`.

**Linux:** Download `install-linux-amd64` (or `install-linux-arm64`), then `chmod +x install-linux-amd64 && ./install-linux-amd64`.

#### Agent / headless install

```bash
npm i -g @deftai/directive
```

Node 20+ is required. For **offline / air-gapped** deposits or **migrating a legacy on-disk layout**, the Go-installer binaries remain at [GitHub Releases](https://github.com/deftai/directive/releases/latest) (see [Legacy and offline install](#legacy-and-offline-install-go-installer-1912)).

#### Framework maintainers (this repository)

Building from source requires Go 1.22+. Use `go run ./cmd/deft-install/` or `deft-install --yes --upgrade --maintainer --repo-root /path/to/directive --json`. Maintainer setup: [CONTRIBUTING.md](./CONTRIBUTING.md).

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
