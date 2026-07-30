# Release & Testing

The release process publishes `@deftai/directive` to npm (the canonical install channel) and builds the frozen legacy Go-installer binaries for all 6 platform targets. The GitHub Actions workflow (`.github/workflows/release.yml`) creates a macOS universal binary, runs smoke tests on real hardware, and publishes both the npm package and a GitHub Release.

> **📚 See also**: [ARCHITECTURE.md](./ARCHITECTURE.md) • [CONCEPTS.md](./CONCEPTS.md) • [FILES.md](./FILES.md) • [../README.md](../README.md)

The interactive operator-side workflow (`task release` / `task release:publish` / `task release:rollback` / `task release:e2e`) is encoded in `skills/deft-directive-release/SKILL.md`. The notes below cover the underlying CI workflow and manual smoke-test procedure.

## Default-branch release policy (#1553)

Releases run on the configured base branch (default `master`). The branch-protection gate (#746 / #747) blocks unauthorised direct commits unless the project has opted in.

**Prefer the typed policy opt-out** for a release session:

```bash
task policy:allow-direct-commits -- --confirm
# ... run the release workflow ...
task policy:enforce-branches
# enforce flips the typed flag to false — commit+push the restore with a
# scoped env bypass on these commands only (#2623); do not leave dirty under
# protection ON (v0.79.0 / #2619 failure mode):
DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1 git add xbrief/PROJECT-DEFINITION.xbrief.json meta/policy-changes.log
DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1 git commit -m "chore(policy): restore branch protection after vX.Y.Z"
DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1 git push origin HEAD
```

This writes `plan.policy.allowDirectCommitsToMaster = true` on `xbrief/PROJECT-DEFINITION.xbrief.json` with an audited capability-cost disclosure. It does not leak into child processes the way the emergency env-var bypass does.

**Do not wrap `task release` or `task ci:local` in `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1`.** That env var is process-wide: every subprocess, nested test, and temporary repository spawned from the same shell inherits it. During the v0.43.0 release attempt this caused the Step 5 `task ci:local` preflight to fail (`TestWriteConsumerGitHooks_VendoredCommitBlocked_RealGit`) because a vendored test repo inherited the bypass and allowed a direct `master` commit the test expected the hook to block.

If the env-var bypass is unavoidable outside the enforce closeout above, scope it to a **single** branch-guard probe only (for example `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1 task verify:branch`) and do not export it for the release session. The release pipeline passes the bypass only in scoped subprocess `env=` for its authorised commit/tag/push mutations (#867); operators must not mirror that pattern at the shell level.

**PowerShell coverage-debt tip (#2621):** pass `--allow-coverage-debt=N` (no bare `#`) or quote `"#N"`. Unquoted `#N` is a PowerShell comment and silently drops the issue number.

See `skills/deft-directive-release/SKILL.md` § Branch-Protection Policy Guard for the full operator workflow.

## Vitest coverage hang recovery (#2652)

Release Step 5 runs `task check` → vitest coverage with a **20-minute hard timeout**. GHA `CI` → “Test with coverage (vitest)” uses the same wall-clock budget (`timeout-minutes: 20` on that step).

**When Step 5 or CI appears stuck**

1. **Do not** leave AFK agents in unbounded `Await` loops on CI — use one-shot probes (`gh run view`, `task pr:watch -- <N> --one-shot`) or cancel after the timeout. See `task pr:watch -- --help` for flags and exits 0/1/2 (#1056).
2. **Local:** if vitest shows no progress for several minutes, stop the process (`Ctrl+C`). Re-run a bounded probe: `pnpm exec vitest run --coverage packages/core/src/pr-monitor --reporter=verbose` (suspect suites first), then `task check` once the suite completes within the timeout.
3. **GHA:** cancel the stuck run (`gh run cancel <run_id>`) after the step exceeds ~20 minutes; inspect logs for the last file printed before the stall. Re-run failed jobs only after a fix lands (`gh run rerun <run_id> --failed`).
4. **Production `--skip-ci` is an incident**, not a normal path: it skips vitest coverage and ships **untested** npm builds. Requires `--allow-skip-ci=#N` citing the tracked issue; Step 5 emits a loud WARN. Use only under operator review; the next patch after a hang fix must cut **without** `--skip-ci`.

Pointer: `content/scm/github.md` § Release Step 5 timeout (maintainer cross-link).

## Fixable check failure during release (#2859)

When Phase 1 `task ci:local` / `task check` fails on a **fixable product or test defect** during a cut, do **not** lead with an inline hotfix on the release branch or untracked `--skip-ci`. Pause the cut and route the blocker through normal issue → xBRIEF → feature branch → PR → merge → confirm check green → resume Phase 1.

The full agent contract (including the explicit rejection of AGENTS.md / agents-entry bulk for this reminder) lives in `skills/deft-directive-release/SKILL.md` § **Fixable check failure — file-and-merge before resume (#2859)**. Production `--skip-ci` with `--allow-skip-ci=#N` remains incident-only per § Vitest coverage hang recovery above.

## Coverage debt hatch during release (#2866)

When **`task release` Step 5** fails on Vitest coverage below the 85% goal, use this hatch **only** when **branches** is the **sole** metric below 85% (lines, functions, and statements all ≥ 85%). Confirm from the Step 5 output or `task coverage:hotspots`. If any other metric also misses, or the failure is a hang / failing test / non-coverage defect, pause and follow § Fixable check failure during release (#2859).

**Runtime note:** `--allow-coverage-debt=#N` zeros all vitest coverage thresholds for the Step 5 run (`vitest.config.ts`, #2573). File debt only for branch-only hairlines; acceptance criteria must restore **all four metrics** to ≥ 85%.

1. **No open coverage-debt issue** → union three probes: (a) open issues with `coverage-debt in:title,body`, (b) open issues with `allow-coverage-debt in:body`, (c) open issues cited via `--allow-coverage-debt=#N` in `CHANGELOG.md` `[Unreleased]` or the last three release sections (legacy hatch debt before markers were mandatory). If all empty, file `#N` with title prefix `coverage-debt:` and body containing both `coverage-debt` and `--allow-coverage-debt`, then continue with `--allow-coverage-debt=#N` on `task release`. On PowerShell use `--allow-coverage-debt=N` or `--allow-coverage-debt="#N"` (#2621).
2. **Open coverage-debt issue from a prior hatch still exists** → do **not** soft-pass again; restore all four metrics to ≥ 85% and close the debt issue before the cut proceeds.

The hatch is **release-scoped only** — not the default for ordinary PR / `task check` work. Hangs, failing tests, multi-metric coverage misses, and other non-coverage Step 5 failures stay under § Fixable check failure during release (#2859).

Canonical agent contract: `skills/deft-directive-release/SKILL.md` § **Step 5 branch-coverage threshold — open-issue ledger hatch (#2866)**.

## Routine vs hard cut for Step 5 (#2953)

Release Step 5 (`task check` with Vitest coverage) is the longest local gate. Two operator modes share the **same safety bar for coverage** — they differ in hygiene and intent, not in silent soft-pass.

### Hard cut (default)

- Run full Step 5: `task release -- <version>` with **no** `--skip-ci`.
- Use when the tip is unproven, the change set is large, or you need maximum local certainty before the tag.
- Coverage soft-pass remains **only** via the explicit hatches already documented:
  - branch-only hairline → `--allow-coverage-debt=#N` (#2866 / #2573)
  - incident hang / untested ship → `--skip-ci` + `--allow-skip-ci=#N` (#2652)
- ⊗ Silent soft-pass of coverage (no `#N`, no loud WARN) is forbidden in every mode.

### Routine cut (faster wall-clock, same gates)

Speed comes from **not scanning junk trees** and from **pre-cut hygiene**, not from skipping coverage:

1. **Default-exclude scratch / worktree noise (#2953).** Content, link, stub, codebase-map, and build-dist walks skip `.deft-scratch/` (and legacy `swarm-worktrees/`) by default. Release Step 5 must not enumerate `.deft-scratch/worktrees/**` unless you are deliberately debugging those trees.
2. **Prefer a clean tip.** Confirm required CI checks are green on the `master` tip you will tag (`gh run list` / required status). Green tip CI is a **precondition for calm routine cuts**, not a substitute for Step 5.
3. **Prune stale worktrees before the cut** when a maintainer clone is heavy: `git worktree list`, remove abandoned `.deft-scratch/worktrees/*` entries, or cut from a clean clone. This is operator hygiene, not a flag.
4. **Still run full Step 5** unless you are in an explicit incident path (`--skip-ci` + `--allow-skip-ci=#N`). Routine does **not** mean “trust CI and skip coverage.”

### Trust CI vs full local check

| Mode | When | Step 5 coverage | Soft-pass rule |
| --- | --- | --- | --- |
| **Hard cut** | Default; large / risky tip | Full `task check` + coverage | Only #2866 hatch or #2652 skip-ci with `#N` |
| **Routine cut** | Calm tip; scratch excluded; CI green on tip | Full `task check` + coverage (same) | Same — no silent soft-pass |
| **Incident skip** | Tracked hang / unblock with review | Skipped via `--skip-ci` | Requires `--allow-skip-ci=#N` + loud WARN |

Optional future: a explicit “trust recent green required checks on tip” flag may land as a separate story. Until then, **hard cut = full Step 5** and **routine cut = full Step 5 + scratch exclude + hygiene**. Do not invent a silent lighter path that zeros coverage thresholds without `#N`.

### Debugging scratch inclusion

If you need to inspect markdown under a worktree, open that worktree path as cwd for `task validate-links` / tools — do not re-enable repo-root walks into `.deft-scratch/` for production cuts.

Pointer: `skills/deft-directive-release/SKILL.md` § Routine vs hard cut (#2953).

## What the Smoke Tests Verify

Every build is tested on its native platform (including `macos-latest` and `ubuntu-24.04-arm`):

- `--version` — binary executes and reports version
- `--help` — flag parsing and usage output render correctly
- `--debug` — correct OS and architecture detection (e.g. `OS=darwin ARCH=arm64`)
- Wizard startup — binary initializes and prints the welcome banner
- `--branch <name>` — branch flag is accepted without error
- macOS universal binary contains both `x86_64` and `arm64` architectures

## Testing Without Publishing

The workflow triggers on version tags (`v*.*.*`). To run a full build and smoke test without publishing a real release, push a disposable test tag from any branch:

```bash
# Tag the current HEAD
git tag v0.0.0-test.1
git push origin v0.0.0-test.1

# Monitor the workflow run
gh run list --workflow=release.yml -R deftai/directive
gh run watch <RUN_ID> -R deftai/directive

# Clean up after verifying
gh release delete v0.0.0-test.1 -R deftai/directive --yes
git push origin --delete v0.0.0-test.1
git tag -d v0.0.0-test.1
```

The workflow also includes a `workflow_dispatch` trigger for manual runs without publishing:

```bash
gh workflow run release.yml --ref <branch> -R deftai/directive
```

Manual runs skip the release job automatically (guarded by `if: startsWith(github.ref, 'refs/tags/v')`).

## Release Process

1. Merge the feature branch PR into `master`
2. Tag `master` with a semantic version:
   ```bash
   git checkout master
   git pull origin master
   git tag v1.2.3
   git push origin v1.2.3
   ```
3. The workflow runs automatically: **build → universal-macos → smoke-test → release**
4. Verify the published release at https://github.com/deftai/directive/releases
5. Each release includes: `install-windows-amd64.exe`, `install-windows-arm64.exe`, `install-macos-universal`, `install-linux-amd64`, `install-linux-arm64`

> **Note:** The frozen legacy Go-installer binaries are not code-signed. macOS users may need to bypass Gatekeeper (see [Getting Started in the README](../README.md#-getting-started)). Windows users may see a SmartScreen warning. The canonical npm package (`@deftai/directive`) is published with keyless OIDC provenance and does not have this restriction.

## Frozen Go-installer bridge: releasing past the freeze line (#1912 / #1972 / #1987)

The Go installer (`deft-install`) is **frozen** as the legacy stage-1 bridge. By default a release tag *above* the frozen line will **not** rebuild the Go binaries — the npm packages still ship (they run in a separate workflow), but the 6 Go binaries + macOS universal asset are skipped. To make a release rebuild the Go installer, you roll the freeze line forward; this section is the runbook.

### Where the freeze lives (the files)

There is exactly **one** place the version literal lives. Everything else reads it.

| File | Role |
|------|------|
| `packages/core/src/legacy-bridge/sot.ts` | **Tier-0 source of truth.** The `LAST_GO_INSTALLER` constant (a quoted tag like `"v0.56.0"`, or `null` while unfrozen). **This is the only file an operator edits to freeze / unfreeze / re-pin.** |
| `.github/workflows/release.yml` | The `freeze-gate` job. This is the **enforcing teeth** — it parses `LAST_GO_INSTALLER` out of `sot.ts`, compares it to the pushed tag, and (when the tag is above the line) sets `frozen_skip=true` so the `build` job and its downstream Go jobs skip cleanly (green run). |
| `packages/core/src/legacy-bridge/freeze-gate.ts` | The TypeScript port of the same comparison logic (`evaluateGoFreeze`), surfaced locally via `task verify:go-freeze`. **Advisory only** locally — it passes no release tag, so once frozen it never fails a local run; CI is where enforcement happens. |
| `packages/core/src/legacy-bridge/bridge-drift.ts` | The `task verify:bridge-drift` gate. Asserts no other doc/code surface hardcodes a competing version literal — every surface must read the Tier-0 SoT. |

Task wiring for both gates is in `tasks/verify.yml` (`verify:go-freeze`, `verify:bridge-drift`).

### How the gate decides

The `freeze-gate` job runs **first** in the release workflow (`build` declares `needs: freeze-gate`). It compares the pushed tag's numeric `major.minor.patch` core against the pinned SoT core:

| `LAST_GO_INSTALLER` | Pushed tag vs SoT | Go binaries |
|---|---|---|
| `null` | any | **build** (advisory — unfrozen) |
| pinned `vX` | tag **above** `vX` | **skip** (green; npm still ships) |
| pinned `vX` | tag **at or below** `vX` (incl. equal) | **build** |
| unparseable | any | **hard-fail** (never fail-open) |

The real installer version is injected at build time via ldflags (`-X main.version=${{ github.ref_name }}`), so the freeze line is the **release tag vs the SoT** — not the `var version` literal in `cmd/deft-install/main.go`.

### Key insight: pinning *is* the release

`LAST_GO_INSTALLER` pins the **latest** frozen installer, not one tag forever. Because the gate builds when `tag <= pin`, pinning the SoT to the *exact tag you are about to cut* both releases the gate for that build **and** leaves the bridge frozen at the new line — in one move. You do **not** need a separate unfreeze-then-re-freeze dance.

### Before the release starts

Do this on your release feature branch, as part of the release commit, **before** tagging:

1. Choose the version you are cutting (e.g. `v0.57.0`).
2. Edit the single constant in `packages/core/src/legacy-bridge/sot.ts`:
   ```ts
   export const LAST_GO_INSTALLER: string | null = "v0.57.0";
   ```
3. Run the gates locally (advisory, but they catch drift and parse errors before CI):
   ```bash
   task verify:go-freeze
   task verify:bridge-drift
   ```
4. Pre-cut rehearsal:
   ```bash
   task release -- 0.57.0 --dry-run --skip-tag --skip-release
   task release:e2e -- --legacy-bridge
   ```
5. Merge the branch, then proceed with the normal [Release Process](#release-process) above (tag `master` with `v0.57.0`).

In CI the `freeze-gate` job sees `tag (0.57.0) == pin (0.57.0)` → does not skip → the `build` matrix rebuilds all 6 Go binaries + the macOS universal binary.

### After the release is done (re-pin)

- **If you pinned to the exact cut tag (the step above):** nothing more to do. The SoT *is* the new frozen line; the bridge is re-frozen at `v0.57.0` automatically.
- **If you temporarily unfroze** (set `LAST_GO_INSTALLER = null` to build regardless of tag ordering): after the tag is published, re-pin the SoT to the just-published tag, re-run both gates, and merge on a branch:
   ```ts
   export const LAST_GO_INSTALLER: string | null = "v0.57.0";
   ```
   ```bash
   task verify:go-freeze
   task verify:bridge-drift
   ```

### Caveats

- A `v*` tag fires **two** workflows: `release.yml` (Go binaries; the GitHub Release lands as a reversible **draft**) and `.github/workflows/npm-publish.yml` (publishes to the public registry **immediately** — irreversible). The freeze gate only governs the Go build; npm ships regardless. Do all reversible testing in the pre-cut rehearsal.
- Edit **only** `sot.ts`. Hardcoding the version anywhere else fails `task verify:bridge-drift`. The pinned `--legacy-bridge` e2e leg and every doc surface read the SoT and follow the new pin automatically.
- The local `DEFT_ALLOW_GO_INSTALLER_BUMP=1` bypass only downgrades the *local* `verify:go-freeze` gate to advisory — it has **no effect** on the CI `freeze-gate` job. Editing `sot.ts` is the only way to make CI rebuild the Go installer.
