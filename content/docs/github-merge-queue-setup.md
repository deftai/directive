# GitHub merge queue setup

Agent-facing playbook for a maintainer who wants Directive's queue mode (#6295) on a GitHub repository. Paste this file and say: follow this playbook. The human runs the settings changes (they need repository admin); the agent prepares and verifies them.

Legend (RFC2119): `!`=MUST, `~`=SHOULD, `⊗`=MUST NOT.

---

## Goal

PRs merge through GitHub's merge queue instead of a direct merge. The queue tests each PR on top of the current target branch, so a PR no longer needs a rebase and a new CI run every time the branch moves. `task pr:wait-mergeable-and-merge` detects the queue and enqueues (see [`scm/github.md`](../scm/github.md) § Merge queue mode).

## What the queue is

- It is a GitHub feature, configured per branch in a repository ruleset. The queue itself is kept by GitHub: `https://github.com/<owner>/<repo>/queue/<branch>`.
- GitHub Actions takes part through the `merge_group` event: for each queue entry GitHub builds a temporary commit, and every required check must report on it.
- Directive keeps no queue state of its own.

## Prerequisites (repository content, before the settings)

1. ! Every workflow behind a required check runs on `merge_group` as well as `pull_request`:
   ```yaml
   on:
     pull_request:
     merge_group:
   ```
2. ! Any required check that a GitHub App posts (for example a review bot) and that does not run on `merge_group` has a `merge_group`-only job with the same name, or the queue waits for it forever. Example in this repository: `.github/workflows/greptile-review-merge-group.yml` reports `Greptile Review` on the group commit.
3. ~ PR-context checks (closing keywords, scope provenance, intent constraint) skip themselves on `merge_group`; they run on the PR head and body. Change-set checks (changelog, class checks) skip there too: on a group commit the change set holds every PR queued ahead, so they run on the PR head instead (#7147). Directive's `task check:merge` already does this.
4. ! A required check that is path-filtered must report `skipped` (job-level `if:`), not be absent (workflow-level `paths:`). A skipped required check passes; an absent one blocks the queue.

## Settings (repository admin)

The commands use `gh` and PowerShell 7. Replace `<owner>/<repo>`, the branch and the check names.

1. Allow auto-merge (the queue enqueues through it):
   ```powershell
   gh api -X PATCH repos/<owner>/<repo> -F allow_auto_merge=true
   ```
2. Required checks on the branch, with "require branches to be up to date" OFF. The queue tests the merged result, so strict mode only adds rebases:
   ```powershell
   @{ strict = $false; checks = @(
       @{ context = 'TypeScript (build + lint)'; app_id = 15368 },
       @{ context = 'Merge gate (task check)'; app_id = 15368 }) } |
     ConvertTo-Json -Depth 4 -Compress |
     gh api -X PATCH repos/<owner>/<repo>/branches/<branch>/protection/required_status_checks --input -
   ```
   `app_id` 15368 is GitHub Actions. If the required checks live in a ruleset instead of classic protection, set `strict_required_status_checks_policy: false` on that rule.
3. A ruleset with the merge queue rule:
   ```powershell
   @{ name = 'Merge queue on <branch>'; target = 'branch'; enforcement = 'active'
      conditions = @{ ref_name = @{ include = @('refs/heads/<branch>'); exclude = @() } }
      bypass_actors = @(@{ actor_id = 5; actor_type = 'RepositoryRole'; bypass_mode = 'always' })
      rules = @(@{ type = 'merge_queue'; parameters = @{
        merge_method = 'SQUASH'; grouping_strategy = 'ALLGREEN'
        max_entries_to_build = 3; min_entries_to_merge = 1; max_entries_to_merge = 3
        min_entries_to_merge_wait_minutes = 0; check_response_timeout_minutes = 60 } }) } |
     ConvertTo-Json -Depth 6 -Compress |
     gh api -X POST repos/<owner>/<repo>/rulesets --input -
   ```
   - ! The ruleset must target the same branch as step 2. For the default branch, `~DEFAULT_BRANCH` also works.
   - `actor_id = 5` is the repository admin role. ! Keep an admin bypass if anything pushes to the branch directly: Directive's `task release` pushes the release commit and tag to the delivery branch.
   - `max_entries_to_build` sets how many group commits CI runs at once. Each costs a full required-check run; 3 is a reasonable start.
   - `ALLGREEN` means every entry in a group must pass.

## Verify

```powershell
gh api repos/<owner>/<repo>/rules/branches/<branch> --jq '[.[].type] | join(",")'
gh api graphql -f query='{repository(owner:"<owner>",name:"<repo>"){mergeQueue(branch:"<branch>"){url configuration{mergeMethod maximumEntriesToBuild}}}}'
```

- ! The first command lists `merge_queue`, and the second returns a non-null `mergeQueue`.
- ! The next PR merged with `task pr:wait-mergeable-and-merge -- <N> --repo <owner>/<repo>` reports `queued` (exit 3) and then `merged` on `--resume`, not a direct merge.

## How agents merge afterwards

- ! Use `task pr:wait-mergeable-and-merge`. In queue mode it checks the head, enqueues with `--match-head-commit`, and returns one result: `merged`, `queued`, `awaiting-admission`, `head-changed`, `removed` or `inactive`, each with a `--resume` command.
- On a branch with strict up-to-date checks and no queue, the direct path prints one advisory line naming this playbook. It does not change the result or the exit code (#6366).
- ⊗ Merge with `--admin` to skip the queue, except as a named operator break-glass action.
- ⊗ Run update-branch or rebase loops to keep a PR current; the queue does that.

## Fewer local hook refusals (#6535)

A repository can let five local hook refusals warn instead of refuse, when its merge path already runs the full gate.

**Part A. What the hook checks**

- (a) `plan.policy.mergeGateContext` in `xbrief/PROJECT-DEFINITION.xbrief.json` names one status check, and the same exact name is in GitHub's copy of that file at the head of the delivery branch and in the copy in the worktree you work in (merge the change, then update each worktree).
- (b) That check is required on the delivery branch, by a ruleset or by classic branch protection.
- (c) `origin` is the GitHub repository, the delivery branch resolves, and `gh` with the credentials the hook uses can read the file at the delivery branch, `rules/branches/<branch>` and `branches/<branch>/protection` within ten seconds in total. A 404 on either protection read is fine; any other error on either means no signal.

**Part B. What you make true (the hook does not check it)**

- (d) The named check runs the full merge gate (`deft check`) and runs on `merge_group`.
- (e) The merge queue is on for the delivery branch.
- (f) The review bot is a required check.

When Part A holds, the five warn sites warn and every other refusal stays. When any item of Part A fails, the hook refuses as today. For the site table, the floor and the limits, see [Warn-only sites behind a live merge gate (#6535)](./hook-root-admission.md#warn-only-sites-behind-a-live-merge-gate-6535).

**Worked example**

The policy fragment in `xbrief/PROJECT-DEFINITION.xbrief.json`:

```json
"plan": {
  "policy": {
    "mergeGateContext": "Merge gate (task check)"
  }
}
```

Three reads, as diagnostics. They show that the parts are in place. They do not prove that the hook's read finishes within its budget.

```bash
gh api "repos/<owner>/<repo>/contents/xbrief/PROJECT-DEFINITION.xbrief.json?ref=<branch>"
gh api repos/<owner>/<repo>/rules/branches/<branch>
gh api repos/<owner>/<repo>/branches/<branch>/protection
```

The result, when Part A holds: a product write that only a stale session ritual would refuse is allowed, with a message that starts `Warning:` and carries the ritual refusal text. Any later refusal (occupancy, a protected store, a binding refusal) still wins.

## Roll back

```powershell
$id = gh api repos/<owner>/<repo>/rulesets --jq '.[] | select(.name=="Merge queue on <branch>") | .id'
gh api -X DELETE repos/<owner>/<repo>/rulesets/$id
```

Turn strict mode back on only if you want rebases enforced again. `pr:wait-mergeable-and-merge` returns to the direct path when no `merge_queue` rule is found.

## Known issues

Open on 0.129.11:

- `--resume` reads the PR once and returns at once; it does not wait (#6423). Run it again about every 30 seconds until it reports `merged` or a failure.
- `one-pr-unit-merge-group` failed on every queue run before the fix for #6424 (releases after 0.131.5 carry it). It is not a required check and did not block the merge.
- After each release, master's `Merge gate (task check)` stays red until the pin PR lands (#6296). Queue runs fail in that window, so land the pin PR first.
- On 0.129.11 a PR that conflicts with its base shows its required checks as `absent-required`, not as a conflict (#6467). From the release with #6467 the merge verb reports `base-conflict` instead, with the base branch and the fix: merge or rebase the base branch into the PR branch, push, and run the merge verb again.

## Saving rounds in the queue

Each push after review costs one more review and one more CI run. For agents on 0.129.11 or later:

- ~ Add changelog lines as `changelog.d/` fragments, not `CHANGELOG.md` edits. Fragments do not conflict, so one merge does not put the other PRs behind.
- ~ Run `task scope:complete -- <active-path> --in-pr` in the story's last product PR, so completion needs no separate lifecycle PR (#6277). List the story's spec-drift row file `xbrief/.audit/spec-drift/<scopeId>.json` in `file_scope` before activation, or `verify:scope-provenance` refuses the PR.
- ~ Record a disproved SLizard finding in one `@slizard label` comment (`<fingerprint> fp head <sha> ...`), not with a new push. A free-text reply does not stop it from coming back (#6377).
- ~ Run `swarm:pre-dispatch -- --scope-id <story> --target-id <worktree>` (begin) before you start a worker. It binds the worktree to its story, so the worker's commits are admitted (#6379).

## Reference setup

`deftai/directive` `master`, set 2026-11-16: auto-merge on; required checks `TypeScript (build + lint)` (renamed from `TypeScript (build + lint + test)` under #6586, when the lane stopped running the suite) and `Merge gate (task check)`, strict off; org ruleset requires `Greptile Review`; ruleset "Merge queue on master" as in step 3, targeting `~DEFAULT_BRANCH`.
