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
