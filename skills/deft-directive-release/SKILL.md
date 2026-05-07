---
name: deft-directive-release
description: >
  Cut a v0.X.Y release of the deft framework safely. Use when the user
  says "release", "cut release", "v0.X.Y", or "publish release" -- to
  walk an 8-phase workflow that pre-flights, runs an end-to-end
  rehearsal against a temp repo, lands a draft on the real repo, gates
  on user review, then publishes or rolls back. Re-uses the
  deft-directive-swarm Phase 6 Step 5 Slack announcement template.
---

# Deft Directive Release

Structured 8-phase workflow for cutting a v0.X.Y release of the deft framework. Operationalizes the `task release` / `task release:publish` / `task release:rollback` / `task release:e2e` surface introduced in #716 (safety hardening of #74).

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**See also**: [deft-directive-swarm](../deft-directive-swarm/SKILL.md) Phase 6 Step 5 (Slack announcement template re-used by Phase 8 below) | [deft-directive-review-cycle](../deft-directive-review-cycle/SKILL.md) (user-gate pattern) | [deft-directive-refinement](../deft-directive-refinement/SKILL.md) (conversational phased flow).

## Platform Requirements

! GitHub as the SCM platform; the **GitHub CLI (`gh`)** must be installed and authenticated. The full pipeline plus the rehearsal target (`task release:e2e`) all dispatch through `gh`.

## Branch-Protection Policy Guard

! Before any Phase 1 state mutation, run the skill-level branch-policy guard documented in `scripts/policy.py` / `scripts/preflight_branch.py` (#746 / #747). Releases run on the configured base branch (default `master`) so the operator MUST be on the explicit-opt-in side of the policy OR have set `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1` for the release session. Concretely:

```
uv run python scripts/preflight_branch.py --project-root . --quiet || exit 1
```

or invoke `task verify:branch`. This is the canonical surface that surfaces the policy state to the operator before the pipeline starts writing files. The release pipeline's other safety surfaces (the dirty-tree guard, base-branch check, `task ci:local` gate) remain independent of this check.

## Deterministic Questions Contract

! Every numbered-menu prompt rendered in this skill (Phase 1 version-bump magnitude check, Phase 2 dry-run review `yes`/`back`/`quit`, Phase 5 `publish`/`rollback`/`defer`) MUST follow [`../../contracts/deterministic-questions.md`](../../contracts/deterministic-questions.md): the final two numbered options MUST be `Discuss` and `Back`, in that order. Existing `back`/`quit` options remain valid; this contract simply adds `Discuss` as a peer alongside `Back`. The Discuss-pause semantic is documented verbatim in the contract -- implicit resumption is forbidden.

## When to Use

- User says "release", "cut release", "v0.X.Y", "publish release", "ship a release"
- The framework's `[Unreleased]` CHANGELOG section is non-empty and the operator wants to cut a tagged release
- A previous release rehearsal succeeded and the operator is ready for the production cut

## Phase 1 — Pre-flight

! Validate the local + remote state before any irreversible action.

1. ! Verify the operator is on the configured base branch (default `master`) and the working tree is clean
2. ! Confirm the next version number (`X.Y.Z`) with the user. Major / minor / patch decision flows from the `[Unreleased]` content (breaking change → major; new feature → minor; fix-only → patch)
3. ! Inspect `[Unreleased]` content vs the proposed version bump. If a breaking change appears in `### Changed` / `### Removed` but only a patch is proposed, surface the mismatch and ask the user to choose
4. ! Verify `task ci:local` passes locally (or `task check` as the graceful-degradation fallback per `tasks/release.yml` line 9-10). The `task release` script will refuse to proceed otherwise -- but Phase 1 catches it earlier
5. ! Verify `gh auth status` reports authenticated (`task release` will refuse otherwise)
6. ! **Run `task reconcile:issues -- --apply-lifecycle-fixes` to clear any closed-issue / non-completed-folder vBRIEFs before invoking `task release`** (#734). The release pipeline carries the deterministic gate at Step 3 (`scripts/release.py::check_vbrief_lifecycle_sync`, refuses with `EXIT_VIOLATION` on any Section (c) mismatch), but Phase 1 is the operator's first-line defence -- running the apply-mode flag here is the canonical clean path; `--allow-vbrief-drift` on the pipeline exists only as the explicit-acknowledgment escape hatch (analogous to `--allow-dirty`). The recurrence record is the v0.21.0 cut, which surfaced 13 stranded vBRIEFs (8 cycle-relevant + 5 historical residue) post-publish; the gate now blocks that drift before any irreversible action
7. ! **Verify the proposed `v<version>` tag is not already in use locally, on origin, or as a published GitHub release** (#784). The release pipeline carries the deterministic gate at Step 4 (`scripts/release.py::check_tag_available`, refuses with `EXIT_VIOLATION` before any state mutation -- CHANGELOG promotion, ROADMAP refresh, build, commit), but Phase 1 is the operator's first-line defence. Quickly probe with `git tag -l v<version>` (local), `git ls-remote --tags origin refs/tags/v<version>` (remote), and `gh release view v<version> --repo <owner>/<repo>` (release-only, where `gh release view` exits 0 only when the release exists). The recurrence record is the v0.22.0 → v0.23.0 release attempt on 2026-05-01: the operator typed `0.22.0` (the prior release from 12 hours earlier) and the legacy pipeline ran 8 steps before failing at `git tag` -- leaving a wrong-version local commit + `dist/deft-0.22.0.zip` orphan + manual `git reset --hard` recovery. The new pre-flight gate blocks that mode before any irreversible action
8. ~ Ask the operator for an optional one-line release **summary** (recommended 80-160 chars; can be skipped). The summary is the canonical narrative for THIS release across three audiences: (a) injected as a Markdown blockquote at the top of the promoted `CHANGELOG.md [<version>]` section, (b) auto-flowed into the GitHub release body via the existing `_section_for_version` pickup, and (c) populated VERBATIM into the Phase 8 Slack `*Summary*:` slot. Capture the wording once here; do NOT regenerate per-audience downstream

⊗ Skip the version-bump magnitude check -- a patch release that ships breaking changes is the kind of regression that Repair Authority [AXIOM] (#709) is designed to prevent.

⊗ Skip the vBRIEF-lifecycle-sync check (#734); the gate exists because operators consistently forget the manual `task scope:complete` move step. The v0.21.0 cut surfaced 13 stranded vBRIEFs (8 cycle-relevant + 5 historical residue) post-publish as the recurrence record this gate prevents. If `task release` reports `[3/13] Pre-flight vBRIEF lifecycle sync... FAIL (<count> mismatches; run task reconcile:issues -- --apply-lifecycle-fixes to fix)`, the canonical recovery is the apply-mode invocation -- `--allow-vbrief-drift` is reserved for cases where the operator has explicitly reviewed the drift and chosen to defer the lifecycle reconcile to the next refinement pass (e.g. an emergency hot-fix release).

⊗ Skip the tag-availability check (#784); the gate exists because the legacy 12-step pipeline only invoked `git tag` at Step 9, after Steps 1-8 had already mutated state (CHANGELOG promoted, ROADMAP refreshed, dist built, release commit made locally). A duplicate-tag failure at Step 9 stranded the operator with an unpushed wrong-version commit + orphaned `dist/deft-<wrong>.zip` artifact + manual `git reset --hard` recovery (forbidden by AGENTS.md SCM rules without explicit permission). The recurrence record is the v0.22.0 → v0.23.0 release attempt on 2026-05-01. If `task release` reports `[4/13] Pre-flight tag availability... FAIL (<surface> tag v<version> already exists ...)`, the canonical recovery is to choose a different version (the most likely cause is operator typo of a prior release).

⊗ Hand-write a different one-line narrative for each of the three downstream surfaces (CHANGELOG / GitHub release / Slack) -- that drift is exactly the gap the `--summary` flag is designed to close. If the operator insists on per-audience tone, populate the canonical `--summary` ONCE here and document the deviation in the Phase 8 anti-pattern.

## Phase 2 — Dry-run review

! Invoke `task release -- <version> --dry-run --skip-tag --skip-release` and present the plan to the user. If Phase 1 collected an operator summary, also pass `--summary "<text>"` so the dry-run preview reflects the canonical narrative the operator just authored.

```
task release -- <version> --dry-run --skip-tag --skip-release --summary "<text>"
```

The dry-run prints `[N/13] <step>... DRYRUN (would <action>)` for every pipeline step (Step 13 is the post-create verify-isDraft gate added by #724; Step 4 is the tag-availability pre-flight gate added by #784). Step 6 (CHANGELOG promotion) surfaces whether a summary was supplied (truncated to ~60 chars in the preview) so the operator can validate the wording before any file is written. Capture the output and present it to the user, then wait for explicit confirmation before continuing.

! Wait for explicit user confirmation: `yes` / `back` / `quit`.
- `yes` (or `confirmed` / `approve`) → proceed to Phase 3
- `back` → return to Phase 1 for re-validation (e.g. user wants to amend the version or `[Unreleased]` content)
- `quit` → abort the workflow cleanly; no state changes

⊗ Skip the dry-run preview. The dry-run is the operator's last opportunity to catch a bad version number, malformed CHANGELOG, or wrong base branch before the pipeline starts writing files.

## Phase 3 — E2E sanity

! Invoke `task release:e2e` against an auto-created+destroyed temp repo to verify the full pipeline shape works end-to-end before touching the real repo.

```
task release:e2e
```

The harness provisions `deftai/deftai-release-test-<ts>-<uuid6>`, runs the smoke-test rehearsal, and destroys the temp repo in a `try/finally` clause. Cleanup runs even if the rehearsal fails. If `gh repo delete` fails, surface the manual-cleanup hint to the user and continue.

! Treat a non-zero exit from `task release:e2e` as a hard refusal to proceed to Phase 4. Surface the diagnostic and ask whether to debug (return to Phase 1) or abort (`quit`).

? **Skip allowed** when the operator has just run `task release:e2e` successfully against the same branch in the past 30 minutes. Note the prior run timestamp in the user-facing summary.

## Phase 4 — Production draft

! Invoke `task release -- <version>` (NO `--dry-run`, NO `--skip-tag`, NO `--skip-release`). If Phase 1 collected an operator summary, pass `--summary "<text>"` so the production cut writes the same blockquote the dry-run previewed.

```
task release -- <version> --summary "<text>"
```

Per #716 default-draft hardening, this lands the release as a `--draft` on the real repo. Binaries upload via release.yml CI, but the artifact is NOT yet visible to consumers. The operator-authored summary becomes part of the promoted `CHANGELOG.md [<version>]` section AND the GitHub release body (auto-pickup via `_section_for_version`). The same wording is the canonical source for the Phase 8 Slack `*Summary*:` slot.

! **Verify isDraft within 5 seconds; flip immediately if not (#724).** Immediately after `gh release create --draft` returns success, `scripts/release.py` Step 11 polls `gh release view v<version> --json isDraft` up to 5 times at 1-second intervals. If the release exists with `isDraft=false`, the pipeline auto-flips it via `gh release edit v<version> --draft=true` and emits a `WARNING: release landed as public; flipping to draft (defense-in-depth, see #724)` line. This closes the ~90-second public-exposure window observed during the v0.21.0 cut where a manual recovery created a public release before the operator noticed and flipped it. The verify gate is defense in depth even when `--draft` was passed correctly: it catches the case where `gh release create` partially succeeded (release record written, error returned) AND the operator-error variant where an alternate code path sent the release without `--draft`. A release-not-found-within-budget result emits a WARN and does NOT fail the pipeline (release.yml CI may still be processing).

! Wait for `task release` to exit 0 before continuing. A non-zero exit means the pipeline halted partway through; consult Phase 7's `task release:rollback` recovery before retrying.

⊗ Pass `--no-draft` here unless the operator has explicitly opted into direct-publish (e.g. automated security patch). The default-draft contract is the foundation of the safety hardening surface.

⊗ Skip the post-create verify-isDraft gate -- the gate is the only reliable safety net against "create call exited 0 but the release somehow landed as public" variants (#724). If `task release` is invoked manually outside the canonical `scripts/release.py` flow, the operator MUST run `gh release view v<version> --json isDraft` followed by `gh release edit --draft=true` on `isDraft=false` BEFORE handing off to Phase 5.

## Phase 5 — Draft review gate (user-only authority)

! After `task release` exits 0, present the draft release for user review.

1. ! Run `gh release view v<version> --json url,name,body,assets,isDraft --repo <owner>/<repo>` and present the output to the user
2. ! Surface the asset list (size + filename) so the user can verify binaries uploaded correctly
3. ! Surface the auto-generated release notes (or the CHANGELOG section that was promoted into the release body)
4. ! Wait for explicit user confirmation:
   - `publish` (or `yes` / `confirmed` / `approve`) → proceed to Phase 6 (Publish branch)
   - `rollback` → proceed to Phase 6 (Rollback branch)
   - `defer` → halt and exit. Surface the draft URL so the operator can return later with `task release:publish` or `task release:rollback`. Do NOT auto-merge; do NOT silently wait

⊗ Bypass the user-only authority gate. Even under time pressure or long-context, the release MUST receive an explicit `publish` / `rollback` / `defer` decision from the user. This mirrors the Phase 5→6 gate in `skills/deft-directive-swarm/SKILL.md`.

## Phase 6 — Publish or rollback

! Branch on the user's Phase 5 decision.

### Publish branch (user said `publish`)

```
task release:publish -- <version>
```

The companion script flips `--draft=false`, then re-reads the release to verify `isDraft == false` actually flipped. State machine:
- `draft` found → flip to public; verify; exit 0
- already `published` → exit 0 no-op (idempotent re-runs are safe)
- `not-found` → exit 1 (cannot publish a missing release)
- gh-error → exit 1 with diagnostic

! Wait for `task release:publish` to exit 0 before continuing.

### Rollback branch (user said `rollback`)

```
task release:rollback -- <version>
```

The state-aware unwind detects the post-release state and applies the matching tiered recovery. Time-windowed download-count guard:
- release age `< 5 min` → threshold = 0 (rollback safe; nobody noticed yet)
- release age `5-30 min` → threshold = max(`--allow-low-downloads`, 10) (filters bot fetches)
- release age `> 30 min` → refuse without `--allow-data-loss`

Three escape hatches (escalating warnings):
- `--allow-low-downloads N` -- accept up to N downloads
- `--allow-data-loss` -- accept any count (consumer impact)
- `--force-strict-0` -- require exactly 0 regardless of release age

Race-condition mitigation: `download_count` is double-read with a 5s sleep between reads; rollback only proceeds if both reads agree below threshold.

! When the guard refuses, surface the recommendation to the user: rollback is risky on a released artifact with non-zero downloads. Prefer the **hot-fix path** (cut the next patch with a withdrawal note in `[Unreleased]/Changed` rather than deleting the broken release).

## Phase 7 — Post-publish verification

! Only enter Phase 7 if Phase 6 took the Publish branch (rollback branch ends here with the unwind log).

1. ! Verify GitHub auto-closed the discrete-task issue(s) referenced via `Closes #N` in the release notes (mirrors `skills/deft-directive-swarm/SKILL.md` Phase 6 Step 2)
2. ! Run `gh issue view <N> --json state --jq .state` for each closed issue. If any didn't auto-close, manually close with `gh issue close <N> --comment "Closed by release v<version> (squash auto-close did not trigger)"` (Layer 1, #167)
3. ! Verify ROADMAP.md correctness via `task roadmap:render` (the release pipeline already invoked this; Phase 7 is the second-pass sanity check)
4. ! Verify binaries are downloadable from the public release URL: `gh release view v<version> --json assets --jq '.assets[].url'` and curl one to confirm 200 OK
5. ! For any umbrella / staying-OPEN issue (`Refs #N`) referenced in the release notes, run the Layer 3 reopen sweep from `skills/deft-directive-swarm/SKILL.md` Phase 6 Step 1: any protected issue that auto-closed MUST be reopened with a comment citing #701

⊗ Skip the post-publish verification. The closing-keyword false-positive (Layer 1 / Layer 2 / Layer 3) and the incremental-renderer-drift (#641, #614) are exactly the kind of issues that surface only AFTER a release is public.

## Phase 8 — Slack announcement

! Generate the canonical Slack release announcement and present it to the user for copy-paste, re-using the template from `skills/deft-directive-swarm/SKILL.md` Phase 6 Step 5.

The announcement block MUST include:

```
:rocket: *deft v<version>* -- <release title>

*Summary*: <one-sentence description of the release scope>

*Key Changes*:
- <bullet per significant change, 3-5 items max>

*Stats*: 1 release | ~<duration> elapsed | <N> commits since v<previous>
*Release*: <GitHub release URL>
```

! Populate version from the freshly-published `gh release view v<version>` output. Populate release title from the CHANGELOG section heading (or the GitHub release title). Summarize key changes from the promoted `[Unreleased]` -> `[<version>]` CHANGELOG section (NOT raw commit messages). Populate stats from `git log v<previous>..v<version> --oneline | wc -l`.

! Populate the `*Summary*:` slot VERBATIM from the operator-authored blockquote at the top of the CHANGELOG `[<version>]` section (the line beginning with `> ` immediately after the `## [<version>] - <date>` heading). The Phase 1 prompt + Phase 4 `--summary` flag exist precisely so this populate step is mechanical -- one canonical narrative authored once at Phase 1, propagated through Phase 4 promotion, and copy-pasted here without re-authoring. If the CHANGELOG section has no blockquote (operator skipped the Phase 1 prompt), generate a one-sentence summary from the `### Added` / `### Changed` bullets and surface to the operator that this is a regenerated narrative (NOT canonical) so they can decide whether to amend the CHANGELOG before publishing.

! Present the block as a code-fenced snippet the user can copy directly. Do NOT post to Slack from inside this skill -- the user owns the actual broadcast.

## Skill Completion

! When Phase 8 completes (or when Phase 5 took the `defer` / `quit` path, or when Phase 6 completed the rollback branch), explicitly confirm skill exit:

```
deft-directive-release complete -- exiting skill.
Next: <one-line guidance>
```

Where `<one-line guidance>` is one of:
- "release v<version> live -- monitor consumer reports for ~24h before cutting v<next>"
- "release v<version> rolled back -- the underlying defect needs a hot-fix in the next CHANGELOG entry"
- "release deferred -- resume by running `task release:publish -- <version>` (or `task release:rollback -- <version>`) when ready"

⊗ Exit silently without confirming completion or providing next-step guidance.

## Anti-Patterns

- ⊗ Run `task release` without a Phase 2 dry-run preview -- the dry-run is the only safe place to catch a bad version, malformed CHANGELOG, or wrong base branch
- ⊗ Skip Phase 3 (e2e rehearsal) on the assumption that "the dry-run is enough" -- the e2e harness catches gh-CLI auth issues, repo permission gaps, and pipeline-shape regressions that the dry-run cannot detect
- ⊗ Pass `--no-draft` to `task release` without explicit operator opt-in -- the default-draft contract is the foundation of the safety hardening surface
- ⊗ Auto-publish a draft without the Phase 5 user-only authority gate -- even under time pressure or long-context, the release MUST receive an explicit `publish` / `rollback` / `defer` decision
- ⊗ Run `task release:rollback` against a release that has > 30 minutes of consumer-driven downloads without first weighing the hot-fix path -- a withdrawal note in the next patch is almost always less disruptive than deleting a public artifact
- ⊗ Use `--allow-data-loss` without first reading the script docstring's hot-fix-path recommendation -- the flag is an explicit acknowledgment of consumer impact, not a default
- ⊗ Skip the Phase 7 Layer 3 reopen sweep -- protected umbrellas can auto-close on a release-merge squash even when the release notes use `Refs #N` only
- ⊗ Post the Phase 8 Slack announcement directly from this skill -- the user owns the broadcast; the skill only generates the template
- ⊗ Hardcode `master` as the base branch -- delegate to the configured base branch from `task release --base-branch <branch>`
- ⊗ Skip the post-create verify-isDraft gate (#724) -- a successful `gh release create` exit code does NOT prove the release actually landed in draft state; the 5-second poll-and-flip gate in `scripts/release.py` Step 11 is the only safety net against operator-error variants and partial-success races, and any manual recovery path that bypasses `scripts/release.py` MUST run `gh release view --json isDraft` followed by `gh release edit --draft=true` on `isDraft=false` before handing off to Phase 5
- ⊗ Manually rewrite the Phase 8 Slack `*Summary*:` line to deviate from the CHANGELOG `[<version>]` blockquote -- the canonical narrative is authored ONCE at Phase 1 via `--summary` and propagates verbatim across all three audiences (CHANGELOG / GitHub release body / Slack). Per-audience hand-edits create documentation drift that the deterministic `--summary` flow is designed to prevent. If the operator wants Slack-specific tone, fold it into the canonical Phase 1 wording before passing `--summary`, OR amend the CHANGELOG blockquote BEFORE Phase 8 so all three surfaces stay aligned
