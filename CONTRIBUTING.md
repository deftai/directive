# Contributing to Deft

Guide for setting up a development environment, running tests, and building the project.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Prerequisites

The following tools must be installed before working on Deft:

- **Go 1.22+** — required for building the installer (`cmd/deft-install/`)
- **Python 3.11+** — required for the CLI (`run`) and test suite
- **uv** — Python package manager and task runner ([docs.astral.sh/uv](https://docs.astral.sh/uv))
- **task** — Taskfile runner ([taskfile.dev](https://taskfile.dev))

Verify your toolchain:

```bash
go version        # go1.22 or later
python --version  # Python 3.11 or later
uv --version      # any recent version
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

## Dev Environment Setup

1. Clone the repository:

```bash
git clone https://github.com/deftai/directive.git
cd directive
```

2. Install Python dependencies:

```bash
uv sync
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

### Slow tests (#975)

Deft uses a `slow` pytest marker to keep `task check` fast on tight-loop iteration. Tests that exceed ~1s wall-clock (e.g. real `time.sleep` / thread-join waits in the watchdog regression suite) are marked with `@pytest.mark.slow` and **excluded by default** from `task check` via `addopts = "-m 'not slow'"` in `pyproject.toml`. The current marker users in `tests/integration/test_triage_bootstrap_at_scale.py` and `tests/test_triage_bootstrap.py` range from ~0.5s to ~1.9s; the **1s threshold is the contributor decision point**, not a hard floor on which existing tests qualify.

```bash
task check        # default lane -- skips @pytest.mark.slow tests (fast)
task check:slow   # slow lane -- runs only @pytest.mark.slow tests
```

! When a test you write exceeds ~1s, mark it with `@pytest.mark.slow` or refactor it to use injected clocks / `monkeypatch` so it runs in milliseconds. The slow lane is intended as a stop-gap; the long-term fix for any genuinely slow test is to remove the wall-clock dependency, not to leave the marker in place forever.

~ Run `task check:slow` locally before pushing changes that touch any `@pytest.mark.slow` test (or the watchdog / threading code those tests cover) so the slow lane stays green. CI runs both lanes.

~ When profiling a suite that feels slow, run `pytest <file> --durations=20` (or the equivalent `task` invocation) to see the top wall-clock offenders. If a single test exceeds 1s, mark it `@pytest.mark.slow` or refactor it before merging.

⊗ Add `@pytest.mark.slow` to tests that are fast but flaky -- the marker is for genuine wall-clock cost, not for hiding intermittent failures. Flaky tests should be fixed at the root cause.

## Running CLI Locally

The Deft CLI is a Python script at the repo root. Run it with:

```bash
uv run python run
```

Available CLI commands:

```bash
uv run python run bootstrap    # Set up user preferences
uv run python run project      # Configure project settings (writes PROJECT-DEFINITION.vbrief.json)
uv run python run spec         # Generate specification via AI interview (produces scope vBRIEFs)
uv run python run validate     # Check deft configuration
uv run python run doctor       # Check system dependencies
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
> scripts/cache.py::cache:fetch-all migrated to paginated REST via
> scripts/scm.py::call('github-issue', 'api', ...). Backward-compat
> reader normalizes uppercase state. New test fixtures at
> tests/cli/test_gh_rest.py exercise...** [continues for 4 paragraphs of
> file paths, function names, and per-test assertions]

The load-bearing difference: the bad version is what the PR body should
carry; the good version is what the release notes carry. A reader who
wants the bad version's detail clicks through to the PR via the
`#1239` link.

A deterministic-tier lint gate that enforces this at commit time is a
separate follow-up; for now the rule is prose-tier and enforced via
code review on every PR that touches `CHANGELOG.md`.

## Windows CLI_ARGS quoting limitation (#1231)

Every `task` fragment under `tasks/` forwards user-facing flags into the
backing Python script via go-task's `{{.CLI_ARGS}}` placeholder. The
placeholder is substituted **bare** -- go-task's `shellQuote` filter
misbehaves on Windows (#577) so wrapping `{{.CLI_ARGS}}` in double quotes
is NOT a viable hardening, and changing the substitution shape is
deferred to a follow-up that switches to a temp-file argv dispatch.

The practical consequence on Windows shells (cmd.exe, PowerShell): an
argument value that contains spaces may be re-split by the shell before
`argparse` sees it. For example, this DOES NOT work as written on
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
`task --list` description (and each script's `--help`) name the
limitation in their summary when a multi-word value is a plausible
operator input.

## Adding a new triage / scope verb (#1150 / N10)

Every `task triage:*` and `task scope:*` verb is documented in one place:
the registry in `scripts/triage_help.py`. The bare `task triage` /
`task scope` invocations and per-verb `--help` flag both render from this
registry, so a new verb without a registry entry will not appear in the
operator-facing catalog.

To add a new verb (call it `task triage:foo`):

1. **Implement the verb script** under `scripts/` (e.g.
   `scripts/triage_foo.py`) following the existing `triage:*` / `scope:*`
   pattern (argparse, project-root resolution, audit-log append where
   applicable). Route any `gh` invocation through `scripts.scm.call`
   (#1145 / N5); raw `gh` subprocess calls outside `scripts/scm.py` are
   rejected by `task verify:scm-boundary`.

2. **Add a Taskfile fragment** (or extend an existing one) under `tasks/`
   that wires the script. Expose the verb as a `task triage:foo` /
   `task scope:foo` alias at the root of `Taskfile.yml`, mirroring the
   existing aliases.

3. **Register the help metadata** in `scripts/triage_help.py`:

   - Add one `REGISTRY["task triage:foo"] = _entry(...)` entry with
     `summary`, `refs`, `description`, `usage`, `flags`, `examples`, and
     `see_also`. Keep `summary` <= 70 chars so the bare-list view stays
     scannable.
   - Add the verb name under the appropriate role in
     `CATEGORIES_TRIAGE` (or `CATEGORIES_SCOPE` for scope verbs). The
     category structure is stable across umbrella waves; do NOT
     re-organize existing categories without an explicit umbrella amendment.
   - Add the script-to-subcommand mapping under
     `SCRIPT_SUBCOMMAND_MAP[<script_name>]`. Use `"__default__"` for a
     single-verb script; use the subcommand keyword for a multi-verb
     dispatcher (`triage_actions` / `scope_lifecycle` / etc.).

4. **Wire the help intercept** at the top of the script's `main()`:

   ```python
   def main(argv: list[str] | None = None) -> int:
       from triage_help import intercept_help

       rc = intercept_help("triage_foo", argv)
       if rc is not None:
           return rc
       # ... existing argparse + dispatch ...
   ```

   The shim returns `0` and prints the structured help when `--help` /
   `-h` is in `argv`; returns `None` otherwise so argparse takes over.

5. **Add forward coverage tests** in `tests/test_triage_foo.py` exercising
   the new verb's happy path AND its `--help` output via the
   `triage_help.intercept_help` shim. The existing
   `tests/test_triage_help.py` already covers registry shape invariants
   so a missing entry is a deterministic test failure.

6. **CHANGELOG entry** under `[Unreleased]` referencing the umbrella and
   the verb's child issue.

Forward-looking placeholders (verbs whose implementation has not landed
yet) carry `placeholder=True` so the structured help prints a
"(not yet implemented)" note. Replace the placeholder entry's metadata
when the verb's implementation child merges.
