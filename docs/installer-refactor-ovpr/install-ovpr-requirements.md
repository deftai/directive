# Install OVPR — Requirements (active)

**Status:** Active product requirements for One Version Per Repo install/upgrade/uninstall/repair/doctor.

**Authority:** This file is the in-repo durable requirements SoT for future installer work on `master`. It was landed from the closed #5490 design (`UNIFIED-GITHUB-V2.md` / Parts A–D) during the wave4j master-merge train. Prefer this file on product conflicts with historical YOLO notes, completion tables, or xbriefs.

**Related**

| Doc | Role |
| --- | --- |
| [install-ovpr-architecture.md](./install-ovpr-architecture.md) | Active architecture summary |
| [install-ovpr-implementation-strategy.md](./install-ovpr-implementation-strategy.md) | Historical delivery narrative (not product ACs) |
| [install-ovpr-human-test-plan.md](./install-ovpr-human-test-plan.md) | HT-00–HT-17 human / harness plan |
| [README.md](./README.md) | Folder map |

**Provenance:** Copied from orchestrator `UNIFIED-GITHUB-V2.md` at wave4j docs land; sha256 `2ea62171e0b5a8f0ce6770a4563c85d6e0784d072274e61c041c3232e3fcfd85` of that source at copy time. Edits after land are first-class; keep this file self-consistent.

**Tracking:** deftai/directive#5490 (design), #5514 (methodology / cutover).

---

# One Version Per Repo — simplify how Directive installs, upgrades and uninstalls itself in a user's repository

| | |
| --- | --- |
| Scope | Installation, upgrade, uninstallation, repair and installation-health checks of Directive **in an end user's repository**. Unrelated product behaviour is unchanged. |
| Commands | `install`, `upgrade`, `uninstall`, `doctor`. (`init`, `update`, `remove` accepted as other names.) |
| Packages | `@deftai/directive` — the global launcher. `@deftai/directive-runtime` — what a repo pins. Nothing else is published. |
| Measured against | Directive v0.121.0 (2026-10-05) |
| Status | **Closed design. No open questions.** Decisions and their consequences are catalogued in §A9 and are accepted as weighed limitations. |
| Supersedes | The body and the comment thread of #4730; the behaviour shipped for #4692, #4710, #4718 and #5245 (see "Authority" below). |
| Document revision | **v261027** (2026-10-27). Operator amendment for unified entry guards and host-hook committed `.mjs` outer. Lines or whole acceptance criteria that changed are tagged `(v261027)` and **replace** the prior text. Unchanged text remains in force. |

---

## Authority, standalone status, and how to review this ticket

**This ticket is self-contained and is the single authority for this work.** It merges, without change of meaning, the design proposal (Part A), the numbered requirements with acceptance criteria (Part B), the CLI specification (Part C) and the handoff guidance (Part D) that were prepared for this effort. Nothing outside this ticket is needed to understand, review or implement it, and nothing outside this ticket overrides it. Reviewers — human or AI — must treat it as a **closed design** and review it for internal consistency, completeness and correctness against its own text only. The known limitations in §A9 are listed and explained so that they can be documented for users; they are **accepted, weighed decisions** and are not to be re-adjudicated, "solved", or used as grounds to reopen the overall solution.

**Authority rules.**

1. **This ticket is the sole authority for this work** and completely supersedes prior install-simplification proposals, including #4730's body and comment thread. Track implementation against this ticket. Cancel #4730 by closing it as "won't fix", without deleting it; references to #4730 here provide historical context only. Do not consult prior issues for behaviour. No older examples or external issue text override the decisions recorded here.
2. **This ticket overrides the behaviour shipped for #4692, #4710, #4718 and #5245.** Where current code makes the pin follow the running CLI (`reconstituteConsumerPinAndLock`, `pinLagsReconstitutedVersion`, the `align-pin` plan mode), that behaviour is to be **removed**. Those four tickets are not to be considered in reviews of this ticket, including any additional arc/design-critique reviews.
3. **The current source code is not the committed architecture.** This work changes it. The present implementation of install, update, doctor, the engine ladder, the `.deft/core` deposit and the four-package layout is input to be inventoried and replaced, never a reference for what the result must look like. Do not review this ticket against how the code behaves today.
4. **Part B acceptance criteria bind “done” for the initial release.** Done means every initial-release acceptance criterion passes. Criteria explicitly marked **follow-up** (the historical survey) are required but nonblocking for the initial release/beta.
5. **Part C is the behavioural specification for the INIT rules Part B cites**, and fills detail where Part B is silent, including the operator decisions reflected throughout. Two operator overrides against the original initializer spec are already incorporated in Part C's text and remain explicit: `install` has no `--upgrade` option (upgrade is its own command), and the pinned package is `@deftai/directive-runtime`. Bounded plans and equal-version migration are also incorporated. **If a Part B criterion and Part C appear irreconcilable, stop and ask the operator** — do not silently prefer one.
6. **Scope is fixed.** The entire effort concerns installation, upgrade, uninstallation, repair and installation-health checks. It supersedes old commands and logic serving those purposes. It does not change unrelated product behaviour, and the four-command restriction applies only to installation management.
7. **If a requirement looks wrong or impossible, stop that slice and raise it with the operator.** Do not reinterpret it, guess, or make assumptions. Seek clarity.

**How this ticket is organised.**

- **Part A — Proposal.** The design, the reasons, and (§A9) the catalogue of known limitations and the decisions behind them.
- **Part B — Requirements.** R1–R16 with acceptance criteria. Where a criterion cites an `INIT-nn` rule, that rule is in Part C.
- **Part C — CLI specification.** Discovery, plans, approval, package-manager rules, repair/upgrade semantics, failure reporting, exit codes, example exchanges.
- **Part D — Handoff guidance.** Operator pre-steps, hard rules, work plan, testing expectations, when to stop and ask, release, final report.

Internal references use `§A…`, `§C…`, `Rn`, `ACn.n` and `INIT-nn`. Illustrative version numbers and paths in examples are illustrative; `<managed-file>` means an actual Directive-managed path the implementation must print.

---
# Part A — Proposal: One Version Per Repo

**Simplifying how Directive installs, upgrades, and uninstalls itself in a user's repository**

## A0. Scope and intended outcome

This proposal governs installation, upgrade, uninstallation, repair and installation-health checks. It supersedes existing commands and logic serving those purposes, including legacy forms that must change or disappear. Unrelated product functionality is unchanged.

- The four-command restriction applies to **installation management**. Existing product commands and their options remain available through the pinned runtime.
- The launcher passes ordinary commands through without needing its own complete list of runtime commands. Runtime command help and validation remain the runtime's responsibility.
- The explicitly retired installation verbs remain retired.
- `upgrade` owns installation-related migration of existing project data. Ordinary project-data operations remain permitted; setup and repair may read settings and follow the initial-seeding boundaries in §A6.3.

**Retain the feature points; fix their version source.** Install and upgrade must install and activate all existing applicable integrations, including OpenClaw, slash commands, Copilot and other current features. Every product-content reference and execution path must resolve to the project's pinned runtime package, not `.deft/core` or a shared global product runtime. Lists in this proposal are examples, not an exhaustive feature inventory or permission to omit integrations.

**Keep the implementation specific and simple.** Choose the safest, simplest, highest-confidence mechanism with the best return on effort. Direct rewiring or an internal uninstall/reinstall preserving settings and project data may both satisfy the outcome. This proposal does not mandate an in-place conversion algorithm, generic registry or extensible installer framework.

## A1. Background

Directive is installed *into* the repositories of the teams that use it. A working install has three parts plus the user's data:

1. **The program and content** — the Directive npm package: the `directive` commands, the `deft-hook` program that AI hosts call before tool use, and the skills, templates and rules agents read.
2. **The wiring** — small files committed to the repo that point at the program and content: skill pointers (`.claude/skills/...`, `.agents/skills/...`), host hook configs (`.claude/settings.json`, `.cursor/hooks.json`, ...), git hooks, a section of `AGENTS.md`, a Taskfile include.
3. **A record of setup** — `.deft/GENERATION.json`, which says which version last wrote the wiring.
4. **The project data** — `xbrief/` files. These belong to the user. Each file carries its own schema version.

For this to work, the program, content and wiring must all be the same Directive version. Today nothing guarantees that.

## A2. Environment

What we have to live with:

- **Package managers:** npm and pnpm are supported. Yarn and Bun projects are recognised and refused with a clear message. macOS, Linux and Windows. pnpm lays out `node_modules` differently from npm and blocks install scripts by default.
- **Node:** `engines.node` allows 20 and up. We test on 22 and 24. Node 20 reached end of life on 30 April 2026 and still accounts for roughly 14% of Node downloads; it is allowed on a best-effort basis with a warning.
- **Not every user repo is a JavaScript project.** Directive is used in .NET, Go and Python repos. Installing creates a minimal `package.json` there. Node and a package manager are required either way.
- **Teams.** Several engineers clone the same repo onto different machines. One engineer has several repos, often on different Directive versions. Dependabot may bump the pin without anyone running a Directive command.
- **AI hosts run our hooks.** Claude Code, Cursor, Codex and Grok each call a hook from a committed config file. Cursor is configured to block every edit if the hook can't run.
- **Git worktrees.** Directive's own swarm feature creates extra worktrees of a repo for parallel agents. A worktree gets the committed files but not `node_modules`.
- **Old installs exist**, in several layouts (§A6.7). Directive is not yet at 1.0.
- **Directive is used to build Directive.** The Directive repo is itself a user of the tool. That is a special case and not what this proposal is designed around.

How install works today (v0.121.0):

- The docs tell users to install the CLI **globally** (`npm i -g @deftai/directive`) and run `directive init` / `directive update` in each repo.
- `init` writes an exact version into the repo's `package.json` (the **pin**) and *copies* content into a gitignored `.deft/core/`. The managed section of `AGENTS.md` and every skill pointer are relative paths into that copy (`.deft/core/main.md`, `.deft/core/skills/…/SKILL.md`).
- `update` copies content **from whichever CLI is running** — normally the global one — not from the version the repo pins. Since 0.119.3 it then rewrites the repo's pin to match that CLI.
- Hooks are committed as the bare command `deft-hook`, which the operating system resolves from `PATH` — the global install's copy.
- There is no uninstall command. Removal is a manual recipe.
- Directive is published as four packages: `@deftai/directive` (the CLI, ~26k lines), `directive-core` (the engine, ~300k lines), `directive-content` (no code: a packaging shell around the repo's `content/` folder of skills, templates and docs), `directive-types` (~1k lines of types plus the xbrief JSON schemas). They depend on each other with `^` ranges. Nobody installs the last three on their own.
- A frozen Go installer (`cmd/deft-install/`) still ships, as the "bridge" for the oldest install layouts.

## A3. Problem

**A repo can hold three different Directive versions at once, and the wrong one usually wins.**

| Where | What decides its version |
| --- | --- |
| The global CLI on the machine | Whenever that person last ran `npm i -g` |
| The pin in `package.json` | Whoever last ran `init` (or, lately, `update`) |
| The copied content in `.deft/core/` | Whichever CLI last ran `update` on this checkout |

The real-world case that triggered the ticket: a repo pinned to 0.119.0, with a 0.119.2 global CLI and 0.119.2 content. `doctor` kept recommending another update, and no update could fix it.

Why this matters in practice:

- **Two repos, one machine.** The single global CLI is wrong for at least one of them.
- **Two engineers, one repo.** The committed pin says one thing; each engineer's global says another. Whoever runs `update` drags the repo to *their* machine's version. Because the check is "different" rather than "older", an engineer with an older global can move the whole team **backwards**.
- **A fresh clone doesn't work until someone copies content again.** The skills point at a gitignored folder that the package install doesn't create.
- **Hooks enforce rules with the wrong version.** The hook that gates an agent's edits is the global one, not the one the repo pins. If there is no global, Cursor blocks everything with an unhelpful "exit 127".
- **The tool itself spreads the problem.** Doctor messages, session-start notices and the staleness prompt all recommend `npm i -g @deftai/directive@latest`. One of them will run it for you if you answer "yes".
- **Four packages with loose ranges.** An "exact" pin on the CLI can still pull a different core or content.

The fixes shipped since the ticket was filed (#4692, #4710, #4718) made the pin *follow* the global CLI. That stops the specific deadlock but keeps the wrong thing in charge. This proposal reverses that.

## A4. Solution Concept

**The pin is the version. Product code and content come from the package. Local wiring completes on first runtime use.**

Two packages, and only two:

| Package | What it is | Where it goes | Has a version that matters? |
| --- | --- | --- | --- |
| `@deftai/directive` | **The launcher.** Small. Gives you the `directive` command, finds the repo, hands off, and does the parts of install/upgrade/uninstall that the runtime can't do to itself. | Global, once per machine | No |
| `@deftai/directive-runtime` | **The runtime.** Everything else: the commands, the hooks, the content, the engine, the types and schemas. | The repo's `package.json` and `node_modules` | **Yes — this is the pin** |

"Directive loads the runtime." Inside the monorepo, `core/`, `content/` and `types/` stay as private folders with their crisp boundaries — content is data agents read and contains no code; types are shapes and schemas; core is behaviour — and the runtime's build bundles them. None of them is published.

Five rules:

1. **The repo decides.** The exact `@deftai/directive-runtime` version in the repo's `package.json`, with the lockfile, is the only statement of which Directive version this repo uses. It is committed, so everyone who clones the repo gets the same answer.
2. **The runtime runs from the repo.** Inside a repo, `directive` always runs the runtime in that repo's `node_modules`. The launcher contains none of the runtime's logic, so it cannot run a different version's behaviour even by mistake.
3. **Everything points into the package.** All existing integration features resolve product code/content under `node_modules/@deftai/directive-runtime/`. No copied product content remains. A previously configured clone gets content from the package install; its first eligible runtime invocation verifies/completes local activation (§A6.2).
4. **The global is required.** Install it once per machine. Standard installation/wiring recovery is `npm i -g @deftai/directive`, then `directive install --repair`. The launcher restores the exact project pin; it never substitutes the global version. We do not teach npx/pnpm-exec shortcuts.
5. **Mutating installation commands show a bounded plan, take one approval and verify the result.** `--yes` supports automation; `--dry-run` stops at the preapproval plan. Doctor is read-only.

Something that installs, something that upgrades, something that uninstalls, something that diagnoses:

| Command | What it means | Changes the version? | Touches `xbrief/` data? |
| --- | --- | --- | --- |
| `directive install` | Set up the repo; reruns repair the exact pin and wiring. | Sets an initial pin; never moves an existing one | Reads settings; first-time install may create missing initial seed project-data files; repair does not |
| `directive upgrade` | Deliberate version change, supported legacy conversion, or same-version data migration. | Yes when target differs | Migrates existing project data after approval |
| `directive uninstall` | Take Directive out of this repo, whatever state it is in. | — | Never |
| `directive doctor` | Tell me what's wrong and what to run. Changes nothing. | No | Never |

`init`, `update` and `remove` are accepted as other names for `install`, `upgrade` and `uninstall`. There is no `sync`, no `migrate`, no `bootstrap`, no `doctor fix`. An unknown command prints the known commands and the closest match.

The split that protects a team: **only upgrade moves an existing pin or migrates existing project data within installation management.** Repair keeps the exact pin; ordinary product-data commands are unaffected; first-time install may create missing initial seed project-data files (§A6.3).

How the main situations play out:

| Situation | What happens |
| --- | --- |
| New machine | `npm i -g @deftai/directive`. Once. |
| New repo | `directive install`. One approval. |
| Clone or new worktree | Run the project PM install. Committed pointers resolve; first eligible runtime command or registered hook completes local wiring and activates Git hooks. |
| Someone upgrades the repo | They run `directive upgrade` and commit. Teammates pull and run `pnpm install`. |
| Dependabot bumps the pin | After PM install, first runtime use checks readiness for the installed pinned version, completes wiring if needed, and reports old data separately as requiring `directive upgrade`. |
| Two repos, two versions, one machine | The launcher runs whichever runtime the current repo pins. |
| Something is broken | Standard installation/wiring recovery: `npm i -g @deftai/directive`, then `directive install --repair`. Doctor diagnoses without fixing. Supported legacy conversion or data migration uses deliberate `upgrade`. Invalid pins must be rectified by the user. |
| Launcher missing | Nothing runs by name. Install it. Hooks and skills still work, because they don't use it. |

## A5. The launcher

The one piece that lives outside the repo. Not to be confused with the hooks (§A5.8).

### A5.1 What it is

The `@deftai/directive` npm package. One small, self-contained JavaScript file with no dependency on the runtime. Not a background service; no configuration, no state. A `node` process starts when you type `directive`, does its job, and exits.

It has four jobs:

1. **Route.** Find the repo you are in and hand the command to that repo's runtime.
2. **Bookend.** Do the parts of `install`, `upgrade` and `uninstall` that a runtime cannot do to itself: discover the project, show the plan, take approval, change `package.json` through the package manager, verify, and hand the verified runtime its setup step.
3. **Uninstall on its own.** Take Directive out of a repo even when the runtime is missing or broken.
4. **Hint.** When the runtime can't run, say why and what to type.

### A5.2 Who installs it, where, and how it gets on the PATH

- **Each engineer installs it, once per machine.** CI images install it too.

  ```text
  npm i -g @deftai/directive
  ```

- The package's `package.json` declares the commands `directive`, `deft` and `deft-hook`. The package manager puts them in its global bin folder, which is already on the `PATH`. No install script.

  | Installed with | The `directive` command | The package |
  | --- | --- | --- |
  | npm, macOS/Linux | symlink in `<npm prefix>/bin/` | `<npm prefix>/lib/node_modules/@deftai/directive` |
  | npm, Windows | `directive.cmd` in `%AppData%\npm\` | `%AppData%\npm\node_modules\@deftai\directive` |
  | pnpm | in `$PNPM_HOME` | pnpm's global store |

- **Directive never installs, upgrades or removes the launcher.** Upgrading a project never touches it (INIT-19).
- **It can disappear** — `npm rm -g`, or switching Node versions with nvm/fnm/Volta. The answer is to install it again. Hooks and skills in a repo don't depend on it.

### A5.3 What happens when you type `directive <something>`

1. The shell finds `directive` on the `PATH` and starts `node` on the launcher's file.
2. **Check Node.** Below 20: stop with one readable line. Below 22: print the best-effort warning and continue.
3. **Find the project.** Use Git's working-tree discovery (`git rev-parse --show-toplevel`) when Git is available; otherwise the explicit `--root` or the current directory, after checking for an enclosing workspace. If that moves up from where you are, say so (INIT-05, INIT-06). One Directive install per repository, at the root (§A9).
4. **Read the pin** from the project's `package.json`.
5. **Look at the installed runtime** — read `version` and the contract number from `node_modules/@deftai/directive-runtime/package.json`. This reads a file; it loads no runtime code.
6. **Decide:**

| What it found | What the launcher does |
| --- | --- |
| The command is `install`, `upgrade` or `uninstall` | Runs its bookend (§A5.4). |
| Runtime installed, same version as the pin | Starts the runtime with your arguments, passing the project root explicitly, and returns its exit code. |
| Pin present, runtime missing or a different version | Ordinary delegation stops with the observed mismatch and the standard launcher-plus-repair recovery sequence. Installation bookends retain their defined behavior; uninstall proceeds with launcher fallback without requiring repair. |
| Runtime speaks a newer contract than this launcher knows | Does not start that runtime. Commands needing delegation stop: "This launcher is too old for this project. `npm i -g @deftai/directive@latest`." Uninstall proceeds with launcher fallback and requires no launcher or runtime upgrade. |
| An old-style install (§A6.7) | Stops: "This project uses an older Directive layout. Run `directive upgrade`." |
| No project | `install`, `--version`, `--help` work. Anything else: "No Directive project here. Run `directive install`." |
| Unknown command | Ordinary commands pass to the verified runtime for validation/help. Retired installation verbs remain rejected; no exhaustive launcher command list gates newer runtime commands. |

`directive --version` shows both halves and does not describe a bare pin as a working installation: `launcher 0.128.0 · project pins 0.130.0 (installed and verified)`.

### A5.4 The bookends

A package cannot safely install, replace or delete the code it is running from. So the three mutating commands are split between launcher and runtime, and they all follow the same shape, from the CLI specification (Part C): **discover → plan → one approval → change → verify → hand off → report.**

| | `install` | `upgrade` | `uninstall` |
| --- | --- | --- | --- |
| **Discover** (read-only) | Root, PM/evidence, current pin and new/configured/inconsistent state | Same, plus exact target resolved before approval; for an equal target, data status from the verified runtime's read-only diagnostic contract | Present owned artifacts from persistent ownership records and the launcher's supported-layout knowledge |
| **Plan shown** | Operation, absolute root, PM/evidence, exact version, expected manifest/lockfile changes, actual PM command or none, bounded setup scope and settings/data preservation | Current → target, expected dependency changes, PM command or none, disclosure of setup/migrations; individual changes only where known beforehand | Known owned removals and what is kept |
| **Approval** | `Set up Directive in this project? [y/N]` / `Repair Directive 1.2.3 in this project? [y/N]` | `Upgrade Directive from 1.2.3 to 1.3.0? [y/N]` | `Uninstall Directive from this project? [y/N]` |
| **Change** | Minimal manifest if needed; native exact dev add; repair restores package only if needed | Native exact runtime add for a version change, replacing supported pre-split pin; equal-version migration needs no reinstall | Use the repository uninstaller when safely available, then launcher cleanup from ownership records and known artifacts; remove known owned registrations before targets and the dependency, protecting shared user content and other worktrees |
| **Verify** | Manifest has the exact pin; lockfile records it; the package is installed; its version matches (INIT-14) | Same, for the target | The removed things are gone; what remains is listed |
| **Hand off** | Verified runtime setup with explicit destination/operation, settings reads and first-time-only seeding (§A6.3); never PATH/download fallback or recursion | Version change: target setup then migrate. Equal version: if wiring/GENERATION/readiness is not current for the pinned version, setup then migrate; if already wired for that version, data migration only (using the runtime's read-only data-status contract) | — |
| **Report** | Operation, destination, verified version, actual files changed, next command, what to review and commit | Same, plus "the global launcher was not changed" | Actual removals, preserved material, known leftovers and uncertainty; distinguish complete removal from best-effort cleanup |

`--yes` approves a fully resolved ordinary plan for a **launcher bookend** command (`install` / `upgrade` / `uninstall`). It never chooses between operations, never authorises overwriting user content, and never bypasses a check. `--dry-run` stops at this preapproval plan and changes nothing; metadata resolution is allowed, but no install, setup, migration simulation or exhaustive diff is required. With no terminal and no `--yes`, a mutating command exits 2.

**Two bounded mutation authorities.** Plan/`--yes` cover launcher bookends only. **Automatic setup** on an eligible ordinary runtime command or registered hook is a separate, bounded authority: it may refresh owned wiring, `GENERATION.json`, Git-hook activation, and per-checkout readiness for the already-pinned installed version; it does not move the pin and does not migrate existing project data.

The launcher needs no target-specific migration knowledge before approval, and no temporary target planner is required. After installation and verification, the actual target returns created, modified, removed and migrated paths plus outcomes/failures; the launcher combines these with PM results. If the runtime cannot complete something safely within the approved high-level scope (for example an unresolved user-content conflict), it finishes safe work, names the conflict, and exits non-zero. A “new proposal” means the user starts a **new** command with a new plan — not a second in-process approval prompt after handoff.

### A5.5 The contract between launcher and runtime

A launcher of one version must work with runtimes of many versions, so the interface is small, written down, and numbered.

**How the launcher learns about a runtime, without running it:** two fields in the runtime's `package.json` — `version` and a contract number (for example `"directive": { "contract": 1 }`).

**How the launcher starts the runtime:** as a separate `node` process on the runtime's entry file, found by path under the verified project's `node_modules`. The user's arguments unchanged. The project root and the launcher's version passed explicitly. Input, output and exit code passed straight through.

**The fixed entry points** (contract 1). Ordinary commands pass through as typed. The bookends call:

| Entry point | Called when | The runtime must |
| --- | --- | --- |
| *setup* `--operation install\|repair\|upgrade --from <version\|old-style\|none> --root <path>` | After launcher verification **or** eligible runtime automatic setup (same entry point and obligations) | Write all integration wiring and generation metadata, verify local activation and record readiness. May read settings; create missing initial seed files only for `--operation install` (see §A6.3). Never migrate existing data. Return actual changes/conflicts; exit 1 if unresolved. |
| *migrate* `--from <version> --root <path>` | By upgrade after setup for a version transition; after setup when equal-version wiring was stale; or directly for equal-version data migration when wiring is already current | Migrate supported xbrief/vbrief schemas, return actual changes/results; retries preserve completed work. |
| *uninstall* `--root <path>` | Before the launcher removes the package, if the runtime can run safely under a compatible contract | Remove owned hook entries first, then owned files/sections; return removals and what remains so launcher cleanup can continue |
| `doctor` | Any time; also the source of the launcher's equal-version data-status decision | Full read-only diagnosis (§A5.7), with a contract result distinguishing data current, migration needed and diagnosis failed |

For equal-version upgrade, the launcher obtains data status from the verified local runtime's read-only diagnostic contract before deciding between a no-write no-op and a migration approval (and, when wiring is stale, includes setup in the plan). Diagnostic failure is an error, never evidence that data is current. This read-only exchange performs no setup or migration and is allowed during discovery and dry-run. Its serialization and transport are implementation choices in the contract document; it requires no new public command or temporary target planner.

**Exit codes** (INIT-23): `0` success, or nothing to do, or explicit cancel · `1` operational or validation failure (including named conflicts) · `2` invalid arguments or a missing choice in non-interactive use · `130` interrupted.

**Rules for changing the contract:**

- A launcher supports every contract number from 1 up to its own. A newer launcher always works with an older runtime.
- An older launcher meeting a newer contract does not start that runtime. Operations requiring delegation stop with the "launcher too old" message. Uninstall instead uses its persistent-record/known-artifact fallback without requiring either package to be installed, repaired or upgraded. It never guesses how to execute an unsupported runtime or substitutes another release (INIT-02).
- The number goes up only when a launcher must behave differently. Adding runtime commands does not change it.

**The runtime checks itself too.** Its first act on any command or hook is to confirm that its own version equals the pin, including executable paths that never go through the launcher. Passive skill reads use the installed package's content and match the pin once project packages are synchronized. Reading Markdown does not itself check versions or repair the installation; the executable guard does not prevent stale skill reads before package synchronization.

### A5.6 What the launcher knows, and what it must not

Allowed:

- the Node version check;
- finding a project root (Git-aware), reading and minimally editing `package.json` (INIT-12);
- telling npm and pnpm apart from project evidence (INIT-08), running their add / install / remove with the project's own settings (INIT-10), and refusing Yarn and Bun clearly;
- asking the registry for the latest stable runtime version, and validating an exact `--target-version`;
- plans, prompts, `--yes`, `--dry-run`;
- the contract in §A5.5;
- recognising an old-style install, and — for `uninstall` only — interpreting the persistent ownership record and using the removal map for supported install shapes; initial scope and historical expansion are in §A6.7.

Its hints:

| It sees | It says |
| --- | --- |
| No project | "No Directive project here. Run `directive install`." |
| Pin, nothing installed | Report missing installation; recovery is `npm i -g @deftai/directive`, then `directive install --repair`. |
| Installed runtime ≠ pin | Report X versus pinned Y; give the same launcher-plus-repair recovery sequence. |
| Package manager not found / unsupported | "This project uses pnpm, which isn't on your PATH." / "Yarn projects aren't supported yet." |
| Node below 20 | "Directive needs Node 20 or later; you have 18.19.0." |
| Node 20 or 21 | "Node 20 reached end of life on 30 April 2026. Directive is tested on Node 22 and 24 and runs on 20 on a best-effort basis." |
| Contract too new | For operations requiring runtime delegation: "This launcher is too old for this project. `npm i -g @deftai/directive@latest`." Uninstall uses launcher fallback without requiring that update. |
| Old-style install | "This project uses an older Directive layout. Run `directive upgrade`." |
| Unknown command | Ordinary commands pass to the verified runtime for validation/help. Retired installation verbs remain rejected; no exhaustive launcher command list gates newer runtime commands. |

Not allowed: anything about hooks, skills, content, `GENERATION.json`'s meaning, or what a healthy install looks like — except the uninstall ownership record and removal map. The runtime supplies schema status through the read-only contract; the launcher does not acquire schema-specific knowledge. Everything else changes between versions, and the launcher's version is whatever that machine happens to have.

### A5.7 `doctor`

Read-only, always, including every hook/helper/subprocess it invokes. It never installs, repairs, writes or invalidates readiness markers, rewrites generated files or changes Git configuration. When it spawns the committed hook command as a probe, it sets `DEFT_DOCTOR_HOOK_DIAGNOSTIC` so the hook suppresses automatic setup and reports the observed state only.

- **In the runtime:** the full installation/readiness check plus existing diagnostics, updated to package paths. Report faults using standard launcher-plus-repair guidance; supported legacy conversion and data migration require `directive upgrade`. Invalid exact-pin declarations are errors for the user to rectify. Newer releases and Node support notes are information only.
- **In the launcher**, when the runtime can't run: the basic diagnosis from §A5.6, ending in the same advice.

### A5.8 Launcher versus hooks

| | **Launcher** | **Hooks** |
| --- | --- | --- |
| What | The global `directive` command | The checks AI hosts run before an agent acts |
| Package | `@deftai/directive` | Part of `@deftai/directive-runtime` |
| Lives | On the machine, outside any repo | In the repo: committed config files that call the runtime by path |
| Installed by | The engineer, once per machine | `install` / `upgrade`, automatically |
| Shared via git | No | Yes |
| If missing | Install it; nothing else works by name | Rules aren't enforced (Cursor blocks edits) until `pnpm install` |
| Uses the other? | — | **No.** Hooks never go through the launcher. |

## A6. Solution Detail

### A6.1 What lives where

```text
repo/
  package.json            exact "@deftai/directive-runtime": "X.Y.Z"   committed   THE PIN
  <lockfile>              npm / pnpm                                   committed
  node_modules/
    @deftai/directive-runtime/   commands, hooks, content, engine     ignored (the install)
  .deft/
    GENERATION.json       version that last ran setup; package        committed
                          manager it used; persistent ownership/removal record + fingerprints
    directive/
      wiring-ready.X.Y.Z.json  verified local activation for X.Y.Z   ignored; per checkout
    (other existing data/state retains its current ownership/layout)
  .claude/ .cursor/ .codex/ .grok/ .agents/ .github/ (and other existing integrations)
                          skill pointers and hook configs, pointing   committed
                          into node_modules/@deftai/directive-runtime/
  .githooks/, AGENTS.md (managed section), Taskfile include           committed
  xbrief/                 the user's project data                     committed; each file has its own schema version

machine
  <global folder>/@deftai/directive       the launcher (§A5)
```

- **No new `.deft/core` content copy.** Product content, schemas and documentation live in the runtime package. Conversion/uninstall removes the legacy copy even if edited; installed package content is disposable too. Project data/settings and shared-file user content remain protected. Neither `.deft` nor `.deft/core` existence alone establishes an installation.
- **(v261027) One pin-content prefix; host outer is separate.** Every *product content* reference Directive writes — the `AGENTS.md` section (`node_modules/@deftai/directive-runtime/main.md`), each skill pointer (`node_modules/@deftai/directive-runtime/skills/<name>/SKILL.md`), git-hook and Taskfile resolution of the runtime binary, and the pin `hook-bin.js` loaded after entry guards — targets `node_modules/@deftai/directive-runtime/`. That path exists at the repo root under both npm and pnpm because the runtime is a direct dependency and contains its own content. **Registered host agent-hook commands** are the committed per-host Node `.mjs` outer (AC9.1); they do not themselves live under `node_modules/`, so the outer can run the entry-guard order when the pin package is absent.
- **One recovery instruction.** README, AGENTS, pointers and installation/wiring diagnostics teach `npm i -g @deftai/directive`, then `directive install --repair`. Installing the launcher does not change the runtime pin. Repair handles PM restoration internally and requires an existing unambiguous exact runtime pin; ranges/conflicts/missing pins are errors, never guesses. No Directive process runs the global command itself.
- **`.deft/GENERATION.json` stays committed.** It records the runtime version that last ran setup, the package manager setup used, and persistent ownership/removal information with fingerprints. The record travels with the committed wiring and survives runtime-package loss or damage. It distinguishes wholly owned files from Directive-owned marked sections or structured entries in shared files and identifies settings/data that must survive uninstall. Reuse existing Directive section markers where available rather than introducing a second marker convention. Install, upgrade and repair setup maintain this record; its representation is an implementation detail, not a generic installer framework. No absolute paths or timestamps that change on every run are recorded. The package manager is a fact about the last setup, not the source of truth: detection always uses project evidence, and the recorded value is used only for drift diagnostics; actual PM selection uses project evidence.
- **Narrow ignore changes only.** Add missing `node_modules` and `.deft/directive/wiring-ready.*.json` entries as needed. Generation remains committed; broader ignore/housekeeping changes are deferred. Future direction: move Directive-specific settings out of PROJECT-DEFINITION into committed `.deft/directive/settings.json` (or config equivalent), with ephemeral state separate and ignored. Xbrief is independent customer-project data that survives uninstall. This proposal does not perform that settings migration; current user-level defaults live at `~/.config/deft/USER.md`.
- **`xbrief/.deft-version` is no longer written.** It is read, like `GENERATION.json`, only as evidence of what an old-style repo was on.

Published packages:

| Package | Contents | Depends on |
| --- | --- | --- |
| `@deftai/directive` (launcher) | One file | nothing |
| `@deftai/directive-runtime` | Today's CLI and core code, the content, the types and schemas — bundled at build time from the private `core/`, `content/` and `types/` folders | its own third-party dependencies only |

Both are published together with the same version number. `directive-core`, `directive-content` and `directive-types` are no longer published; the folders remain in the monorepo, private, with their boundaries intact.

### A6.2 "In sync" — one definition

A checkout is in sync when the exact pin, lockfile and installed runtime agree; `GENERATION.json` records setup for that version; all required integration wiring targets that runtime; and local activation, including Git hooks, has been verified.

Committed wiring and generation metadata travel with a clone/worktree; installed packages and local readiness do not. After the project PM install synchronizes packages with the pin, pointers resolve to that version's content. Before synchronization, passive reads may consume an older installed version's instructions; no version check runs merely from reading Markdown. The **first eligible runtime command or registered host hook** verifies/completes local wiring, even if committed generation is current. Git hooks are activated after that invocation, not promised active immediately after package installation. A passive skill-file read is not an executable trigger; adding a package to a never-configured project does not create discovery wiring (§A9).

**Versioned, per-checkout readiness.** Store successful local verification in ignored `.deft/directive/wiring-ready.<runtime-version>.json`, for example `wiring-ready.1.2.4.json`. Check it against the installed exact-pinned version and cheap wiring-validity evidence. Missing/stale readiness triggers automatic setup. Invalidate superseded markers when rewiring begins; write the new marker only after verification succeeds. Failures/conflicts must never claim readiness. This handles successive PM installs of different versions without invoking the global launcher and does not depend on package-manager install scripts. A stale older marker cannot be reused after a later version partially rewires the checkout.

Eligible automatic-setup invocations are ordinary runtime commands and registered hooks, not diagnostic probes. Installation-management operations (`install` / `upgrade` / `uninstall`) use their explicit setup stages and do not rely on automatic setup.

The runtime contains the shared full check used by setup and doctor. Normal hooks use a cheap identity/readiness check (under 50 ms on a warm filesystem when valid), without full setup on every call. Automatic setup keeps the pin unchanged, may read settings, and follows §A6.3's data boundaries (it does not create initial seed project-data files). Concurrent automatic repairs that target the **same pinned runtime version** are assumed to converge: they apply the same owned changes and may overlap; last writer wins is acceptable. Do not require cross-process locking or spin-wait. Broader overlap with upgrade/uninstall or a package-manager pin change to another version is a known limitation (§A9), not a required transaction system.

Doctor and all its probes remain read-only: they report missing/stale readiness without completing it. When doctor spawns the committed hook command as a probe, it sets the environment variable `DEFT_DOCTOR_HOOK_DIAGNOSTIC` so the hook reports only and performs no automatic setup or installation writes. Ordinary host invocations never set that variable. Data on an older supported schema is reported separately from installation sync; only deliberate upgrade migrates it, including when the package is already current.

### A6.3 `install`

`directive install [--root <path>] [--package-manager npm|pnpm] [--target-version <exact>] [--repair] [--yes] [--dry-run]`

**First time** (no pin):

1. Discover (§A5.4). Package manager from evidence: `--package-manager`, then `packageManager` / `devEngines`, then workspace config and lockfile, then npm. Conflicting evidence stops with an explanation; nothing is migrated or deleted.
2. Target = latest stable, or `--target-version`. Prereleases need `--target-version`.
3. Show the plan. One approval: `Set up Directive in this project? [y/N]`.
4. Create `{ "private": true }` if there is no manifest. Add the exact dev dependency with the package manager. Add only necessary package/readiness ignore entries (§A6.1).
5. Verify. Hand off to the runtime's setup (`--operation install --from none`): all applicable wiring, generation/readiness and missing initial seed files (starter project-data files that do not yet exist); preserve existing data.
6. Report, including what to review and commit (never `node_modules` or ignored readiness markers).

**Run again** (pin exists) — the project counts as configured on the pin alone, even if `node_modules`, the lockfile or generated files are missing (INIT-15):

- Show: `Directive is already configured. Pinned version: 1.2.3.` and a menu — **Repair 1.2.3** / **Cancel**. Cancel is the default, except when the state looks like a fresh clone or worktree (pin present, no conflicting entries, `node_modules` or generated files absent): then Repair is the default.
- `--repair` skips the menu. `--yes` without `--repair` on a configured project stops with instructions and exit 2 — it never picks for you.
- **Repair restores the pinned installation without migrating existing data.** It restores a missing/damaged package, regenerates wholly owned wiring, preserves settings/user data/shared-file user content, verifies and records readiness. It may read settings in xbrief. **Only first-time `install` setup creates missing initial seed project-data files.** Repair and automatic setup never create those seeds; if first install died before seeds appeared, the user reruns `directive install --repair` (wiring) or a fresh install path as appropriate — they do not invent seed permission on a hook. Healthy packages need no reinstall; repeat repair is idempotent. Missing/ranged/invalid/conflicting runtime pins cause an error with no pin change. When the lockfile does not consistently record the exact pin, treat it as unusable for repair and disclose restoring the pin via the PM's exact native add (which updates the lockfile). “Preserve lockfile resolution” applies only when the lockfile already agrees with the pin.
- `install` never offers an upgrade. `--target-version` is rejected with `--repair`.
- On an old-style project, `install` stops and names `directive upgrade`.

### A6.4 `upgrade`

`directive upgrade [--root <path>] [--package-manager npm|pnpm] [--target-version <exact>] [--yes] [--dry-run]`

1. Requires an exact pin, or an old-style install (§A6.7).
2. Resolve the target to an exact version before the prompt. **Before modifying the project**, preflight that target's published contract number from registry/tarball metadata (same family of resolution as picking the exact version). If the contract is higher than this launcher supports, stop immediately, instruct `npm i -g @deftai/directive@latest`, and leave pin/lockfile unchanged. Older than the pin: reject. For an equal target, obtain data status through the verified pinned runtime's read-only diagnostic contract (§A5.5); a failed diagnosis is an error, never a no-op. Equal to the pin **and** data already on the current schema **and** wiring/readiness current: report "already on 1.3.0", change nothing, exit 0 — `directive install --repair` is how you reinstall a version. Equal to the pin with wiring/GENERATION/readiness not current for that version, and/or data behind: the plan includes finishing setup as needed then any required data migration.
3. Show current → target, expected dependency/lockfile changes, actual PM command or none, and disclosure of setup/required migrations. Name only changes known beforehand; actual results come from the installed target. One approval: `Upgrade Directive from 1.2.3 to 1.3.0? [y/N]` (or an equal-version confirmation naming setup and/or migration as applicable).
4. For a version change, add the exact runtime target through the PM, replacing the supported pre-split dependency. Equal-version work does not require reinstallation when the installed package already matches the pin.
5. Verify the target. For a version transition run its setup then migration. For equal-version work: if wiring/GENERATION/readiness is not current for the pinned version, run setup then migration; if already wired for that version, run migration only (or no-op if data is current). Migrate supported schemas, preserving completed work on retry. If already current for both wiring and data, change nothing.
6. Report, listing the changed/migrated files. The global launcher is never changed.

If installation succeeded but setup or migration failed, say exactly that: the pin and lockfile now reference the new version; here is what could not be done; run `directive install --repair` (wiring) or `directive upgrade` again (data) after fixing it (INIT-21, Example F in §C9). No promise of rollback of package-manager operations is made.

### A6.5 `uninstall`

`directive uninstall [--root <path>] [--yes] [--dry-run]`

1. Discover Directive-owned integration files/entries using the persistent ownership record (§A6.1) and the launcher's knowledge of supported current and latest legacy architectures (§A6.7), including generation/readiness metadata and copied legacy core. Retain the discovered removal information for cleanup even if the repository uninstaller removes the record. Ownership does not extend to all `.deft`, node_modules or shared configs.
2. Show the plan: what will be removed, what will be kept (`xbrief/`, user skills, user hook entries, user content in `AGENTS.md`, the rest of `package.json`, the global launcher). One approval.
3. Use the repository uninstaller when it can run safely under a compatible contract; then the launcher removes remaining artifacts identified by its ownership record and existing knowledge. If that uninstaller is missing, damaged, incompatible or fails, continue safe launcher cleanup within the approved scope instead of requiring repair or an upgrade. Remove known owned hook registrations before their targets. Remove whole files only when wholly owned; remove only Directive's marked sections or structured entries from shared files such as `AGENTS.md` and host configs. Reuse existing section markers. Distributed content and wholly owned generated files are disposable even if hand-edited; preserve settings/data designated to survive uninstall and user-owned shared content. Remove `.deft/directive` wholesale only when all its contents are known removable; its name alone is not ownership evidence. No historical checksum preservation is required for unsupported distributed-content edits.
4. Remove the dependency through the PM. Do not blindly clear shared `core.hooksPath` merely because it equals `.githooks`: preserve activation needed by other linked worktrees and unrelated user configuration.
5. Report actual removals, preserved material, known leftovers and any uncertainty. Missing, damaged or unrecognized ownership information permits best-effort cleanup from what the launcher knows, not a claim that every trace is gone. Incomplete cleanup is reported as partial with a nonzero exit; a runtime-uninstaller failure does not by itself mean incomplete cleanup if fallback verifies removal. Print how to uninstall the launcher, but do not do it; other repos may use it.

No `--force`, and no prerequisite installation, repair or upgrade of either the repository runtime or the global launcher. The already-running launcher attempts safe fallback cleanup even when it cannot execute the runtime or understand all removal information; it does not require a newer contract implementation to proceed. Historical expansion remains follow-up work. The ownership record is bounded cleanup information, not permission to delete arbitrary paths or user content.

### A6.6 Hooks and skills that defend themselves

- **(v261027) Agent hooks** are committed as `node <host-deposit>/deft-hook-<sha8>.mjs …` (host and event arguments; timeout argument when the host deposit uses one), not the bare `deft-hook` and not a shell `.sh` wrapper. The outer is identical in role on every OS and PM: Node runs it without a shell. The outer applies the entry-guard order (AC9.12). When the pin is present it loads `node_modules/@deftai/directive-runtime/dist/hook-bin.js` for product decisions. When the pin package is absent, the outer fails closed with clear **project** package-manager install guidance (not a silent host fail-open).
- **Before doing anything else**, the hook checks that it belongs to the project it was asked about and that the cheap in-sync check passes. The payload's project root must match this checkout's root; on mismatch, fail closed (no policy, no automatic setup, host failure code). Normal swarm agents that `cd` into their worktree satisfy this by construction; the guard catches aberrant cross-worktree payloads. If local readiness is absent/stale, it completes wiring under §A6.2, except when `DEFT_DOCTOR_HOOK_DIAGNOSTIC` is set. It never enforces a different version's rules.
- **Git `core.hooksPath`.** Setup / automatic setup may set `core.hooksPath` to the repo's conventional relative value `.githooks` when activating Directive Git hooks. Uninstall may unset it only when it still points at that Directive-owned hooks path and clearing it would not disable a sibling worktree that still needs the shared setting (§A9 / R11). No cross-worktree transaction engine is required.
- **Skill pointers** reference files under `node_modules/@deftai/directive-runtime/`. They are version-free and carry the recovery instruction from §A6.1.
- **Git hooks** and the **Taskfile include** resolve the runtime the same way.
- **Worktrees and clones:** package install materializes the runtime; first eligible invocation completes local activation and records that checkout's readiness. CI may use `directive install --repair --yes` with a valid pin. Cleanup must not disable a sibling worktree's Git hooks.

### A6.7 Bringing old installs into the fold

Directive is not yet released, so the goal is simple: **a clean upgrade to current**, not a launcher that runs old versions.

**Telling old from new:** an exact runtime pin identifies the new model. Initially supported legacy conversion is the latest architecture with an exact pre-split `@deftai/directive` package.json pin and copied core. Neither `.deft`/`.deft/core` existence nor a modern launcher dependency alone establishes a legacy install. Settings/data remnants after uninstall must not block reinstall.

**What a new launcher does in a supported old-style project:** every command except `upgrade`, `uninstall`, `--version` and `--help` stops with "This project uses an older Directive layout. Run `directive upgrade`." It never hands off to an old version.

**What `upgrade` does to it:** converts the supported latest legacy architecture to the exact runtime pin, removes copied core even if locally edited, retains settings/project data and activates all existing applicable integrations against the package. The target performs required supported schema migrations. Direct conversion or internal uninstall/reinstall are both allowed; no complex extensible engine is required. Old generation/version files are evidence only, never version authority. Report actual changes, including tracked core deletion for review/commit.

**What `uninstall` does to it:** removes supported owned tool artifacts from the launcher's map without running the old version, preserving settings, project data and user-owned shared content.

**Initial release versus historical follow-up.** Completion of the initial release/beta requires tested conversion/uninstall for the latest exact-package.json-pin/copied-core architecture, including its integrations and schemas. The full historical layout/schema survey remains required but is separately organized and nonblocking. It later assigns conversion or uninstall/reinstall paths and supplies fixtures for older generations, including Go-era layouts. Do not promise unverified historical recovery at initial release. The Go installer is still removed.

**Old globals against a converted project:** an old global CLI looks for a pin name that is no longer there. The only protection kept is the existing generation check (CLIs from 0.119.10 on refuse to write over a newer generation). The answer to anyone running an old global is to update it. No further defence is built.

### A6.8 Things inside Directive that must change

Inventory the current installer's outputs, including conditional host integrations, copied schemas/docs, Git attributes, review/CodeQL exclusions and core-guard workflows. Verify all useful feature points are retained and correctly wired on fresh install and supported conversion. Remove scaffolding whose only purpose was the retired copied-content model, preserving user-owned shared fields. No active generated references may remain to deleted core content or retired installation commands. The inventory proves completeness; it is not a requirement for a generic installation registry.

- **Collapse to two packages.** Today's `@deftai/directive` code and `directive-core` move into `@deftai/directive-runtime`, with `content/` and `types/` bundled in; `@deftai/directive` is rewritten as the launcher. The publish workflow publishes two packages. The core-vs-content version-skew code goes.
- **Delete the Go installer** (`cmd/deft-install/`) and the "bridge" messages that point at it.
- **Stop copying content.** `.deft/core/` deposit, the deposit hygiene checks, and the three code paths that locate "the content package" all go; the runtime references its own content.
- **Pointers, the `AGENTS.md` template and hooks** are rewritten to package-relative paths with the recovery instruction.
- **`update` rewrites the pin to match the running CLI** (0.119.3), and `doctor` has an "align pin to engine" mode. Both go. The pin is written only by the launcher's `install` and `upgrade`, through the package manager.
- **Replace global-runtime repair advice**, not approved launcher guidance. Installation/wiring recovery uses the launcher-plus-repair sequence. Remove code that performs global installation automatically. Missing/too-old launcher bootstrap is legitimate; updating it never changes the project pin.
- **The "engine ladder" and version-skew windows** disappear. The pinned runtime runs, or nothing does.
- **The old verbs** — `migrate`, `bootstrap`, `install-upgrade`, `install-uninstall` — are deleted outright. Unknown commands list the known ones.
- **`engines.node: ">=20"`** on both packages; CI tests 22 and 24, with a non-blocking job on 20.

### A6.9 Delivery order

1. **Groundwork:** the in-sync check as one module; the owned-files and package-manager record in `GENERATION.json`; the contract written down and signed off; the package collapse (two published, three private).
2. **The switch, in one release:** the launcher with its bookends; the runtime's setup, migrate, self-completing setup and `doctor`; package-relative pointers, `AGENTS.md` text and hooks; removal of the content copy; `upgrade` from old-style; `uninstall` with its map; every next-command message; deletion of old verbs and the Go installer; docs.
3. **Required historical follow-up, separately organized and nonblocking for initial release/beta:** enumerate every historical install layout and xbrief schema version, including the Go-era ones; decide convert versus uninstall-and-reinstall for each; fill in the conversion and uninstall maps.

The first launcher release and the first runtime release are the same release. Initial completion requires supported latest-legacy conversion and current integration checks, not completion of the historical survey.

## A7. What changed from prior install-simplification proposals

Recorded so the lineage is visible. This ticket is self-contained and completely supersedes #4730's body and thread; neither is needed to act on this ticket and must not be consulted for behaviour (see "Authority").

The ticket's direction stands: the pin is the version, the global is a router, hooks use the repo's version. These are the points that change it, with where each decision came from.

| # | Change | Why |
| --- | --- | --- |
| 1 | **No content copy.** `.deft/core/` goes; pointers, `AGENTS.md` and hooks reference the runtime package. The ticket's central mechanism was a copied projection. | Operator. Content comes from the package; committed discovery plus first runtime use completes local activation. |
| 2 | **Two published packages, not four.** `@deftai/directive` is the launcher; `@deftai/directive-runtime` is pinned and contains core, content and types. The ticket chose "same package". | Operator. A launcher with no runtime code can't run the wrong version's logic; the other three packages had no consumers of their own and their `^` ranges made the pin inexact. |
| 3 | **The launcher owns discovery, plan, approval, package-manager changes, verification and hand-off** for the three mutating commands, under a numbered contract. | The CLI specification (Part C); a package can't install, replace or delete itself. |
| 4 | **Verbs: `install`, `upgrade`, `uninstall`, `doctor`.** `install` repairs when rerun and never offers an upgrade. No `sync`, no `doctor fix`. | Operator; the CLI specification (Part C) for the shape of `install`. |
| 5 | **Only upgrade moves an existing pin or migrates existing data within installation management**, after approval. Repair may read settings; only first-time install creates missing initial seed project-data files. | INIT-01/INIT-19 (Part C); operator. The ticket's migration section let a newer global pull the pin, and had `update` run migrations. |
| 6 | **Undo the interim fixes.** #4710/#4718 rewrite the pin from the running CLI. | Contradicts INIT-01. |
| 7 | **(v261027) Hook command: committed host `.mjs` outer via Node, then pin `hook-bin.js`.** Supersedes the earlier direct-only `hook-bin.js` deposit string. | Operator amendment for revision **v261027**. Bare `deft-hook` and `.sh` wrappers remain forbidden. |
| 8 | **Setup completes local wiring** when per-checkout versioned readiness is absent/stale, including a clone with current generation. The ticket's "stretch goal", with `doctor` kept read-only. | Operator, for Dependabot and plain-`pnpm install` teammates. |
| 9 | **The global launcher is required**, installed by the engineer, never by Directive, and can disappear. No `npx`/`pnpm exec` paths are taught. | Operator. |
| 10 | **`uninstall` works from the launcher alone**, using persistent ownership records and known artifacts when the repository uninstaller is unavailable or fails. Neither package needs a prerequisite install or upgrade; incomplete cleanup is reported honestly. Historical coverage follows separately. | Operator. |
| 11 | **npm and pnpm only;** Yarn and Bun refused clearly. | INIT-09 (Part C); operator. |
| 12 | **Clean upgrade to current, no old-tool defence.** A new launcher never runs old versions; the survey of old shapes is a separate sprint; the Go installer is deleted. | Operator; Directive is pre-1.0. |
| 13 | **Narrow package/readiness ignore changes only;** `GENERATION.json` stays committed and records the package manager used. | Operator. |
| 14 | **No redirects for retired verbs.** Unknown commands list the known ones. | Operator. |
| 15 | **Node 20 allowed, 22 and 24 supported.** `engines >=20` with a best-effort warning. | Operator; ~14% of downloads are still on 20. |
| 16 | **Replace global-runtime repair advice and remove automatic global installation.** Approved launcher bootstrap/recovery remains. | Otherwise the tool recreates the problem. |

## A8. Challenges

- **Agents reading under `node_modules`.** The design assumes every host will open a file at `node_modules/@deftai/directive-runtime/...` when a skill pointer or `AGENTS.md` names it. That assumption is based on light testing and is **not an open design question**. Delivery may include a non-blocking smoke confirmation per host; if a specific host cannot follow package-relative pointers, treat it as host-specific remediation — not a reopen of this closed design.
- **Collapsing the packages.** A published package can't depend on unpublished workspace folders, so the runtime's build has to bundle `core/`, `content/` and `types/` into its own `dist`. Ordinary tooling work, but it touches the publish workflow and every import path.
- **Self-completing setup writes on eligible runtime invocation.** Bound it to owned wiring (not initial seed project-data files), preserve settings/data, retain a cheap readiness path, and treat same-pin simultaneous automatic repairs as converging (last writer OK). Report conflicts without claiming readiness. Broader lifecycle concurrency is deferred.
- **Data that is behind.** Repair never migrates existing data. Runtime reads older supported schemas; doctor/session-start name upgrade for migration even at the current package version. Initial legacy coverage is §A6.7; broader history follows the survey.
- **The pin changes name.** Old tools look for `@deftai/directive` and won't find it. By decision, the only defence is the existing generation check.
- **`@deftai/directive` changes meaning on npm.** Up to now it is the whole product; from the split it is a launcher. Adding it locally does not activate an installation; the known-limitation and recovery rules in §A9 apply.
- **The contract has to be right the first time.** Contract 1 will sit on machines for years.
- **Package managers from Node on Windows** already fail today (#5383). Every bookend depends on this.
- **Hook command portability.** Package-relative wiring across existing applicable integrations, three operating systems and two package managers. Needs the test matrix.
- **(v261027) A fresh clone before package installation** has unavailable runtime targets. Managed text and the host outer (AC9.1 / AC9.12) demand a **project** package-manager install first; launcher-plus-repair remains for wiring/pin problems after packages exist. First eligible invocation after package installation completes local activation under AC8.6.
- **Repair semantics.** "Don't reinstall if healthy, but always rerun idempotent setup, and never accumulate changes" needs careful tests.
- **Node 20 best-effort.** Our dependencies must actually run on 20 for "best effort" to mean anything; a non-blocking CI job is how we find out.
- **Directive developing itself.** The exact mechanism for developing and testing Directive itself is left to the Directive principal during implementation and is not specified at design time. It may include global installation, local accommodations, an environment variable, checking Git origin, or another mechanism selected by the principal.

## A9. Known limitations and the decisions behind them

Catalogued so they can be documented for users and revisited deliberately. Each row: what a user will hit, why we chose it, and what would change it. **For the purposes of this ticket these limitations are accepted as weighed decisions. They are to be listed and documented, not re-adjudicated or "solved" as part of this work.**

| Limitation | Why | What would change it |
| --- | --- | --- |
| **The global launcher is required.** Nothing runs by name without `npm i -g @deftai/directive`. A configured clone without a launcher can install packages and use committed pointers/registered hooks; first eligible runtime invocation completes local activation, but `directive` is unavailable by name. | The alternatives were teaching `npx`/`pnpm exec` (bad habits, and bare `npx directive` can fetch the wrong package) or a launcher outside npm (install scripts, PATH edits, orphans). | A shell installer as a second front door, if the one-time global install proves to be a real barrier. |
| **The launcher can disappear** (`npm rm -g`, Node version switch). | It is an ordinary global npm package. | Same as above. |
| **One Directive install per repository, at the Git root.** No per-package pins in a monorepo; no subfolder installs; unrelated projects sharing one repo get one Directive. | Every host reads its config from the project root anyway; one layout we can fully describe. `--root` exists for the no-Git case, not for subfolders. | Allow `--root` to select a subfolder, with discovery stopping at the nearest pin. Nothing in the root-only design prevents adding it. |
| **npm and pnpm only.** Yarn and Bun projects are refused. | Each manager needs its own adapter (workspaces, Plug'n'Play). Pre-1.0, two is what we can test. | A Yarn adapter (INIT-09 describes what it owes). |
| **Repair does not migrate/rewrite existing xbrief data.** It may read settings. Only first-time install creates missing initial seed project-data files; repair and automatic setup do not. A package update may leave old supported data until upgrade. | Data migration is deliberate, approved work. Ordinary product operations are outside this restriction. | Nothing planned; doctor/session-start name `directive upgrade`. |
| **Setup completes local wiring on first eligible runtime invocation.** Package installation alone does not activate Git hooks; passive skill reads do not execute setup. Plan/`--yes` cover launcher bookends; automatic setup is a separate bounded authority for owned wiring/readiness only. | Per-checkout versioned readiness keeps normal checks fast and handles clones/worktrees/package changes without install scripts or a global invocation. | Nothing planned; same-pin simultaneous automatic repairs are assumed to converge (last writer OK). |
| **Passive skill reads are not version-gated.** After a pin change and before package synchronization, a skill pointer may still expose the older installed instructions. | Commands and hooks enforce identity when they execute; reading Markdown executes no check. Passive content matches the pin after PM synchronization. | A separate passive-content enforcement mechanism, which is not part of this design. |
| **Uninstall can be best-effort when the runtime or ownership record is unusable or unfamiliar.** The launcher removes what its persistent record and existing knowledge safely identify, and reports leftovers or uncertainty. | Removal must not require installing, repairing or upgrading either package first. The repository uninstaller is used when safely available, but is not a prerequisite. | Broader removal coverage as it is implemented; no prerequisite upgrade or generic removal framework is required. |
| **Old global CLIs are not defended against.** A pre-split global run in a converted repo is stopped only by the existing generation check (0.119.10+); older ones may write stale files. | Pre-1.0; the answer is "update your global", and the standard launcher-plus-repair sequence repairs wiring where the exact pin remains valid; invalid declarations must be rectified. | A sweep of old versions against a converted repo, if it ever matters. |
| **A new launcher never delegates to an old-style runtime.** Ordinary commands in supported old layouts name `directive upgrade`; upgrade/uninstall and version/help retain their defined behavior. Engineers who update their global must convert each old repo (or leave the global alone). | The launcher contains no runtime code, by design. | Nothing; conversion is the path. |
| **Initial historical support is the latest package.json-pinned/copied-core architecture.** Older layouts may later require uninstall/reinstall. | Few legacy users, pre-release urgency; the full survey is separately organized and does not block initial release/beta. | Required historical survey, per-shape decisions and tested recovery coverage. |
| **Retired verbs are gone, not redirected.** `migrate`, `bootstrap`, `install-upgrade`, `install-uninstall` print "unknown command" with the known list. | Paring down pre-1.0; redirects keep dead names alive. `init`/`update`/`remove` remain as names. | Nothing. |
| **`update` now means `upgrade`.** An old habit of running `update` to refresh now moves the repo to the latest version (after a plan and approval). | `update` is kept only as a courtesy name. The approval prompt is the guard. | Nothing; the prompt makes it visible. |
| **Only package/readiness ignore entries change.** Generation stays committed; broader housekeeping stays where it is. | Future direction: committed Directive settings under `.deft/directive/settings.json`, separate ignored state, and xbrief containing versioned customer-project data. | Separate settings/housekeeping migration, not this implementation. |
| **Node 20 is best-effort.** Allowed by `engines`, warned about, not tested as a gate. | ~14% of Node downloads are still on 20 (July 2026); we won't force an upgrade. Tested lines are 22 and 24. | The warning moves to 22 when it leaves maintenance (April 2027); the floor moves only if something stops working. |
| **`@deftai/directive` changes meaning** from "the product" to "the launcher" at the split version. | Keeps the command people already know. Pre-split versions stay on the registry. | Nothing. |
| **(v261027) Pin package absent before the outer can load `hook-bin`.** With the committed host `.mjs` outer (AC9.1), the outer still runs and fails closed with **project** `npm`/`pnpm` install guidance (entry-guard AC9.12). Residual: Node itself missing, or the host never starts the registered command — host-native behaviour; recover by installing Node and the project packages, then repair if wiring is still incomplete. Invalid pins remain errors. | No fallback to another version's rules. Do not use a shell `.sh` host command. | Host never starts the outer / Node missing (disclosed residual). |
| **No installation-management `--force`.** Conflicts are named and left; destructive replacement is a separate decision. | §C3; uninstall handles supported layouts without needing it. | Nothing. |
| **Three private packages are not consumable by anyone else.** `core`, `content` and `types` are no longer on npm. | No one consumed them; their loose ranges were part of the bug. | Publish again if a real external consumer appears. |
| **Manual package add is not activation.** Adding a runtime or launcher locally to a never-configured project provides no hook registrations, skill pointers or guaranteed discovery; reading Markdown does not run setup. | One supported recovery path, no extra bootstrap machinery: `npm i -g @deftai/directive`, then `directive install --repair`. Repair requires an existing unambiguous exact runtime pin; missing/ranged/invalid/conflicting pins error and must be rectified by the user. | Nothing planned. First-time setup remains `directive install`. |
| **Do not overlap installation-changing commands in one checkout.** Same-pin automatic repairs may overlap and are assumed to converge (last writer OK; no required locking). Coordination with upgrade/uninstall or a PM pin change to another version is not guaranteed. | Rare cross-version overlap does not justify a transaction engine or lifecycle-race test matrix. Wiring may need manual repair; interrupted uninstall/migration has no blanket repair guarantee. | Later demonstrated need; inexpensive safeguards are allowed. Shared Git-hook cleanup must still protect sibling worktrees. |
| **Edits to distributed content or wholly owned generated files are unsupported.** Legacy core is removed and package/generated content replaced even if edited. | These are disposable tool assets, unlike project data/settings and user-owned shared-file content. Avoid historical-hash preservation machinery. | Nothing planned; normal plans disclose removal/replacement scope. |
| **Preapproval plans and dry runs are bounded.** They do not enumerate every target-specific migration or simulate all file changes. | Target code runs after installation/verification and returns actual outcomes; no temporary target planner is required. | Nothing planned. If work cannot complete safely within approved scope, stop/fail and the user starts a new command — not an in-process second prompt. |

---
# Part B — Requirements: One Version Per Repo

Requirements and acceptance criteria for the proposal in Part A. `INIT-01 … INIT-23` are the CLI specification rules in Part C, cited where a criterion comes from one; operator decisions are catalogued in §A7 and §A9. Part C specifies INIT-cited behaviour and fills silence; if this part and Part C appear irreconcilable, stop and ask the operator. The two operator overrides once recorded against the original initializer spec — no `--upgrade` on `install`; the pinned package is `@deftai/directive-runtime` — are already incorporated into Part C's text.

**This part is the contract for the work.** Done means every initial-release acceptance criterion passes. Criteria explicitly marked **follow-up** are required but nonblocking for the initial release/beta. Closed design. No open questions.

**Scope and implementation freedom**

This work governs installation, upgrade, uninstallation, repair and installation-health checks. It supersedes existing commands and logic serving those purposes, including legacy forms that must change or disappear. Unrelated product functionality is unchanged. The four-command restriction applies only to installation management: ordinary product commands and options pass through to the pinned runtime, which owns their help and validation. The launcher does not maintain an exhaustive runtime-command list. Explicitly retired installation verbs remain retired. Restrictions on xbrief writes concern these installation operations, not normal product-data operations.

Install and upgrade must retain and activate all existing feature points under their existing applicability/settings, including OpenClaw, slash commands and Copilot. Lists of outputs are illustrative, not exhaustive. All product references and execution paths must resolve to the project-local runtime package, not copied content or a shared global product runtime. Choose the safest, simplest, highest-confidence implementation with the best return on effort: direct rewiring or internal uninstall/reinstall preserving settings and project data are both acceptable. No generic extensible installer framework is required.

Initial completion and release require the current architecture and conversion from the latest legacy architecture (an exact `package.json` pin with copied `.deft/core` content). The full historical layout/schema survey is a separately organized, required follow-up; criteria explicitly marked **follow-up** do not block the initial release or beta.

**Reading this part**

- "The project" means an end user's repository, not the Directive source repo.
- **Launcher** — the `@deftai/directive` package, installed globally.
- **Runtime** — the `@deftai/directive-runtime` package, installed in the project. Commands, hooks, content, engine, types.
- **Pin** — the exact `@deftai/directive-runtime` version in the project's root `package.json` `devDependencies`.
- **Wiring** — integration files Directive writes, normally committed: skill pointers, host hook configs, git hooks, the managed `AGENTS.md` section, the Taskfile include.
- **Setup** — the runtime entry point for wiring, `GENERATION.json` and per-checkout readiness. It may read settings; first-time install may create missing initial seed project-data files under R8. Repair/automatic setup do not create seeds. Setup never migrates existing project data.
- **Migrate** — the runtime's entry point that brings `xbrief`/`vbrief` files to the current schema. Called only by `upgrade` (R4, R7).
- **In sync** — defined in R2.
- **Old-style project** — set up before the launcher/runtime split. Initial supported conversion is the latest exact-package.json-pin/copied-core architecture; older layouts await the separate survey (R10).
- **Split version** — the first release in which `@deftai/directive` is the launcher.
- **PM** — npm or pnpm. Examples use pnpm.
- **Installation-management commands** — `install`, `upgrade`, `uninstall`, `doctor`. `init` = `install`, `update` = `upgrade`, `remove` = `uninstall`; every criterion applies equally to the other name.
- Unless stated otherwise, every criterion must hold on macOS, Linux and Windows, with npm and pnpm, on Node 22 and 24.

There are no open questions. Where a criterion encodes a decision from §A9, it says so.

---

## R1. The pin is the only source of the version

- **AC1.1** After `install`, `package.json` contains `@deftai/directive-runtime` in `devDependencies` as an exact version — no range, tag or caret (INIT-01).
- **AC1.2** The PM's lockfile records the resolved installation. Directive never generates, edits, fabricates or deletes lockfile contents itself (INIT-01, INIT-13).
- **AC1.3** The runtime has no dependency on any other Directive package. Installing it at `V` installs exactly one Directive package in the project.
- **AC1.4** In a project pinned to `V`, with a launcher at `W ≠ V`, commands and hooks execute only the verified project runtime at `V`. Passive skill instructions come from the installed package and match `V` after project packages are synchronized with the pin. Reading Markdown does not perform a version check or repair and may expose stale installed content before synchronization. A global version never silently replaces or upgrades the pin (INIT-01).
- **AC1.5** The pin is written only by the launcher's `install` (first time) and `upgrade`, and only through the PM's native add operation. `install --repair`, `doctor`, hooks, setup, migrate and every runtime code path never write it.
- **AC1.6** No competing version authority exists. `xbrief/.deft-version` is no longer written. `GENERATION.json` and the ignored versioned readiness marker record completed setup, never override the pin, and are invalid when inconsistent with it.
- **AC1.7** The pin is read from the project root only. One Directive install per repository (§A9). A nested `package.json` is never treated as the project.

## R2. One definition of "in sync"

- **AC2.1** A checkout is in sync only if (1) the exact pin, (2) lockfile and (3) installed runtime agree on V; (4) `GENERATION.json` records setup for V; (5) all required wiring targets V in the runtime package, preserving user-owned shared content; and (6) local activation, including Git hooks, has been verified and has valid readiness under AC8.6.
- **AC2.2** `xbrief` data on an older schema is not an out-of-sync condition. It is reported separately by `doctor` and the session-start hook as "run `directive upgrade`".
- **AC2.3** The check is implemented once, in the runtime. `doctor` and setup call it. A deliberately broken checkout is reported identically by both.
- **AC2.4** Hooks use a cheap check of pin/installed-runtime identity and local readiness validity, completing in under 50 ms on a warm filesystem when readiness is valid. Full setup is not repeated on that fast path.
- **AC2.5** A fresh clone/worktree of a configured project resolves committed skill pointers after the package install. Its first eligible runtime command or registered host hook verifies and completes local wiring, including Git-hook activation, even when committed `GENERATION.json` is already current. The test then runs an actual Git hook and finds doctor in sync. Package installation alone does not guarantee Git-hook activation before that invocation; doctor itself does not activate anything.
- **AC2.6** Before any command or hook operates, the runtime confirms its version equals the exact pin. On mismatch it starts no setup or policy evaluation, exits non-zero and gives the standard installation-recovery guidance (AC9.7).

## R3. The launcher package

- **AC3.1** `@deftai/directive`, from the split version on, has no dependency on the runtime or on any Directive code. A test on the packed tarball asserts an empty dependency list.
- **AC3.2** The launcher is one self-contained file, fully loaded before it runs any PM command, with no lazy loading afterwards.
- **AC3.3** The launcher contains no knowledge of hooks, skills, content, `GENERATION.json`'s meaning or what a healthy install looks like, except the old-style detection (AC10.1) and the persistent ownership/removal record and uninstall map (R11). Schema-status decisions use the runtime's read-only contract result, not launcher-owned schema logic.
- **AC3.4** It keeps no configuration and writes nothing outside the project it is acting on.
- **AC3.5** `npm i -g @deftai/directive` (or `pnpm add -g`) makes `directive`, `deft` and `deft-hook` available on the `PATH` with no install script and no further step.
- **AC3.6** No Directive command, hook, prompt or install script installs, upgrades or removes anything in a global location. Upgrading a project never changes the launcher (INIT-19).
- **AC3.7** Discovery uses `git -C <dir> rev-parse --show-toplevel` when Git is available, supports `.git` files (worktrees), distinguishes "not a repository" from other Git errors, and discloses when it moves up from the invocation directory (INIT-05). Without Git it uses `--root` or the current directory after checking for an enclosing workspace, and never runs `git init` (INIT-06).
- **AC3.8** A filesystem root or the user's home directory is refused as a destination unless selected deliberately; `--yes` does not bypass this (INIT-06). A `--root` that is not the Git working-tree root of a Git repository is refused with an explanation (§A9: root only).
- **AC3.9** It learns the installed runtime's version and contract number by reading the runtime's `package.json`, loading no runtime code.
- **AC3.10** Runtime installed and equal to the pin: the launcher starts that runtime with the user's arguments, passes the project root explicitly, and returns its exit code.
- **AC3.11** Two projects on one machine pinned to `V1` and `V2`: `directive --version` in each reports its own; upgrading one changes nothing in the other.
- **AC3.12** Pin present, runtime missing or at another version: for commands other than `install`, `upgrade`, `uninstall`, `doctor`, `--version`, `--help`, the launcher exits non-zero, starts no runtime and gives AC9.7 recovery guidance.
- **AC3.13** No project: `install`, `--version`, `--help` work; everything else exits non-zero naming `directive install`.
- **AC3.14** `directive --version` reports the launcher version and, when in a project, the pinned version, stating whether that version is installed and verified. A bare pin is never described as a working installation (§C3).
- **AC3.15** Launcher hints follow §A5.6. Approved global-launcher bootstrap/update and standard recovery advice is allowed; advice to replace the project runtime with a global runtime is forbidden.
- **AC3.16** Ordinary commands pass through to the verified pinned runtime without a launcher allowlist. The runtime owns their help, validation and unknown-command response (exit 2, known commands and a close spelling suggestion). Retired installation verbs receive the specified unknown-command response rather than being revived. Tests cover an existing product command and a new command in a compatible runtime without a launcher update.

## R4. The launcher–runtime contract

- **AC4.1** The runtime's `package.json` carries a contract number. Contract 1 is defined by this section and written down in one document in the Directive repo with a test suite named for it.
- **AC4.2** The launcher starts the runtime as a separate `node` process on the runtime's entry file, found by path under the verified project's `node_modules` — never through `PATH`, never through a mechanism that can download a substitute (INIT-14). Arguments unchanged; project root and launcher version passed explicitly; stdio and exit code passed through.
- **AC4.3** Contract 1 defines these entry points beyond ordinary pass-through:

  | Entry point | Called | Runtime's obligation |
  | --- | --- | --- |
  | setup `--operation install\|repair\|upgrade --from <version\|old-style\|none> --root <path>` | after the launcher verified the install, **or** by eligible runtime automatic setup (same entry point and obligations) | write/refresh wiring; record itself in `GENERATION.json`; run the in-sync check; do everything safe; name every conflict; exit 1 if any; may read settings; create missing initial seed project-data files only for `--operation install` (AC8.4); never migrate existing data |
  | migrate `--from <version> --root <path>` | by upgrade after setup for a version change; after setup when equal-version wiring was stale; or directly for equal-version data migration when wiring is already current | migrate supported `xbrief`/`vbrief` schemas to current; return actual changes and outcomes |
  | uninstall `--root <path>` | before the launcher removes the package, when the runtime can run safely under a compatible contract | remove owned hook entries first, then owned files/sections; return removals and what remains for continued launcher cleanup |
  | `doctor` | any time; also before the equal-version upgrade decision | full read-only diagnosis, including all child processes; supply a contract result distinguishing data current, migration needed and diagnosis failed |

- **AC4.4** The hand-off never recursively invokes the launcher's `install` flow, and the approved operation survives the hand-off without a second discovery (INIT-03, INIT-14).
- **AC4.5** Exit codes everywhere (launcher and runtime): `0` success / nothing to do / explicit cancel; `1` operational or validation failure; `2` invalid arguments or a missing choice in non-interactive use; `130` interrupted (INIT-23).
- **AC4.6** A launcher supports every contract number from 1 up to its own. A compatibility test runs the newest launcher against a runtime at every shipped contract number.
- **AC4.7** A launcher meeting a higher contract number never starts that runtime or chooses another release (INIT-02). Operations requiring delegation stop and explain which launcher update is required. Uninstall instead proceeds with launcher fallback (R11), without requiring installation, repair or upgrade of either package. When selecting a not-yet-installed upgrade target, preflight that target's published contract before modifying the project; if too new, stop with the same launcher-update guidance and leave pin/lockfile unchanged.
- **AC4.8** The contract number increases only when launcher behaviour must change; the release checklist says so.
- **AC4.9** After execution, the verified target runtime returns actual created, modified, removed and migrated paths, outcomes and failures to the launcher for its completion/partial-failure report. No target-supplied preapproval planner or temporary target execution is required.
- **AC4.10** For equal-version upgrade, the launcher obtains data status from the verified pinned runtime through the read-only diagnostic contract before choosing a no-op, migration-only, or setup-then-migration plan (setup when wiring/GENERATION/readiness is stale for the pin). The result distinguishes current data, migration needed and diagnostic failure; failure exits nonzero and is never treated as current data. The diagnostic exchange itself performs no setup or migration, including during dry-run. Serialization and transport remain implementation choices in the contract document; no new public command or schema knowledge in the launcher is required.

## R5. Common command behaviour (`install`, `upgrade`, `uninstall`)

- **AC5.1** Before mutation, show a bounded plan: operation, absolute destination, PM and selection evidence, current version where relevant, exact target, expected manifest/lockfile changes, and disclosure of target setup and upgrade migrations as applicable. The default human plan states the package-manager effect in plain language; the actual PM command (or no PM operation) and permitted-install-script disclosure appear at `-v`/`--verbose` as part of that same plan. Include known managed changes and preservation of settings/project data. The launcher need not enumerate target-specific migrations or every changed file before the target is installed (INIT-11). Disclose the Node best-effort note when relevant.
- **AC5.2** One operation-specific confirmation, default No. That approval covers the disclosed changes, installation and setup for launcher bookends. If work cannot complete safely within that scope, stop/fail and report; a “new proposal” means the user starts a new command — not an in-process second prompt (INIT-11).
- **AC5.3** `--yes` approves a fully resolved ordinary plan. It never chooses between operations, never authorises overwriting user content, changing PM, or bypassing a check (INIT-20).
- **AC5.4** `--dry-run` stops at the preapproval plan in AC5.1, changes no project files and runs no package installation, setup or migration. Read-only registry metadata requests and the verified installed runtime's equal-version diagnostic exchange (AC4.10) are allowed. It does not simulate the target or promise an exhaustive file diff, and needs no approval.
- **AC5.5** With no interactive terminal: never wait for input; a mutating command without `--yes` exits 2; unresolved destination or PM ambiguity exits 2 with the flags to supply (INIT-20).
- **AC5.6** PM selection order: `--package-manager` (validated against project evidence), then `packageManager` / `devEngines.packageManager`, then workspace configuration and lockfile, then npm. Conflicting evidence stops with an explanation. Neither the launcher's own install method nor the PM recorded in `GENERATION.json` is used as evidence (INIT-08).
- **AC5.7** Yarn and Bun projects are recognised and refused with a clear message. Nothing is installed into them with npm (INIT-09).
- **AC5.8** The project's registry, authentication, proxy, lockfile and install-script settings are honoured; the declared PM version is used when available; a missing PM or version is explained, never installed or switched; Corepack is used if present, never assumed. No secrets are printed (INIT-10).
- **AC5.9** Workspaces: the repository root is distinguished from the PM installation scope; a root dev dependency is preferred where it fits; no competing manifest or lockfile is created inside an existing workspace; `--root` never authorises unannounced changes outside it (INIT-07).
- **AC5.10** `package.json` edits are minimal: unrelated fields preserved, no reformatting, no added name/license/type/engines/`packageManager`/scripts, no `private: true` added to an existing manifest. A new tooling-only manifest starts as `{ "private": true }` and is explained in plain language (INIT-12).
- **AC5.11** Dependencies are added only with the PM's native add operation, exact and dev, with the dev dependency physically installed even if the environment would omit dev dependencies. `npm ci` is never used to introduce or upgrade the dependency. Lockfile policy conflicts stop with an explanation (INIT-13).
- **AC5.12** Before setup runs, the launcher verifies: the manifest has the approved exact pin; the lockfile records it consistently; the package is installed; its version matches (INIT-14).
- **AC5.13** A clean Git working tree is not required. Before writing, the launcher checks that relevant files have not changed in a way that invalidates the plan (INIT-21).
- **AC5.14** On installation, verification, setup or migration failure: stop; say what failed, what succeeded and what remains; known file changes; the next useful command; exit non-zero. Uninstall has the explicit R11 fallback: an unavailable or failed repository uninstaller permits continued safe launcher cleanup within the approved scope, with partial cleanup reported nonzero. "No files were changed" only when verified. No automatic lockfile deletion, Git reset, discarded user changes, weakened checks, bypassed script policy, or fallback to a global product runtime (INIT-21).
- **AC5.15** Interruption never reports success; after an interrupted mutation the report says partial changes may remain unless verified (INIT-21).
- **AC5.16** Completion combines PM results and actual runtime results (AC4.9): operation, destination, verified version, actual created/modified/removed/migrated files, next action and review/commit list. For uninstall, include launcher cleanup results, preserved material, known leftovers and uncertainty; a verified runnable runtime is not required to report removal. Never list `node_modules` or ignored readiness markers for commit, or invent file changes (INIT-22).
- **AC5.17** A general `--force` option does not exist (§C3).

## R6. `install`

- **AC6.1** `directive install` in a project with no pin: discover; target = latest stable or `--target-version <exact>` (ranges, tags and unsupported specs rejected; prereleases require `--target-version`); plan; `Set up Directive in this project? [y/N]`; manifest created if needed; PM add; `node_modules` ignore entry only if one is needed; verify; hand off to setup `--operation install --from none`; report. One meaningful approval (INIT-02, INIT-12, INIT-13).
- **AC6.2** After a first `install`, the project is in sync and `doctor` reports so without any further command.
- **AC6.3** An exact runtime pin is sufficient to select repair even when installed/generated files are absent. Repair requires an existing unambiguous exact pin: missing, ranged, invalid or conflicting declarations cause an explicit error with no pin change or inferred version. The user must rectify invalid declarations; they are not treated as clean first installs (INIT-15).
- **AC6.4** On a configured project, interactive `install` with no flag shows the menu **Repair <pin>** / **Cancel**, with the project path and pinned version (INIT-16). Cancel is the default, except when the pin is present, no conflicting entries exist, and `node_modules` or generated files are absent — then Repair is the default (INIT-15).
- **AC6.5** The menu never contains Upgrade. `--target-version` with `--repair` is rejected (exit 2). `install` never resolves or selects the registry's latest release on a configured project.
- **AC6.6** `--repair` selects repair without the menu; the plan and approval are still shown unless `--yes`. `--yes` without `--repair` on a configured project exits 2 with the exact commands to choose from (INIT-20, Example E in §C9).
- **AC6.7** Repair keeps the pin unchanged; restores missing or damaged installed components, saying what scope a reinstall touches; reruns the pinned runtime's setup; recreates missing managed files when safe; preserves user settings, content and unrelated files; verifies before reporting success (INIT-17).
- **AC6.8** Repair may read project settings, including current xbrief policy, but never migrates or rewrites existing xbrief data and never creates initial seed project-data files (AC8.4). A test preserves existing data byte-for-byte while using its settings to wire correctly.
- **AC6.9** A healthy installation needs no reinstall, but setup still runs. Running repair twice produces no further changes (INIT-17).
- **AC6.10** When the lockfile consistently records the exact pin, repair preserves its resolution. When the lockfile is missing, unusable, or does not consistently record the exact pin, treat it as unusable for repair and disclose restoring the pin via the PM's exact native add (INIT-17).
- **AC6.11** Repair never silently escalates to broad deletion, force flags or security-policy changes. Distributed content and wholly owned generated files follow AC8.3; conflicts affecting user-owned content are named and preserved. Destructive replacement of user-owned material requires a separate explicit decision (INIT-18).
- **AC6.12** In a project with no `package.json`, `install` creates `{ "private": true }` and continues (INIT-12).
- **AC6.13** On an old-style project, `install` changes nothing and names `directive upgrade`.
- **AC6.14** `directive init` behaves identically.

## R7. `upgrade`

- **AC7.1** `directive upgrade` requires an exact pin or an old-style project; otherwise exit 2 naming `directive install`.
- **AC7.2** The target — latest stable or `--target-version <exact>` — is resolved to an exact version before the prompt and not resolved again after approval (INIT-02). Before modifying the project, preflight that target's published contract from registry/tarball metadata; if higher than this launcher supports, stop with launcher-update guidance and leave pin/lockfile unchanged.
- **AC7.3** Target older than pin: reject. For an equal target, obtain data status using AC4.10 before selecting the outcome. Diagnostic failure is an error, never a no-op. Equal target with wiring and data current: no-op, no writes, already-current report. Equal target with wiring/GENERATION/readiness not current for that version, and/or data behind: after the bounded plan and approval, the verified pinned runtime runs setup as needed then any required migrations, without a required package reinstall. Retrying interrupted migration preserves completed work and safely finishes remaining work.
- **AC7.4** The preapproval plan gives current/target versions, PM operation if needed, expected dependency/lockfile changes and disclosure that the installed target performs required setup and/or migrations while preserving project settings/data. Only changes known beforehand are described individually. Actual paths and results come from the target afterward; no exhaustive preview or separate target planner is required.
- **AC7.5** For a version transition, the PM installs the exact target (replacing a supported pre-split dependency) and updates the lockfile; verification follows (AC5.12), then the target runtime setup and migration. Equal-version work follows AC7.3: setup then migrate when wiring is stale; migrate only when wiring is already current for the pin (after AC4.10 status).
- **AC7.6** The code that finishes the upgrade is the new version's. A test upgrades `V → W` where `W`'s setup writes a marker `V` does not know, and finds it.
- **AC7.7** Existing configuration is preserved unless an approved migration requires a specific change (INIT-19).
- **AC7.8** Among installation-management operations, only `upgrade` migrates existing `xbrief`/`vbrief` data. After success, supported data is current and actual changed files are reported. Initial seed creation follows AC8.4 (first-time install only); ordinary product-data operations are outside this restriction.
- **AC7.9** If installation succeeded but setup or migration failed, the report states that the pin and lockfile now reference the new version, what could not be done, and names the command to finish (`directive install --repair` for wiring, `directive upgrade` for data) after the cause is corrected (INIT-21, Example F in §C9). No rollback of PM operations is promised.
- **AC7.10** The global launcher is never changed by `upgrade` (INIT-19).
- **AC7.11** `directive update` behaves identically.

## R8. Setup and self-completing setup (runtime)

- **AC8.1** Setup installs/activates all existing integration features, respecting their existing settings and applicability, and points their product content/execution at `node_modules/@deftai/directive-runtime/`. Examples include skill pointers, slash commands, OpenClaw, Copilot, host/Git hooks, AGENTS and Taskfile wiring. On install, upgrade and repair it maintains setup version, PM and the persistent ownership/removal record in `GENERATION.json` (AC11.10), then verifies local activation and records readiness. The list is not exhaustive; initial data seeding follows AC8.4.
- **AC8.2** Setup is idempotent: running it twice on an in-sync checkout changes nothing.
- **AC8.3** Treat distributed content and wholly Directive-owned generated files as disposable: replace/regenerate/remove them even if hand-edited. Editing `.deft/core` or installed package content is unsupported; no historical checksum comparison or special edit warning is required to preserve such edits. Preserve project data/settings and user-owned portions of shared files (including AGENTS and host configs); ownership of an entry does not imply ownership of its whole file. Name unresolved user-content conflicts, finish safe work and exit 1. Ownership metadata may still support shared-file safety.
- **AC8.4** Setup, repair and automatic setup may read settings needed for wiring. First-time install setup (`--operation install`) creates missing initial seed project-data files and preserves existing data. Repair and automatic setup never create those seeds and never replace existing project-data files; they do not migrate or rewrite existing xbrief data. Doctor is always read-only.
- **AC8.5** Add only necessary `node_modules` and `.deft/directive/wiring-ready.*.json` ignore entries. Readiness markers are ephemeral and per checkout; `GENERATION.json` remains committed. Broader ignore/settings relocation is deferred.
- **AC8.6** On an eligible ordinary runtime command or registered hook, check the installed pinned version and the ignored `.deft/directive/wiring-ready.<runtime-version>.json` marker, plus cheap wiring-validity evidence. Missing/stale readiness triggers safe local setup, including Git-hook activation, even if committed generation is current. Invalidate superseded markers when rewiring begins; write the current marker only after successful verification, never on failed/conflicted setup. Detect back-to-back package-version changes without any global launcher invocation; stale markers must not make an older version appear ready after another version partially rewired. Subsequent valid invocations use the fast path. No package-manager lifecycle script is required; pin and existing project data remain unchanged; automatic setup does not create initial seed project-data files. Doctor and all its children suppress these writes (see AC9.10). Installation-management operations use their explicit setup stages (including equal-version upgrade setup-when-stale per AC7.3).
- **AC8.7** Simultaneous automatic wiring repairs targeting the **same pinned runtime version** are assumed to converge: they apply the same owned changes and may overlap; last writer wins is acceptable. Do not require cross-process locking or spin-wait. Retain the two-hook acceptance test. Comprehensive coordination with concurrent upgrade/uninstall or a PM pin change to another version is deferred (§A9): do not run installation-changing commands concurrently in the same checkout. Such overlaps may require manual wiring repair; no blanket recovery promise is made for interrupted uninstall or migration, and no dedicated lifecycle-race matrix is required.
- **AC8.8** Plain `doctor` never triggers self-completing setup.
- **AC8.9** When data is behind the runtime's schema, `doctor` and the session-start hook say so and name `directive upgrade`. Other hooks stay silent about it.
- **AC8.10** Inventory all outputs of the current installer, including conditional integrations, copied schemas/docs, Git attributes, review/CodeQL exclusions and the core-guard workflow. Verify all useful feature points remain activated and correctly targeted on new install and supported conversion. Remove Directive-owned scaffolding solely serving the retired copied-content model; preserve project data/user-owned shared content. No active generated reference may target deleted core content or a retired installation command. This inventory is completeness evidence, not a generic installer registry.

## R9. Hooks, skills and wiring

- **(v261027) AC9.1** Every agent hook entry written by Directive (Claude Code, Cursor, Codex, Grok) is `node <committed-host-outer>.mjs …` with `--host` and `--event` (and the host-timeout argument when that host's deposit records a timeout). The outer path is under that host's deposit directory (for example `.grok/hooks/deft-hook-<sha8>.mjs`). The outer uses only Node built-ins until entry guards pass, then loads product logic from `node_modules/@deftai/directive-runtime/dist/hook-bin.js`. None uses `deft-hook` on `PATH`. None uses a shell `.sh` as the registered command. The registered form is identical on every OS and PM.
- **AC9.2** Setup rewrites existing bare `deft-hook` entries and preserves the user's own hook entries in the same files.
- **AC9.3** Without a launcher, a previously configured clone/worktree can use committed pointers and registered hooks after package installation; the first eligible runtime invocation completes local activation under AC2.5. Manually adding a package to a never-configured project provides no discovery or activation (AC14.50).
- **AC9.4** Before applying policy, the hook verifies project identity and exact pin/installed-runtime identity, then completes missing readiness under R8 unless `DEFT_DOCTOR_HOOK_DIAGNOSTIC` is set. The payload's project root must match this checkout's root; on mismatch, fail closed. On failure it applies no policy, gives AC9.7 guidance and exits with the host failure code.
- **AC9.5** A hook launched from the main checkout but given a payload naming a different worktree does not evaluate that worktree with the main checkout's runtime (fail closed per AC9.4).
- **AC9.6** Skill pointers contain no version number and reference `node_modules/@deftai/directive-runtime/skills/<name>/SKILL.md`. The `AGENTS.md` managed section references `node_modules/@deftai/directive-runtime/main.md` and other paths under the same prefix. Passive reads match the pin after package synchronization; they do not execute identity checks or repair. User-facing version guarantees make that prerequisite explicit.
- **AC9.7** README, managed AGENTS text, skill pointers and installation/wiring recovery messages consistently teach: `npm i -g @deftai/directive`, then `directive install --repair`. The first command installs/updates only the launcher; repair restores the existing exact runtime pin. The user runs the global command; Directive never does. Repair handles PM restoration internally, using project evidence, and reports invalid pins or other blockers honestly. This is not a replacement for intentional upgrade or data migration.
- **AC9.8** Every host in scope opens a file at a `node_modules/...` path when a skill pointer or `AGENTS.md` names it. Assumed from light testing (closed design); delivery may include a non-blocking per-host smoke confirmation. Host-specific inability is remediation, not a design reopen.
- **AC9.9** Git hooks and the Taskfile include resolve the runtime by path, not a global `deft`. Setup may set `core.hooksPath` to relative `.githooks`; uninstall unsets only under R11 / §A9 sibling-protection rules.
- **AC9.10** Doctor may exercise the committed hook command as a subprocess probe. When it does, it sets environment variable `DEFT_DOCTOR_HOOK_DIAGNOSTIC` so the hook reports only: no automatic setup, no readiness writes/invalidation, no generated-file or Git configuration changes. Ordinary host invocations never set that variable. Every doctor child/helper likewise suppresses installation writes. Tests with missing/stale readiness and wiring verify the diagnosis and unchanged files/relevant Git configuration afterward.
- **AC9.11** Messages aimed at agents never mention `npx` or `pnpm exec`.
- **(v261027) AC9.12** Unified local entry guards — same order on the committed host-hook outer (AC9.1), the deposited git-hook helper, the Taskfile pin entry, and on global-launcher commands that **delegate to the pin**: (1) untracked `.deft-directive-disable` → tool-appropriate stop with no pin policy load; (2) else missing or unusable pin package under `node_modules/@deftai/directive-runtime` → fail closed with clear **project** `npm install` / `pnpm install` (or equivalent) guidance; (3) else run the pin. Do not treat empty `node_modules` as a default `npm i -g` + `directive install --repair` story when the only gap is an unsynchronized project install. **Launcher-only paths remain available without a pin package** per existing ACs: `install`, `install --repair`, `upgrade`, `uninstall`, `doctor`, `--version`, and `--help` (see AC3.12, AC6.1, AC11.1). `.no-deft-directive` continues to mean the project opts out of Directive install/session/setup per existing product rules. AC8.6 (eligible hook/CLI automatic setup when the pin *is* present but readiness is missing/stale) is unchanged.

## R10. Old installs and old tools

- **AC10.1** Recognise the latest supported legacy installation using its exact pre-split `@deftai/directive` package.json pin and installation evidence. A modern launcher dependency by itself is not a legacy runtime install. Existence of `.deft`, `.deft/core` or `deft` alone is insufficient; retained data/housekeeping must not block a new install after uninstall.
- **AC10.2** In a supported old-style project every command except `upgrade`, `uninstall`, `--version` and `--help` exits non-zero naming `directive upgrade`. The launcher never hands off to an old local version.
- **AC10.3** Upgrade converts the latest legacy architecture (package.json exact pin plus copied `.deft/core`) to the exact runtime pin and package-based wiring in one approved operation. All existing applicable integrations remain activated; legacy core is removed, setup/readiness is verified and supported project schemas migrate. Direct conversion or internal uninstall/reinstall preserving settings and data is acceptable; the mechanism is not prescribed.
- **AC10.4** The old habit — `npm i -g @deftai/directive@latest`, then `directive update` — produces the same result as AC10.3.
- **AC10.5** Conversion reads the old `GENERATION.json`, `.deft/core/VERSION` and `xbrief/.deft-version` only as evidence; none is written afterwards except `GENERATION.json`.
- **AC10.6** Conversion preserves project settings, user-owned shared content and project data (subject to approved schema migration). Remove legacy `.deft/core` even if edited; ordinary conversion disclosure includes that removal, with no special edited-content warning or historical-hash preservation requirement.
- **AC10.7** Initial release/completion requires tested conversion and uninstall support for the latest package.json-pinned/copied-core architecture. Older architecture generations are not initial-release gates. Do not claim unverified conversion or automatic uninstall/reinstall support for them; preserve user data and report unsupported cases honestly.
- **AC10.8** **Follow-up, nonblocking for initial release/beta:** a separately organized survey enumerates every historical install layout and xbrief/vbrief schema, including Go-era shapes, records producing versions, assigns conversion or uninstall/reinstall outcomes and completes their recovery coverage. Its checked-in table drives the later fixture expansion. This work remains required but is not part of initial completion.
- **AC10.9** Conversion raises the generation number in `GENERATION.json`. No other defence against old global CLIs is built (§A9).
- **AC10.10** `cmd/deft-install/` (the Go installer) and every message that points at it are deleted.

## R11. `uninstall`

- **AC11.1** Uninstall is available from the already-running launcher even with a missing, broken or incompatible runtime. No prerequisite installation, repair or upgrade of either the repository runtime or global launcher, and no --force, is required. Use persistent ownership information and known artifacts for current and initially supported legacy layouts; missing/damaged/unrecognized information permits best-effort cleanup with honest reporting under AC11.11. Broader historical coverage follows AC10.8.
- **AC11.2** Discovery uses the persistent ownership record and the launcher's supported-layout knowledge to list Directive-owned entries/files, including integrations from AC8.10, readiness/generation metadata, legacy core and the appropriate dependency. Retain discovered removal information through the repository-uninstaller handoff. Ownership of these artifacts does not imply ownership of all `.deft`, shared configs or node_modules; removal of `.deft/directive` as a whole requires its contents to be known removable.
- **AC11.3** The plan shows what will be removed and what will be kept; approval is `Uninstall Directive from this project? [y/N]`; `--yes` and `--dry-run` as in R5.
- **AC11.4** Remove known Directive-owned hook registrations before their target runtime is removed. With usable ownership information and supported artifacts, no owned registration remains targeting a file this uninstall deleted. Where information is missing, damaged or unfamiliar, remove what can safely be identified and report any known remaining registrations or uncertainty under AC11.11; do not claim complete removal. Concurrent lifecycle operations are outside the guarantee in AC8.7.
- **AC11.5** Use the repository uninstaller when it can run safely under a compatible contract, then perform launcher cleanup using the persistent ownership record and known-artifact map. If runtime execution is unavailable or fails, continue safe fallback cleanup within the approved scope without a prerequisite install, repair or upgrade. Remove whole files only when wholly owned; otherwise remove Directive's marked sections or structured entries, reusing existing markers. Legacy core and wholly owned generated files are removable even if edited; preserve user data/settings and user-owned shared entries under AC8.3.
- **AC11.6** Remove the dependency through the PM. Do not blindly unset shared `core.hooksPath` merely because it equals `.githooks`: preserve hook activation needed by another linked worktree and unrelated user configuration. Use the simplest correct cleanup; no broad cross-worktree transaction framework is required.
- **AC11.7** Untouched: `xbrief/`, user-authored skills, user entries in host configs, user content in `AGENTS.md`, the rest of `package.json`, the global launcher. The report prints how to uninstall the launcher and does not do it.
- **AC11.8** After verified complete `uninstall`, `install` succeeds in the same project. Partial/best-effort cleanup reports any remaining blockers rather than promising a clean reinstall. `uninstall` on a project with no footprint exits 0 and says so.
- **AC11.9** `directive remove` behaves identically.
- **AC11.10** The committed ownership/removal record survives package loss and is maintained by setup on install, upgrade and repair. It identifies wholly owned files, Directive-owned marked sections or structured entries in shared files, and settings/data that survive uninstall. Existing Directive section markers are reused where available; no alternate convention is invented where one already exists. The launcher treats the record as bounded cleanup information, never authority to delete arbitrary paths or user content. Missing or damaged records do not prevent cleanup of artifacts the launcher can safely recognize. Representation remains an implementation choice; no generic installer framework is required.
- **AC11.11** Report actual removals, preserved material, known leftovers and uncertainty. If safe cleanup cannot establish complete removal, report best-effort/partial cleanup and exit nonzero; do not demand package installation or upgrade as a prerequisite for the cleanup attempted. A repository-uninstaller failure may be recovered by launcher fallback; if fallback verifies complete removal, success is permitted. Tests cover intact and missing/damaged records, whole files versus marked sections/structured entries, preservation of shared user content and retained settings, and unavailable/failed/incompatible runtimes.

## R12. `doctor`

- **AC12.1** Doctor writes no files and runs no installs in any state. This covers every hook/helper/subprocess it launches, readiness-marker writes/invalidation and Git configuration. Snapshot the project, relevant Git configuration and isolated global location before/after diagnostic tests.
- **AC12.2** Doctor reports sync and readiness failures and uses the standard AC9.7 installation-recovery sequence. Data behind or a supported old-style conversion needs `directive upgrade`; repair must not be presented as data migration. Invalid pins are errors the user must rectify, never guessed.
- **AC12.3** `doctor` covers the new surfaces: pin, lockfile, installed runtime, `GENERATION.json`, wiring, hook command form, skill pointer targets, `xbrief` schema currency, whether a launcher is present (information only), whether a newer release exists (information only), the Node best-effort note (information only). Its read-only data-status contract (AC4.10) also supplies the launcher's equal-version upgrade decision without parsing changing human-facing prose or duplicating schema logic in the launcher.
- **AC12.4** When the runtime cannot run, `directive doctor` through the launcher gives the launcher's basic diagnosis (AC3.15) ending in the same advice.
- **AC12.5** Messages may recommend approved global-launcher bootstrap/update and AC9.7 recovery. They must not recommend a global product runtime as a substitute for the project pin, and no Directive code runs a global installation/update/removal. Message checks distinguish approved launcher advice from the prohibited global-runtime remedy.
- **AC12.6** The engine ladder, skew windows, core-vs-content skew notices, `--accept-engine-jump` and `DEFT_ACCEPT_ENGINE_SKEW` do not exist in the runtime.
- **AC12.7** No message says `update` or `upgrade` when the remedy is repair, and none says `install --repair` when the remedy is a data migration.

## R13. Files, packages, command surface, documentation

- **AC13.1** No command creates copied product content in `.deft/core`. Runtime content/schemas/docs stay in the runtime package; installed integration references resolve there under npm and pnpm. This does not prohibit generating thin wiring, project seed data or setup/readiness records.
- **AC13.2** `.deft/GENERATION.json` keeps its name and records the runtime version that last ran setup, the PM used, and the persistent ownership/removal information with fingerprints described in AC11.10. It distinguishes whole files from marked sections/structured entries and retained settings/data. It contains nothing that changes when the version and managed files have not changed — no absolute paths, no per-run timestamps.
- **AC13.3** Ignore changes are limited to necessary `node_modules` and ephemeral `.deft/directive/wiring-ready.*.json` entries. Broader `.deft` restructuring and settings relocation remain future work.
- **AC13.4** Exactly two packages are published, together at one version: `@deftai/directive` (launcher) and `@deftai/directive-runtime`. `directive-core`, `directive-content` and `directive-types` are no longer published; their folders remain in the monorepo as private workspace packages, and the runtime's build bundles them. The first launcher release and the first runtime release are the same release. Pre-split versions of all four old packages remain on the registry unchanged.
- **AC13.5** The private folders keep their boundaries: `content/` contains no executable code; `types/` contains only types and schemas. A lint or test enforces both.
- **AC13.6** Installation-management help/documentation shows `install`, `upgrade`, `uninstall`, `doctor`; `init`, `update`, `remove` remain accepted undocumented aliases. Retired installation verbs (`sync`, `doctor fix`, `migrate`, `bootstrap`, `install-upgrade`, `install-uninstall`) are absent. Ordinary product commands/options and their runtime-owned help remain available; this is not a product-wide four-command limit.
- **AC13.7** `--help` explains usage, options, first installation, repair, upgrade, uninstall and automation examples (§C3).
- **AC13.8** README and all setup/recovery docs/templates consistently teach global launcher installation, `directive install` for a new project, normal PM install after clone/pull, and AC9.7 as the single installation/wiring troubleshooting sequence. Explain first eligible runtime activation, deliberate `directive upgrade` for version/schema changes, and read-only doctor. CI may use `directive install --repair --yes` with a valid pin. Never teach npx/pnpm-exec shortcuts. Manual package add is not activation, and repair rejects invalid pins.
- **AC13.9** One documentation page describes the launcher: what it is, who installs it, where each PM puts it, what it does on each run, the bookends, the contract, and what happens without it.
- **AC13.10** One documentation page lists the known limitations from §A9, in user terms.

## R14. Failure and edge cases

Each row is an acceptance test except those explicitly marked follow-up. "Stops" means: exits non-zero, changes nothing, prints one line naming the problem and one next command.

| # | Starting state | Action | Expected |
| --- | --- | --- | --- |
| **AC14.1** | Fresh clone, nothing installed, launcher present. | `directive install` | Menu defaults to Repair; plan shows the install command; after approval, in sync; exit 0. |
| **AC14.2** | Same | `pnpm install`, then an eligible runtime invocation | Pointers resolve after PM install; first invocation verifies/activates local wiring and records readiness. Actual Git hook works afterward (AC2.5). |
| **(v261027) AC14.3** | Same | Hook fires before any package install | Host outer (AC9.1) runs entry guards (AC9.12): fail closed with clear **project** `npm install` / `pnpm install` (or equivalent) guidance. After packages exist, wiring/pin problems still use the AC9.7 launcher-plus-repair sequence. |
| **AC14.4** | Same, launcher absent | `directive …` | Command not found (shell). README step 1 covers it. |
| **AC14.5** | In-sync project. Launcher uninstalled. | Hook fires; skill used | Both work. |
| **AC14.6** | Configured project, node_modules deleted | `directive doctor` | Launcher diagnoses missing installation and gives AC9.7 guidance; no writes. |
| **AC14.7** | Same | `directive install --repair --yes` | Reinstalls (plan said so), setup runs, in sync. Pin unchanged. |
| **AC14.8** | Pin and lockfile moved V → W, installed runtime still V | Hook fires | V performs no setup or policy evaluation; stops with AC9.7 recovery guidance. |
| **AC14.9** | Pin moved to W **and** wiring/`GENERATION.json` already committed for W; installed package was still V | `pnpm install`, then a hook fires | In sync at `W` (wiring already matched the pin; cheap path / minimal work). |
| **AC14.10** | Dependabot (or equivalent) changed **only** pin + lockfile to W; PM installed W; **GENERATION/wiring still describe V** | Registered hook or eligible runtime command runs | Completes wiring/readiness at W, then proceeds. Pin and existing xbrief data unchanged. |
| **AC14.11** | Same as AC14.10, and `W` has a newer `xbrief` schema. | `directive doctor`; session-start hook; then `directive upgrade` | Doctor/session-start report data behind and name `directive upgrade`. Upgrade plans setup if wiring still stale, then migration (or migration alone if wiring already current for W). |
| **AC14.12** | Same, but shared config contains user-owned entries | Hook runs | Preserves user entries while refreshing Directive-owned wiring; any unresolved ownership conflict is named, setup exits unsuccessfully and no ready marker is written. |
| **AC14.13** | Pin hand-edited to a version that does not exist. | `directive install --repair` | Stops with the PM's error preserved; `package.json` untouched. |
| **AC14.14** | Lockfile disagrees with the pin. | `directive doctor`; then `directive install --repair` | Doctor: not in sync; names the lockfile; next repair. Repair treats the disagreeing lockfile as unusable for pin purposes and discloses exact native-add of the pin (lockfile update). |
| **AC14.15** | Registry unreachable. | `directive upgrade` | Stops before any change. |
| **AC14.16** | PM add fails midway (simulated). | `directive upgrade` | Report says installation failed, what changed, next command; exit 1. No lockfile deletion, no global fallback. |
| **AC14.17** | New runtime's setup fails (simulated). | `directive upgrade` | Report says installed `W` but setup did not finish, names the file, names `directive install --repair`; exit 1 (Example F). |
| **AC14.18** | New runtime's migrate fails on one file (simulated). | `directive upgrade` | Report names the file, says which files were migrated, names `directive upgrade` to finish; exit 1. |
| **AC14.19** | Wholly Directive-owned skill pointer hand-edited | `directive install --repair --yes` | Pointer regenerated for pinned runtime; user-owned shared content remains untouched; verified result reported. |
| **AC14.20** | Configured project with generation record deleted | Registered hook runs | Rebuilds owned wiring/metadata and readiness where ownership is established; protects user-owned content and reports unresolved conflicts without claiming readiness. |
| **AC14.21** | Launcher much newer than the pinned runtime; runtime healthy. | Ordinary runtime command | Runs the project's runtime. No warning. Installation-management commands retain their bookend/fallback behavior. |
| **AC14.22** | Launcher older than the runtime, same contract; runtime healthy. | Ordinary runtime command | Runs the project's runtime. No warning. Installation-management commands retain their bookend/fallback behavior. |
| **AC14.23** | Launcher older, runtime has a higher contract — already installed, **or** `directive upgrade` would select such a target | Command requiring runtime delegation; `directive upgrade`; separately `uninstall --yes` | Runtime is never started. Delegation/upgrade reports "Launcher too old" naming `npm i -g @deftai/directive@latest`. On upgrade, contract preflight stops **before** modifying pin/lockfile. Uninstall instead performs safe launcher fallback, without requiring either package to be installed or upgraded, and reports removals, leftovers and uncertainty. |
| **AC14.24** | Two projects, pins `V1` and `V2`, one launcher. | `directive upgrade` in project 1 | Project 2 unchanged. |
| **AC14.25** | New swarm worktree of a configured project | Worktree creation and first eligible runtime invocation | PM install runs, then runtime verifies/completes local activation. Package/setup failure prevents claiming readiness; worktree has its own ignored marker. |
| **AC14.26** | Hook from main checkout, payload names another worktree. | Hook fires | Fails per AC9.5. |
| **AC14.27** | Not in a project. | `directive doctor` | "No Directive project here"; names `directive install`; exit non-zero. |
| **AC14.28** | Latest supported legacy project with exact pre-split package.json pin and copied core | `directive install` | Stops naming `directive upgrade`. |
| **AC14.29** | Same | `directive upgrade --yes` | Converted: runtime pinned and installed, `.deft/core/` gone, `AGENTS.md`/pointers/hooks rewritten, xbriefs migrated, `GENERATION.json` updated; in sync. |
| **AC14.30** | Same | `directive uninstall --yes` | Directive-owned runtime/wiring removed without executing old version; project data/settings and user-owned shared entries preserved. |
| **AC14.31** | Supported latest legacy project with a committed `.deft/core/`. | `directive upgrade --yes` | Converted; the tracked copy is deleted from the working tree and the deletion is listed for review and commit. |
| **AC14.32** | Older shape later marked reinstall by historical survey | `directive upgrade` | **Follow-up:** after support is implemented/tested, stops without mutation and names uninstall then install. Not an initial-release fixture gate. |
| **AC14.33** | Project with broken runtime (half-deleted package), usable ownership record and supported artifacts. | `directive uninstall --yes` | Completes from the persistent ownership record and launcher's known-artifact map without repairing or upgrading either package; user content and retained settings survive. |
| **AC14.34** | Configured project, no terminal, no `--yes`. | `directive install` | Exit 2, nothing changed. |
| **AC14.35** | Configured project. | `directive install --yes` | Exit 2 with `directive install --repair --yes` suggested (Example E). |
| **AC14.36** | Configured project. | `directive install --repair --target-version 1.4.0` | Exit 2: `--target-version` is not allowed with `--repair`. |
| **AC14.37** | Configured project, already latest, data current. | `directive upgrade` | "Already on X"; no change; exit 0. |
| **AC14.38** | Configured project. | `directive upgrade --target-version <older>` | Rejected; exit 1. |
| **AC14.39** | Bare repo, user answers "n". | `directive install` | "Cancelled. No project files were changed."; exit 0. |
| **AC14.40** | Bare repo, no `package.json`. | `directive install --yes` | `{ "private": true }` created; dependency added; in sync. |
| **AC14.41** | Repo in a subfolder of a Git working tree. | `directive install` | Plan says it will set up at the working-tree root. |
| **AC14.42** | `--root` pointing at a subfolder of a Git working tree. | `directive install --root sub/` | Refused: one Directive install per repository, at the root. |
| **AC14.43** | Destination is `/` or `$HOME`. | `directive install --yes` | Refused. |
| **AC14.44** | Yarn or Bun project. | `directive install` | Clear "not supported" message; nothing installed. |
| **AC14.45** | `packageManager` says pnpm; pnpm not on `PATH`. | `directive install` | Explains how to make pnpm available; nothing changed. |
| **AC14.46** | Both `package-lock.json` and `pnpm-lock.yaml` present. | `directive install` | Conflict explained; nothing deleted or migrated. |
| **AC14.47** | `GENERATION.json` says setup used pnpm; a `package-lock.json` has appeared. | `directive doctor` | Drift noted as information; PM still chosen from project evidence. |
| **AC14.48** | `NODE_ENV=production` in the environment. | `directive install --yes` | Dev dependency is physically installed. |
| **AC14.49** | Bare repo | `directive install --dry-run` | Bounded preapproval plan only; no project mutation, target execution, setup or simulated migration diff. |
| **AC14.50** | Package manually added; project never set up | Host attempts discovery or reads package Markdown | No automatic activation/discovery guarantee and no setup merely from a file read. Known limitation: use AC9.7. Repair succeeds only with an unambiguous exact runtime pin; otherwise errors without changing it. Existing xbrief data is preserved under AC8.4. |
| **AC14.51** | Launcher package added to a project by hand. | `directive install` | Entry left alone; normal install proceeds. |
| **AC14.52** | Two hooks fire at once on a checkout needing self-completing setup for the same pin. | — | Convergent result (same owned end state; last writer OK); no corrupted file. |
| **AC14.53** | Node 18. | Any command | One line from the launcher: Directive needs Node 20 or later. Exit 1. |
| **AC14.54** | Node 20. | `directive install` | Plan includes the best-effort note; install proceeds. |
| **AC14.55** | User types `directive migrate`. | — | Exit 2; lists known commands; suggests `upgrade`. |
| **AC14.56** | User presses Ctrl-C during the PM add. | `directive install` | Exit 130; report says partial changes may remain. |
| **AC14.57** | Generation current, per-checkout readiness missing | `directive doctor`, then eligible runtime command | Doctor and its hook probes (with `DEFT_DOCTOR_HOOK_DIAGNOSTIC`) write nothing; ordinary command completes local activation and writes the versioned marker only after verification. |
| **AC14.58** | Successive PM installs change V → W without launcher use | Runtime invoked at W | W readiness is verified anew; obsolete markers cannot bypass setup. Failed rewiring never creates readiness; a valid marker uses the cheap fast path. |
| **AC14.59** | Same pinned/installed version; wiring and/or data not current | `directive upgrade`, approved | No unnecessary reinstall; setup runs if wiring/GENERATION/readiness stale for the pin, then migration as needed; preserves completed migration work; reports actual paths. Already current for both yields a no-write no-op. |
| **AC14.60** | Missing initial seed files after a partial first install, or existing settings/data present | Repair/automatic setup | Reads needed settings; does **not** create seed project-data files; existing data remains byte-identical. Seed creation remains first-time install only (AC8.4). |
| **AC14.61** | Edited legacy core, user-owned shared config, retained project data | Supported conversion or uninstall/reinstall | Core removed without edit-preservation hashes; applicable features point at package after install; user settings/data preserved and directory remnants do not falsely imply an active legacy install. |
| **AC14.62** | Equal target version; data current, behind, or diagnosis fails | `directive upgrade`, including dry-run | Verified runtime returns read-only data status before the launcher selects no-op or migration approval. No diagnosis writes, setup or migration during discovery/dry-run. Diagnostic failure exits nonzero without claiming current data or migrating. |
| **AC14.63** | Runtime missing/broken; ownership record missing, damaged or contains unfamiliar entries | `directive uninstall --yes` | Safe known-artifact cleanup proceeds without a prerequisite install, repair or upgrade. Shared user content and retained settings survive; unknown material is not guessed at. Report actual removals and leftovers/uncertainty; incomplete cleanup exits nonzero. |
| **AC14.64** | Repository uninstaller fails after partial cleanup; persistent record identifies whole files, existing marked sections and structured registrations | `directive uninstall --yes` | Launcher continues safe cleanup within approval using retained discovery information. Only owned files/sections/entries are removed. Report whether fallback completed removal or left partial cleanup; neither package must be installed, repaired or upgraded first. |
| **AC14.65** | Pin/lockfile advanced V → W; installed runtime remains V | Passive skill read, then executable hook invocation | Passive pointer may expose V's instructions without running a check. Hook rejects the mismatch without setup/policy. After PM synchronization, passive content is W's. Documentation states that boundary. |

## R15. Test coverage

- **AC15.1** Automated throwaway fixtures run initial-release R3–R14 criteria across {npm, pnpm} × {macOS, Linux, Windows} × {Node 22, Node 24}, with isolated launcher installation. Node 20 is nonblocking. Explicit follow-up historical cases are excluded from the initial gate; no comprehensive lifecycle-race matrix is required.
- **AC15.2** Initial fixtures use actual published versions from the latest package.json-pinned/copied-core architecture and cover its applicable integrations, conversion/uninstall and data schemas. **Follow-up:** expand fixtures to every layout/schema in AC10.8 as its recovery coverage is delivered.
- **AC15.3** A launcher × runtime compatibility test runs every shipped contract number against the current launcher.
- **AC15.4** Hook, skill-pointer and `AGENTS.md` path behaviour (R9) is verified per host with the real committed config file for that host, on each OS, including AC9.8.
- **AC15.5** Tests install packages from tarballs built from the branch, never from the test machine's real global folder, real `~/.config/deft`, or the Directive checkout's own install.

## R16. Node version

- **AC16.1** Both published packages declare `engines.node: ">=20"`.
- **AC16.2** Supported (tested as a gate) Node lines are 22 and 24. This is stated in the README.
- **AC16.3** On Node below 20, the launcher stops before anything else with one readable line naming the required version. The runtime's hook entry does the same for the paths that skip the launcher.
- **AC16.4** On Node 20 or 21, the launcher prints one warning line at startup — end-of-life date, tested lines, "best effort" — and continues. The same line appears in `install`/`upgrade` plans and in `doctor`. Hooks do not print it on every call; the session-start hook may print it once.
- **AC16.5** The warning threshold is a single constant, so it can move to 22 when 22 leaves maintenance without changing `engines`.

---
# Part C — CLI specification: Directive installation management

This part decides behaviour where it speaks (see "Authority"). Part B supplies the detailed acceptance checks; where a Part B criterion cites `INIT-nn`, the rule is here.

## C1. Purpose and primary workflow

A user installs the global Directive launcher:

```sh
npm i -g @deftai/directive
```

They then initialize Directive from within a project:

```sh
directive install
```

The initializer must identify the intended project, explain its proposed changes, obtain approval, install an exact project-local version of `@deftai/directive-runtime`, and run that installed version's project setup.

The ordinary first-run interaction should require one confirmation. Ask additional questions only to resolve genuine ambiguity.

When initialization has already occurred, `directive install` must offer:

1. Repair the current pinned version.
2. Cancel without making changes.

Upgrade is the separate `directive upgrade` command; `install` has no `--upgrade` option.

The examples below use illustrative version numbers and project paths. `<managed-file>` means an actual Directive-managed file path that the implementation must print. The per-checkout readiness marker is `.deft/directive/wiring-ready.<runtime-version>.json` (§A6.2); other reported paths must be actual outputs, not invented names.

**Scope.** This specification governs installation, upgrade, uninstallation, repair and installation-health checks. It supersedes old commands/logic serving those purposes, not unrelated product behavior. The four installation-management commands do not limit the whole product: ordinary commands/options pass through to the pinned runtime, which owns their help and validation; the launcher needs no exhaustive command list. Explicitly retired installation verbs remain retired. Only upgrade migrates existing project data within this scope; ordinary xbrief operations remain permitted, with setup/seeding boundaries in INIT-17.

**Feature preservation and simplicity.** New install and supported upgrade retain and activate all existing integrations, including conditional OpenClaw, slash commands, Copilot and other current feature points, wired to the local runtime package. Lists of outputs are examples. Use the simplest reliable mechanism; direct rewiring or internal uninstall/reinstall preserving settings/data are acceptable, without requiring a generic installer framework. AC8.10 (Part B) defines the completeness inventory.

**One installation-recovery procedure.** README and managed recovery text consistently teach:

```sh
npm i -g @deftai/directive
directive install --repair
```

The user installs/updates the launcher; Directive never changes global packages itself. Repair restores the existing exact runtime pin and handles package restoration internally. Missing, ranged, invalid or conflicting pins are errors for the user to rectify; repair never establishes or guesses a pin. This advice does not replace intentional upgrades or data migrations. Manual package add in a never-configured project provides no automatic skill discovery or hook activation (§A9).

## C2. Core version and execution rules

### INIT-01: The project version is authoritative

The project's normal version declaration must be an exact development dependency:

```json
{
  "devDependencies": {
    "@deftai/directive-runtime": "1.2.3"
  }
}
```

Do not use a range, floating tag, or a separate competing version file.

The package manager's lockfile must record the resolved installation. The initializer must not generate or edit lockfile contents itself.

An installed global version must never silently replace or upgrade a project's pinned version.

### INIT-02: Define version selection explicitly

Use these version-selection rules:

| Operation | Target version |
|---|---|
| First initialization | The configured registry's latest stable release, unless `--target-version` is supplied. |
| Repair | The existing project pin, unchanged. |
| Upgrade | The configured registry's latest stable release, unless `--target-version` is supplied. |

Resolve any upgrade target to an exact version before showing the approval prompt. Install that exact version. Do not resolve a floating tag again after approval.

Prerelease upgrade targets require an explicit `--target-version`.

If the launcher cannot initialize the selected release safely, stop before modifying the project and explain which launcher update or other action is required. Do not silently choose another release. For upgrade (and any path that selects a not-yet-installed target), this includes **preflighting the target's published contract** from registry/tarball metadata before changing pin or lockfile. If that contract exceeds what this launcher supports, stop with launcher-update guidance and leave the project unmodified.

### INIT-03: Bootstrap must work when the local installation is broken

The global initializer must remain usable when the local Directive package, executable, configuration, or `node_modules` directory is missing or damaged.

Do not require successful execution of the local package before offering repair.

After installation or restoration, run setup from the verified project-local package. Do not fall back to the globally installed implementation if local execution fails.

The internal handoff must not recursively invoke the global `directive install` flow.

## C3. Required command-line interface

Support:

```text
directive install [options]
directive upgrade [options]
directive uninstall [options]
directive doctor [options]
```

`init`, `update` and `remove` remain accepted aliases for install, upgrade and uninstall. Options below govern installation management, not ordinary runtime-command options.

| Option | Required behavior |
|---|---|
| `--root <path>` | Select the actual setup destination. Do not silently relocate an explicitly supplied destination. Validate workspace boundaries and explain conflicts. |
| `--package-manager <name>` | Select a supported package manager. Validate it against existing project declarations and lockfiles. This is not permission to migrate package managers. |
| `--target-version <exact-version>` | Select an exact release for first initialization or upgrade. Reject ranges, floating tags, and unsupported package specifications. Do not use this option for repair. |
| `--repair` | Select repair of the current project pin without showing the operation-selection menu. Still show the plan and request approval unless `--yes` is supplied. |
| `--yes`, `-y` | Approve a fully resolved, ordinary setup plan without a confirmation prompt. Do not interpret this as permission to upgrade, overwrite user content, change package managers, or bypass checks. |
| `--dry-run` | Show the resolved operation, destination, version, intended changes, and commands without changing project files or running installation/setup. Read-only registry metadata requests are permitted. |
| `--help`, `-h` | Explain usage, options, first initialization, repair, upgrade, and automation examples. |

Also support:

```text
directive --version
```

Version output must clearly distinguish the global launcher version from a detected project version when both are reported. A manifest pin alone must not be described as a verified working installation.

### Option rules

- `--repair` is an `install` option. Upgrade is a separate command; `install --upgrade` is rejected.
- `--repair` requires an existing, unambiguous exact project pin.
- `upgrade` requires an existing unambiguous exact runtime pin or the supported latest legacy installation described in §A6.7.
- `--target-version` is allowed for first initialization or with `upgrade`.
- `--target-version` is not allowed with `--repair`.
- Equal-target upgrade first obtains data status from the verified pinned runtime through the read-only diagnostic contract (AC4.10). It may finish wiring (setup) when GENERATION/readiness is stale for the pin, then migrate data after approval, without reinstalling the package when it already matches the pin. If wiring and data are already current, it is a no-write no-op; diagnostic failure is an error, not a no-op. A retry safely finishes remaining migration work and preserves completed work.
- An upgrade target older than the current pin must be rejected. Downgrading is outside this workflow.
- `--yes` must not choose between repair and upgrade.
- On an already configured project, `install --yes` without `--repair` stops and names `install --repair --yes`; deliberate upgrade uses `upgrade --yes`.
- `--dry-run` does not require final approval. An operation must still be selected when the project is already configured.

A public `--force` option is not required. Do not add it as a general-purpose bypass for conflicting or destructive situations.

No `--no-install` mode is part of this work.

**Uninstall has no package-restoration prerequisite.** It uses the repository uninstaller when that runtime can run safely, then launcher cleanup from the committed ownership record and known artifacts. A missing, damaged, failed or incompatible runtime does not require installation, repair or upgrade of either the repository runtime or the global launcher before fallback cleanup. Persistent records distinguish whole-file removal from Directive-owned marked sections/structured entries and retained settings/data; existing section markers are reused. If the record is missing, damaged or unfamiliar, the launcher performs safe best-effort cleanup and reports actual removals, preserved material, leftovers and uncertainty (R11). Complete removal is not claimed when it cannot be established. A newer runtime contract blocks delegation to that runtime, not launcher-only uninstall.

## C4. Read-only discovery and project selection

### INIT-04: Discover before modifying

Before approval, inspect enough state to determine:

- The destination and applicable workspace.
- The project's package manager and relevant version requirements.
- Whether Directive is new, configured, or in an inconsistent state.
- The current pin and proposed target version.
- Expected manifest/lockfile changes, known managed changes, and any required minimal ignore entries; an exhaustive target-specific file/migration list is not required.
- Any known incompatibility that prevents installation or setup.

Do not modify project files, install packages, execute Directive setup, or initialize Git during discovery.

Equal-version upgrade discovery may obtain data status from the verified installed runtime's read-only diagnostic contract (AC4.10). That exchange must not complete wiring, alter readiness or migrate data, and a failed diagnosis must not be treated as current data.

### INIT-05: Find Git roots correctly

When Git is available, use Git's working-tree discovery rather than testing only for a `.git` directory:

```sh
git -C "<starting-directory>" rev-parse --show-toplevel
```

For repository-wide setup, propose the working-tree root when appropriate.

When moving upward from the invocation directory, disclose the change:

```text
You're in /work/acme/src/server.
I'll set up Directive at the repository root: /work/acme.
```

The final approval may confirm this destination. A separate root-confirmation question is unnecessary when the destination is unambiguous.

Support working trees whose `.git` entry is a file. Do not confuse Git's administrative storage location with the setup destination.

Distinguish "not a Git repository" from an unexpected Git error.

### INIT-06: Git is optional

Without Git, use the explicitly selected destination or propose the current directory after checking for an enclosing package-manager workspace.

Do not run `git init` automatically.

Use plain language:

```text
No Git repository was found.

I'll set up Directive in:
  /work/new-project

Git will not be initialized.
```

Require deliberate destination selection for suspicious locations such as a filesystem root or the user's home directory. Do not let `--yes` silently bypass that protection.

### INIT-07: Respect package and workspace boundaries

Distinguish the repository root from the package-manager installation scope.

For repository-wide tooling, prefer a root development dependency when that fits the existing workspace.

Do not silently create a competing manifest or lockfile inside an existing workspace.

When multiple supported destinations are genuinely plausible, ask one focused question. When only one layout is supported, explain the limitation instead of offering choices the implementation cannot honor.

An explicit `--root` must not authorize unannounced changes outside that destination. If the existing workspace requires broader changes, explain the affected scope before proceeding.

## C5. Package-manager selection

### INIT-08: Use project evidence

Do not infer the project's package manager from the fact that the global launcher was installed with npm.

Use:

1. An explicit `--package-manager`, after conflict checks.
2. Applicable project declarations such as `packageManager` and supported `devEngines.packageManager` settings.
3. The relevant workspace configuration and lockfile.
4. npm as the documented default when no project preference exists.

Conflicting evidence must be resolved explicitly. Do not silently choose one manager, delete another manager's lockfile, or migrate the project.

Inspect the relevant installation scope. Lockfiles belonging to unrelated nested projects are not automatically conflicts.

### INIT-09: State supported managers

At minimum, support npm and pnpm.

Recognize Yarn and Bun projects and stop with a clear unsupported-manager message in this release. Never silently install into those projects using npm.

Each supported adapter must handle the manager's workspace behavior and supported versions correctly.

A future Yarn adapter would need to account for layouts without `node_modules`, including Plug'n'Play; it is outside this work.

### INIT-10: Preserve the project's environment

Honor applicable registry, authentication, proxy, lockfile, and install-script settings.

Use the project's declared package-manager version when supported and available.

If the required manager or version is unavailable, explain how to make it available. Do not silently install or upgrade global package managers, alter global configuration, or switch managers.

Use an existing Corepack arrangement when applicable. Do not assume it is installed.

Never print authentication secrets in plans, commands, or errors.

## C6. Approval and installation

### INIT-11: Show one concrete plan

Before any project mutation, show:

- The operation: initialize, repair, or upgrade.
- The absolute destination.
- The package manager and the evidence used to select it.
- The existing version, when present, and the exact target version.
- Expected manifest/lockfile changes and a clearly bounded description of setup and, on upgrade, required migrations; individually name only changes known before execution.
- The installation/restoration command.
- The fact that the installed verified local release performs setup and any required upgrade migrations, preserving settings and project data.

The plan is bounded, not an exhaustive preview of target-version code. Do not require a target planner, temporary target execution or advance enumeration of every migration. After installation and verification, the actual target returns the files it created/modified/removed/migrated and their outcomes for the final report. PM results supply manifest/lockfile changes.

`--dry-run` ends at this preapproval plan. It may read registry metadata and obtain equal-version data status through the verified installed runtime's read-only diagnostic contract, but runs no install, setup or migration and does not simulate the target or promise a complete diff.

Disclose that installation may run scripts permitted by the project's settings.

Use an operation-specific confirmation with a default of No:

```text
Set up Directive in this project? [y/N]
```

or:

```text
Repair Directive 1.2.3 in this project? [y/N]
```

or:

```text
Upgrade Directive from 1.2.3 to 1.3.0? [y/N]
```

This single approval covers the disclosed high-level scope, installation, local setup and upgrade migrations where applicable. Do not request redundant approvals for each step.

If the runtime cannot complete something safely within that approved scope, it finishes safe work, names the conflict, and exits non-zero. A “new proposal” means the user starts a **new** command with a new plan — not a second in-process approval prompt after handoff.

### INIT-12: Make minimal manifest changes

For an existing `package.json`, preserve unrelated fields and project decisions. Do not intentionally reformat or rewrite the whole document.

Do not add or change names, licenses, module types, engine declarations, package-manager declarations, or unrelated scripts merely because initialization touches the manifest.

Do not set `"private": true` on an existing manifest.

For a new tooling-only manifest, begin with:

```json
{
  "private": true
}
```

Then use the package manager to add the exact development dependency.

Explain a new manifest simply:

```text
This project doesn't have a package.json.
I'll create a small one to track Directive and its version.
```

Do not run a general application scaffold merely to obtain a manifest.

If installation requires a missing `node_modules` ignore entry, include that minimal `.gitignore` change in the plan. Also include the narrow ignore entry `.deft/directive/wiring-ready.*.json` when needed. Do not add a broad template or ignore all Directive configuration; `GENERATION.json` remains committed.

### INIT-13: Let the package manager add the dependency

For first initialization and upgrades, use the manager's native dependency-add operation with an exact version and development-dependency placement.

Examples for ordinary, non-workspace packages:

```sh
npm install --save-dev --save-exact --include=dev @deftai/directive-runtime@1.2.3
```

```sh
pnpm add --save-dev --save-exact @deftai/directive-runtime@1.2.3
```

Use the appropriate workspace flags and invocation scope when required.

Ensure that the development dependency is physically installed, even when the environment would otherwise omit development dependencies.

Do not use `npm ci` to introduce or upgrade the dependency.

Let the package manager create or update its lockfile. Never hand-edit, fabricate, or delete the lockfile to make installation succeed.

If project policy prevents creating a required lockfile, explain the conflict and stop rather than silently overriding policy.

Do not promise that only Directive's own lockfile entries will change. Describe the requested dependency change and report the actual resulting changes.

### INIT-14: Verify before local setup

Before executing local setup, verify that:

1. The manifest contains the approved exact pin.
2. The expected lockfile records the installation consistently.
3. The installed project-local package is available.
4. Its installed version matches the approved version.

Execute the verified local package through a supported, manager-aware mechanism.

Do not use a bare `directive install` subprocess whose executable is selected through `PATH`.

Do not use an execution mechanism that can silently download a substitute when the local package is missing.

Pass the resolved project destination explicitly to local setup. The approved operation must survive the handoff without another discovery-and-selection loop.

## C7. Existing initialization: repair, upgrade, or cancel

### INIT-15: Detect initialization from durable project state

An existing exact project pin is sufficient to classify the project as previously initialized, even if the installation or configuration is incomplete.

Missing `node_modules`, a missing local executable, a missing lockfile, or missing generated files must not cause an existing pin to be ignored.

Committed integration wiring and `GENERATION.json` travel with a clone/worktree; the installed package and ignored readiness marker do not. With an exact pin and no conflicting entries, missing installed or generated files cause the rerun menu to default to Repair. The mere existence of `.deft` or `.deft/core` does not establish an active installation.

Do not infer successful initialization solely from an installed executable or a generated-file marker.

Conflicting dependency entries, non-exact declarations, or configuration without a recoverable pin require an explicit recovery decision. Do not treat such a project as a clean first installation or overwrite the evidence.

If an exact runtime pin cannot be established for repair, stop with an error and leave the declaration unchanged. The user must rectify missing, ranged, invalid or conflicting declarations; repair does not select a target or turn into first install.

### INIT-16: Always offer the rerun menu in ordinary interactive use

When an exact pin exists and no operation flag was supplied, show:

```text
Directive is already configured in this project.

Project:         /work/acme
Pinned version:  1.2.3

What would you like to do?

  Repair 1.2.3
    Restore the current version and rerun project setup.

> Cancel
    Leave the project unchanged.
```

Cancel must be the default selection UNLESS the INIT-15 condition allowing a repair default is detected.

Show this menu even when the installation appears healthy. Do not silently exit merely because initialization ran before.

After Repair is selected, show its plan and request approval. Upgrade is invoked separately.

### INIT-17: Repair keeps the current version

Repair must:

- Keep the exact project pin unchanged.
- Restore missing or damaged installed components as needed.
- Rerun that pinned release's project setup.
- Recreate missing Directive-managed files when safe.
- Preserve user settings, user-authored content, and unrelated files.
- Verify the repaired installation before reporting success.

Repair must not select the registry's latest release.

Rerunning an already-satisfied dependency-add command is not, by itself, proof of repair. The implementation must use an appropriate restoration strategy and verify the result.

Repair may remove/reinstall the local runtime package and regenerate Directive-owned wiring, preserving settings, project data and user-owned shared content. It must not delete all of `.deft` or unrelated packages. No particular in-place rewrite or reinstall algorithm is required.

Setup/repair may read project settings, including settings currently stored in xbrief. First-time install creates missing initial seed project-data files without overwriting existing data. Repair and automatic setup never create those seeds and never migrate or rewrite existing xbrief data.

In a previously configured clone/worktree, the first eligible ordinary runtime command or registered hook checks `.deft/directive/wiring-ready.<runtime-version>.json` and cheap validity evidence. If absent/stale, it completes local wiring including Git-hook activation, invalidates superseded markers when rewiring begins, and writes readiness only after verification. A current committed generation alone is insufficient. Package version changes need no global launcher invocation, and this does not depend on install scripts. Same-pin concurrent automatic repairs are assumed to converge (last writer OK); broader overlap with upgrade/uninstall is a documented limitation.

Doctor and every diagnostic hook/helper remain read-only: they neither repair wiring nor alter readiness, generated files or Git configuration. When doctor spawns a committed hook as a probe, it sets `DEFT_DOCTOR_HOOK_DIAGNOSTIC`. Lifecycle operations use their explicit setup stages (including equal-version upgrade setup-when-stale). Merely reading skill Markdown executes neither setup nor a version check. Passive content matches the pin after packages are synchronized; before that it may reflect an older installed version.

When the lockfile consistently records the exact pin, preserve its dependency resolution rather than deliberately updating transitive dependencies.

If the lockfile is missing, unusable, or does not consistently record the exact pin, disclose restoring the pin via the PM's exact native add (lockfile update). Do not claim that a newly resolved dependency graph is identical to the old one.

A healthy installation may need no package reinstall, but the pinned release's idempotent setup must still run. Repeating repair should not produce accumulating changes.

If a full dependency rebuild is necessary, explicitly describe its scope before approval. For example, a repair using `npm ci` must explain that it rebuilds the project's dependency installation, not only Directive.

Do not silently escalate to broad deletion, force flags, or security-policy changes after an ordinary repair attempt fails.

### INIT-18: Preserve user content according to ownership

Define ownership at file or field level. Distributed content (legacy `.deft/core` and the installed runtime package) and wholly Directive-owned generated files are disposable, even if hand-edited. Their normal replacement/removal needs no historical checksum comparison, special edit warning or extra approval. The conversion plan discloses legacy-core removal.

Preserve settings, customer project data, user-authored skills and user-owned portions of shared AGENTS/config files. Ownership of a hook entry does not confer ownership of its whole file. Setup maintains committed ownership/removal metadata that survives package damage and distinguishes whole files from Directive-owned marked sections or structured entries and settings/data retained on uninstall. Reuse existing Directive section markers where available. The launcher uses this bounded information together with its known-artifact map for fallback uninstall; it does not treat a recorded path as authority to delete arbitrary material. `.deft/directive` may be removed wholesale only when all its contents are known removable. Missing or damaged metadata permits safe best-effort removal, not guessed ownership or a prerequisite package upgrade (R11).

When a conflict involving user-owned content cannot be repaired safely, preserve it and identify the required recovery action. Destructive replacement of that content is outside ordinary approval and requires a separate explicit decision. Removing obsolete copied-content scaffolding must not remove useful integration functionality.

### INIT-19: Upgrade changes the pin deliberately

For `directive upgrade`:

1. Resolve the exact candidate release.
2. Check available compatibility information, including **preflighting the target's published contract** before modifying the project (INIT-02).
3. Show the current and target versions.
4. Describe expected dependency changes and disclose target setup/migrations, naming only changes known beforehand.
5. Obtain approval.
6. If the target differs, install it and let the PM update the lockfile; equal-version work needs no package reinstall when the installed package already matches the pin.
7. Run the verified target's setup then migration for a version transition. For equal-version work: if wiring/GENERATION/readiness is not current for the pinned version, run setup then migration; if already wired for that version, run migration only (or no-op if data is current).
8. Verify and report the result.

Preserve existing configuration unless an approved migration requires a specific change.

For an equal target, first obtain data status from the verified pinned runtime through the read-only diagnostic contract (AC4.10). If wiring/GENERATION/readiness is stale and/or data needs migration, show the bounded plan (setup and/or migration), obtain approval, and use that runtime. If both wiring and data are current, report that and make no changes. If diagnosis fails, report the failure and exit nonzero without treating the data as current or beginning migration. The launcher owns no schema-specific decision logic; serialization and transport remain implementation choices. Do not convert Upgrade into Repair merely to reinstall a healthy package. Retrying an interrupted migration preserves completed work and safely finishes the remainder.

Initial legacy support covers the latest exact-package.json-pin/copied-core architecture, with all existing integration features retained. The separately organized historical survey is required later but does not block the initial release. Do not claim automated recovery for unverified older layouts.

Upgrading the project must not automatically upgrade the global launcher.

## C8. Automation, failures, and completion

### INIT-20: Noninteractive behavior must be explicit

When no interactive terminal is available:

- Never wait for input.
- Require `--yes` for an operation that changes files.
- Require `install --repair --yes` for automated repair of a configured project; `upgrade --yes` explicitly selects upgrade.
- Require explicit answers for unresolved destination or package-manager ambiguity.
- Allow a fully resolved `--dry-run` without `--yes`.

Examples:

```sh
# First initialization using the latest stable runtime release.
directive install --yes

# First initialization using a specified release.
directive install --target-version 1.2.3 --yes

# Repair the committed project version.
directive install --repair --yes

# Upgrade to the latest stable release.
directive upgrade --yes

# Upgrade to a specified release.
directive upgrade --target-version 1.3.0 --yes

# Preview a repair without changing the project.
directive install --repair --dry-run

# Explicit destination and manager.
directive install --root /work/acme --package-manager pnpm --yes
```

`--yes` approves the normal resolved plan. It does not authorize an ambiguous, incompatible, or destructive operation.

### INIT-21: Preserve work and report partial failures accurately

Do not require a clean Git working tree for every initialization.

Preserve existing uncommitted work and identify relevant existing changes when necessary.

Before writing, ensure that relevant project files have not changed in a way that invalidates the approved plan.

On failure:

- Stop the remaining sequence, except that an unavailable or failed repository uninstaller allows the explicitly defined safe launcher cleanup under R11 to continue within the approved scope.
- Identify whether installation, verification, or project setup failed.
- State what succeeded and what remains incomplete.
- Report known file changes.
- Provide the next useful command or recovery action.
- Return a nonzero exit status.

Do not claim "No files were changed" unless verified.

Do not automatically delete lockfiles, reset Git, discard user changes, weaken dependency checks, bypass install-script policy, or fall back to a global product runtime. Launcher-only uninstall using persistent ownership information and known artifacts is the explicit R11 removal mechanism, not global product execution. It requires no prerequisite installation, repair or upgrade of either package. A failed repository uninstaller can be recovered by verified fallback cleanup; known leftovers or unresolved uncertainty require an honest partial-cleanup report and nonzero exit.

Do not promise complete rollback of arbitrary package-manager operations or installation scripts.

Handle interruption without falsely reporting success. After an interrupted mutation, report that partial changes may remain unless their state has been verified.

### INIT-22: Completion must describe the actual result

Report:

- The completed operation.
- The project destination.
- The verified local Directive version for install, repair or upgrade. Uninstall reports the version when known and does not require a runnable runtime to report removal.
- Actual created, modified, removed or migrated project files, combining PM results and the target runtime's returned outcomes.
- A useful next command.
- What should be reviewed and committed when Git is present.

Do not report completion until the required verification, setup and any requested migration have succeeded. Equal-version work does not require a package reinstall when the installed runtime already matches the pin; it may still run setup when wiring/readiness is stale, then migration as needed (AC7.3 / AC4.10).

For uninstall, combine repository-uninstaller results when available with launcher cleanup and PM results. Report actual removals, preserved material, known leftovers and uncertainty. Distinguish verified complete removal from best-effort/partial cleanup; do not claim every trace is gone when ownership or removal coverage is incomplete.

Do not list `node_modules` or ignored readiness markers as something to commit.

Do not invent configuration filenames in output. Print the actual managed paths.

Use concise, plain-language progress messages. Preserve useful package-manager errors rather than replacing them with a generic failure.

### INIT-23: Exit status

Use a documented, consistent convention:

| Status | Meaning |
|---|---|
| `0` | Successful initialization, repair, upgrade, dry run, no available upgrade, or explicit menu cancellation before changes. |
| `1` | Operational or validation failure. |
| `2` | Invalid arguments or missing choices required for noninteractive execution. |
| `130` | Interrupted by the user. |

## C9. Example exchanges

### Example A: First initialization

```text
$ npm i -g @deftai/directive

$ directive install

Set up Deft Directive

Project:          /work/acme
Package manager:  pnpm (from package.json)
Directive version: 1.2.3

If you approve, Directive will:
  • add Directive 1.2.3 to this project's development tools with pnpm
  • update pnpm-lock.yaml
  • create Directive's project files for this folder

Your other project files stay as they are.

Set up Directive in this project? [y/N] y

✓ Installed Directive 1.2.3
✓ Created Directive's project files
✓ Verified the project-local installation

Directive 1.2.3 is ready in /work/acme.

Next:
  directive --help

Review and commit:
  package.json
  pnpm-lock.yaml
  <managed-file>

Commands in this project use its pinned Directive version.
Updating the global launcher will not upgrade this project.
```

With `-v` / `--verbose`, the same plan also shows the exact package-manager command and a short note that Directive skips lifecycle scripts on that add (AC5.1).

### Example B: Rerun and repair

This example assumes the installed package is healthy but a managed project file is missing.

```text
$ directive install

Directive is already configured in this project.

Project:         /work/acme
Pinned version:  1.2.3

What would you like to do?

> Repair 1.2.3
    Restore the current version and rerun project setup.

  Cancel
    Leave the project unchanged.

Selection: Repair 1.2.3

Repair Directive

Project:          /work/acme
Package manager:  pnpm (from package.json)
Directive version: 1.2.3 (unchanged)

The installed package is healthy. No reinstall is needed.

I'll rerun setup using Directive 1.2.3 and recreate:
  <managed-file>

Your existing settings and other files will be preserved.

Repair Directive 1.2.3 in this project? [y/N] y

✓ Verified the installed Directive 1.2.3 package
✓ Reran project setup
✓ Restored the missing project file

Directive 1.2.3 is ready.
The project version has not changed.

Review and commit:
  <managed-file>
```

If the installed package is missing or damaged, the repair plan must instead show the actual restoration command and affected installation scope.

### Example C: Upgrade

```text
$ directive upgrade

Checking for a newer stable release...

Upgrade Directive

Project:          /work/acme
Package manager:  pnpm (from package.json)
Current version:  1.2.3
Target version:   1.3.0

If you approve, Directive will:
  • change this project's Directive version to 1.3.0
  • update pnpm-lock.yaml
  • run project setup and any needed data updates for that version

Your existing project settings stay as they are.

Upgrade Directive from 1.2.3 to 1.3.0? [y/N] y

✓ Installed Directive 1.3.0
✓ Completed project setup
✓ Verified the project-local installation

This project now uses Directive 1.3.0.
The global launcher was not changed.

Review and commit:
  package.json
  pnpm-lock.yaml
```

This example assumes no project-data migration was needed. The plan discloses that the installed target will perform required migrations; only migrations known beforehand need individual description. The completion report lists actual changed/migrated paths returned by the target. No exhaustive preapproval migration list is required.

### Example D: Cancel

```text
Selection: Cancel

Cancelled. No project files were changed.
```

### Example E: Ambiguous automated rerun

```text
$ directive install --yes

Directive is already configured at version 1.2.3.
To repair this installation, select repair explicitly:

  directive install --repair --yes

For a deliberate version or data upgrade, use directive upgrade --yes.
No project files were changed.
```

This command exits with status `2`.

### Example F: Installation succeeded, but setup failed

```text
Directive 1.3.0 is installed, but project setup did not finish.

Setup could not update:
  <managed-file>

Reason:
  Permission denied.

The project pin and lockfile now reference Directive 1.3.0.

Correct the file permissions, then run:
  directive install --repair

Review the existing changes before committing.
```

The failure message must reflect the verified on-disk state. Do not describe the project as still pinned to the previous version when installation already changed it.

## C10. Minimum acceptance criteria

The implementation is acceptable when:

- A normal first initialization requires one meaningful approval.
- Rerunning install offers Repair or Cancel; upgrade is a separate command.
- Repair preserves the project pin and reruns that release's setup.
- Upgrade changes versions only after explicit selection/approval and supports equal-version data migration without unnecessary reinstall.
- A broken local installation does not prevent the global initializer from offering repair.
- Package-manager and workspace choices respect existing project configuration.
- Installation produces an exact development dependency and a manager-generated lockfile.
- Setup executes the verified local version without a global or temporary-download fallback.
- Repeated repair preserves customization and does not accumulate unnecessary changes.
- Cancellation, interruption, and partial failure produce accurate results and exit statuses.
- Noninteractive execution never hangs or silently chooses an upgrade.

The installation-management acceptance criteria also require per-checkout versioned readiness and automatic activation on eligible runtime invocation; preservation of every existing applicable integration; disposable distributed/wholly owned generated content with user-data/settings protection; transitive read-only doctor probes and an explicit equal-version data-status handoff; and the standard launcher-plus-repair recovery guidance. Passive skill content matches the pin after package synchronization and is not independently version-gated by reading Markdown. Uninstall uses the repository uninstaller when safely available, then persistent ownership records and launcher knowledge, with no prerequisite installation, repair or upgrade of either package and honest reporting of partial cleanup. Part B supplies the detailed checks. Historical coverage beyond the latest pinned/copied-core architecture and comprehensive lifecycle concurrency are explicitly deferred. Shared Git-hook cleanup must not disable another worktree.

---
# Part D — Handoff guidance for whoever implements this ticket

This part is guidance for the implementer (for example the parent agent of a Deft Directive swarm in the `deftai/directive` repository, or any other harness the operator chooses). It restates the blanket rules that apply across every slice, the suggested delivery sequence, the testing expectations, the points at which to stop and ask the operator, and what the final report must contain. It adds no requirements beyond Parts A–C; where it is more specific, it is a consolidation of them.

## D1. Before starting, the operator must

1. Point the implementing agents at **this ticket alone** as the single source document and implementation tracking issue (Parts A–D). Do not send implementers to prior install-simplification issues for behaviour.
2. Confirm the npm scope can publish a new package, `@deftai/directive-runtime`, and that the three retired packages (`directive-core`, `directive-content`, `directive-types`) may stop being published.
3. Organize the required historical survey as separate follow-up work. Its completion does not block this initial release/beta; the latest package.json-pinned/copied-core architecture must be supported now.
4. (Operator logistics only:) Cancel deftai/directive#4730 by closing it as "won't fix", without deleting it. This ticket completely supersedes its body and comment thread; #4730 is historical context only and is not material to implementation.

## D2. What is being built, in brief

The job is to change how Directive installs, upgrades and uninstalls itself **in an end user's repository**, as specified in this ticket:

- **Part A** — the design, the reasons, and (§A9) the catalogue of known limitations and the decisions behind them.
- **Part B** — numbered requirements (R1–R16) with acceptance criteria. **This is the contract for the work.** Done means every initial-release acceptance criterion passes. Explicitly marked historical follow-up criteria are nonblocking.
- **Part C** — the detailed behaviour of the initializer (discovery, plans, approval, package-manager rules, failure reporting, exit codes). Where the requirements cite an `INIT-nn` rule, read it there. Part C fills INIT detail and silence; if Part B and Part C appear irreconcilable, stop and ask the operator.
- **Part D** — this handoff guidance (hard rules, sequence, testing, stop-and-ask).

This superseding ticket is the implementation tracking issue and is self-contained. #4730 is to be cancelled (closed as "won't fix", not deleted); references to it provide historical context only. Read **Parts A–D** in full before planning. Closed design. No open questions; every decision is recorded. Directive's own development/testing mechanism is left to the principal during implementation (§D3).

In brief:

- The product collapses to two published packages. `@deftai/directive` becomes a small **launcher**: it gives the user the `directive` command, finds the project, and hands off. A new `@deftai/directive-runtime` holds everything else — the commands, hooks, content, engine, types and schemas — bundled at build time from the monorepo's `core/`, `content/` and `types/` folders, which stay private. The project pins the runtime at an exact version; that pin is the only statement of the project's Directive version.
- **Nothing is copied.** `.deft/core/` goes away. The `AGENTS.md` managed section, skill pointers, hook configs, git hooks and the Taskfile include reference paths under `node_modules/@deftai/directive-runtime/`, and carry the standard launcher-plus-repair recovery instruction. On configured clones, PM install restores content and first eligible runtime invocation verifies/completes local activation; passive reads do not run setup.
- The launcher owns the **bookends** of `install`, `upgrade` and `uninstall`: discovery, the plan, one approval, the package-manager change, verification, and the hand-off to the verified runtime when available and required. The runtime owns the version-specific middle. They talk through a small, numbered **contract** (R4) with four entry points: setup (wiring, settings reads; first-time install may create initial seed project-data files), migrate (existing data, `upgrade` only), uninstall, doctor (also supplying read-only status for equal-version migration decisions). Automatic setup is a separate bounded authority for owned wiring/readiness on eligible ordinary commands/hooks.
- Installation commands: install (initial setup or repair without moving an existing pin), upgrade (version transition, or equal-version setup-when-stale and/or data migration), uninstall (repository uninstaller when safely available, then persistent-record/known-artifact launcher cleanup without prerequisite package installs or upgrades), doctor (read-only throughout its children; probes use `DEFT_DOCTOR_HOOK_DIAGNOSTIC`). Aliases remain init/update/remove. Ordinary product commands are preserved. Incomplete uninstall is reported honestly rather than requiring an upgrade to attempt cleanup.
- Eligible runtime commands/hooks complete local wiring when `.deft/directive/wiring-ready.<runtime-version>.json` is missing/stale, even with current committed generation. Cheap checks follow successful verification. Doctor and its probes never do this.

### Scope and implementation freedom (restated for the implementer)

The entire effort concerns installation, upgrade, uninstallation, repair and checking installation health. It supersedes old commands/logic for those purposes; it does not change unrelated product behavior.

- The four-command restriction applies to installation management. Existing product commands/options remain available through the pinned runtime.
- The launcher passes ordinary commands through without a complete command allowlist; their help and validation belong to the runtime.
- Explicitly retired installation verbs remain retired. Do not preserve old installation machinery by calling it outside scope.
- Upgrade owns installation-related migration of existing data (and equal-version setup when wiring is stale); ordinary project-data operations remain permitted. Settings reads and first-time-only initial seeding follow R8.

Retain and activate **all** existing applicable feature points, including OpenClaw, slash commands and Copilot. Document examples are not exhaustive. Inventory current installer outputs and verify their new package targets; remove only scaffolding solely supporting the retired copied-content architecture, preserving user data/settings/shared-file content.

Use the safest, simplest, highest-confidence mechanism with the best return on effort. Direct rewiring or internal uninstall/reinstall preserving settings/data are both acceptable. Do not infer a generic extensible installer engine, registry or comprehensive transaction system from these requirements.

### Authority (restated for the implementer)

The authority rules at the top of this ticket apply in full. This ticket is the sole authority for the work and completely supersedes the body and comment thread of #4730; cancel #4730 as "won't fix" without deleting it. Where current code makes the pin follow the running CLI (`reconstituteConsumerPinAndLock`, `pinLagsReconstitutedVersion`, the `align-pin` plan mode), that behaviour is to be **removed**. Part B acceptance criteria bind done; Part C specifies INIT-cited behaviour and fills silence; if they appear irreconcilable, stop and ask the operator. The two original overrides remain explicit (install has no `--upgrade` option, and the pin is `@deftai/directive-runtime`), and bounded plans and equal-version upgrade behaviour (AC4.10 status, setup-when-stale, then migrate) are also incorporated. No older examples or external issue text override these decisions. If a requirement looks wrong or impossible, stop that slice and raise it with the operator. Do not reinterpret it.

## D3. Keep these two things separate at all times

The `deftai/directive` repository is both the source of the tool and a user of the tool. Hold this line:

- **You are changing the product**: code under `packages/`, content under `content/`, docs. The target of the change is a *user's* project.
- **You are not changing this repo's own Directive install.** Do not run `directive install`, `upgrade` or `uninstall` (or `init` / `update` / `remove`) against the `deftai/directive` checkout or any swarm worktree of it as a way of testing your work. Do not hand-edit this repo's own `.deft/`, hook configs or pin. This repo keeps using the released Directive it has today until the work is released and the operator upgrades it.
- Required consumer-installation acceptance testing happens in **throwaway fixture projects** created by tests in temp directories, with packages installed from tarballs built from your branch and a launcher installed into an isolated global location (R15).
- The exact mechanism for developing and testing Directive itself is left to the Directive principal during implementation and is not specified at design time. It may include global installation, local accommodations, an environment variable, checking Git origin, or another mechanism selected by the principal. This design prescribes neither a source-checkout detection mechanism nor particular bypass rules; the principal makes those implementation decisions.

## D4. Hard rules

1. The installation-management command surface is exactly `install`, `upgrade`, `uninstall`, `doctor`, plus `init`/`update`/`remove` as accepted, undocumented names. Installation-management flags only where the requirements name them: `--root`, `--package-manager`, `--target-version`, `--repair`, `--yes`/`-y`, `--dry-run`, `--help`/`-h`. No `--force`, no `--upgrade` on `install`, no redirects for retired verbs.
2. **The consumer launcher stays version-neutral.** Allowed: the Node version check; Git-aware project discovery; reading and minimally editing `package.json`; telling npm and pnpm apart from project evidence and running their add/install/remove with the project's settings; refusing Yarn and Bun; resolving the latest stable version and validating an exact one; plans, prompts, `--yes`, `--dry-run`; the contract, including runtime-supplied read-only data status; old-style detection; and, for `uninstall` only, the persistent ownership/removal record and map of supported install shapes. Ordinary runtime-command passthrough is also required. Changes to this consumer responsibility boundary need operator clarification. Directive's own development/testing accommodations are separately left to the principal under §D3.
3. **The launcher has no dependencies** and is one self-contained file, fully loaded before it runs a package manager.
4. **The contract is frozen once written.** Slice 1c writes it; afterwards any change to an entry point, exit code or passed value needs operator approval.
5. **Only the launcher's `install` (first time) and `upgrade` write the pin**, and only through the package manager's native add. Nothing in the runtime writes it. `doctor` writes nothing at all.
6. **Only upgrade migrates existing xbrief data within installation management.** Setup/repair/automatic setup may read settings. First-time install may create missing initial seed project-data files; repair and automatic setup must not. Ordinary product-data operations remain outside this restriction.
7. **No copied product content in `.deft/core`.** Generated wiring, readiness/generation metadata and project seeds remain allowed. Every product-content pointer, `AGENTS.md` reference and hook target is under `node_modules/@deftai/directive-runtime/`. If a slice finds a case where that cannot work, stop and ask; do not reintroduce a copy.
8. Approved launcher bootstrap/update advice is allowed. Standard installation/wiring recovery is `npm i -g @deftai/directive`, then `directive install --repair`. Directive itself never runs global package installation/update/removal. Never use a global product runtime as project repair. Repair errors on missing/ranged/invalid/conflicting pins and leaves them unchanged.
9. Messages aimed at agents never say `npx` or `pnpm exec`. Humans are told to install the global launcher. The managed `AGENTS.md` text and skill pointers carry the recovery instruction from AC9.7 using that standard sequence.
10. `update` now means `upgrade`. Every message, doc, template or skill that today tells someone to run `update` as a repair must be changed to `directive install --repair`. Track it as an inventory, not a find-and-replace.
11. Ignore changes are limited to needed `node_modules` and `.deft/directive/wiring-ready.*.json` entries. `.deft/GENERATION.json` keeps its name and stays committed.
12. Delete, don't deprecate: `migrate`, `bootstrap`, `install-upgrade`, `install-uninstall`, the Go installer under `cmd/deft-install/`, the `.deft/core/` deposit code, the engine ladder and skew policy, the core-vs-content skew notices, and the publishing of `directive-core`, `directive-content`, `directive-types`.
13. The private `core/`, `content/` and `types/` folders keep their boundaries (AC13.5): no code in `content/`, only types and schemas in `types/`.
14. Use Directive's normal process for this repo: scopes/xBRIEFs per slice, swarm worktrees, one PR per slice, the standard gates. If a gate fails *because* of the old global-first, copied-content or four-package assumptions you are removing, fix the gate in the same slice and say so in the PR.
15. Distributed content and wholly owned generated files are disposable even if edited. Remove legacy core during conversion/uninstall without historical-hash preservation or a special edit warning. Maintain the persistent ownership record, distinguishing whole files from Directive-owned marked sections/structured entries and retained settings/data; reuse existing section markers. Preserve user settings/data and user-owned shared-file entries; never infer ownership of an entire shared file or all `.deft`. Uninstall uses the repository uninstaller when safely available, then launcher cleanup, with no prerequisite installation, repair or upgrade of either package. Missing/damaged/unfamiliar records permit safe best-effort cleanup and honest reporting of leftovers or uncertainty.
16. Preapproval/dry-run plans are bounded; no exhaustive migration preview, target planner or temporary target execution. The verified target returns actual changed/migrated paths and outcomes after execution. If work cannot complete safely within approved scope, stop/fail; a “new proposal” means the user starts a new command.
17. Readiness is per checkout and runtime version. Invalidate superseded markers when rewiring begins; write one only after verification, never on failure/conflict. Keep the cheap valid fast path, version-switch behavior and same-pin simultaneous-auto-repair convergence test (last writer OK; no required locking). Broader lifecycle concurrency and its test matrix are deferred; uninstall must still preserve shared Git-hook activation needed by another worktree. Setup may set `core.hooksPath` to relative `.githooks`.
18. Do not relocate existing project settings/housekeeping in this change. Record the future direction of `.deft/directive/settings.json`, separate ignored ephemeral state, and xbrief as independent customer-project data.

## D5. Work plan

Waves 0–2 deliver the initial release. The separately organized historical survey follows without blocking it. Slices in a wave may run in parallel when their file sets do not overlap. Each slice is one PR that lists the acceptance criteria it satisfies. This sequencing is consistent with §A6.9.

**Wave 0 — assumption confirmation and harness (non-blocking premise smoke; does not gate Wave 1)**

- 0a. **Assumption confirmation (non-blocking): paths under `node_modules`.** The closed design assumes hosts can open/read package files under `node_modules` after install (AC9.8), based on light testing. Delivery may include a non-blocking smoke confirmation per applicable host (Claude Code, Cursor, Codex, Grok, Copilot, OpenClaw where applicable): a thin pointer / `AGENTS.md` reference under `node_modules/@deftai/<something>/…`, and for hook-capable hosts `node node_modules/@deftai/<pkg>/dist/hook-bin.js …` on macOS, Linux and Windows, plus what each host shows when the file is absent (AC14.3). Report results to the operator as delivery evidence. **This is not an open design question and does not gate Wave 1.** If a specific host cannot follow package-relative pointers, treat it as host-specific remediation / limitation — not a reopen of this design.
- 0b. Fixture matrix (R15): helpers that create a temp project, pack the packages from the branch, install with npm and pnpm, install the launcher into an isolated global location, and simulate each host's hook invocation from its committed config. Fixtures for the latest package.json-pinned/copied-core architecture from real published versions, including its applicable integrations. Initial-release R14 cases become tests; historical follow-up cases are explicitly deferred.
- 0c. CI runs the matrix on macOS, Linux and Windows, on Node 22 and 24, with a non-blocking Node 20 job.

**Wave 1 — groundwork and the package collapse**

- 1a. The in-sync check (R2) as one module, full and cheap forms.
- 1b. `GENERATION.json`: persistent ownership/removal record with fingerprints and the PM used; distinguish whole files, marked sections/structured entries and retained settings/data; reuse existing markers and keep the record available when the runtime is damaged. Remove fields that change on every run (AC11.10, AC13.2).
- 1c. **The contract document** (R4, AC4.1) — written, reviewed, and signed off by the operator before 1d.
- 1d. **The package collapse.** Create `packages/runtime` as `@deftai/directive-runtime`; move today's CLI code and core into it; bundle `content/` and `types/` into its build; mark `core`, `content`, `types` private; update the publish workflow to two packages (AC13.4); enforce the folder boundaries (AC13.5). Reduce `packages/cli` (`@deftai/directive`) to the launcher skeleton: Node check (R16), discovery (INIT-05..07), reading pin and runtime metadata, routing (R3), hints (AC3.15), unknown-command handling (AC3.16), contract handling. Directive's own development/testing mechanism is selected by the principal during implementation (§D3), not prescribed in this slice. Delete the Go installer (AC10.10).

**Wave 2 — the switch (ships as one release)**

- 2a. **`install`** (R6): launcher side — discovery, PM selection (INIT-08..10), plan (INIT-11), approval, manifest handling (INIT-12), PM add (INIT-13), verification (INIT-14), hand-off; the rerun menu with the Repair default rule (INIT-15, INIT-16); `--repair`, `--target-version`, `--yes`, `--dry-run`; failure and completion reporting (INIT-21, INIT-22); exit codes (INIT-23). Runtime side — setup `--operation install|repair` (R8), wiring plus permitted settings reads; first-time install may seed missing project-data files; repair does not; idempotent, conflict-naming, exit 1 on conflicts. Fix Windows package-manager spawning (#5383) here; it is on the critical path.
- 2b. **`upgrade`** (R7): launcher side — target resolution and **contract preflight** before the prompt, the no-op and reject rules including "pin current, wiring/data behind", using the runtime's read-only data-status contract (AC4.10) for equal-version decisions; diagnosis failure is an error, not a no-op. Bounded plan with setup/migration disclosure, not exhaustive advance migration list, PM add, verification, hand-off to the new runtime's setup then migrate (equal-version: setup-when-stale then migrate); Example F reporting. Runtime side — read-only status, setup `--operation upgrade --from <X>` and the migrate entry point for initially supported schemas, including equal-version setup-when-stale and safe retry. Wider historical schema coverage is follow-up.
- 2c. **Package-relative wiring and the end of the copy** (R9, AC13.1): `AGENTS.md` template, pointers, all existing applicable host integrations, including conditional ones, git hooks, Taskfile include, all with the recovery instruction (AC9.7); rewrite of existing bare `deft-hook` entries; the hook's identity and in-sync check with the standard launcher-plus-repair recovery message; delete the `.deft/core/` deposit, deposit hygiene and the content locators.
- 2d. **Self-completing setup** (R8): per-checkout versioned readiness, cheap validity checks and automatic activation on first eligible runtime invocation, even when generation is current. Preserve settings/existing data; do not create initial seed project-data files; invalidate old readiness before rewiring and verify before marking ready. Cover fresh clone/worktree, version changes without global invocation, fast path, failure and same-pin concurrent automatic repairs (convergence / last writer OK). Doctor and all children remain read-only (`DEFT_DOCTOR_HOOK_DIAGNOSTIC` on probes).
- 2e. **`doctor`** (R12): the runtime's full check on the new surfaces including schema currency; the launcher's basic diagnosis; delete the engine ladder, skew policy and skew notices; replace global-runtime repair advice and remove automatic global installation; keep approved launcher guidance and update message checks accordingly; verify real hook probes cannot mutate wiring, readiness or Git configuration; complete the rule 10 inventory and the rule 9 agent wording.
- 2f. **Latest legacy architecture** (R10): detect its exact package.json pin and copied core using real installation evidence, never directory existence alone. Convert to runtime pin/package wiring, remove legacy core even if edited, preserve settings/data, migrate supported schemas and verify every existing applicable feature point. Direct rewrite or internal uninstall/reinstall is allowed. Comprehensive historical coverage is separate follow-up; no extensible conversion engine is mandated.
- 2g. **`uninstall`** (R11): launcher-side discovery from persistent ownership information and known artifacts, plan, approval, repository uninstaller when safely available, then launcher fallback cleanup even when that uninstaller is unavailable or fails. No prerequisite installation, repair or upgrade of either package. Honor whole-file versus marked-section/structured-entry ownership, preserve retained settings/data, report partial cleanup honestly, remove the dependency through the PM, and preserve shared `core.hooksPath` activation needed by sibling worktrees.
- 2h. Delete old verbs (AC13.6); worktree creation runs the package install (AC14.25).
- 2i. Documentation (AC13.8–AC13.10): the launcher page; the known-limitations page from §A9; README, getting-started, UPGRADING, QUICK-START, ARCHITECTURE, `content/docs/full-stop.md`, `content/docs/hook-runtime-unavailable.md`, the `AGENTS.md` template; `--help` text (AC13.7); the Node support statement (AC16.2).

**Separate follow-up — historical survey (required, nonblocking for initial release/beta)**

- 3a. Walk the repository history and `CHANGELOG.md` and enumerate every install layout Directive has produced (Go installer tarballs, vendored `.deft/core`, `deft/` folders, submodules, pre-0.27 `AGENTS.md`, every npm-era shape) and every `xbrief`/`vbrief` schema version, with the versions that produced each. Check the table in.
- 3b. For each shape, decide convert or uninstall-and-reinstall, and fill the conversion map (2f), the migrate entry point (2b) and the uninstall map (2g). Add a fixture and tests per shape (AC15.2). Do not advertise support for a shape before its recovery tests pass. This historical expansion does not gate initial completion (AC10.7–10.8).
- 3c. Report the table and the decisions to the operator; if the recommendation is "demand uninstall and reinstall at 1.0", say so with the reasons.

## D6. Testing expectations

- Every PR names the acceptance criteria it claims and includes the tests that prove them. A PR that claims an AC without a test is not done.
- Tests run real package managers against real packed tarballs. Mock only for failure injection (AC14.15–AC14.18, AC14.52, AC14.56, and the diagnostic/uninstaller failure cases in AC14.62 and AC14.64).
- Tests never touch the machine's real global npm folder, `~/.config/deft`, or the Directive checkout's own install. Add a guard that fails the run if one does.
- Windows is not optional and not last. Every Wave 2 slice is green on Windows before merge.
- The contract has its own named test suite (AC4.1) run across every launcher/runtime pairing (AC15.3).
- Reviewer agents for each PR check six things: (1) only the launcher's `install`/`upgrade` write the pin, through the PM; (2) only upgrade migrates existing project data, while settings reads and initial seeding follow R8; (3) the launcher has gained no version-specific knowledge (rule 2) and no dependencies; (4) no copied product content remains and all existing applicable integrations target the local package; (5) doctor and every child write nothing; automatic setup preserves the pin, existing data and user-owned content and records readiness only on success; (6) no message says `update`/`upgrade` where it means repair, none says `install --repair` where it means migrate, and no agent-facing message says `npx` or `pnpm exec`.

## D7. When to stop and ask the operator

- After spike 0a, before Wave 1.
- Before freezing the contract (1c), and for any later change to it.
- A slice wants the launcher to know something outside rule 2's list.
- A slice cannot keep a product-content/execution target under `node_modules/@deftai/directive-runtime/` (rule 7), or needs setup/repair/automatic setup to create seed files or mutate existing xbrief data (rule 6 — first-time install seeds only; migration is upgrade-only).
- Bundling `core/`, `content/` or `types/` into the runtime turns out to need a change to how any of them is written.
- A requirement conflicts with another, with Part C, or cannot be met on one OS or package manager.
- The survey finds an install shape or schema version that neither conversion nor uninstall-and-reinstall can handle.
- A change would require altering `xbrief` lifecycle semantics beyond the schema migrations.
- A slice needs a new installation-management command/flag not named in the requirements; ordinary runtime commands remain intact.

Ask one specific question with your recommended answer. Continue with unblocked slices while waiting.

## D8. Release

- Wave 2 ships as a single release after initial-scope acceptance passes, including latest package.json-pinned/copied-core conversion and integration preservation. The separate historical survey is nonblocking. The first launcher and runtime ship at the same version (AC13.4). Wave 1 may ship with it. Do not publish from the swarm; the operator cuts releases.
- Release note for users: once per machine → `npm i -g @deftai/directive@latest`; new project → `directive install`; existing project on the supported latest legacy layout → `directive upgrade`; after clone or pull → `pnpm install` (first eligible runtime invocation completes local activation); installation/wiring trouble → `npm i -g @deftai/directive` then `directive install --repair`; to migrate data after a Dependabot bump → `directive upgrade`; CI and swarms → `npm i -g @deftai/directive` then `directive install --repair --yes`. Include the known-limitations page.
- After release, upgrading the `deftai/directive` repo's own install is a separate operator task. It is not part of this swarm.

## D9. Final report

When the initial-release slices are merged, report: each requirement R1–R16 with initial criteria pass/fail and explicit historical follow-up status; the spike 0a results per host; the contract document and its test results; the initial legacy fixtures and integration inventory; the separately organized historical survey status and deferred coverage; other explicit limitations; the fixture-matrix run for all OS × package-manager × Node cells, including the non-blocking Node 20 results.

---

*End of ticket. This document is self-contained: Parts A–D together are the complete and authoritative statement of the work. Review it against itself, not against prior install-simplification issues, not against #4692, #4710, #4718 or #5245, and not against the current implementation, which this work replaces.*
