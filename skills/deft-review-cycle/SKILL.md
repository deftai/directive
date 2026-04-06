---
name: deft-review-cycle
description: >
  Greptile bot reviewer response workflow. Use when running a review cycle
  on a PR — to audit process prerequisites, fetch bot findings, fix all
  issues in a single batch commit, and exit cleanly when no P0 or P1 issues
  remain.
---

# Deft Review Cycle

Structured workflow for responding to bot reviewer (Greptile) findings on a PR.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## When to Use

- User says "review cycle", "check reviews", or "run review cycle" on a PR
- A bot reviewer (Greptile) has posted findings on an open PR
- Dispatching a cloud agent to monitor and resolve PR review findings

## Pre-Flight Check

! Before entering the review/fix loop, verify the Greptile configuration supports it:

1. ! `triggerOnUpdates` must be enabled (via Greptile dashboard or `.greptile/config.json`) — without this, Greptile only reviews the initial PR and never re-reviews after fix pushes, so the loop cannot reach the exit condition
2. ~ `statusCheck` should be enabled so Greptile posts a `"Greptile Review"` check run on each commit — this is the signal the org ruleset uses to gate merges
3. ? If Greptile does not re-review after a push despite `triggerOnUpdates` being enabled, comment `@greptileai` on the PR as a manual re-trigger fallback

! Greptile posts **check runs** (GitHub Checks API), not **commit statuses** (Statuses API). To verify the check run is present on a commit:

```
gh api repos/<owner>/<repo>/commits/<sha>/check-runs --jq '.check_runs[] | select(.name == "Greptile Review")'
```

⊗ Use `commits/<sha>/statuses` to check for Greptile — that endpoint will always be empty.

~ See `tools/greptile.md` for recommended dashboard and per-repo settings.

## Phase 1 — Deft Process Audit

! Before touching code, verify ALL prerequisites are satisfied. Fix any gaps first:

1. ! `SPECIFICATION.md` has task coverage for all changes in the PR
2. ! `CHANGELOG.md` has entries under `[Unreleased]` for the PR's changes
3. ! `task check` passes fully (fmt + lint + typecheck + tests + coverage ≥75%)
4. ! `.github/PULL_REQUEST_TEMPLATE.md` checklist is satisfied in the PR description
5. ! If the PR touches 3+ files: verify a `/deft:change` proposal exists in `history/changes/` for this branch and was explicitly confirmed by the user (affirmative response, not a broad 'proceed'), or document N/A with reason in the PR checklist
6. ! Verify the PR is on a feature branch — work MUST NOT have been committed directly to the default branch (master/main)

! Phase 1 audit gaps must be resolved before merging — but hold the fixes (do NOT commit or push them independently). Proceed to Phase 2 analysis to gather bot findings, then batch all Phase 1 + Phase 2 fixes into a single commit.
⊗ Commit or push Phase 1 audit fixes independently before gathering Phase 2 findings.

## Phase 2 — Review/Fix Loop

### Step 1: Fetch ALL bot comments

! Retrieve findings using BOTH methods — each catches different comment categories:

```
gh pr view <number> --comments
```

! Use `do_not_summarize_output: true` — summarizers silently drop the "Comments Outside Diff" section from large bot comments.

! Also use MCP `get_review_comments` to catch Comments Outside Diff.

⊗ Report "all comments resolved" without verifying both sources.

### Step 2: Analyze ALL findings before changing anything

! Before making any changes:

- Read every finding across all files
- Identify cross-file dependencies (a term, value, or field mentioned in multiple files)
- Categorize by severity (P0, P1, P2 — where P0 is critical/blocking, P1 is a real defect, P2 is a style or non-blocking suggestion)
- Plan a single coherent batch of fixes

⊗ Start fixing individual findings as you encounter them.

### Step 3: Fix all findings in ONE batch commit

! Apply ALL fixes across all files before committing:

- ! For any fix that touches a value, term, or field appearing in multiple files: grep for it across the full PR file set and update every occurrence in the same commit
- ! Validate structured data files locally before committing (e.g. `python3 -m json.tool` for JSON, YAML lint for YAML) — do not rely on the bot to catch syntax errors
- ! Run `task check` before committing
- ~ Commit message: `fix: address Greptile review findings (batch)`

⊗ Push individual fix commits per finding — always batch.

### Step 3b: Proactive test coverage scan

! After committing the fix batch but before pushing, scan the changed lines for untested code paths:

1. ! Run `git --no-pager diff HEAD~1 HEAD --name-only` to identify files touched in the fix batch
2. ! For each changed file that has a corresponding test file, review whether the fix introduced or modified logic that lacks test coverage
3. ! If untested code paths are found, write tests and amend them into the fix batch commit (or add as a second commit in the same push)
4. ! Run `task check` again after adding tests to verify they pass

~ This eliminates one CI round-trip per fix cycle — catching coverage gaps before CI does.

⊗ Push fix commits without scanning for untested code paths in changed files.

### Step 4: Push and wait

! Push the batch commit, then wait for the bot to review the latest commit.

! After pushing, the agent MUST autonomously poll for review updates and continue the review cycle without stopping to ask the user. Do not pause for confirmation, do not ask "should I continue?", do not wait for user input between push and review completion. The review/fix loop is designed to run to the exit condition without human intervention.

⊗ Push any additional commits — including unrelated fixes, doc updates, or lessons — while waiting for the bot to finish reviewing the current head. Every push re-triggers Greptile and resets the review clock. If you discover additional work while waiting, stage it locally but do NOT push until the current review completes.

~ Poll for completion no more than once every 60 seconds. Greptile reviews typically take 3–7 minutes; polling faster than once per minute adds no value and creates noise. Use `Start-Sleep -Seconds 60` (PowerShell) or `time.sleep(60)` (Python) between MCP `get_check_runs` calls. Do not report a delay that did not occur.

! Greptile may advance its review by **editing an existing PR issue comment** rather than creating a new PR review object. Do NOT rely solely on `pulls/{number}/reviews` — that endpoint may remain stale at an older commit SHA even after Greptile has reviewed the latest commit.

! To confirm the review is current, check **both** surfaces:

1. **PR issue comments** (primary signal) — Greptile edits its existing summary comment in place:
   - `gh pr view <number> --comments` (with `do_not_summarize_output: true`)
   - Or `gh api repos/<owner>/<repo>/issues/<number>/comments`
   - Parse the comment body for `Last reviewed commit` and compare to the pushed commit SHA
   - Check the comment's `updated_at` timestamp to confirm it was refreshed after your push
2. **PR review objects** (secondary signal) — may or may not be updated:
   - `gh api repos/<owner>/<repo>/pulls/<number>/reviews`
   - Check `commit_id` on the latest review object

! Treat an edited Greptile issue comment as a valid new review pass even if no new PR review object was created.

! Fetch the full untruncated comment body or use MCP `get_comments` to get the actual commit URL containing the full SHA — do NOT rely on grepping truncated link text.

⊗ Re-fetch or re-trigger while the bot's last review still targets an older commit on **both** surfaces.

### Step 5: Re-fetch and analyze

! Fetch the new review using both methods from Step 1.

! Analyze all new findings before planning any changes.

### Step 6: Exit condition check

! Exit the loop and report to the user when ALL of these are true:

- No P0 or P1 issues remain (P2 issues are non-blocking style suggestions and do not gate the loop)
- Greptile confidence score is greater than 3

? If the bot says "all prior issues resolved" but lists new issues, treat it as one final batch — not the start of another loop. Go back to Step 2 one more time, then stop.

If the exit condition is not met, go back to Step 2.

## Submitting GitHub Reviews

! When submitting PR reviews via the GitHub MCP tool, always use `pull_request_review_write` with method `create` and the appropriate event:

- `APPROVE` — formally approve the PR (shows green "Approved" status)
- `REQUEST_CHANGES` — block the PR with requested changes
- `COMMENT` — review feedback without approving or blocking

⊗ Use `add_issue_comment` for review notes — that creates a regular comment, not a formal review. Review notes must always go in the review body via `pull_request_review_write`.

## GitHub Interface Selection

~ Use the most efficient interface for the task:

- **MCP GitHub tool** — structured/programmatic operations (querying issues, creating PRs, bulk operations, filtering data)
- **GitHub CLI (`gh`)** — quick ad-hoc commands and direct shell integration

Choose whichever minimizes steps and maximizes clarity for the given task.

## Anti-Patterns

- ⊗ Push individual fix commits per finding
- ⊗ Start fixing before analyzing ALL findings
- ⊗ Rely on the bot to catch syntax errors in structured data files
- ⊗ Re-trigger a bot review before the previous one has updated
- ⊗ Report "all comments resolved" without checking both MCP and `gh pr view`
- ⊗ Use `add_issue_comment` for formal review submission
- ⊗ Commit or push Phase 1 audit fixes independently — always batch with Phase 2 fixes
- ⊗ Proceed to Phase 2 while any Phase 1 prerequisite is unmet
- ⊗ Rely solely on `pulls/{number}/reviews` to detect whether Greptile has reviewed the latest commit — Greptile may update via an edited issue comment instead of a new review object
- ⊗ Push additional commits while Greptile is reviewing the current head — each push re-triggers Greptile and resets the review clock
- ⊗ Poll `get_check_runs` more frequently than once per 60 seconds — use a real delay between polls, not back-to-back calls
- ⊗ Stop and ask the user whether to continue after pushing — the review/fix loop MUST run autonomously to the exit condition
- ⊗ Push fix commits without scanning changed lines for untested code paths — always check test coverage before pushing
