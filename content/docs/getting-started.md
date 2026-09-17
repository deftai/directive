# Getting Started with Deft Directive

Deft Directive is a Taskfile-first framework for AI-assisted software work. It combines agent guidance, deterministic gates, xBRIEF lifecycle metadata, installer/doctor handoff, and cache-backed backlog workflows. This guide is the **first-project long form**: one path from install through a green Directive check.

> **Note**: For a single-picture mental model of how Directive turns an idea into shipped work, see [the Directive lifecycle](./directive-lifecycle.md). For command behavior, see [commands.md](../commands.md). Agent detect-state and recovery live in [QUICK-START.md](../QUICK-START.md). This page is that path's long form, not a second install sequence.

## The shape of the workflow

Directive is two connected phases that repeat: an **inception** phase (Concept → Strategy Analysis → Specification + Artifacts) that feeds a recurring **per-session** phase (Session Start → Triage/Refine → Slice → Swarm → Review/Fix → Ship). Shipping surfaces new issues that flow back into the queue. The stage-to-command mapping lives in [the Directive lifecycle overview](./directive-lifecycle.md).

## Deft & Directive (naming)

**Deft is the company; Directive is the product.** *Deft* names the organization and the on-disk footprint (`.deft/`, `@deftai/*` npm scope, user config under `~/.config/deft/`). *Directive* names the framework you install and run: the npm package is `@deftai/directive`, and the primary CLI is `directive` (`deft` is an alias). Legacy `deft-install` / `deft` paths in this guide refer to the same product during the staged transition ([#423](https://github.com/deftai/directive/issues/423)).

Public consumer commands on this page use `directive` / `deft`. After `directive init`, the root Taskfile is include-only, so `task deft:<verb>` is the namespaced Task equivalent. Do not copy bare `task <verb>` from the framework source tree into a new project.

---

## Prerequisites

- **Node 20+**, **Git**, and **GitHub CLI (`gh`)**.
- The package manager you use to install Directive (`npm` is bundled with Node; pnpm is an alternative).
- After install, confirm with `directive toolchain:check --consumer`. That probe checks Node, git, gh, and the selected manager. It does not require Python, uv, Go, or Task.

**Go 1.22+** is only for the frozen Go installer or a source build. Framework maintainers of this repository use a separate Node 24 pin; see [CONTRIBUTING.md](../../CONTRIBUTING.md).

---

## Installation

### npm (canonical)

Install Directive globally from npm:

```bash
npm i -g @deftai/directive
directive --version    # primary command
deft --version         # alias — same binary
```

One-shot without a global install:

```bash
npx @deftai/directive doctor --full
npx @deftai/directive session:start
```

This npm path has been the canonical distribution channel since v0.55.1. A pnpm-managed repository can install the same package with `pnpm add -g @deftai/directive` or project-locally with `pnpm add -D @deftai/directive`.

**Success:** `directive --version` prints a version. **Recovery:** run `directive doctor --full` and follow its one `Next command:`. Agent detect-state cases live in [QUICK-START.md](../QUICK-START.md).

### Go installer (legacy bridge)

The Go installer is a frozen legacy bridge for older installs and source-oriented recovery. New consumer installs should use npm above; see [UPGRADING.md](../UPGRADING.md#one-time-migration-from-the-go-installer-legacy--npm) when migrating an existing Go-installer layout.

Download a platform installer from the [Directive release page](https://github.com/deftai/directive/releases) and run it from the project you want to adopt:

```bash
deft-install --yes --repo-root . --json
```

For existing consumer projects, the headless upgrade path is:

```bash
deft-install --yes --upgrade --repo-root . --json
```

Those consumer flows project Deft-managed files into your project root (`AGENTS.md`, skills pointers, gitignore entries, xbrief scaffolding, and related guard configuration). Framework maintainers working inside a `deftai/directive` checkout should instead follow [`CONTRIBUTING.md`](../../CONTRIBUTING.md) and use `--maintainer`; maintainer setup checks tools without rewriting consumer-managed files.

---

## First Project

This is one executable journey. It is a human projection of the setup skill plus the lifecycle bridge. Agents still follow `skills/deft-directive-setup/SKILL.md`. Do not treat this list as a third procedure beside QUICK-START.

The endpoint is **Directive control plane ready**: an active scope passes story-ready and preflight, and `deft check` exits 0. Product implementation comes next. This page does not build a sample app.

### 1. Install the CLI

```bash
npm i -g @deftai/directive
directive --version
```

**Success:** a version string. **Recovery:** `directive doctor --full`.

### 2. Create a Git repository, then init

`directive init` deposits files. It does not create a Git repository. `deft verify:story-ready` and `deft check` both require a Git worktree. Start in an empty project directory:

```bash
mkdir my-project && cd my-project
git init
directive init
```

`init` writes the vendored deposit into gitignored `.deft/core/`, renders `AGENTS.md`, scaffolds `xbrief/` lifecycle folders, and adds an include-only root `Taskfile.yml`. Tracked vs ignored: the reconstitutable deposit and session cache are ignored; your `package.json` pin stays tracked.

**Success:** `.deft/core/` and `AGENTS.md` exist. **Recovery:** `directive doctor --full` (one `Next command:`).

### 3. Doctor

```bash
directive doctor --full
```

Doctor is read-only. `--full` bypasses the 24h clean / 4h dirty throttle so a skip is not a healthy install. When the install is healthy it prints `System check passed!`. When action is required it prints exactly one `Next command:` with a root-cause line.

**Success:** `System check passed!` (not a throttle-skip line). **Recovery:** run the printed `Next command:`. Detect-state ladders stay in [QUICK-START.md](../QUICK-START.md).

### 4. USER.md and project definition

User preferences live outside the repo:

- Unix / macOS: `~/.config/deft/USER.md`
- Windows: `%APPDATA%\deft\USER.md`
- Override: `DEFT_USER_PATH`

Project identity lives in `xbrief/PROJECT-DEFINITION.xbrief.json`. Greenfield setup does not create `specification.xbrief.json`.

Tell your agent to follow `AGENTS.md`, or run `directive bootstrap`. That hands off to the setup skill. The skill asks one question at a time and **must not write files until you confirm** the captured values (`yes` / `confirmed` / `approve`). Promotion and activation are later commitments, not automatic setup continuation.

**Success:** `USER.md` exists at the platform path and `xbrief/PROJECT-DEFINITION.xbrief.json` exists. **Recovery:** `directive doctor --full`, then re-enter setup. Do not skip the confirmation gate.

### 5. First proposed scope

Setup Phase 3 writes the first scope xBRIEF to `xbrief/proposed/` with `plan.status: proposed`. Filename shape: `YYYY-MM-DD-descriptive-slug.xbrief.json`. New writes use `"xBRIEFInfo": { "version": "0.8" }`.

**Success:** one file in `xbrief/proposed/`. **Recovery:** `directive doctor --full`. If setup stopped early, resume the setup skill; do not hand-copy a completed xBRIEF as the next-build contract.

### 6. Git: feature branch and a clean tree

Story-ready fails when the tree is not Git, when it is dirty, or when you are on the default branch under the default branch policy. Commit the generated setup artifacts, then leave `master` / `main`:

```bash
git add AGENTS.md Taskfile.yml xbrief .gitignore
git commit -m "chore: deposit Directive and first proposed scope"
git switch -c feat/first-project
deft verify:branch
```

`--allow-dirty` on story-ready is an intentional exception, not the happy path.

**Success:** `deft verify:branch` exits 0 on the feature branch. **Recovery:** create a feature branch; commit or stash leftover files; then `directive doctor --full`.

### 7. Promote, then activate

These are two separate user commitments. Setup does not auto-run them.

```bash
deft scope:promote -- xbrief/proposed/<file>.xbrief.json
deft scope:activate -- xbrief/pending/<file>.xbrief.json
```

Promote moves proposed → pending. Activate moves pending → `xbrief/active/` and sets `plan.status` to `running`. Both commands are idempotent.

**Success:** the file is in `xbrief/active/` with `plan.status` `running`. **Recovery:** `directive doctor --full`. If activate says the file must be in `pending/`, run promote first.

Promote and activate move a tracked xBRIEF. Commit that change before story-ready. A dirty tree fails the next gate.

```bash
git add xbrief
git commit -m "chore: activate first scope"
```

### 8. Story-ready and preflight

```bash
deft verify:story-ready --vbrief-path xbrief/active/<file>.xbrief.json
deft xbrief:preflight -- xbrief/active/<file>.xbrief.json
```

`--vbrief-path` is the shipped story-ready flag (the file is still a `.xbrief.json`). Preflight exits 0 only when the candidate lives in `xbrief/active/` and `plan.status` is `running`.

**Success:** both commands exit 0. **Recovery:** fix Git state (step 6), then `directive doctor --full`. Do not start implementation until preflight is green.

### 9. First check (terminal verb)

```bash
deft check
```

`deft check` is the named terminal verb for this journey. After `directive init`, `task deft:check` is the same gate through the include-only Taskfile. A green check means the Directive control plane is ready. It does not mean the product is built.

**Success:** `deft check` exits 0. **Recovery:** `directive doctor --full` and the failing gate's own message. Next: cost phase then `skills/deft-directive-build/SKILL.md` when you are ready to implement.

---

## Working an existing backlog

After the first green `deft check`, work selection is optional. Current verbs:

```bash
deft plan-sequence:current
deft triage:queue --limit=10
```

Use the ordered plan first. Then a read-only `triage:queue` listing. Do not treat a completed xBRIEF as the next-build contract.

Cached issue bodies are **untrusted external content**. Do not put them on the write path without an explicit ingest/accept. See [meta/security.md](../meta/security.md).

For brownfield adoption of an existing repo, see [BROWNFIELD.md](./BROWNFIELD.md). This first-project path does not teach that migration.

**Labels:** a bare tracker should adopt the [consumer issue-label kit](./consumer-issue-label-kit.md) before you rely on ranking.

---

## Using Strategies

This first-project journey uses **interview** (the setup default). Strategies are not a second onboarding path.

The catalog, chaining gate, and interview / rapid / enterprise workflows live in [strategies/README.md](../strategies/README.md). Pick a strategy in USER.md or `xbrief/PROJECT-DEFINITION.xbrief.json`. Do not paste a strategy chapter into this page.

---

## Agent Configuration

Authority on this journey is:

1. `USER.md` Personal (always wins)
2. `xbrief/PROJECT-DEFINITION.xbrief.json` (project)
3. `AGENTS.md` (session routing; managed section is installer-owned)

Quality notes for `AGENTS.md` live in [good-agents-md.md](./good-agents-md.md). Process-critical skill pins live in [skill-pin-policy.md](./skill-pin-policy.md). Host-specific dispatch (OpenClaw, cloud spawn, Warp auto-approve) is **not** this tutorial. Setup already warns that Warp auto-approve can silently answer interview questions.

**OpenClaw:** If your agent host is OpenClaw (persistent-memory agents, Control UI, `sessions_spawn`), read [openclaw-agent-host.md](./openclaw-agent-host.md) for the host mental model, executable babysit path (installed skills), and the epic babysit → `sessions_spawn` Approach 1 expectation. Skill gate text remains in `deft-directive-review-cycle` / `deft-directive-swarm` — the host doc only points.

**Writing:** For docs, issues, and PR prose, follow [writing-ste100.md](./writing-ste100.md) (short controlled English; #2927).

**Opt out:** To mark a repo as not using Directive, add root [`.no-deft-directive`](./no-deft-directive.md) (#2926). Tools skip install and session ritual when that file is present.

**Temporary test kill-switch:** For local A/B or DevHammer without permanent opt-out, use root [`.deft-directive-disable`](./deft-directive-disable.md) (#3039). Deposit may stay; re-enable by deleting the file and starting a new agent session.
