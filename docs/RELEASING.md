# Release & Testing

The release process publishes `@deftai/directive` and `@deftai/directive-runtime` to npm (the **canonical** install channel). The Go installer (`cmd/deft-install/`, platform `install-*` binaries) is **deleted** (AC10.10), and master has no Go build, workflow or toolchain (#6863). Do not rebuild or ship Go installer binaries.

**OVPR publish shape (AC13.4 / #5490):** exactly two public packages, same version, runtime then launcher. Private workspace packages `types` / `core` / `content` are vendored into the runtime via `packages/runtime/scripts/stage-bundle.mjs` + `pack-staged-runtime.mjs` (mirrored by `task release:e2e` / `packOvprTarballs`). Do not `npm pack packages/runtime` raw. Post-publish two-pass fixture Pass 2 is `directive install --yes --target-version <V>` (not legacy `update --upgrade`). Registry wait (`task release:wait-npm`) polls both public packages only.

> **📚 See also**: [ARCHITECTURE.md](./ARCHITECTURE.md) • [CONCEPTS.md](./CONCEPTS.md) • [FILES.md](./FILES.md) • [installer-refactor-ovpr/README.md](./installer-refactor-ovpr/README.md) • [../README.md](../README.md)

The interactive operator-side workflow (`task release` / `task release:publish` / `task release:rollback` / `task release:e2e`) is encoded in `skills/deft-directive-release/SKILL.md`. The notes below cover the underlying CI workflow and manual smoke-test procedure.

## Release through a PR (#6296)

A maintainer cut needs one human act: the release grant. Branch protection stays on, nothing is pushed to `master` directly, and the next PR needs no `hotfix` label.

A stable cut runs these steps as one command, `deft release:run` (§ Release run (#6845) below), which mints the grant up front. The steps below are what the run does, and the manual path when the run cannot be used.

1. Make the release branch from the fetched tip: `git fetch origin master && git switch -c release/vX.Y.Z origin/master`.
2. Run `task release -- X.Y.Z`. Step 2 accepts only `release/vX.Y.Z` at the fetched `origin/master` tip. It refuses `master` (and every other branch) and names the release branch; it refuses a `release/vX.Y.Z` that already exists on origin or no longer sits at the tip (an earlier attempt) and names the recovery. Steps 3 to 9 are unchanged. In place of the old Steps 10 and 11, the cut pushes `release/vX.Y.Z` and opens the release PR. The generated body carries the version and the documentation-impact block, and no closing keyword or release notes. The cut then stops and prints the finish command.
3. Merge the release PR through the merge queue like any PR: `task pr:wait-mergeable-and-merge -- <N> --wait`.
4. Mint the grant (`deft authz:grant -- --template release-publish --target X.Y.Z --confirm`), then run `task release -- --finish X.Y.Z`. The finish step resolves the merged release PR and its merge commit M. It refuses before any tag unless M is on the fetched `origin/master`, has one parent, changes only `CHANGELOG.md`, `ROADMAP.md` and deleted `changelog.d/` fragments, holds the `## [X.Y.Z]` heading and the release line, holds no other `[Unreleased]` entry and no fragment, and the named `Merge gate (task check)` is green on M. Then it runs the release grant check, tags M by its SHA, pushes only the tag, and creates the draft GitHub release from `CHANGELOG.md` at M. The grant authorizes the version; it is not evidence about the commit.

**The release line.** The release writes one line back under the fresh `[Unreleased]`: `- [release-line] vX.Y.Z`. It is an entry, so `[Unreleased]` is never empty after a release and master's merge gate stays green with no change to the empty-section rule. The next release drops it; it never enters a version section.

**The release rule.** `verify:changelog-unreleased` treats a change set that adds a release line as a release attempt and judges it by the release rule only, never by the ordinary rules. It passes only when the change set touches `CHANGELOG.md`, `ROADMAP.md` and deleted fragments only; adds the matching `## [X.Y.Z]` heading; leaves the release line as the only `[Unreleased]` entry and no fragment in `changelog.d/`; keeps every non-blank `CHANGELOG.md` line of the merge base (other than the earlier release line); and puts every non-blank line of each deleted fragment into the new version section. Lines are compared after CRLF is read as LF and trailing whitespace is removed. An ordinary change set that removes or changes the release line fails. Every other change set is judged as before, and the release line already in the file does not count as its entry.

**The merge queue skip.** `verify:changelog-unreleased` skips itself on a `merge_group` run, like the closing-keyword, scope-provenance, intent-constraint and class checks. It prints the change-set skip notice (#7147): on a group commit the change set holds every PR queued ahead, so the check runs on the PR head instead. What is given up: on a merge-queue commit nothing re-checks the changelog. The entry requirement and the release rule were judged on the PR at its last CI run.

**Changes that land ahead.** Case A: a PR that adds a fragment or an `[Unreleased]` entry merges to `master` before the release PR's check runs. The release rule fails on the release PR and names the leftover. Recovery: close the release PR, delete the release branch, and run the cut again from a fresh branch. Case B: such a PR is still in the queue ahead of the release PR and lands first. No check sees it on the queue commit; the finish step refuses and names the leftover entries or fragments.

**Recovery by state.**

- Release PR open: close the PR and delete the release branch (`git push origin --delete release/vX.Y.Z`), or run the cut again.
- Merged and not tagged: run the finish step. When the finish step refuses (case B), the release cannot be tagged. Abandoning it is break-glass until #6485 ships a queue path: an operator with ruleset bypass reverts the release commit on `master` directly (§ Break-glass below). A revert PR through the queue fails the release rule, because it removes the release line without adding one.
- Tagged: `task release:rollback`, which is unchanged. It still pushes `master` directly and needs an operator with ruleset bypass, so it is break-glass.

The pin-bump PR after a release is an ordinary PR: it adds its own entry next to the release line and merges through the queue with no `hotfix` label.

## Release run (#6845)

A stable cut is one command, one approval and the post-run pin steps. The operator approves once, up front, and the run goes to the end unless a phase stops.

```bash
deft release:run X.Y.Z --expires <ISO> [--promote-latest] [--summary "<text>"]
```

Run it on a clean primary checkout on the default branch, after each agent has released its own lease on the primary. In order:

1. **Readiness**, before any write: the Phase 1 checks, the Phase 2 dry run, a free tag, consistent version files and the CI rule (§ Step 5 CI reuse (#6791)). It says whether Step 5 will reuse CI or run the full local check, and about how long that takes. It prints each nightly lane (#6849) and, when one is not reusable, which lane and why and the command that starts the nightly workflow. A failed check refuses. Queued PRs and armed auto-merge are reported, not refused.
2. **Setup and the local cut**: the release branch from the fetched tip B, `session:start --primary-claim-exception=release-cut`, the cut context, then Steps 1 to 9 with no push.
3. **Approve** (the one human act): the run shows the version, B, the release tree T and the promoted CHANGELOG section, then mints one `release-publish` grant for `X.Y.Z@<T>` with your `--expires` (and, with `--promote-latest`, one `release-promote-latest` grant). Type `mint` at the TTY. Without a TTY it prints the mint commands and stops: mint them from your own terminal, then run `deft release:run X.Y.Z --resume`.
4. **Release PR**: push and open it, wait with `pr:watch` until CLEAN, then `pr:wait-mergeable-and-merge --wait`. It enqueues only while the origin tip is still B and the merge queue is empty; otherwise it stops without enqueueing. A failed required check is re-run once per run.
5. **Finish**: refuses unless the sole parent of the merge commit M is B; tags M, pushes only the tag, creates the draft GitHub release with the notes and upgrade banner read from M, and clears the cut context.
6. **Publish watch**: waits on the tag-triggered `npm-publish.yml` run at M. npm is done only when that run and its post-publish two-pass fixture job concluded `success` and both packages carry X.Y.Z on the `maintainer` dist-tag. A failed run stops the run. The run publishes only by the tag push and never dispatches the manual republish workflow.
7. **Draft flip**: a published release is done; a draft is flipped with the run's `release-publish` grant (it never moves `latest`).
8. **Promote**, only with the up-front `release-promote-latest` grant: it looks for a promote-latest run first (in progress: wait; `success` with both packages on `latest`: done; failed or partial: stop), and with none it dispatches once. Without that grant `latest` stays where it was.

The run ends by printing the post-run steps (§ Post-run pin steps).

**Fixture caveat (#6966).** Until #6966 lands, a post-publish fixture that gave up waiting for the registry (`two-pass closure deferred`) still concludes `success`. The publish-watch line says so; read the fixture log before you promote.

### Stops and `--resume`

Every stop names the phase and the run record (`.deft-scratch/release-run/X.Y.Z.json`). Fix the cause, then run `deft release:run X.Y.Z --resume`. The record keeps B, T, the PR number, the grant ids and the retry counts; `--resume` never resets the re-run count. Each phase decides from what GitHub and npm show, so a done step is never redone and nothing is overwritten:

- A tag on M only local is pushed; a remote tag on M is done; a tag on any other commit stops.
- A GitHub release that exists for the tag is done; the flip is done when it is not a draft.
- A tag-triggered run in progress is waited on; a failed run stops.
- An expired or spent grant that an unfinished phase needs stops the run and names the mint command. A newer grant you mint for the same target is used on `--resume`.
- A promote dispatch whose result is unknown stops; the grant was spent before the dispatch, so it is not retried.
- Any other state stops the run.

### Release run recovery

- A PR landed ahead of the release PR: finish refuses before the tag. Undo the release with the break-glass path (§ Break-glass below) until #6485 ships.
- The tag-triggered publish run failed: the run stops and does not republish. Fix the cause on a later commit, re-publish the tag by hand (`gh workflow run npm-publish.yml --ref master -f tag=vX.Y.Z`, an operator act), check both packages on npm, then flip the draft with `task release:publish -- X.Y.Z` and decide on `latest`. `--resume` keeps stopping on the failed tag-triggered run.
- A promote run failed or left a partial state: fix it by hand; the run does not dispatch again.

### Post-run pin steps

1. Pin PR on a branch from `origin/master`: set the `@deftai/directive-runtime` pin to X.Y.Z in `package.json` and its `minimumReleaseAgeExclude` row, run `pnpm update -w @deftai/directive-runtime@X.Y.Z` to regenerate the lockfile, check that `pnpm install --frozen-lockfile` passes, add one changelog line, then open the pin PR and merge it through the queue. The agent commit gate refuses a dogfood pin commit, so the operator commits the pin from their own terminal until #5771 lands. Installing the new version re-deposits host files on the first commit; the pin PR carries that deposit.
2. Switch the primary to the default branch, then `task release:local-update -- X.Y.Z --checkout <primary>`.
3. `npm i -g @deftai/directive@X.Y.Z`.
4. Phase 7 closeout in the release skill: issue auto-close checks, roadmap render, umbrella reopen sweep.

## Break-glass: base-branch release (#1553 / #6296)

The normal path above needs none of this section. `task release -- X.Y.Z --break-glass` keeps the old run on the base branch with the atomic push of the release commit and tag (it writes the release line too). Use it only when the queue itself is broken. Abandoning a merged, untagged release (a direct revert on `master`) is break-glass in the same way until #6485. Both need an operator with ruleset bypass. The branch-protection gate (#746 / #747) blocks direct commits unless the project has opted in.

**Prefer the typed policy opt-out** for a break-glass session:

```bash
task policy:allow-direct-commits -- --confirm
# ... run the release workflow ...
task policy:enforce-branches
# enforce flips the typed flag to false — commit+push the restore with a
# scoped env bypasses of DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1 and DEFT_ALLOW_DESTRUCTIVE_GH_VERBS=1 on these commands only (#2623); do not leave dirty under
# protection ON (v0.79.0 / #2619 failure mode):
DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1 DEFT_ALLOW_DESTRUCTIVE_GH_VERBS=1 git add xbrief/PROJECT-DEFINITION.xbrief.json meta/policy-changes.log
DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1 DEFT_ALLOW_DESTRUCTIVE_GH_VERBS=1 git commit -m "chore(policy): restore branch protection after vX.Y.Z"
DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1 DEFT_ALLOW_DESTRUCTIVE_GH_VERBS=1 git push origin HEAD
```

This writes `plan.policy.allowDirectCommitsToMaster = true` on `xbrief/PROJECT-DEFINITION.xbrief.json` with an audited capability-cost disclosure. It does not leak into child processes the way the emergency env-var bypass does.

**Do not wrap `task release` or `task ci:local` in `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1`.** That env var is process-wide: every subprocess, nested test, and temporary repository spawned from the same shell inherits it. During the v0.43.0 release attempt this caused the Step 5 `task ci:local` preflight to fail (`TestWriteConsumerGitHooks_VendoredCommitBlocked_RealGit`) because a vendored test repo inherited the bypass and allowed a direct `master` commit the test expected the hook to block.

If the env-var bypass is unavoidable outside the enforce closeout above, scope it to a **single** branch-guard probe only (for example `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1 task verify:branch`) and do not export it for the release session. The release pipeline passes the bypass only in scoped subprocess `env=` for its authorised commit/tag/push mutations (#867); operators must not mirror that pattern at the shell level.

**PowerShell coverage-debt tip (#2621):** pass `--allow-coverage-debt=N` (no bare `#`) or quote `"#N"`. Unquoted `#N` is a PowerShell comment and silently drops the issue number.

See `skills/deft-directive-release/SKILL.md` § Release through a PR (#6296) for the operator workflow, and § Branch-Protection Policy Guard for the break-glass steps.

## Merge queue on master (#6295)

`master` requires a GitHub merge queue (squash is the queue's merge method), and the repository allows auto-merge. Required checks: `TypeScript (build + lint)` and `Merge gate (task check)` from `ci.yml` (it also runs on `merge_group`), and `Greptile Review` (the org ruleset). On the group commit, `Greptile Review` comes from `.github/workflows/greptile-review-merge-group.yml`.

- Release and policy commits land through the queue as PRs: `task release` opens the release PR from `release/vX.Y.Z`, it merges with `task pr:wait-mergeable-and-merge -- <N>`, and `task release -- --finish X.Y.Z` tags the merge commit (§ Release through a PR (#6296)). The normal path has no policy commit.
- Direct pushes to `master` are not part of the normal path. The direct-commit steps in § Break-glass: base-branch release above are break-glass only, for when the queue itself is broken, and need an operator with ruleset bypass.
- Do not pass `--admin` to merge around the queue. A break-glass direct merge is a separate, named operator action, not an agent default.

## Release artifact write order (#4318)

`task release` Step 5 starts with a read-only CHANGELOG node-type guard (regular file plus symlink-ancestor floor). `--skip-ci` skips the CI suite, not that guard. Step 6 is **Prepare release artifacts** (in-memory ROADMAP + CHANGELOG; pair-open existing destinations; no writes). Step 7 is **Write release artifacts** (ROADMAP to completion, then CHANGELOG). `--skip-build` skips Step 8 (`task build`), not prepare-artifacts.

### Changelog fragments (#6315)

Step 6 also captures the `changelog.d/` fragments, applies the CHANGELOG read-safety refusal to each, and assembles the promoted section in memory (subsection order, then file name). It refuses an invalid fragment, an entry line held by two fragments, and a `CHANGELOG.md` that already holds the version heading. Step 7 deletes exactly the captured fragments after the CHANGELOG write. Step 9 stages the deletions in the release commit and refuses while a captured fragment is still on disk. A dry run writes and deletes nothing.

Recovery after a failure between the Step 7 write and the Step 9 commit: restore `CHANGELOG.md`, `ROADMAP.md` and `changelog.d/` to HEAD (`git restore --source=HEAD --staged --worktree -- CHANGELOG.md ROADMAP.md changelog.d/`), then rerun. `--allow-dirty` is not a recovery path. After the release commit exists, follow § Release through a PR (#6296) recovery by state; for a tagged release, `task release:rollback` reverts the commit and restores the fragments.

## Warn-first refusals (#6281)

Narrow or remove a gate before adding one. A gate that must exist and adds a new default consumer-visible refusal is declared in the refusal table (`packages/core/src/refusal-declarations/table.ts`) and ships in `warn` mode for at least one release: the work proceeds and the line names the gate id, the remedy and that the gate can refuse from a later release. It turns to `enforce` in a later release with a one-line row change and its own CHANGELOG entry.

A refusal that must refuse in its first release (for example a security fix) is a named exception: its row carries an `exception` reason and its CHANGELOG entry states the reason.

Step 5 Check 5 lists every declared refusal that is new or changed against the table at the previous release tag, and names that baseline: warned in the previous release, new with no warn release, or unknown when the baseline cannot be read. It never stops the cut; the operator judges.

The warn period is counted per release, not per consumer, and no per-consumer warn state is kept. A consumer who upgrades past the warn-only release meets the refusal first; the refusal line still names the gate id and the remedy. Walkthrough: `content/docs/gate-walkthrough.md`.

## Step 5 CI reuse (#6791)

Step 5 reuses CI, with no flag, citation or prompt, when both hold:

- The Step 5 input tree (the release branch HEAD before Step 6 writes) is identical to the tree of the fetched `origin/<base>` tip, and the shared release-input classifier returns `clean` or `session-scratch-only` (not `dirty`). Session-scratch-only admits pure working-tree `.gitignore` additions that are members of imported `DIRECTIVE_GITIGNORE_LINES` and/or untracked `.deft/GENERATION.json` + `.deft/directive/` (porcelain collapsed), with a no-concealment check; it does not require `--allow-dirty`. Readiness Phase 1, pipeline Step 1, and `evaluateCiReuse` share that classifier. Suite-stamp still uses raw `checkGitClean`.
- The latest run of each required check on that tip SHA (`TypeScript (build + lint)`, `Merge gate (task check)`) completed `success`. A missing, pending, failed or re-running latest attempt never reuses an older success.

Nightly lanes are **not** a hard conjunct for tip-green reuse (#7328). Readiness and Step 5 still read and print each lane's status, reason, run URL and head SHA, and never claim a lane ran when it did not. When a lane is not reusable under tip-green reuse, smoke-only reuse continues; the workflow start command stays printed (`gh workflow run nightly.yml --repo deftai/directive --ref master`), and the Windows full-suite boundary is reported independently of host OS.

On reuse, Step 5 prints the tip SHA, the check-run URLs and nightly disposition, and runs only the **host smoke check**: `pnpm run build`, then `pnpm exec vitest run` without coverage on a fixed small set of host test files (`RELEASE_HOST_SMOKE_TEST_FILES` in `packages/core/src/release/ci-reuse.ts`: release spawn, release paths, the check-lane runner and the reuse rule). It takes a few minutes. A failed smoke check fails Step 5.

**A reused cut runs no host coverage** (operator ruling B on #6791). Both nightly lanes are reusable on that tree (§ Nightly coverage and Windows lanes (#6849)) when they stand in for the skipped local coverage/Windows suite; when they are not, tip-green smoke-only reuse still admits without silently claiming those lanes ran. When tip-green does not hold, or a read fails, Step 5 prints why and runs the full local check with host coverage as below. Under `deft release:run` (#6876), Step 5 also prints when its decision changed since readiness. `--skip-ci` stays incident-only.

## Nightly coverage and Windows lanes (#6849)

**Where they run.** `.github/workflows/nightly.yml` runs once a day (and on `workflow_dispatch`) on the `master` tip, never on pull requests or `merge_group`, so PR and queue time do not change. It is not a required check. Both lanes check out the same commit:

- `Nightly coverage (Linux)`: `pnpm run test` (vitest with `--coverage` and the `vitest.config.ts` floor) on `ubuntu-latest`, 60-minute limit. It uploads `coverage/coverage-final.json`.
- `Nightly full suite (Windows)`: `pnpm exec vitest run` without coverage, both vitest projects, on `windows-latest`, 240-minute limit. The coverage floor is read on Linux only.

Both lanes use the merge gate preparation (Node from `.nvmrc`, corepack pnpm, frozen install, Task, uv, tip dogfood materialize). A lane fails as a setup failure, before any test runs, unless `task --version` succeeds and `packages/cli/dist/bin.js` exists.

**Reuse rule.** Readiness and Step 5 read the nightly runs (`packages/core/src/release/nightly-reuse.ts`). For each lane the witness is the newest nightly run whose head commit tree equals the clean Step 5 input tree. The lane is reusable only when the latest attempt of that lane in that run concluded `success`. A pending, failed or missing latest attempt is not reusable, an older success is never used, and a green run on an ancestor with a different tree never counts. Readiness prints each lane's status, run URL and head SHA.

**Fallback.** When tip-green does not hold, readiness says before the mint which required check or tree condition failed, that the full local Step 5 check will run and about how long. When tip-green holds but a nightly lane is not reusable, readiness and Step 5 still name the lane and why, keep printing the command that starts the workflow on `master` (`gh workflow run nightly.yml --repo deftai/directive --ref master`), and continue smoke-only reuse without claiming those lanes ran. Step 5 evaluates the rule again and continues without a prompt either way: full local check with host coverage only when tip-green does not hold.

**Windows host boundary.** When tip-green smoke-only reuse runs without a reusable Windows nightly lane, or when full local fallback runs on a non-Windows host without that lane, readiness and Step 5 print that the Windows suite did not run for this release. Nothing refuses. The Windows boundary is reported independently of host OS under tip-green reuse (#7328).

**Red lanes.** A reporting job runs after both lanes and classifies each one as `passed`, `test-failure`, `setup-failure`, `timed-out-or-cancelled` or `report-unavailable`. Each lane has one durable tracking issue (found by a hidden body marker among issues opened by `github-actions[bot]`). A red lane reopens it, or creates it once, and comments with the outcome, SHA, run id and attempt, run URL, failing test files and, on the coverage lane, the four coverage totals; a value the run did not produce is written as unknown. A passed lane comments on and closes an open issue. One comment per run id and attempt. The issue is assigned to the login in the `NIGHTLY_OWNER` repository variable; when it is unset, the run summary says no one was assigned. These issues are not coverage-debt issues and do not feed the Step 5 hatch.

## Windows Step 5 host coverage decision (#6041; reverses #5026)

**Decision.** PR CI and ordinary `ts:check-lane` run the suite **without** `--coverage`. Release Step 5 (`ts:check-lane` under `DEFT_RELEASE_PREFLIGHT=1`), when it does not reuse CI (§ Step 5 CI reuse (#6791)), runs host vitest **with** `--coverage` and enforces thresholds on the host. On-demand `task test:coverage` remains. Tip-SHA GHA coverage-of-record cites are retired from Step 5 success, stamp-hit, and auto-hatch paths.

**Rationale.** Owner decision: coverage is not a merge requirement; it runs at release for now, or on demand. The 75% floor is a collapse detector, not a per-PR quality ratchet.

**Suite stamp.** Skip only when the stamp carries a mechanical `hostCoverageWitness` (schemaVersion 2). Old schemaVersion-1 stamps miss. `pass_with_debt` requires a positive `debtIssue` on read. Witness is minted only after a completed host coverage run or suite-bound debt classification.

**Host auto-hatch / `--allow-coverage-debt`.** Restored for the host-coverage Step 5 lane (branch-hairline soft-pass against a fresh local `coverage/coverage-final.json`).

**Win32 residual (accepted).** Ubuntu GHA is the sole coverage floor reader. Win32-only product branches the Ubuntu job never executes are an accepted residual of this bind; hang-detector / GHA timeout raises stay on #5024; spawn-heavy cheapen stays on #5027/#5028.

**Measured wall clock (Windows host).** Before (coverage host): v0.119.9 production cut hit the Step 5 hang detector at 30m (exit 124) with host `--coverage` active. Package-scoped proxy on this host (`packages/core/src/ts-check-lane`, unit project): no-coverage 3.05s vs with-coverage 7.76s (~2.5x). After (full Step 5 no-coverage lane): record the first production Step 5 wall clock on the release tee after this lands.

## Vitest coverage hang recovery (#2652 / #4230)

Release Step 5 runs `task check` on the **cached** path with a **60-minute hang detector** (`RELEASE_CHECK_TIMEOUT_MS`; `runReleaseCheck` arms `timeoutMs`). That is hang detection, not a success SLA. Ambient `task check` tees without that kill. Under #6041 the Step 5 host suite runs with `--coverage`; ambient / merge-path `task check` uses `pnpm exec vitest run` without coverage. `task release` does not take the uncached `--no-cache` path. Do **not** raise this constant casually -- further increases are a deliberate gate change via issue/PR + intent-constraint mint (suite growth raised 20→30 under #5022, then 30→45 under #5024, then 45→60 under #5091). For ordinary exit 124, cheapen the Windows Step 5 suite first; numeric raise is not the default recovery.

**Stale-binary diagnostic (before treating 124 as a vitest hang).** If a single-shot `Measure-Command { node -e 0 }` is greater than about 100 ms or `git --version` is greater than about 150 ms, investigate before assuming a suite hang. Probe with a **repeated** measurement and read the **median** — the first invocation in a fresh shell is a warm. Confirm with the claimant's differential: rename the original binary, copy a fresh file onto the original path; the renamed original stays slow and the fresh copy at the same path goes fast. Then copy-over-self / reinstall. Measured 40 min → 3.6 min on deft01 2026-09-07. Bitdefender exceptions are optional (216–277 s across states, within noise).

**#5140 host probe (record, do not invent a silent repair).** On the release host used for the #5140 implement leaf (2026-09-30): Node `C:\Program Files\nodejs\node.exe` v24.18.0 median cold `node -e 0` ≈132 ms (5 probes); Git `C:\Users\msada\AppData\Local\grok\git\2.55.0.windows.5\cmd\git.exe` 2.55.0.windows.5 median `git --version` ≈470 ms (5 probes; first 559 ms); host load ≈55% on 32 logical CPUs (AMD RYZEN AI MAX+ 395). Git median is above the ~150 ms stale-binary tip — treat host binary latency as an open differential alongside suite composition. Do **not** silently AV-exclude or replace binaries as the #5140 product change; host repair needs explicit operator evidence.

GHA CI TypeScript lane runs vitest without coverage (#6041) and keeps a 20-minute wall (`timeout-minutes: 20`). Do not equate that Ubuntu CI budget with the Windows release Step 5 hang detector.

**When Step 5 or CI appears stuck**

1. **Do not** leave AFK agents in unbounded `Await` loops on CI — use one-shot probes (`gh run view`, `task pr:watch -- <N> --one-shot`) or cancel after the timeout. See `task pr:watch -- --help` for flags and exits 0/1/2 (#1056).
2. **Local:** if vitest shows no progress for several minutes, stop the process (`Ctrl+C`). Re-run a bounded probe: `pnpm exec vitest run --coverage packages/core/src/pr-monitor --reporter=verbose` (suspect suites first), then `task check` once the suite completes within the timeout.
3. **GHA:** cancel the stuck run (`gh run cancel <run_id>`) after the step exceeds ~20 minutes; inspect logs for `ts:check-lane last-file` (or a 20% band) before the stall. Re-run failed jobs only after a fix lands (`gh run rerun <run_id> --failed`).
4. **Production `--skip-ci` is an incident**, not a normal path: it skips vitest coverage and ships **untested** npm builds. Requires `--allow-skip-ci=#N` citing the tracked issue; Step 5 emits a loud WARN. Use only under operator review; the next patch after a hang fix must cut **without** `--skip-ci`.

**Per-file duration ranking from the retained tee (#5027).** Step 5 / supervised `ts:check-lane` tees land under `.deft/check-tees/**/*.log` (retained on exit 124). The progress reporter already flushes `ts:check-lane timeline file <path> <ms> project=…` via `writeSync` when a file's elapsed time is ≥ `PROGRESS_FILE_HEARTBEAT_MS` (30s). That stream is the hang-kill-durable ranking input — last-completed-file is only a hang cursor, and hand-timed isolates understate contended Step 5 cost. Stock vitest `--reporter=json` / `outputFile` is **not** used here: `JsonReporter` writes in `onTestRunEnd`, which does not run under win32 `taskkill /T /F` or POSIX `SIGKILL`.

Omission (explicit): files that finish in under 30s never emit a timeline file line, so they never appear in the ranking. Top-N is among emitted duration lines only.

Rank helper:

```text
pnpm exec tsx packages/core/src/ts-check-lane/duration-rank.ts --top 20 .deft/check-tees/<session>/<run>.log
```

`--top` is required (no coded default). Use `--top 20` for the #5024 cheapen baseline paste.

Paste the top-20 from the next production Windows Step 5 cut into #5024 as the cheapen baseline. Out of scope here: acting on the ranking; uploading the artifact.

**#5140 sequencer fixture refresh.** `packages/core/fixtures/vitest-file-durations.json` is the `DurationSequencer` input (#5028). Refresh it from a retained tee via the #5027 scraper; delete sub-30s seeded noise; validate every key resolves to a tip test file. #5140 used tee `.deft/check-tees/no-session/60556-1277c46c.log` (original v0.119.11 hang-kill tee was missing on host). Top measured offenders on that tee: `init-deposit/refresh` (~1393s), `session/occupancy` (~1379s), `durable-effect-acquisition/evaluate` (~478s), `presentation-coverage/gates` (~472s), `vbrief-validate/landed-filename` (~315s). **Incomplete-tee merge rule:** when the retained tee did not finish the suite, preserve prior fixture entries that are still tip test files and were ≥30s (e.g. `session/spawn-occupancy.test.ts` ~275s) until a completed measurement replaces them — listed files sort ahead of unlisted ones, so dropping known-slow keys recreates the idle tail. Keep unit git tails in the **unit** project with share-plus-reset; do not move them into `spawn-heavy`. Search space includes default Vitest `pool` / `poolOptions.forks.isolate` (do not flip `isolate: false` without a measured cut). `DurationSequencer` name-tiebreak is `spawn-heavy` < `unit` lexicographically when `groupOrder` matches; config still omits `sequence.groupOrder` so projects overlap.

Pointer: `content/scm/github.md` § Release Step 5 timeout (maintainer cross-link).

## Fixable check failure during release (#2859)

When pipeline Step 5 fails on a **fixable product or test defect** during a cut, do **not** lead with an inline hotfix on the release branch or untracked `--skip-ci`. Pause the cut and route the blocker through normal issue → xBRIEF → feature branch → PR → merge → confirm pipeline Step 5 is green → resume Phase 1.

The full agent contract (including the explicit rejection of AGENTS.md / agents-entry bulk for this reminder) lives in `skills/deft-directive-release/SKILL.md` § **Fixable check failure — file-and-merge before resume (#2859)**. Production `--skip-ci` with `--allow-skip-ci=#N` remains incident-only per § Vitest coverage hang recovery above.

## Coverage debt hatch during release (#2866 / #3187)

**#6041 host lane:** Windows Step 5 regenerates local coverage again. Host auto-hatch / `--allow-coverage-debt` soft-pass applies to that host report. Use this hatch **only** when **branches** is the **sole** metric below 85% (lines, functions, and statements all ≥ 85%). Confirm from suite output or `task coverage:hotspots`. Do not treat `coverage/coverage-final.json` as live until [#4244](https://github.com/deftai/directive/issues/4244). If any other metric also misses, or the failure is a hang / failing test / non-coverage defect, pause and follow § Fixable check failure during release (#2859).

**Runtime note (coverage-bearing lane only):** `--allow-coverage-debt=#N` zeros all vitest coverage thresholds (`vitest.config.ts`, #2573). File debt only for branch-only hairlines; acceptance criteria must restore **all four metrics** to ≥ 85%.

### Auto-hatch after one suite (#3187)

`task release` Step 5 classifies a non-zero suite as `REAL_FAILURE` | `BRANCH_HAIRLINE` | `OTHER_COVERAGE` | `UNKNOWN`:

| Class | Behavior |
| --- | --- |
| `BRANCH_HAIRLINE` + **empty** open debt ledger | Auto-file `#N` with markers, mark `PASS_WITH_DEBT(#N)`, **continue without re-running vitest** |
| `BRANCH_HAIRLINE` + **open** prior debt | Fail closed — restore coverage and close `#N` first (no consecutive soft-pass) |
| `REAL_FAILURE` / `OTHER_COVERAGE` / `UNKNOWN` | Fail closed — no auto-issue |

Never soft-pass without a durable issue (file-before-continue). Manual `--allow-coverage-debt=#N` remains valid (PowerShell: `--allow-coverage-debt=N` or `"#N"`, #2621).

### Open-issue ledger probes

1. **No open coverage-debt issue** → union three probes: (a) open issues with `coverage-debt in:title,body`, (b) open issues with `allow-coverage-debt in:body`, (c) open issues cited via `--allow-coverage-debt=#N` in `CHANGELOG.md` `[Unreleased]` or the last three release sections (legacy hatch debt before markers were mandatory). If all empty, auto-hatch (or operator) files `#N` with title prefix `coverage-debt:` and body containing both markers `coverage-debt` and `--allow-coverage-debt`.
2. **Open coverage-debt issue from a prior hatch still exists** → do **not** soft-pass again; restore all four metrics to ≥ 85% and close the debt issue before the cut proceeds.

### SHA suite stamp (#3187)

After suite **green** or `PASS_WITH_DEBT`, release writes a local stamp at `.deft/release-suite-stamp.json` (gitignored) bound to `git rev-parse HEAD` with `hostCoverageWitness: true` (schemaVersion 2). Re-invoke at the same **clean** HEAD skips the suite (logs `suite stamp hit`). Dirty tree, different HEAD, corrupt/old stamp, or **CI** (`CI` / `GITHUB_ACTIONS`) → stamp miss; suite runs again. CI never trusts laptop stamps. Gate ordering (fast before slow) is owned by #3188.

### Scope

The hatch is **framework-release-first / release-scoped only** — not the default for ordinary PR / `task check` work. Consumer auto-hatch via `plan.policy.coverageDebt` is **reserved**; consumer expansion is not implemented (#3314). The live consumer hatch is `--allow-coverage-debt=#N` (#2866). Hangs, failing tests, multi-metric coverage misses, and other non-coverage Step 5 failures stay under § Fixable check failure during release (#2859).

Canonical agent contract: `skills/deft-directive-release/SKILL.md` § **Step 5 branch-coverage threshold — open-issue ledger hatch (#2866 / #3187)**.

## Routine vs hard cut for Step 5 (#2953)

Step 5 has one rule, and no mode or flag changes it. When the Step 5 input tree (clean or session-scratch-only) is identical to a fetched tip whose latest required checks succeeded, Step 5 reuses CI on its own and runs only the host smoke check, with no host coverage (§ Step 5 CI reuse (#6791 / #7328)). Nightly disposition is printed truthfully; tip-green smoke-only reuse is the named allowed mode when a nightly lane is not reusable. Otherwise it runs the full `task check` with host `--coverage` (#6041), where the branch-hairline auto-hatch and `--allow-coverage-debt=#N` apply. `deft release:run` asks for no choice: readiness says which path Step 5 will take, and Step 5 says again if that changed.

There is no routine-cut skip path. `--skip-ci` with `--allow-skip-ci=#N` (#2652) is incident-only (a tracked hang or an untested ship under review), is never passed by `deft release:run`, and prints a loud WARN. Silent soft-pass of coverage is forbidden; tip-green reuse with printed nightly disposition is not a silent soft-pass.

What makes a full Step 5 faster is hygiene, not a lighter gate:

1. **Default-exclude scratch / worktree noise (#2953).** Content, link, stub, codebase-map, and build-dist walks skip `.deft-scratch/` (and legacy `swarm-worktrees/`) by default. Release Step 5 must not enumerate `.deft-scratch/worktrees/**` unless you are deliberately debugging those trees.
2. **Prefer a calm tip.** Cut from a fetched `master` tip with green required checks, so the CI reuse rule can hold.
3. **Prune stale worktrees before the cut** when a maintainer clone is heavy: `git worktree list`, remove abandoned `.deft-scratch/worktrees/*` entries, or cut from a clean clone.

### Debugging scratch inclusion

If you need to inspect markdown under a worktree, open that worktree path as cwd for `task validate-links` / tools — do not re-enable repo-root walks into `.deft-scratch/` for production cuts.

Pointer: `skills/deft-directive-release/SKILL.md` § Routine vs hard cut (#2953).

## Stable cut order

Do not tag `master` by hand. A stable cut is `deft release:run` (§ Release run (#6845)); the release skill's § Stable cut runbook gives the same order with the operator and agent roles.

> **Canonical consumer install:** `npm i -g @deftai/directive` then `directive install` / `upgrade` / `install --repair` / `doctor`. Do **not** download deleted `install-*` / `deft-install` binaries.

## Frozen Go-installer bridge — retired from master (#1912 / #1972 / #6863)

> **Retired.** `cmd/deft-install/` is **absent**, and master no longer carries `go.mod`, a Go release workflow, the bridge freeze or drift gates, or the `--legacy-bridge` e2e leg (#6863). npm/`directive` is the only release and install channel. Do not teach `deft-install --yes --upgrade` as a current path.

- The frozen bridge binaries stay downloadable from the published [v0.58.0 release](https://github.com/deftai/directive/releases/tag/v0.58.0) (`install-linux-amd64`, `install-linux-arm64`, `install-macos-universal`, `install-windows-amd64.exe`, `install-windows-arm64.exe`). Never delete those release assets or the tag.
- If the bridge must ever be rebuilt, build it from the `v0.58.0` tag, not from master.
