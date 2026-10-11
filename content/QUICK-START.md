# QUICK-START

You are reading this because a user told you to, or because a stale `AGENTS.md` (or a `skills/deft-*/SKILL.md` redirect stub) sent you here. Follow these steps exactly, in order.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Installing Deft (canonical — two packages)

! If Directive is **not yet installed** and you were told to "install Deft into this directory," use the global launcher + project install (Node **22 or 24** preferred; Node 20 best-effort):

```bash
npm i -g @deftai/directive
directive install          # alias: init — pins @deftai/directive-runtime
directive doctor
```

After a fresh clone or new worktree: `npm install` / `pnpm install`, then the first eligible runtime command or registered hook completes local activation. Repair: `directive install --repair`. Upgrade: `directive upgrade` (alias `update`). See [docs/launcher.md](./docs/launcher.md) and [docs/known-limitations.md](./docs/known-limitations.md).

The Go installer has been removed. Supported latest-legacy layouts convert with `directive upgrade`. Continue with Step 1 below.

## Step 1 — Detect project state

Before touching `../AGENTS.md`, inspect the user's project root to decide whether this is a fresh install, a re-run, a stale-AGENTS.md upgrade, or a pre-cutover project that needs migration.

Run these deterministic checks, in order:

### 1a. Does `../AGENTS.md` exist?

- **No:** treat as fresh install — jump to Case F ("No AGENTS.md") in Step 2.
- **Yes:** continue to 1b.

### 1b. Does `../AGENTS.md`'s managed section match the current template? Do referenced paths resolve?

Do **not** parse managed-section markers, byte-compare an attributed block against the template, or locate a hardcoded v2 managed-section marker. Detection is the four-state classifier (`current | stale | missing | absent`) from `deft agents:refresh --check` — the same plan `deft doctor` uses. v1/v2 markers are force-stale. Truncated or future markers are unreadable (do not append).

Three checks here, in this order. The first match wins; later checks only run when earlier checks pass.

1. **Classifier (Case G gate).** Run `deft agents:refresh --check` (or `deft doctor`). If the CLI is not on PATH, `npm i -g @deftai/directive` then the same verb. Wiring/runtime missing: `directive install --repair`. Supported legacy layout: `directive upgrade`.
   - ! If state is **stale**, **missing**, **absent**, or **unreadable**, treat as **stale content** -- jump to Case G ("Stale AGENTS.md") in Step 2. Case G remediates with the registered rewrite, not a hand-append.
   - If state is **current**, continue to the install-path check below.
2. **Install-path resolution (Case K gate -- #1046 PR-A).** When the classifier reports **current**, parse the section for its install-path declaration (`Full guidelines: <root>/main.md`, e.g. `node_modules/@deftai/directive-runtime/main.md` for the OVPR layout or `deft/main.md` for a legacy install layout). Verify that `../<root>/main.md` exists on disk.
   - ! If the classifier reports **current** BUT the declared install path does NOT resolve, jump to **Case K ("Install location mismatch")** in Step 2. Refreshing the managed section is a documented no-op when the content already matches -- Case K is a different failure class than Case G and demands a different remediation (#1046 finding #2).
3. **Legacy skill-path resolution (v0.19 AGENTS.md backstop).** Parse `../AGENTS.md` for any token matching `deft/skills/<name>/SKILL.md` (the legacy v0.19 path shape) and verify the file exists under `./skills/<name>/SKILL.md` (relative to this QUICK-START.md).
   - ! If any referenced path does not exist on disk, treat `../AGENTS.md` as **stale** -- jump to Case G in Step 2.
   - If all referenced paths exist, continue to 1c.

Priority ordering: Case G (classifier not current) always wins over Case K (install-path mismatch) because the registered refresh is the higher-priority remediation -- when the template content has moved on, the refresh closes BOTH the content drift and any incidental install-path mismatch that the new content might re-introduce. Case K only fires when the classifier is current AND the path is unresolved -- the exact "refresh would be a no-op" failure class issue #1046 documents.

**Big-jump joint check (Case G+H gate).** Before acting on ANY Case G routing above (a byte-different managed section, or an unresolved legacy skill path), first ALSO evaluate the 1c pre-cutover check below against `../`. ! If 1c ALSO holds (real pre-v0.20 `SPECIFICATION.md` / `PROJECT.md` present), the project is in the **joint big-jump state** where both the AGENTS.md refresh (Case G) and the pre-cutover migration (Case H) are due — jump to **Case G+H** (combined single-session remediation) in Step 2 instead of Case G. The combined path runs the refresh and the migration in one session and emits a single restart, avoiding the wasted Case G → restart → Case H round-trip. If 1c does not hold, route to Case G as usual.

### 1c. Are there pre-v0.20 artifacts at the user's project root?

Check both of these files at `../` (the user's project root), using the same
rule implemented by `task migrate:preflight`:

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

1. ! Run `deft agents:refresh` (the registered rewrite for classifier state `absent`). ⊗ Do not copy `templates/agents-entry.md` by hand. If the CLI is not on PATH: `npm i -g @deftai/directive`, then the same verb. Wiring/runtime missing: `directive install --repair`. Data/schema: `directive upgrade`. Pre-canonical layout: frozen Go bridge (UPGRADING.md / GitHub releases).
2. Tell the user: "✓ Created AGENTS.md at your project root."
3. Continue to Step 3.

### Case G — Stale AGENTS.md (v0.19 → v0.20 upgrade)

1. ⊗ Do not locate the `deft/main.md` sentinel, do not append `templates/agents-entry.md`, and do not hand-rewrite markers. QUICK-START is not a second parser.
2. ! Run `deft agents:refresh`. That command is the four-state plan (`current | stale | missing | absent`; v1/v2 force-stale). Truncated close refuses to write a second section.
3. If the CLI is not on PATH: `npm i -g @deftai/directive`, then the same verb. Wiring/runtime missing: `directive install --repair`. Data/schema: `directive upgrade`. Pre-canonical layout: frozen Go bridge (UPGRADING.md / GitHub releases).
4. Tell the user: "✓ Refreshed Deft-managed section of AGENTS.md. Your existing additions outside that region were preserved."
5. ! Instruct the user: **"Framework updated. Start a new agent session to pick up the changes. The current session has stale context."** Do not continue past this instruction in the current session.

### Case H — Pre-cutover migration (SPECIFICATION.md / PROJECT.md without sentinel)

1. Tell the user: "Your project uses the pre-v0.20 document model. Current npm releases no longer ship in-product `task migrate:vbrief` (#2068). Follow [UPGRADING.md § Frozen pre-v0.20 document-model migration](./UPGRADING.md#frozen-pre-v020-document-model-migration-2068): pin framework **v0.59.0** (frozen Go installer or git tag), install Python 3.11+ and `uv`, run `task migrate:vbrief` once from that payload, then upgrade to current npm."
2. ! Run `task migrate:preflight` (or `task -t ./node_modules/@deftai/directive-runtime/Taskfile.yml migrate:preflight`) to confirm pre-cutover state and print the frozen-release guidance. ⊗ Do NOT offer to run `task migrate:vbrief` from the current npm deposit — the migrator is not bundled.
3. See [./main.md](../main.md#migrating-from-pre-v020) for what pre-cutover looks like and what the migrator produces, and [docs/BROWNFIELD.md](./docs/BROWNFIELD.md) for the brownfield adoption guide.
4. After migration completes on v0.59.0 and the operator upgrades to current npm, re-run Step 1 of this QUICK-START — the project state has changed. Most likely you land in Case G (AGENTS.md still references old paths) or Case J.
5. When AGENTS.md is refreshed, ! instruct the user: **"Framework updated. Start a new agent session to pick up the changes. The current session has stale context."**

### Case G+H — Combined stale AGENTS.md + pre-cutover migration (big-jump, one session)

Reached only via the **Big-jump joint check** in 1b: the managed section in `../AGENTS.md` is stale (Case G) AND pre-v0.20 artifacts are present at `../` (Case H). This is the typical shape of a multi-version "big jump" that crossed both the AGENTS.md managed-section refresh and the pre-v0.20 document-model cutover.

! Run the two remediations in this exact order — **AGENTS.md refresh first, frozen migration guidance second** — then emit a **single** restart instruction at the very end:

1. **Refresh AGENTS.md first (Case G work).** Perform Case G steps 1-4: run `deft agents:refresh` (registered rewrite). ⊗ Do not append. ⊗ Do NOT emit the Case G step-5 restart instruction here — the combined path defers the single restart to step 3.
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

The managed section in `../AGENTS.md` is byte-identical to the current `./templates/agents-entry.md` render, BUT the install path the managed section declares (e.g. `node_modules/@deftai/directive-runtime/main.md`) does NOT resolve on disk. This is the failure class issue #1046 finding #2 documents: Case G's "refresh the managed section" prescription is a byte-for-byte no-op against the current template, so re-running just re-detects the same staleness next session.

1. Tell the user (verbatim phrasing, naming the unresolved path): "AGENTS.md's managed section is byte-identical to the current template, but the install path it declares (`<declared-path>`) does NOT exist on disk. Refreshing the managed section would be a no-op -- Case G's remediation does not fix install-location mismatches."
2. ! Direct the user to run `deft doctor` (the diagnostic + remediation surface that owns Case K's fix path) OR to manually verify that the install path AGENTS.md claims actually exists on disk. Confirm the framework is deposited at the path AGENTS.md declares, OR run `directive install --repair` / `directive upgrade` as doctor directs, OR hand-edit AGENTS.md to point at the path where the framework actually lives. Pre-canonical layout: frozen Go bridge (UPGRADING.md / GitHub releases).
3. ⊗ Run a Case G refresh -- it is a documented no-op for Case K. The managed section already byte-matches the current template; refreshing the bytes back to the same bytes does not change which install path is declared.
4. ! Instruct the user: **"Stop here. Do not continue to Step 3 until the install-path mismatch is resolved -- subsequent sessions will re-enter Case K until then."**

## Step 3 — Continue setup

Read and follow `../AGENTS.md`. This starts the normal first-session flow (user preferences, project definition, specification). If you reached Case G or completed Case H/I and rewrote AGENTS.md, you have already told the user to start a new session — do not keep going yourself.

**Brownfield pointer:** For users retrofitting Deft onto an existing project (existing code, existing docs, or pre-v0.20 Deft layout), the authoritative adoption guide is [docs/BROWNFIELD.md](./docs/BROWNFIELD.md). It covers install options, migration, post-migration checks, and troubleshooting in more depth than the Case H flow above.

**Upgrade pointer:** Users moving between framework versions should also read [UPGRADING.md](./UPGRADING.md) in the repo root for the version-by-version guide. For a multi-version "big jump", start at its [big-jump triage entry point](./UPGRADING.md#big-jump-triage--multi-version-upgrades-start-here), which names which version buckets apply and in what order. An agent on a big jump that hits both a stale AGENTS.md and pre-cutover artifacts should follow [Case G+H](#case-gh--combined-stale-agentsmd--pre-cutover-migration-big-jump-one-session) above to complete both in one session.

**OpenClaw agent-host pointer:** Running Directive under OpenClaw persistent-memory agents? See [docs/openclaw-agent-host.md](./docs/openclaw-agent-host.md) for Control UI / identity notes, the executable babysit path (installed review-cycle skill), and the epic babysit → `sessions_spawn` Approach 1 expectation — skill and register contracts stay in shipped skills (#2877 / epic #2874).

**Writing pointer:** For docs, issues, and PR prose that maintainers or agents author, follow [docs/writing-ste100.md](./docs/writing-ste100.md) (short controlled English; #2927).

**Consumer issue-label kit:** New or bare backlogs should adopt the thin portable label set in [docs/consumer-issue-label-kit.md](./docs/consumer-issue-label-kit.md) (#2611) — core type labels, optional epic/tracker/child rules, optional `triaged` + mirror PD knobs. Do not copy the full maintainer taxonomy (#2609).

**Opt-out pointer:** Projects that must not use Directive should commit root [`.no-deft-directive`](./docs/no-deft-directive.md) so session/doctor/init/setup skip install and ritual (#2926). Temporary local kill-switch (deposit OK): [`.deft-directive-disable`](./docs/deft-directive-disable.md) (#3039).

**Contributor pointer (non-blocking):** Working on Deft itself (a `deftai/directive` source checkout)? See [CONTRIBUTING.md](../CONTRIBUTING.md) and use the maintainer install path (`deft-install --yes --upgrade --maintainer --repo-root . --json`). The repo's root `AGENTS.md` has contributor instructions — you do not need the consumer first-session flow above.

## Update notifications

After a Deft project is set up, the CLI runs a periodic, read-only remote-version probe (issue #801) so you find out when the upstream framework ships a new release. The probe shells out to `git ls-remote --tags --refs <upstream>` against the deft submodule's `origin` remote at most once every 24 hours, parses the highest semver tag, and -- if your local checkout is behind -- prints a single informational warn line below the existing recorded-vs-current message:

```
⚠ Upstream directive v0.24.0 is available (you are on v0.23.0). Run `task framework:check-updates` for details; follow `skills/deft-directive-sync/SKILL.md` Phase 0 (npm + `directive update` / `deft update`) and Phase 8 SCM release handoff (`released` | `pr-open` | `blocked:<reason>`) — not submodule Phase 2 alone (#1604).
```

The banner is informational only: it never blocks CI, never prompts in non-interactive sessions, and never triggers a second `Continue anyway?` prompt on top of the existing #410 marker-drift gate. Re-notification cadence is per-tag -- once you dismiss `v0.24.0` the banner stays silent for 24 hours, but a fresh `v0.24.1` re-notifies immediately. State is persisted to `xbrief/.deft-remote-probe.json`; per-run-invocation dedup prevents the same banner from stacking when chained commands (e.g. `cmd_install -> cmd_project -> cmd_spec`) all hit the gate.

For a synchronous interactive probe -- handy when you want to verify your update path before pushing -- run `task framework:check-updates`. Pass `-- --force` to bypass the 24-hour throttle and `-- --json` to get a machine-parseable payload (useful in CI dashboards). Exit code is `1` only when the probe positively reports BEHIND; every other status (`OK` / `NO-UPSTREAM` / `NO-TAGS` / `ERROR` / `SKIPPED`) returns `0`.

Air-gapped or strict-egress environments can opt out of the probe entirely by setting `DEFT_NO_NETWORK=1` in the calling shell -- the probe short-circuits before any subprocess call, the gate emits no banner, and no `framework:remote-drift` event is recorded. The subprocess timeout (default 5 seconds) is overridable via `DEFT_REMOTE_PROBE_TIMEOUT` for slow upstream remotes.

<!-- xbrief-backcompat-2111 -->

> **xBRIEF rename (#2034 / #2110):** Projects still on the legacy `vbrief/` layout and `x-vbrief/` reference tokens remain read-accepted until you run `deft migrate:xbrief` (or `task migrate:xbrief`). `deft doctor` and `deft update` signpost unmigrated layouts.
