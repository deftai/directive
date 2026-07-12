# QUICK-START

You are reading this because a user told you to, or because a stale `AGENTS.md` (or a `skills/deft-*/SKILL.md` redirect stub) sent you here. Follow these steps exactly, in order.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Installing Deft (canonical — npm)

! If Deft is **not yet installed** and you were told to "install Deft into this directory," the canonical install is npm (Node ≥ 20 required):

```bash
npm i -g @deftai/directive
```

Once installed, run `directive` (or the `deft` alias) from your project directory. Continue with Step 1 below.

### Legacy / offline install (frozen Go installer, #1912)

Node ≥ 20 is required to **run** Deft regardless of how it's installed — the Go installer only deposits files on disk, so install Node first ([nvm](https://github.com/nvm-sh/nvm) / your OS package manager / [nodejs.org](https://nodejs.org/)) and prefer the npm command above. Use the Go installer only for an **offline / air-gapped** deposit or to **migrate a legacy on-disk layout**. Do NOT build from a source checkout and do NOT guess a path. Each one-liner downloads the correct release binary from `releases/latest/download`, makes it executable, then runs it headless.

**macOS (Intel + Apple Silicon):**

```bash
curl -fsSL -o /tmp/deft-install https://github.com/deftai/directive/releases/latest/download/install-macos-universal && chmod +x /tmp/deft-install && /tmp/deft-install --yes --repo-root . --json
```

**Linux** (amd64; use `install-linux-arm64` on Raspberry Pi / ARM):

```bash
curl -fsSL -o /tmp/deft-install https://github.com/deftai/directive/releases/latest/download/install-linux-amd64 && chmod +x /tmp/deft-install && /tmp/deft-install --yes --repo-root . --json
```

**Windows** (PowerShell; use `install-windows-arm64.exe` on Surface / Copilot+ PCs):

```powershell
Invoke-WebRequest -Uri https://github.com/deftai/directive/releases/latest/download/install-windows-amd64.exe -OutFile $env:TEMP\deft-install.exe; & $env:TEMP\deft-install.exe --yes --repo-root . --json
```

⊗ Do NOT `go build` from a source checkout or a developer-specific path (e.g. a hardcoded `/Users/<name>/...` clone). Once the installer finishes, continue with Step 1 below.

## Step 1 — Detect project state

Before touching `../AGENTS.md`, inspect the user's project root to decide whether this is a fresh install, a re-run, a stale-AGENTS.md upgrade, or a pre-cutover project that needs migration.

Run these deterministic checks, in order:

### 1a. Does `../AGENTS.md` exist?

- **No:** treat as fresh install — jump to Case F ("No AGENTS.md") in Step 2.
- **Yes:** continue to 1b.

### 1b. Does `../AGENTS.md`'s managed section match the current template? Do referenced paths resolve?

Three checks here, in this order. The first match wins; later checks only run when earlier checks pass.

1. **Template-content byte comparison (Case G gate).** Locate the managed section in `../AGENTS.md` (the block bounded by the `<!-- deft:managed-section v2 -->` and `<!-- /deft:managed-section -->` markers). Compare those bytes against the current `./templates/agents-entry.md` rendered managed-section output.
   - ! If the managed section is **byte-different** from the current template render (or the markers are absent in `../AGENTS.md`), treat as **stale content** -- jump to Case G ("Stale AGENTS.md") in Step 2. Case G is the right remediation for byte-different staleness because the refresh actually rewrites the content.
2. **Install-path resolution (Case K gate -- #1046 PR-A).** When the managed section IS byte-current, parse the section for its install-path declaration (`Full guidelines: <root>/main.md`, e.g. `.deft/core/main.md` for the canonical install layout or `deft/main.md` for the legacy install layout). Verify that `../<root>/main.md` exists on disk.
   - ! If the managed section is **byte-identical** to the current template render BUT the declared install path does NOT resolve, jump to **Case K ("Install location mismatch")** in Step 2. Refreshing the managed section is a documented no-op when the content already matches -- Case K is a different failure class than Case G and demands a different remediation (#1046 finding #2).
3. **Legacy skill-path resolution (v0.19 AGENTS.md backstop).** Parse `../AGENTS.md` for any token matching `deft/skills/<name>/SKILL.md` (the legacy v0.19 path shape) and verify the file exists under `./skills/<name>/SKILL.md` (relative to this QUICK-START.md).
   - ! If any referenced path does not exist on disk, treat `../AGENTS.md` as **stale** -- jump to Case G in Step 2.
   - If all referenced paths exist, continue to 1c.

Priority ordering: Case G (byte-different content) always wins over Case K (install-path mismatch) because the refresh path is the higher-priority remediation -- when the template content has moved on, the refresh closes BOTH the content drift and any incidental install-path mismatch that the new content might re-introduce. Case K only fires when the content is byte-current AND the path is unresolved -- the exact "refresh would be a no-op" failure class issue #1046 documents.

**Big-jump joint check (Case G+H gate).** Before acting on ANY Case G routing above (a byte-different managed section, or an unresolved legacy skill path), first ALSO evaluate the 1c pre-cutover check below against `../`. ! If 1c ALSO holds (real pre-v0.20 `SPECIFICATION.md` / `PROJECT.md` present), the project is in the **joint big-jump state** where both the AGENTS.md refresh (Case G) and the pre-cutover migration (Case H) are due — jump to **Case G+H** (combined single-session remediation) in Step 2 instead of Case G. The combined path runs the refresh and the migration in one session and emits a single restart, avoiding the wasted Case G → restart → Case H round-trip. If 1c does not hold, route to Case G as usual.

### 1c. Are there pre-v0.20 artifacts at the user's project root?

Check both of these files at `../` (the user's project root), using the same
rule implemented by `scripts/_precutover.py`:

- `../SPECIFICATION.md` — exists and is neither a deprecation redirect nor a current generated spec export. A current generated spec export contains `<!-- Purpose: rendered specification -->` and `<!-- Source of truth: xbrief/specification.xbrief.json -->`, and `../xbrief/specification.xbrief.json` plus all five lifecycle folders exist.
- `../PROJECT.md` — exists and is not a deprecation redirect (`<!-- deft:deprecated-redirect -->` or `<!-- Purpose: deprecation redirect -->`).

- If **either** holds (real pre-v0.20 content present), treat as **pre-cutover** — jump to Case H ("Pre-cutover migration") in Step 2.
- If both contain the sentinel (or neither exists), continue to 1d.

### 1d. Partial migration?

Check whether `../xbrief/` exists. If it does, inspect for the 5 lifecycle subfolders (`proposed/`, `pending/`, `active/`, `completed/`, `cancelled/`). If `xbrief/` exists but any lifecycle subfolder is missing, treat as **partial migration** — jump to Case I ("Partial migration repair") in Step 2.

### 1e. Everything clean

If none of 1a–1d triggered, `../AGENTS.md` is current and the project is on v0.20+. Jump to Case J ("Everything clean") in Step 2.

## Step 2 — Act on detected state

Pick exactly one case from Step 1 and follow its instructions. Do not mix cases.

### Case F — No AGENTS.md (fresh install)

1. Read `./templates/agents-entry.md` (this directory).
2. Write that content to `../AGENTS.md`.
3. Tell the user: "✓ Created AGENTS.md at your project root."
4. Continue to Step 3.

### Case G — Stale AGENTS.md (v0.19 → v0.20 upgrade)

1. Read `../AGENTS.md` and identify the **Deft-managed section** — bounded by the `deft/main.md` sentinel marker.
2. If the `deft/main.md` sentinel is **absent**, treat the entire existing file as user-authored and do NOT rewrite it. Instead, read `./templates/agents-entry.md` and **append** its content to `../AGENTS.md` with two blank lines between the existing content and the appended block. This matches the idempotent append behavior documented in `setup.go::WriteAgentsMD` for brownfield projects with a pre-existing AGENTS.md.
3. If the `deft/main.md` sentinel is **present**, replace only the sentinel-bounded section with the current content of `./templates/agents-entry.md`. Preserve everything outside that region verbatim.
4. Tell the user: "✓ Refreshed Deft-managed section of AGENTS.md. Your existing additions outside that region were preserved."
5. ! Instruct the user: **"Framework updated. Start a new agent session to pick up the changes. The current session has stale context."** Do not continue past this instruction in the current session.

### Case H — Pre-cutover migration (SPECIFICATION.md / PROJECT.md without sentinel)

1. Tell the user: "Your project uses the pre-v0.20 document model. Current npm releases no longer ship in-product `task migrate:vbrief` (#2068). Follow [UPGRADING.md § Frozen pre-v0.20 document-model migration](./UPGRADING.md#frozen-pre-v020-document-model-migration-2068): pin framework **v0.59.0** (frozen Go installer or git tag), install Python 3.11+ and `uv`, run `task migrate:vbrief` once from that payload, then upgrade to current npm."
2. ! Run `task migrate:preflight` (or `task -t ./.deft/core/Taskfile.yml migrate:preflight`) to confirm pre-cutover state and print the frozen-release guidance. ⊗ Do NOT offer to run `task migrate:vbrief` from the current npm deposit — the migrator is not bundled.
3. See [./main.md](../main.md#migrating-from-pre-v020) for what pre-cutover looks like and what the migrator produces, and [docs/BROWNFIELD.md](./docs/BROWNFIELD.md) for the brownfield adoption guide.
4. After migration completes on v0.59.0 and the operator upgrades to current npm, re-run Step 1 of this QUICK-START — the project state has changed. Most likely you land in Case G (AGENTS.md still references old paths) or Case J.
5. When AGENTS.md is refreshed, ! instruct the user: **"Framework updated. Start a new agent session to pick up the changes. The current session has stale context."**

### Case G+H — Combined stale AGENTS.md + pre-cutover migration (big-jump, one session)

Reached only via the **Big-jump joint check** in 1b: the managed section in `../AGENTS.md` is stale (Case G) AND pre-v0.20 artifacts are present at `../` (Case H). This is the typical shape of a multi-version "big jump" that crossed both the AGENTS.md managed-section refresh and the pre-v0.20 document-model cutover.

! Run the two remediations in this exact order — **AGENTS.md refresh first, frozen migration guidance second** — then emit a **single** restart instruction at the very end:

1. **Refresh AGENTS.md first (Case G work).** Perform Case G steps 1-4 verbatim: identify the managed section, append when the sentinel is absent or byte-replace it when present, and preserve everything outside the managed region. ⊗ Do NOT emit the Case G step-5 restart instruction here — the combined path defers the single restart to step 3.
2. **Surface frozen migration path second (Case H work).** Perform Case H steps 1-3 verbatim: explain the v0.59.0 pinned migrator path (#2068), run `task migrate:preflight`, and point at UPGRADING.md. The operator (or a machine with v0.59.0 deposited) runs `task migrate:vbrief` outside the current npm deposit. ⊗ Do NOT perform Case H steps 4-5 until migration has completed on the pinned release and the operator has upgraded to current npm.
3. **Single restart, exactly once.** Only after BOTH the refresh and the operator-confirmed migration + npm upgrade have completed, ! instruct the user EXACTLY ONCE: **"Framework updated and project migrated. Start a new agent session to pick up the changes. The current session has stale context."** ⊗ Do NOT emit a second restart instruction.

For the version-by-version context of a big jump, see the [big-jump triage entry point](./UPGRADING.md#big-jump-triage--multi-version-upgrades-start-here) in UPGRADING.md.

### Case I — Partial migration repair

1. Tell the user: "Your project has a partial xBRIEF layout. Missing lifecycle folders: <list the absent ones>. Complete the layout via the frozen v0.59.0 migrator (see UPGRADING.md § Frozen pre-v0.20 document-model migration) or create the missing folders manually after migrating narratives."
2. Run `task migrate:preflight` to confirm state. If the operator has v0.59.0 deposited, they may run `task migrate:vbrief` there; otherwise point at the frozen path. Re-run Step 1 afterwards.
3. If the user declines, point them at [docs/BROWNFIELD.md](./docs/BROWNFIELD.md) §Troubleshooting and stop.

### Case J — Everything clean

1. Tell the user: "✓ Deft is already configured and current in your AGENTS.md."
2. Continue to Step 3.

### Case K — Install location mismatch (#1046 PR-A)

The managed section in `../AGENTS.md` is byte-identical to the current `./templates/agents-entry.md` render, BUT the install path the managed section declares (e.g. `.deft/core/main.md`) does NOT resolve on disk. This is the failure class issue #1046 finding #2 documents: Case G's "refresh the managed section" prescription is a byte-for-byte no-op against the current template, so re-running just re-detects the same staleness next session.

1. Tell the user (verbatim phrasing, naming the unresolved path): "AGENTS.md's managed section is byte-identical to the current template, but the install path it declares (`<declared-path>`) does NOT exist on disk. Refreshing the managed section would be a no-op -- Case G's remediation does not fix install-location mismatches."
2. ! Direct the user to run `task framework:doctor` (forthcoming in PR-B of the #1046 cohort -- the diagnostic + remediation surface that owns Case K's fix path) OR to manually verify that the install path AGENTS.md claims actually exists on disk. Until PR-B merges, the manual check is the operator's only path: confirm the framework is deposited at the path AGENTS.md declares, OR re-run the installer / relocator to deposit at that path, OR hand-edit AGENTS.md to point at the path where the framework actually lives.
3. ⊗ Run a Case G refresh -- it is a documented no-op for Case K. The managed section already byte-matches the current template; refreshing the bytes back to the same bytes does not change which install path is declared.
4. ! Instruct the user: **"Stop here. Do not continue to Step 3 until the install-path mismatch is resolved -- subsequent sessions will re-enter Case K until then."**

## Step 3 — Continue setup

Read and follow `../AGENTS.md`. This starts the normal first-session flow (user preferences, project definition, specification). If you reached Case G or completed Case H/I and rewrote AGENTS.md, you have already told the user to start a new session — do not keep going yourself.

**Brownfield pointer:** For users retrofitting Deft onto an existing project (existing code, existing docs, or pre-v0.20 Deft layout), the authoritative adoption guide is [docs/BROWNFIELD.md](./docs/BROWNFIELD.md). It covers install options, migration, post-migration checks, and troubleshooting in more depth than the Case H flow above.

**Upgrade pointer:** Users moving between framework versions should also read [UPGRADING.md](./UPGRADING.md) in the repo root for the version-by-version guide. For a multi-version "big jump", start at its [big-jump triage entry point](./UPGRADING.md#big-jump-triage--multi-version-upgrades-start-here), which names which version buckets apply and in what order. An agent on a big jump that hits both a stale AGENTS.md and pre-cutover artifacts should follow [Case G+H](#case-gh--combined-stale-agentsmd--pre-cutover-migration-big-jump-one-session) above to complete both in one session.

**Contributor pointer (non-blocking):** Working on Deft itself (a `deftai/directive` source checkout)? See [CONTRIBUTING.md](../CONTRIBUTING.md) and use the maintainer install path (`deft-install --yes --upgrade --maintainer --repo-root . --json`). The repo's root `AGENTS.md` has contributor instructions — you do not need the consumer first-session flow above.

## Update notifications

After a Deft project is set up, the CLI runs a periodic, read-only remote-version probe (issue #801) so you find out when the upstream framework ships a new release. The probe shells out to `git ls-remote --tags --refs <upstream>` against the deft submodule's `origin` remote at most once every 24 hours, parses the highest semver tag, and -- if your local checkout is behind -- prints a single informational warn line below the existing recorded-vs-current message:

```
⚠ Upstream directive v0.24.0 is available (you are on v0.23.0). Run `task framework:check-updates` for details; follow `skills/deft-directive-sync/SKILL.md` Phase 2 to update.
```

The banner is informational only: it never blocks CI, never prompts in non-interactive sessions, and never triggers a second `Continue anyway?` prompt on top of the existing #410 marker-drift gate. Re-notification cadence is per-tag -- once you dismiss `v0.24.0` the banner stays silent for 24 hours, but a fresh `v0.24.1` re-notifies immediately. State is persisted to `xbrief/.deft-remote-probe.json`; per-`run`-invocation dedup prevents the same banner from stacking when chained commands (e.g. `cmd_install -> cmd_project -> cmd_spec`) all hit the gate.

For a synchronous interactive probe -- handy when you want to verify your update path before pushing -- run `task framework:check-updates`. Pass `-- --force` to bypass the 24-hour throttle and `-- --json` to get a machine-parseable payload (useful in CI dashboards). Exit code is `1` only when the probe positively reports BEHIND; every other status (`OK` / `NO-UPSTREAM` / `NO-TAGS` / `ERROR` / `SKIPPED`) returns `0`.

Air-gapped or strict-egress environments can opt out of the probe entirely by setting `DEFT_NO_NETWORK=1` in the calling shell -- the probe short-circuits before any subprocess call, the gate emits no banner, and no `framework:remote-drift` event is recorded. The subprocess timeout (default 5 seconds) is overridable via `DEFT_REMOTE_PROBE_TIMEOUT` for slow upstream remotes.

<!-- xbrief-backcompat-2111 -->

> **xBRIEF rename (#2034 / #2110):** Projects still on the legacy `vbrief/` layout and `x-vbrief/` reference tokens remain read-accepted until you run `deft migrate:xbrief` (or `task migrate:xbrief`). `deft doctor` and `deft update` signpost unmigrated layouts.
