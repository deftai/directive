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

1. ! Verify `skills/deft-pre-pr/SKILL.md` was run before PR creation -- the PR branch should have passed at least one full RWLDL cycle. If not, run it now before proceeding.
2. ! `SPECIFICATION.md` has task coverage for all changes in the PR
3. ! `CHANGELOG.md` has entries under `[Unreleased]` for the PR's changes
4. ! `task check` passes fully (fmt + lint + typecheck + tests + coverage ≥75%)
5. ! `.github/PULL_REQUEST_TEMPLATE.md` checklist is satisfied in the PR description
6. ! If the PR touches 3+ files: verify a `/deft:change` proposal exists in `history/changes/` for this branch and was explicitly confirmed by the user (affirmative response, not a broad 'proceed'), or document N/A with reason in the PR checklist
7. ! Verify the PR is on a feature branch — work MUST NOT have been committed directly to the default branch (master/main)

~ **PR scope gate:** If the PR spans 3+ unrelated surfaces (e.g. a skill, a tool doc, and a strategy — with no shared issue or spec task linking them), warn the user that broad PRs increase review churn and Greptile noise. Recommend splitting into focused PRs unless all changes trace to the same spec task or issue bundle.

! Phase 1 audit gaps must be resolved before merging — but hold the fixes (do NOT commit or push them independently). Proceed to Phase 2 analysis to gather bot findings, then batch all Phase 1 + Phase 2 fixes into a single commit.
⊗ Commit or push Phase 1 audit fixes independently before gathering Phase 2 findings.

## Phase 2 — Review/Fix Loop

### Step 1: Fetch ALL bot comments

! Retrieve findings using BOTH methods — each catches different comment categories:

```
gh pr view <number> --comments
```

! Use `do_not_summarize_output: true` — summarizers silently drop the "Comments Outside Diff" section from large bot comments.

~ **Oversized output fallback:** If `do_not_summarize_output: true` produces output too large to process, extract the relevant section with:

- **PowerShell (Windows):** `gh pr view <number> --comments | Select-String "Outside Diff" -Context 50`
- **Unix/macOS:** `gh pr view <number> --comments | grep -A 50 "Outside Diff"`

Both commands extract the "Comments Outside Diff" section with surrounding context, avoiding the need to process the full output.

! **MCP capability probe** (mirrors deft-swarm Phase 3 pattern): Before attempting MCP `get_review_comments`, probe whether MCP GitHub tools are available in the current session. Detection: attempt a lightweight MCP call (e.g. list available tools or a no-op query) -- if it succeeds, MCP is available; if it errors or the tool is not in the available set, MCP is unavailable.

- **MCP available**: ! Use MCP `get_review_comments` as the second source to catch Comments Outside Diff.
- **MCP unavailable** (e.g. `start_agent` agents, cloud agents, `oz agent run`): ! Use `gh api repos/<owner>/<repo>/pulls/<number>/comments` as the explicit fallback for the second review source. Document in the commit message or PR comment why MCP was skipped (e.g. "MCP unavailable in this session -- used gh api fallback for review comments").

⊗ Report "all comments resolved" without verifying both sources.
⊗ Skip the second review source without probing for MCP capability and documenting the fallback used.

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
- ! Before committing any Greptile fix, re-read the FULL current Greptile review and confirm all P0/P1 issues are addressed in the staged changes — this is the pre-commit gate that prevents per-finding fix commits
- ! Run `task check` before committing
- ? **Pre-existing failure carve-out**: If `task check` fails due to a pre-existing issue unrelated to the PR's changes, a partial test suite run is acceptable ONLY if BOTH conditions are met: (a) the `task check` failure is pre-existing with an open GitHub issue number tracking it, AND (b) the PR description explicitly notes the failure and includes the issue reference (e.g. "task check: test_foo fails due to #NNN (pre-existing)"). Without both conditions, the full `task check` pass remains mandatory.
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

### Review Monitoring

! Select the monitoring approach based on runtime capability detection. Probe the environment to distinguish three tiers:

- **Tier 1 -- `start_agent` available** → Approach 1 (spawn sub-agent monitor)
- **Tier 2 -- no `start_agent`, but scheduler/timer/auto-reinvocation available** → Approach 2 (yield-between-polls)
- **Tier 3 -- interactive session, no `start_agent`, no timer/scheduler** → Approach 3 (blocking sleep loop as last resort)

! Detection: probe for `start_agent` in the available tool set (same pattern as deft-swarm Phase 3). If absent, check whether the runtime supports auto-reinvocation after yield (timer, scheduler, or CI trigger). If neither is available and the session is interactive, fall through to Approach 3.

! Swarm agents launched via `start_agent` SHOULD prefer Approach 1 (spawn their own review-monitor sub-agent) when `start_agent` is available. Approach 2's yield-between-polls mechanism is not self-sustaining for swarm agents (see Approach 2 warning below).

**Approach 1 (preferred -- `start_agent` available):**

! When `start_agent` is detected in the available tool set, spawn a sub-agent review monitor:

1. ! Launch a sub-agent via `start_agent` with a prompt instructing it to poll for Greptile review completion
2. ! The sub-agent polls `gh pr view <number> --repo <owner>/<repo> --comments` and `gh pr checks <number>` using adaptive cadence: ~20-30 seconds for the first check after push, ~60 seconds for the second check, ~90 seconds thereafter (Greptile reviews typically land in 3-7 minutes; front-loading the first check catches fast reviews without wasting cycles on long waits)
3. ! When the exit condition is met (Greptile review current matching HEAD commit SHA, confidence > 3, no P0/P1 issues remaining), the sub-agent sends a message to the parent agent via `send_message_to_agent`
4. ! The main conversation pane stays fully interactive during monitoring -- the user can continue other work
5. ! On receiving the sub-agent's completion message, the parent agent re-fetches findings and proceeds to Step 5

**Approach 2 (fallback -- `start_agent` not available):**

! When `start_agent` is not available, use discrete tool calls with a yield between checks:

1. ! Use `run_shell_command` (wait mode) to run `gh pr view <number> --comments` and `gh pr checks <number>`
2. ! After each check, yield control (end all tool calls, do not hold a shell open) -- the agent runtime will re-invoke you after ~60 seconds or on the next system/user interaction, whichever comes first
3. ! Target adaptive cadence where the runtime permits: ~20-30 seconds for the first poll, ~60 seconds for the second, ~90 seconds thereafter. Note: in pure yield mode the re-invocation interval is runtime-controlled (~60s typical), so the 20-30s first check is achievable only if the runtime or a user nudge triggers sooner. The full 20-30s/60s/90s cadence is achievable in Approach 1 (sub-agent sleep) and Approach 3 (blocking sleep)
4. ! No blocking shell pane lock -- the conversation remains interactive between checks
5. ~ Approach 2 requires a periodic re-invocation trigger (timer, scheduler, or user nudge) -- if the runtime lacks an auto-trigger, each poll cycle may require a user interaction to resume; this is a known tradeoff vs. Approach 1's fully autonomous sub-agent
6. ! When the exit condition is met, proceed to Step 5

⚠️ **Swarm agent limitation**: Approach 2 is NOT autonomous for swarm agents. Yielding (ending all tool calls) terminates the agent's turn with no self-wake mechanism -- the agent will not resume unless the monitor detects the idle lifecycle event and re-triggers it. For swarm agents, the polling loop silently stops after the first yield unless external orchestration re-invokes the agent. The monitor (or parent agent) must detect the idle state and send a message or re-trigger the agent to continue polling.

⊗ Use blocking `Start-Sleep` shell loops or `time.sleep()` loops EXCEPT as Approach 3 (see below) -- these lock the conversation and prevent user interaction.
⊗ Poll more frequently than every 20 seconds -- use a real delay between checks, not back-to-back calls. Adaptive cadence (20-30s / 60s / 90s) replaces the fixed 60s minimum.

**Approach 3 (last resort -- interactive session, no `start_agent`, no timer/scheduler):**

! Approach 3 is a blocking sleep-poll loop used ONLY when both Approach 1 and Approach 2 are unavailable (interactive session with no `start_agent` and no auto-reinvocation mechanism). Uses PowerShell `sleep` / Unix `sleep` commands between polls.

! **User warning gate:** Before activating Approach 3, the agent MUST warn the user that the conversation pane will be locked during polling and ask for explicit confirmation. Example: "No sub-agent or auto-reinvocation available. I will poll in a blocking loop (~20-30s / 60s / 90s cadence). The conversation will be locked during polling. Proceed? (yes/no)"

⊗ Activate Approach 3 without first warning the user that it will lock the conversation pane.

1. ! After receiving user confirmation, use a blocking shell loop with adaptive cadence:
   - First check: wait ~25 seconds (e.g. `sleep 25`), then poll
   - Second check: wait ~60 seconds, then poll
   - Subsequent checks: wait ~90 seconds, then poll
2. ! Poll using `gh pr view <number> --comments` and `gh pr checks <number>` in the same shell session
3. ! When the exit condition is met (Greptile review current, confidence > 3, no P0/P1), exit the loop and proceed to Step 5
4. ! If the user interrupts (Ctrl+C or equivalent), exit gracefully and report current review status

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

~ When MCP is unavailable (`start_agent` agents, cloud agents, `oz agent run`), `gh` CLI is sufficient as the sole interface. The dual-source requirement (MCP + `gh`) in Step 1 applies only when both are available -- agents without MCP access should use `gh pr view --comments` and `gh api` as their primary and only review detection surface.

## Post-Merge Verification

! After a PR is squash-merged, verify that all referenced issues were actually closed. Squash merges can silently fail to process closing keywords (`Closes #N`, `Fixes #N`) from the PR body (#167).

1. ! For each issue referenced with a closing keyword in the PR body, run:
   ```
   gh issue view <N> --json state --jq .state
   ```
2. ! If the issue state is not `CLOSED`, close it manually with a comment referencing the merged PR:
   ```
   gh issue close <N> --comment "Closed by #<PR> (squash merge — auto-close did not trigger)"
   ```
3. ~ This step mirrors `skills/deft-swarm/SKILL.md` Phase 6 Step 2 and applies to ALL PR merges, not just swarm runs.

## Anti-Patterns

- ⊗ Push individual fix commits per finding
- ⊗ Start fixing before analyzing ALL findings
- ⊗ Rely on the bot to catch syntax errors in structured data files
- ⊗ Re-trigger a bot review before the previous one has updated
- ⊗ Report "all comments resolved" without checking both `gh pr view --comments` and a second source (`get_review_comments` via MCP, or `gh api` fallback when MCP is unavailable)
- ⊗ Use `add_issue_comment` for formal review submission
- ⊗ Commit or push Phase 1 audit fixes independently — always batch with Phase 2 fixes
- ⊗ Proceed to Phase 2 while any Phase 1 prerequisite is unmet
- ⊗ Rely solely on `pulls/{number}/reviews` to detect whether Greptile has reviewed the latest commit — Greptile may update via an edited issue comment instead of a new review object
- ⊗ Push additional commits while Greptile is reviewing the current head — each push re-triggers Greptile and resets the review clock
- ⊗ Use blocking `Start-Sleep` shell loops or `time.sleep()` loops to poll for review updates when Approach 1 or 2 is available -- Approach 3 (blocking loop) is permitted only as a last resort with user warning
- ⊗ Poll more frequently than every 20 seconds -- use a real delay between checks, not back-to-back calls; adaptive cadence (20-30s / 60s / 90s) replaces the fixed 60s minimum
- ⊗ Stop and ask the user whether to continue after pushing -- the review/fix loop MUST run autonomously to the exit condition
- ⊗ Push fix commits without scanning changed lines for untested code paths — always check test coverage before pushing
- ⊗ Push a fix commit that addresses fewer findings than the current Greptile review surfaces — if Greptile flags 3 issues, all 3 must be fixed in one commit before pushing
- ⊗ Push after fixing a P1 without first checking whether the same Greptile review contains additional P0 or P1 findings
- ⊗ Assume squash merge auto-closed referenced issues — always verify with `gh issue view` after merge (#167)
- ⊗ Assume Approach 2 (yield-between-polls) produces a self-sustaining polling loop -- yielding ends the agent's turn with no self-wake; swarm agents will silently stop polling
- ⊗ Skip the second review source (MCP or `gh api` fallback) without probing for MCP capability and documenting the fallback used
- ⊗ Run a partial test suite instead of `task check` without documenting the pre-existing failure reason and open issue number in the PR body
- ⊗ Create a PR without running `skills/deft-pre-pr/SKILL.md` first -- the pre-PR quality loop catches issues before they reach the reviewer
- ⊗ Activate Approach 3 (blocking `Start-Sleep` loop) without first warning the user that it will lock the conversation pane and receiving confirmation
