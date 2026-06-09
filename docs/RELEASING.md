# Release & Testing

The GitHub Actions workflow (`.github/workflows/release.yml`) builds installers for all 6 platform targets, creates a macOS universal binary, runs smoke tests on real hardware, and publishes a GitHub Release.

> **📚 See also**: [ARCHITECTURE.md](./ARCHITECTURE.md) • [CONCEPTS.md](./CONCEPTS.md) • [FILES.md](./FILES.md) • [../README.md](../README.md)

The interactive operator-side workflow (`task release` / `task release:publish` / `task release:rollback` / `task release:e2e`) is encoded in `skills/deft-directive-release/SKILL.md`. The notes below cover the underlying CI workflow and manual smoke-test procedure.

## Default-branch release policy (#1553)

Releases run on the configured base branch (default `master`). The branch-protection gate (#746 / #747) blocks unauthorised direct commits unless the project has opted in.

**Prefer the typed policy opt-out** for a release session:

```bash
task policy:allow-direct-commits -- --confirm
# ... run the release workflow ...
task policy:enforce-branches   # restore after the cut (or on abort)
```

This writes `plan.policy.allowDirectCommitsToMaster = true` on `vbrief/PROJECT-DEFINITION.vbrief.json` with an audited capability-cost disclosure. It does not leak into child processes the way the emergency env-var bypass does.

**Do not wrap `task release` or `task ci:local` in `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1`.** That env var is process-wide: every subprocess, nested test, and temporary repository spawned from the same shell inherits it. During the v0.43.0 release attempt this caused the Step 5 `task ci:local` preflight to fail (`TestWriteConsumerGitHooks_VendoredCommitBlocked_RealGit`) because a vendored test repo inherited the bypass and allowed a direct `master` commit the test expected the hook to block.

If the env-var bypass is unavoidable, scope it to a **single** branch-guard probe only (for example `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1 task verify:branch`) and do not export it for the release session. The release pipeline passes the bypass only in scoped subprocess `env=` for its authorised commit/tag/push mutations (#867); operators must not mirror that pattern at the shell level.

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

> **Note:** Binaries are not yet code-signed. macOS users may need to bypass Gatekeeper (see [Getting Started in the README](../README.md#-getting-started)). Windows users may see a SmartScreen warning. Code signing is planned for a future release.
