# Contributing to Deft

Guide for setting up a development environment, running tests, and building the project.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Prerequisites

The following tools must be installed before working on Deft:

- **Node.js 24+** and **pnpm** — required for the TypeScript CLI (`packages/cli`) and test suite
- **Go 1.22+** — required for building the installer (`cmd/deft-install/`)
- **task** — Taskfile runner ([taskfile.dev](https://taskfile.dev))

Python is not required for the CLI or the default test suite. The retired root `run` launcher and `uv run python` CLI are gone.

## Grok Build as parent (#4035)

If Grok Build is the parent agent and Claude Code / Codex run as subscription CLIs, follow [Grok Build subscription-only setup](./content/docs/grok-build-subscription-setup.md). That playbook is host auth, not Directive `session:start`.

Verify your toolchain:

```bash
node --version    # v24 or later
pnpm --version    # any recent version
go version        # go1.22 or later
task --version    # any recent version
```

## Windows quickstart (#902)

A fresh Windows maintainer can bootstrap the entire toolchain with a single command. This wraps the canonical `winget` package ids for Go, Python 3.12, uv, Task, and the GitHub CLI, then refreshes the running shell's `PATH` so the new binaries are visible without launching a new session.

One-line bootstrap (preferred):

```powershell
task setup:toolchain
```

Or invoke the script directly:

```powershell
pwsh -ExecutionPolicy Bypass -File scripts\setup_windows.ps1
```

The script is **idempotent**: it probes each tool via `Get-Command` first and only invokes `winget install` when the binary is missing. Re-running on a fully-provisioned machine prints an `Already present: ...` summary and exits 0. Each `winget install` runs with `--silent --accept-source-agreements --accept-package-agreements` so the bootstrap is non-interactive and CI-friendly.

If you launched your shell **before** running the bootstrap (or before any `winget install`), refresh the in-process `PATH` from the registry without restarting:

```powershell
. scripts\refresh-path.ps1
```

The helper merges the system PATH (`HKLM:\System\CurrentControlSet\Control\Session Manager\Environment\Path`) and user PATH (`HKCU:\Environment\Path`), de-duplicates while preserving order, and assigns `$env:PATH` in the current session. This is the same registry-key contract the Go installer's `refreshPathFromRegistry()` helper uses (#899) -- both surfaces read from the exact same two keys.

### Manual fallback (no winget)

If `winget` is unavailable on your host, install each tool from its official source:

- **Go** -- https://go.dev/dl/
- **Python 3.12+** -- https://www.python.org/downloads/windows/
- **uv** -- https://docs.astral.sh/uv/getting-started/installation/
- **Task** -- https://taskfile.dev/installation/
- **GitHub CLI** -- https://cli.github.com/

After each install, dot-source `scripts\refresh-path.ps1` to pick up the new entries without restarting your shell.

### Windows-native Node / pnpm notes (#2467)

When running tests with Windows-native Node (not WSL), a few extra steps help:

1. **pnpm user-prefix** — ensure pnpm's bin dir is on `PATH` so `pnpm` and
   `directive` are found:

   ```powershell
   pnpm setup       # writes %APPDATA%\npm to PATH (user-level)
   # restart PowerShell, or:
   $env:PATH = "$env:APPDATA\npm;" + $env:PATH
   ```

2. **LF line endings** — the repo ships `.gitattributes` with `* text=auto eol=lf`.
   If you cloned before this was added, re-normalize with:

   ```powershell
   git rm --cached -r .
   git reset --hard
   ```

3. **Symlink tests** — a handful of tests that exercise `symlinkSync` require
   Developer Mode or an elevated shell. They are automatically skipped on Windows
   via `it.skipIf(process.platform === "win32")` so a standard shell is fine.

### Install scripts (pnpm `allowBuilds`, not npm `allowScripts`)

Monorepo install-script authority is **pnpm** `allowBuilds` in `pnpm-workspace.yaml` (today: `esbuild: true` for vitest's platform binary link). CI and local installs use `pnpm install` / `pnpm install --frozen-lockfile`. Do **not** run `npm approve-scripts` against the pnpm virtual store and treat that map as monorepo SoT — npm v12 consumer allowlists apply to npm-managed app trees, not this layout. See [UPGRADING.md — npm v12 install-time security defaults](./content/UPGRADING.md#npm-v12-install-time-security-defaults).

## Contained writes (#2951)

Product write sinks under `packages/core/src/**` must use the shared
`containedWrite` API instead of bare `writeFileSync` / `appendFileSync` /
`createWriteStream`. The API resolves the target under an explicit root,
refuses symlink escape and out-of-root paths, then writes with an explicit
mode (`create` | `replace` | `append`) and stable error codes.

- **Contract + agent rules:** [`docs/reference/contained-write.md`](docs/reference/contained-write.md)
- **Implementation:** `packages/core/src/fs/contained-write.ts`
- **Inventory (fail-open Phase 1):** `task verify:contained-writes`  
  Pass `--enforce` only when intentionally fail-closing. Not in `task check` yet.

AppSec “one more medium sink” fixes should prefer migrating the call site onto
`containedWrite` over another bespoke containment helper + raw write pair when
behavior is equivalent. Tests and fixtures may keep using raw writes.

4. **`chmod`-based tests** — Windows does not honour POSIX `chmod` semantics;
   those tests are likewise skipped automatically.

## Dev Environment Setup

1. Clone the repository:

```bash
git clone https://github.com/deftai/directive.git
cd directive
```

2. Install JavaScript dependencies:

```bash
pnpm install
```

3. Verify everything works:

```bash
task check
```

### Linux / WSL Maintainer Bootstrap

If you are bootstrapping a framework checkout with a published `deft-install`
binary, use maintainer mode:

```bash
deft-install --yes --upgrade --maintainer --repo-root /path/to/directive --json
```

Maintainer mode validates that `--repo-root` is a `deftai/directive` checkout,
reports core setup status, and skips consumer projections such as `AGENTS.md`,
`.gitignore`, `.gitattributes`, guard workflows, consumer `vbrief/` scaffolding,
and root Taskfile wiring. That keeps the maintainer-owned repository files from
being rewritten by the consumer installer path.

`ghx` is maintainer and swarm tooling: it speeds up repeated read-only GitHub API
calls and helps protect shared rate limits. Consumer projects require `gh` for
GitHub-backed workflows and work normally without `ghx`. Maintainers can opt in
with:

```bash
task setup:ghx
```

## Running Tests

Run the test suite:

```bash
task test
```

Run tests with coverage reporting:

```bash
task test:coverage
```

### The `task check` Gate

! `task check` is the **authoritative pre-commit gate**. It runs validation, linting, and the full test suite in sequence:

```bash
task check    # runs: validate + lint + test
```

! A passing `task check` is the **definition of ready-to-commit**. Do not commit unless `task check` passes.

⊗ Commit code that has not passed `task check`.

### Telemetry coverage (#3362)

! A telemetry deliverable is not done until a fixture reads its events from a fake trial (`task verify:telemetry-coverage`). Silence is the failure mode this gate exists for.

⊗ Add a run-summary event kind or emitter method without a production caller and a field-shaped fixture. The framework `task check` list ships this gate warn-only this release; pass `--enforce` to fail closed.

### AGENTS.md line budget (#645)

`task verify:agents-md-budget` (wired into `task check:framework-source`) is a **ratchet** that keeps AGENTS.md a map, not a manual (#1882). It counts the managed section and the unmanaged region separately and fails when either grows past `plan.policy.agentsMdBudget.{managedMaxLines,unmanagedMaxLines}` in `PROJECT-DEFINITION`. The budget is seeded at the current per-region size, so the gate ships green; only *growth* fails.

- ! When you need to add content, push the detail into a reference doc (`main.md` section, a content pack, or `docs/`) and leave a pointer from AGENTS.md — do not expand AGENTS.md itself. See `REFERENCES.md` § "AGENTS.md is a map, not a manual".
- ! When you *reduce* AGENTS.md, lower the matching `managedMaxLines` / `unmanagedMaxLines` in the same PR so the ratchet tightens toward the ~150-line ceiling.
- ? If growth is genuinely warranted (e.g. a new #1309-propagated consumer rule), raising the budget is an explicit, reviewed diff to the typed field — that diff is the "was this growth deliberate?" checkpoint.

### Slow tests (#975)

Keep default `vitest run` / `task check` fast on tight-loop iteration. The retired Python `@pytest.mark.slow` lane (`pyproject.toml` `addopts`, `task check:slow`) is gone with the Python CLI. The **1s threshold is still the contributor decision point**.

```bash
task check                          # merge chokepoint -- full gate
pnpm exec vitest run --coverage <paths>   # iteration lane on changed modules
```

! When a test you write exceeds ~1s, refactor it to use injected clocks / fake timers so it runs in milliseconds. Do not add a pytest slow marker; that lane does not exist on this tree.

~ During implementation, use the iteration lane (`vitest run` on changed paths, `task coverage:hotspots`, `task verify:forward-coverage`) rather than full `task check` on every commit (#1704). Run full `task check` once before push/PR.

~ When profiling a suite that feels slow, run `pnpm exec vitest run <file> --reporter=verbose` (or the equivalent `task` invocation) and look at wall-clock. If a single test exceeds 1s, refactor it before merging.

⊗ Hide flaky tests behind a slow marker or skip -- flaky tests should be fixed at the root cause.

## Running CLI Locally

The Deft CLI is TypeScript. On a framework-source checkout, `task <verb>` goes through `engine:invoke`, which runs `packages/cli/dist/bin.js` (rebuilt by `engine:_ts-build` when sources are newer). You can also invoke the dist binary directly after a build:

```bash
task doctor
task check
node packages/cli/dist/bin.js doctor
```

Useful local commands:

```bash
task session:start             # Session ritual
task doctor                    # Check system dependencies
task check                     # Authoritative pre-commit gate
task project:render            # Refresh project definition exports
```

## Building the Go Installer

The Go installer lives in `cmd/deft-install/`. Build it with:

```bash
go build ./cmd/deft-install/
```

This produces a `deft-install` binary (or `deft-install.exe` on Windows) in the current directory.

To run the installer directly without building first:

```bash
go run ./cmd/deft-install/
```

To run the installer's tests:

```bash
go test ./cmd/deft-install/
```

## CHANGELOG entry style (#1242)

`CHANGELOG.md` `[Unreleased]` entries are released as the body of the
GitHub release for the next version. **GitHub caps release bodies at
125,000 characters** -- the v0.32.0 release-blocker (#1242 recurrence
anchor) was that the auto-generated body for the promoted `[Unreleased]`
section blew past that cap because the entries had drifted into
engineering-log territory (multi-paragraph file-by-file walkthroughs).
The rule below keeps that ceiling out of reach forever.

! `[Unreleased]` and promoted-version entries MUST be brief release-notes,
not implementation detail. Target 2-4 sentences per entry (roughly
300-800 characters), max one paragraph.

! Each entry MUST reference the canonical PR and/or issue number(s) so
readers who want implementation detail can follow the link. `Closes #N`
and `Refs #N` tails at the end of the entry MUST be preserved when
rewriting.

! Each entry MUST describe the user-visible change in plain English, not
the conventional-commit subject or internal change name. Mirrors the
personal ship-report convention.

⊗ MUST NOT inline file paths, file lists, test counts, schema fragments,
function signatures, or implementation walkthroughs in CHANGELOG
entries -- that detail belongs in the PR body where the reviewer needs
it, not in the release-notes surface readers consume.

⊗ MUST NOT exceed roughly 800 characters per entry. If the change
genuinely needs more, split into multiple distinct user-visible bullets
or move the detail to the PR body and link it.

~ Entries SHOULD lead with the user-visible benefit, then the mechanism,
then the link.

Example (good):

> **feat(cache): REST writer migration (#1239)** -- `task
> triage:bootstrap` is now ~99% faster on large repos (~13s vs ~504s for
> 396 issues). Cache fetch now uses paginated REST instead of GraphQL,
> and the queue reader defensively lowercases the cached `state` field
> so pre-migration caches still surface. Closes #1239. Refs #1119.

Example (bad):

> **feat(cache):
> packages/core/src/cache/fetch-all.ts migrated to paginated REST via
> packages/core/src/scm/call.ts. Backward-compat reader normalizes
> uppercase state. New tests at packages/core/src/cache/fetch-all.test.ts
> exercise...** [continues for 4 paragraphs of file paths, function names,
> and per-test assertions]

The load-bearing difference: the bad version is what the PR body should
carry; the good version is what the release notes carry. A reader who
wants the bad version's detail clicks through to the PR via the
`#1239` link.

A deterministic-tier lint gate that enforces this at commit time is a
separate follow-up; for now the rule is prose-tier and enforced via
code review on every PR that touches `CHANGELOG.md`.

## Windows CLI_ARGS quoting limitation (#1231)

Every `task` fragment under `tasks/` forwards user-facing flags into the
TypeScript CLI via `engine:invoke` and go-task's `{{.CLI_ARGS}}` placeholder.
The placeholder is substituted **bare** -- go-task's `shellQuote` filter
misbehaves on Windows (#577) so wrapping `{{.CLI_ARGS}}` in double quotes
is NOT a viable hardening, and changing the substitution shape is
deferred to a follow-up that switches to a temp-file argv dispatch.

The practical consequence on Windows shells (cmd.exe, PowerShell): an
argument value that contains spaces may be re-split by the shell before
the verb's argv parser sees it. For example, this DOES NOT work as written on
Windows:

```powershell
task slice:record-existing -- --umbrella=1119 --children=1121,1122 --notes "backfill after N7 landed"
```

Workarounds, ranked by simplicity:

1. **Single-token values (preferred for routine use):** drop the spaces
   so the value parses as one argv element regardless of the shell, e.g.
   `--notes=backfill-after-N7-landed`.
2. **`=` form with quoting:** `--notes="backfill after N7 landed"` works
   in PowerShell 7+ and bash but is fragile under cmd.exe; test before
   adopting in cohort docs.
3. **WSL / bash / pwsh 7+ shell:** if you must use a multi-word value
   verbatim, run the task from a POSIX-ish shell where `{{.CLI_ARGS}}`
   substitution preserves quoting.

The limitation is **repo-wide**: every `tasks/*.yml` fragment uses the
same bare-`{{.CLI_ARGS}}` shape, so the workarounds above apply to every
`task triage:* `, `task scope:*`, `task slice:*`, etc. verb. The verb's
`task --list` description (and each verb's `--help`) name the
limitation in their summary when a multi-word value is a plausible
operator input.

## Issue labels (this repo) (#2609)

Maintainer taxonomy for **`deftai/directive` only** lives in [`.github/ISSUE_LABELS.md`](.github/ISSUE_LABELS.md):

- Facets (type, `area:*`, platform, status role, machine/mirror)
- When to apply `epic` vs `status:tracker` / `status:child`
- Machine labels (`triaged`, `triage:*`) used by SCM label mirror
- Twin decisions (legacy vs forward names)

Before inventing a label or applying epic/child roles, read that file. Prefer **colon** facet names; never apply `legacy:*` (closed-history quarantine only). Portable **consumer** kit is [`content/docs/consumer-issue-label-kit.md`](content/docs/consumer-issue-label-kit.md) (**#2611**) — not this full set. Open-issue migration onto the scheme is **#3128** (one-shot: `node .github/scripts/migrate-issue-labels-3128.mjs --dry-run` then `--apply`; report in `.github/ISSUE_LABEL_MIGRATION_3128.json`).

## Adding a new triage / scope verb (#1150 / N10 / #4091)

Every `task triage:*` and `task scope:*` verb is documented in one place:
the hand-maintained help registry in
`packages/core/src/triage/help/registry-data.ts`. Edit that file in place.
There is no generator. ⊗ Regenerate help from Python.

Bare `task triage` / `task scope` and per-verb `--help` both render from
this registry, so a new verb without a registry entry will not appear in
the operator-facing catalog.

`engine:invoke` (`tasks/engine.yml`) runs `packages/cli/dist/bin.js` on a
framework-source checkout. Dist is rebuilt by `engine:_ts-build` when
sources are newer. Slash-command / native-wrapper deposit
(`content/commands.md` § Native multi-host registration) is a different
family and out of this section.

There is no single undifferentiated dispatch path. Pick a topology.

### Topology A — new CLI module

Standalone verb (example: `task triage:evaluate`).

1. **Handler** in `packages/cli/src/<stem>.ts` (or a core-only entry under
   `packages/core/src/` with no CLI wrapper). Export `run` / `main`.
2. **Register the stem** in `CLI_MODULE_VERBS` (CLI wrapper) or
   `CORE_MODULE_VERBS` (core-only) in `packages/cli/src/dispatch.ts`. Add a
   `VERB_ALIASES` colon spelling (`"triage:foo": "triage-foo"`).
3. **Taskfile fragment** under `tasks/` that calls `engine:invoke` with
   `ENGINE_CMD: '<stem> {{.CLI_ARGS}}'`. Expose `task triage:foo` as a root
   alias in `Taskfile.yml`.
4. **Help triple** in `registry-data.ts` (edit in place):
   - `registry["task triage:foo"]` with `summary`, `refs`, `description`,
     `usage`, `flags`, `examples`, and `see_also`. Keep `summary` <= 70 chars.
   - Verb name under the matching role in `categoriesTriage` /
     `categoriesScope`. Do not re-organize existing categories without an
     umbrella amendment.
   - `scriptSubcommandMap["triage_foo"]`. Use `"__default__"` for a
     single-verb module.
5. **`interceptHelp("triage_foo", argv)`** at the top of the handler
   `run()`. The dispatcher also forwards `--help` for mapped script ids so
   advertised forms compose: `directive triage:foo --help`,
   `directive triage-foo --help`, and `task triage:foo -- --help`.
   `triage:accept --help` failing while `triage:evaluate --help` works is
   the class this intercept exists to catch.
6. **Guards:** `packages/cli/src/dispatch.test.ts` (every CLI module verb,
   core verb, and alias). New source files need a colocated test;
   `task verify:forward-coverage` is in `task check`.

### Topology B — multiplexed subcommand

New subcommand of an existing dispatcher (example: `task triage:accept` on
`triage-actions`).

1. **Handler case** in the existing module (e.g.
   `packages/cli/src/triage-actions.ts`).
2. **Alias-to-subcommand map** in `dispatch.ts`
   (`TRIAGE_ACTION_ALIAS_SUBCOMMANDS` or the matching family) **and** a
   matching `SUBCOMMAND_ROUTES` row in
   `packages/cli/src/cli-router/route-argv.ts`. The alias maps must mirror
   `SUBCOMMAND_ROUTES`.
3. **Taskfile** inner task that invokes `engine:invoke` with the subcommand
   token (`ENGINE_CMD: 'triage-actions accept {{.CLI_ARGS}}'`) plus a root
   `task triage:accept` alias.
4. **Help triple** as in topology A, with
   `scriptSubcommandMap["triage_actions"]` mapping `accept` →
   `task triage:accept` (not `__default__`).
5. **`interceptHelp("triage_actions", argv)`** at handler `run()` so
   `accept --help` resolves. Dispatch injects the subcommand for colon
   aliases (`triage:accept --help` → `["accept", "--help"]`) and intercepts
   `--help` before the handler parser.
6. Same `dispatch.test.ts` / `verify:forward-coverage` guards.

### SCM boundary and containment

Route `gh` / `ghx` through `packages/core/src/scm/call.ts`
(`call(source, verb, args)`). `task verify:scm-boundary` is the merge-path
gate (`packages/core/src/verify-source/scm-boundary.ts`).

That gate's `SCOPE_GLOBS` still lists retired `scripts/triage_*.py` /
`scripts/scope_*.py` paths. `scripts/` has no `.py` files, so the glob set
is vacuous and a green result does not mean TypeScript verb modules were
scanned. Owner of that vacuity: `packages/core/src/verify-source/scm-boundary.ts`
(`SCOPE_GLOBS`). Do not treat the empty Python glob as the TypeScript control.

Product write sinks under `packages/core/src/**` use `containedWrite`
(`packages/core/src/fs/contained-write.ts`). Inventory:
`task verify:contained-writes` (not in `task check` yet; `--enforce`
fail-closes).

7. **CHANGELOG** `[Unreleased]` entry referencing the umbrella and the
   verb's child issue.

Forward-looking placeholders (verbs whose implementation has not landed
yet) carry `placeholder: true` so the structured help prints a
"(not yet implemented)" note. Replace the placeholder entry's metadata
when the verb's implementation child merges.
