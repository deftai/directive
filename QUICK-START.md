# QUICK-START

You are reading this because a user told you to, or because a stale `AGENTS.md` (or a `skills/deft-*/SKILL.md` redirect stub) sent you here. Follow these steps exactly, in order.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Step 1 — Who are you?

Ask the user: **"Are you (1) using deft in your project, or (2) working on deft itself?"**

- If **(2)**: Tell the user: "Read `./AGENTS.md` in this directory instead — it has contributor instructions." **Stop here.**
- If **(1)**: Continue to Step 2.

## Step 2 — Detect project state

Before touching `../AGENTS.md`, inspect the user's project root to decide whether this is a fresh install, a re-run, a stale-AGENTS.md upgrade, or a pre-cutover project that needs migration.

Run these deterministic checks, in order:

### 2a. Does `../AGENTS.md` exist?

- **No:** treat as fresh install — jump to Case F ("No AGENTS.md") in Step 3.
- **Yes:** continue to 2b.

### 2b. Does `../AGENTS.md` reference any `deft/skills/` path that does not exist on disk?

Parse `../AGENTS.md` and extract every token matching `deft/skills/<name>/SKILL.md`. For each extracted path, verify the file exists under `./skills/<name>/SKILL.md` (relative to this QUICK-START.md).

- ! If any referenced path does not exist on disk, treat `../AGENTS.md` as **stale** — jump to Case G ("Stale AGENTS.md") in Step 3.
- ! If the referenced path exists but its first 200 characters contain `<!-- deft:deprecated-skill-redirect -->`, also treat as stale. These stubs exist to keep v0.19 `AGENTS.md` files working until QUICK-START can refresh them. (The 200-character window matches the same budget used in 2c and is guaranteed to cover the sentinel position in every stub this repo ships -- see `tests/content/test_deprecated_skill_redirects.py::test_stub_has_sentinel`.)
- If all referenced paths exist and none are redirect stubs, continue to 2c.

### 2c. Are there pre-v0.20 artifacts at the user's project root?

Check both of these files at `../` (the user's project root):

- `../SPECIFICATION.md` — exists and the first 200 characters do **not** contain `<!-- deft:deprecated-redirect -->`.
- `../PROJECT.md` — exists and the first 200 characters do **not** contain `<!-- deft:deprecated-redirect -->`.

- If **either** holds (real pre-v0.20 content present), treat as **pre-cutover** — jump to Case H ("Pre-cutover migration") in Step 3.
- If both contain the sentinel (or neither exists), continue to 2d.

### 2d. Partial migration?

Check whether `../vbrief/` exists. If it does, inspect for the 5 lifecycle subfolders (`proposed/`, `pending/`, `active/`, `completed/`, `cancelled/`). If `vbrief/` exists but any lifecycle subfolder is missing, treat as **partial migration** — jump to Case I ("Partial migration repair") in Step 3.

### 2e. Everything clean

If none of 2a–2d triggered, `../AGENTS.md` is current and the project is on v0.20+. Jump to Case J ("Everything clean") in Step 3.

## Step 3 — Act on detected state

Pick exactly one case from Step 2 and follow its instructions. Do not mix cases.

### Case F — No AGENTS.md (fresh install)

1. Read `./templates/agents-entry.md` (this directory).
2. Write that content to `../AGENTS.md`.
3. Tell the user: "✓ Created AGENTS.md at your project root."
4. Continue to Step 4.

### Case G — Stale AGENTS.md (v0.19 → v0.20 upgrade)

1. Read `../AGENTS.md` and identify the **Deft-managed section** — bounded by the `deft/main.md` sentinel marker.
2. If the `deft/main.md` sentinel is **absent**, treat the entire existing file as user-authored and do NOT rewrite it. Instead, read `./templates/agents-entry.md` and **append** its content to `../AGENTS.md` with two blank lines between the existing content and the appended block. This matches the idempotent append behavior documented in `setup.go::WriteAgentsMD` for brownfield projects with a pre-existing AGENTS.md.
3. If the `deft/main.md` sentinel is **present**, replace only the sentinel-bounded section with the current content of `./templates/agents-entry.md`. Preserve everything outside that region verbatim.
4. Tell the user: "✓ Refreshed Deft-managed section of AGENTS.md. Your existing additions outside that region were preserved."
5. ! Instruct the user: **"Framework updated. Start a new agent session to pick up the changes. The current session has stale context."** Do not continue past this instruction in the current session.

### Case H — Pre-cutover migration (SPECIFICATION.md / PROJECT.md without sentinel)

1. Tell the user: "Your project uses the pre-v0.20 document model. I can run `task migrate:vbrief` to upgrade, which replaces SPECIFICATION.md and PROJECT.md with deprecation redirect stubs and creates the `vbrief/` lifecycle folders. First I'll run an environment preflight."
2. ! Execute the environment preflight from `./skills/deft-directive-setup/SKILL.md` "Pre-Cutover Detection Guard" § Environment Preflight: check (a) `task migrate:vbrief` resolvability, (b) `uv` on PATH, (c) `deft/scripts/migrate_vbrief.py` present. Report each result to the user BEFORE asking for approval. If any check fails, surface the specific fix pointer and stop — do not prompt for approval until preflight passes.
3. ! If `task migrate:vbrief` is not resolvable from the project root (the consumer `Taskfile.yml` does not yet include `deft/Taskfile.yml`), tell the user the fallback invocation `task -t ./deft/Taskfile.yml migrate:vbrief` will be used instead. See [./main.md](./main.md#publishing-deft-tasks-in-your-project-root) for the recommended include pattern that makes the primary command work from the project root.
4. ! Only after preflight results have been reported, ask the user: "Preflight passed. Shall I run `task migrate:vbrief` (or the fallback invocation) now?" Wait for explicit user approval (`yes`, `approve`, `confirmed`). ⊗ Run migration on a broad "proceed" or "go ahead".
5. On approval: run the resolved command (primary `task migrate:vbrief` or the fallback `task -t ./deft/Taskfile.yml migrate:vbrief`) from the project root. For preview (`--dry-run`), dirty-tree bypass (`--force`), and undo (`--rollback`) see the [Migration safety flags](./skills/deft-directive-setup/SKILL.md#migration-safety-flags) subsection.
6. See [./main.md](./main.md#migrating-from-pre-v020) for the full migration reference (what pre-cutover looks like, what the migrator produces, safety flags) and [docs/BROWNFIELD.md](./docs/BROWNFIELD.md) for the brownfield adoption guide.
7. After migration completes, re-run Step 2 of this QUICK-START — the project state has changed. Most likely you land in Case G (AGENTS.md still references old paths) or Case J.
8. When AGENTS.md is refreshed, ! instruct the user: **"Framework updated. Start a new agent session to pick up the changes. The current session has stale context."**

### Case I — Partial migration repair

1. Tell the user: "Your project has a partial vBRIEF layout. Missing lifecycle folders: <list the absent ones>. Shall I complete the migration by running `task migrate:vbrief`? It is idempotent and safe to re-run."
2. On approval, run `task migrate:vbrief` (or fall back to `task -t ./deft/Taskfile.yml migrate:vbrief` if the task is not resolvable from the project root — see [./main.md](./main.md#publishing-deft-tasks-in-your-project-root)). Re-run Step 2 afterwards.
3. If the user declines, point them at [docs/BROWNFIELD.md](./docs/BROWNFIELD.md) §Troubleshooting and stop.

### Case J — Everything clean

1. Tell the user: "✓ Deft is already configured and current in your AGENTS.md."
2. Continue to Step 4.

## Step 4 — Continue setup

Read and follow `../AGENTS.md`. This starts the normal first-session flow (user preferences, project definition, specification). If you reached Case G or completed Case H/I and rewrote AGENTS.md, you have already told the user to start a new session — do not keep going yourself.

**Brownfield pointer:** For users retrofitting Deft onto an existing project (existing code, existing docs, or pre-v0.20 Deft layout), the authoritative adoption guide is [docs/BROWNFIELD.md](./docs/BROWNFIELD.md). It covers install options, migration, post-migration checks, and troubleshooting in more depth than the Case H flow above.

**Upgrade pointer:** Users moving between framework versions should also read [UPGRADING.md](./UPGRADING.md) in the repo root for the version-by-version guide.

## Update notifications

After a Deft project is set up, the CLI runs a periodic, read-only remote-version probe (issue #801) so you find out when the upstream framework ships a new release. The probe shells out to `git ls-remote --tags --refs <upstream>` against the deft submodule's `origin` remote at most once every 24 hours, parses the highest semver tag, and -- if your local checkout is behind -- prints a single informational warn line below the existing recorded-vs-current message:

```
⚠ Upstream directive v0.24.0 is available (you are on v0.23.0). Run `task framework:check-updates` for details; follow `skills/deft-directive-sync/SKILL.md` Phase 2 to update.
```

The banner is informational only: it never blocks CI, never prompts in non-interactive sessions, and never triggers a second `Continue anyway?` prompt on top of the existing #410 marker-drift gate. Re-notification cadence is per-tag -- once you dismiss `v0.24.0` the banner stays silent for 24 hours, but a fresh `v0.24.1` re-notifies immediately. State is persisted to `vbrief/.deft-remote-probe.json`; per-`run`-invocation dedup prevents the same banner from stacking when chained commands (e.g. `cmd_install -> cmd_project -> cmd_spec`) all hit the gate.

For a synchronous interactive probe -- handy when you want to verify your update path before pushing -- run `task framework:check-updates`. Pass `-- --force` to bypass the 24-hour throttle and `-- --json` to get a machine-parseable payload (useful in CI dashboards). Exit code is `1` only when the probe positively reports BEHIND; every other status (`OK` / `NO-UPSTREAM` / `NO-TAGS` / `ERROR` / `SKIPPED`) returns `0`.

Air-gapped or strict-egress environments can opt out of the probe entirely by setting `DEFT_NO_NETWORK=1` in the calling shell -- the probe short-circuits before any subprocess call, the gate emits no banner, and no `framework:remote-drift` event is recorded. The subprocess timeout (default 5 seconds) is overridable via `DEFT_REMOTE_PROBE_TIMEOUT` for slow upstream remotes.
