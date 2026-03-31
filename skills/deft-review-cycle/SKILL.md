---
name: deft-review-cycle
description: >
  Greptile bot reviewer response workflow. Use when running a review cycle
  on a PR — to audit process prerequisites, fetch bot findings, fix all
  issues in a single batch commit, and exit cleanly when no P1/P2 issues
  remain. Enables cloud agents to run autonomous PR review cycles.
---

# Deft Review Cycle

Structured workflow for responding to bot reviewer (Greptile) findings on a PR.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## When to Use

- User says "review cycle", "check reviews", or "run review cycle" on a PR
- A bot reviewer (Greptile) has posted findings on an open PR
- Dispatching a cloud agent to monitor and resolve PR review findings

## Phase 1 — Deft Process Audit

! Before touching code, verify ALL prerequisites are satisfied. Fix any gaps first:

1. ! `SPECIFICATION.md` has task coverage for all changes in the PR
2. ! `CHANGELOG.md` has entries under `[Unreleased]` for the PR's changes
3. ! `task check` passes fully (fmt + lint + typecheck + tests + coverage ≥85%)
4. ! `.github/PULL_REQUEST_TEMPLATE.md` checklist is satisfied in the PR description

⊗ Proceed to Phase 2 while any prerequisite is unmet.

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
- Categorize by severity (P1, P2, P3, style)
- Plan a single coherent batch of fixes

⊗ Start fixing individual findings as you encounter them.

### Step 3: Fix all findings in ONE batch commit

! Apply ALL fixes across all files before committing:

- ! For any fix that touches a value, term, or field appearing in multiple files: grep for it across the full PR file set and update every occurrence in the same commit
- ! Validate structured data files locally before committing (e.g. `python3 -m json.tool` for JSON, YAML lint for YAML) — do not rely on the bot to catch syntax errors
- ! Run `task check` before committing
- ~ Commit message: `fix: address Greptile review findings (batch)`

⊗ Push individual fix commits per finding — always batch.

### Step 4: Push and wait

! Push the batch commit, then wait for the bot to review the latest commit.

! Confirm the review is current by comparing the "Last reviewed commit" hash at the bottom of the Greptile comment to the pushed commit SHA. Fetch the full untruncated comment body or use MCP `get_comments` to get the actual commit URL containing the full SHA — do NOT rely on grepping truncated link text.

⊗ Re-fetch or re-trigger while the bot's last review still targets an older commit.

### Step 5: Re-fetch and analyze

! Fetch the new review using both methods from Step 1.

! Analyze all new findings before planning any changes.

### Step 6: Exit condition check

! Exit the loop and report to the user when ALL of these are true:

- No P1 or P2 issues remain
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
- ⊗ Proceed to Phase 2 while any Phase 1 prerequisite is unmet
