# Getting Started with Deft Directive

Deft Directive is a CLI-native framework for AI-assisted software work (`directive` / `deft` primary; Taskfile optional parallel). It combines agent guidance, deterministic gates, xBRIEF lifecycle metadata, installer/doctor handoff, and cache-backed backlog workflows. This guide is the **first-project long form**: one path from install through a green Directive check.

> **Note**: For a single-picture mental model of how Directive turns an idea into shipped work, see [the Directive lifecycle](./directive-lifecycle.md). For command behavior, see [commands.md](../commands.md). Agent detect-state and recovery live in [QUICK-START.md](../QUICK-START.md). This page is that path's long form, not a second install sequence.

## The shape of the workflow

Directive is two connected phases that repeat: an **inception** phase (Concept → Strategy Analysis → Specification + Artifacts) that feeds a recurring **per-session** phase (Session Start → Triage/Refine → Slice → Swarm → Review/Fix → Ship). Shipping surfaces new issues that flow back into the queue. The stage-to-command mapping lives in [the Directive lifecycle overview](./directive-lifecycle.md).

## Process-use reporting (#4229)

Claiming used-Directive for product work must name the relevant scope path, lifecycle progress (proposed through completed), and delivery evidence — not deposit or init alone.

**You have not used Directive if:**

1. Only PROJECT-DEFINITION exists and lifecycle folders are empty.
2. Specs live only under docs/ outside the xBRIEF lifecycle.
3. There was no promote/activate/session/implement against an active scope for the claimed work.

Lawful idle / empty-active after real history is not failure. ARC-before-ingest posture is owned by open #5716 — do not treat ARC always-on as shipped here.

## Deft & Directive (naming)

**Deft is the company; Directive is the product.** *Deft* names the organization and the on-disk footprint (`.deft/`, `@deftai/*` npm scope, user config under `~/.config/deft/`). *Directive* names the framework you install and run: the npm package is `@deftai/directive`, and the primary CLI is `directive` (`deft` is an alias). The Go installer (`deft-install`) is deleted — use the global launcher + `directive install` / `directive upgrade` path only.

Public consumer commands on this page use `directive` / `deft`. After `directive init`, the root Taskfile is include-only, so `task deft:<verb>` is the namespaced Task equivalent. Do not copy bare `task <verb>` from the framework source tree into a new project.

---

## Prerequisites

- **Node 22 or 24** (tested gates). Node 20 is allowed best-effort with a warning; Node &lt; 20 is refused.
- **Git**, and **GitHub CLI (`gh`)** for GitHub-backed workflows.
- **npm or pnpm** (Yarn and Bun projects are refused).
- After install, confirm with `directive doctor` and `directive toolchain:check --consumer`.

Two published packages: global **`@deftai/directive`** (launcher) and project-pinned **`@deftai/directive-runtime`**. See [launcher.md](./launcher.md) and [known-limitations.md](./known-limitations.md).

Framework maintainers of this repository use a separate Node 24 pin; see [CONTRIBUTING.md](../../CONTRIBUTING.md).

Maintainer execution on this repo: after `git pull` / FF, hooks and ordinary `task <verb>` use the pin under `node_modules/@deftai/directive-runtime`. Tip dogfood without publishing is an explicit `task materialize:runtime` into **this** checkout only (each worktree installs/materializes its own pin). See [launcher.md](./launcher.md).

---

## Installation

### Global launcher + project install (canonical)

```bash
npm i -g @deftai/directive
# or: pnpm add -g @deftai/directive

cd your-project   # must be a Git repo for most workflows
directive install # pins @deftai/directive-runtime exactly
directive doctor
```

**Windows:** the same two steps. If PowerShell refuses to run npm's own script, use `npm.cmd i -g @deftai/directive`. Directive tries to remove its own `.ps1` shims when it installs; if PowerShell still refuses `directive`, type `directive.cmd`. It is the same command.

After clone or a new worktree: run the project package manager (`npm install` / `pnpm install`), then the first eligible runtime command or registered hook completes local activation.

**Dependabot / pin-only bumps (AC14.10):** a PR that changes only the `@deftai/directive-runtime` pin + lockfile is valid. After `pnpm install` / `npm install` brings `node_modules` to the new pin, the first eligible skill, hook, or ordinary runtime command runs local automatic setup (wiring / `GENERATION` / readiness). `directive doctor` stays read-only — dirty doctor output before that eligible invocation is expected. CI may either rely on that first eligible command or run explicit `directive install --repair --yes`. Do not treat "deposit bytes must land in the same pin PR" as product law. Human-test mirror: HT-17 in `docs/installer-refactor-ovpr/install-ovpr-human-test-plan.md`. Schema/data behind the new pin still needs `directive upgrade` (AC14.11), not repair alone.

**When something is wrong**, run the one command that matches (`directive doctor` names it):

| What is wrong | Command |
| --- | --- |
| Runtime missing or not the pinned version | `npm install`, or `pnpm install --frozen-lockfile` for pnpm |
| Wiring damaged with the right runtime installed | `directive install --repair` |
| Project data behind, or an older Directive layout | `directive upgrade` |
| `directive` command missing | `npm i -g @deftai/directive` |

**Upgrade version or migrate data:** `directive upgrade`.

**Uninstall project wiring:** `directive uninstall`.

Do not use `npx` / `pnpm exec` as day-to-day identity. Retired verbs (`migrate`, `bootstrap`, `sync`, `install-upgrade`, `install-uninstall`, `doctor fix`) print unknown command.

**Success:** `directive --version` shows the launcher; the project has an exact `@deftai/directive-runtime` pin and `directive doctor` is healthy. **Recovery:** [QUICK-START.md](../QUICK-START.md).

Supported latest-legacy layouts (pre-split pin + copied `.deft/core`): run `directive upgrade`. The Go installer has been removed.

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

### 2. Create a Git repository, then install

`directive install` does not create a Git repository. Start in an empty project directory:

```bash
mkdir my-project && cd my-project
git init
directive install
```

`install` adds an exact `@deftai/directive-runtime` pin through the package manager, runs setup (package-relative `AGENTS.md` / hooks / skills), and may seed initial project data. There is no copied `.deft/core/` content.

**Success:** `package.json` pins `@deftai/directive-runtime`, managed wiring exists, `directive doctor` is healthy. **Recovery:** `directive install --repair` (first `npm i -g @deftai/directive` if the `directive` command is missing).

### 3. Doctor

```bash
directive doctor --full
```

Doctor is read-only and never skips a run; `--full` also runs the live hook probe. When the install is healthy it prints `System check passed!`. When action is required it prints exactly one `Next command:` with a root-cause line.

**Success:** `System check passed!` (not a throttle-skip line). **Recovery:** run the printed `Next command:`. Detect-state ladders stay in [QUICK-START.md](../QUICK-START.md).

### 4. USER.md and project definition

User preferences live outside the repo:

- Unix / macOS: `~/.config/deft/USER.md`
- Windows: `%APPDATA%\deft\USER.md`
- Override: `DEFT_USER_PATH`

Project identity lives in `xbrief/PROJECT-DEFINITION.xbrief.json`. Greenfield setup does not create `specification.xbrief.json`.

Tell your agent `read AGENTS.md and follow it`. That starts the setup skill. The skill asks one question at a time and **must not write files until you confirm** the captured values (`yes` / `confirmed` / `approve`). Promotion and activation are later commitments, not automatic setup continuation.

**Success:** `USER.md` exists at the platform path and `xbrief/PROJECT-DEFINITION.xbrief.json` exists. **Recovery:** `directive doctor --full`, then re-enter setup. Do not skip the confirmation gate.

### 5. First proposed scope

Setup Phase 3 writes the first scope xBRIEF to `xbrief/proposed/` with `plan.status: proposed`. Filename shape: `YYYY-MM-DD-descriptive-slug.xbrief.json`. New writes use `"xBRIEFInfo": { "version": "0.8" }`.

**Success:** one file in `xbrief/proposed/`. **Recovery:** `directive doctor --full`. If setup stopped early, resume the setup skill; do not hand-copy a completed xBRIEF as the next-build contract.

### 6. Git: feature branch and a clean tree

Story-ready fails when the tree is not Git, when it is dirty, or when you are on the default branch under the default branch policy. The commit gate also refuses commits on `master` / `main`, so create the feature branch first, then commit the generated setup artifacts on it:

```bash
git switch -c feat/first-project
deft verify:branch
git add AGENTS.md Taskfile.yml xbrief .gitignore
git commit -m "chore: deposit Directive and first proposed scope"
```

The deposited `.gitignore` ignores Directive's runtime state under `.deft/` and `.deft-cache/`, so `session:start` does not dirty the tree. Records a story commits, such as `.deft/approved-scope/` and `.deft/intent-constraint/`, stay trackable.

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

## Fewer local hook refusals (#6535)

Optional. You do not need this for the first green `deft check`. For the repository settings it names, see [GitHub merge queue setup](./github-merge-queue-setup.md), which carries this same section after "How agents merge afterwards".

A repository can let five local hook refusals warn instead of refuse, when its merge path already runs the full gate.

**Part A. What the hook checks**

- (a) `plan.policy.mergeGateContext` in `xbrief/PROJECT-DEFINITION.xbrief.json` names one status check, and the same exact name is in GitHub's copy of that file at the head of the delivery branch and in the copy in the worktree you work in (merge the change, then update each worktree).
- (b) That check is required on the delivery branch, by a ruleset or by classic branch protection.
- (c) `origin` is the GitHub repository, the delivery branch resolves, and `gh` with the credentials the hook uses can read the file at the delivery branch, `rules/branches/<branch>` and `branches/<branch>/protection` within ten seconds in total. A 404 on either protection read is fine; any other error on either means no signal.

**Part B. What you make true (the hook does not check it)**

- (d) The named check runs the full merge gate (`deft check`) and runs on `merge_group`.
- (e) The merge queue is on for the delivery branch.
- (f) The review bot is a required check.

When Part A holds, the five warn sites warn and every other refusal stays. When any item of Part A fails, the hook refuses as today. For the site table, the floor and the limits, see [Warn-only sites behind a live merge gate (#6535)](./hook-root-admission.md#warn-only-sites-behind-a-live-merge-gate-6535).

**Worked example**

The policy fragment in `xbrief/PROJECT-DEFINITION.xbrief.json`:

```json
"plan": {
  "policy": {
    "mergeGateContext": "Merge gate (task check)"
  }
}
```

Three reads, as diagnostics. They show that the parts are in place. They do not prove that the hook's read finishes within its budget.

```bash
gh api "repos/<owner>/<repo>/contents/xbrief/PROJECT-DEFINITION.xbrief.json?ref=<branch>"
gh api repos/<owner>/<repo>/rules/branches/<branch>
gh api repos/<owner>/<repo>/branches/<branch>/protection
```

The result, when Part A holds: a product write that only a stale session ritual would refuse is allowed, with a message that starts `Warning:` and carries the ritual refusal text. Any later refusal (occupancy, a protected store, a binding refusal) still wins.

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

**Temporary test kill-switch:** For local A/B testing without permanent opt-out, a person runs `deft kill-switch:on --confirm` at a terminal; it writes the kill record `.deft/authz/kill-switch.disable` ([kill-switch docs](./deft-directive-disable.md), #3039 / #6740). A bare root flag file turns nothing off. Deposit may stay; re-enable with `deft kill-switch:off --confirm` and a new agent session.
