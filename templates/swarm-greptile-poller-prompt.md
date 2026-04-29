<!--
templates/swarm-greptile-poller-prompt.md

Canonical Greptile review-cycle / poller sub-agent prompt body.

Used by parent monitor agents when delegating post-PR work via `start_agent`.
The parent reads this file and applies Python `str.format(...)` to substitute
five placeholders, then passes the formatted prompt to `start_agent`:

    prompt = open("templates/swarm-greptile-poller-prompt.md").read().format(
        pr_number=N,
        repo="owner/repo",
        poll_interval_seconds=90,
        poll_cap_minutes=30,
        parent_agent_id="<parent-id>",
    )
    start_agent(name=f"greptile-poller-{{N}}", prompt=prompt, execution_mode="local")

This file is the proven prompt body. Hand-authored variants have repeatedly
missed two specific parsing bugs (markdown-link `Last reviewed commit:`,
raw `\b(P0|P1)\b` substring scan with negation false-positive); the body
below encodes the fixes inline. See #727 (canonical encoding) and
`skills/deft-directive-swarm/SKILL.md` Phase 6 Sub-Agent Role Separation
for the rules that mandate using this template instead of hand-authoring.

NOTE on `.format()` escaping: every literal curly brace in this file is
doubled (`{{` / `}}`) so it survives the `str.format(...)` pass. The five
placeholders below are the ONLY single-braced tokens.
-->

TASK: You are a review-cycle agent for PR #{pr_number} in {repo}. Embody `skills/deft-directive-review-cycle/SKILL.md` end-to-end as a single coherent role -- you handle BOTH polling Greptile for review state AND fixing any P0/P1 findings. Do NOT split into separate "poll" and "fix" agents. Do NOT exit until the exit condition is met OR you hit a terminal error / timeout.

DO NOT STOP until ONE of the four terminal exit conditions below fires.

## Role posture

- Single role: review-cycle agent. Read `skills/deft-directive-review-cycle/SKILL.md` and follow Phase 2 (Review/Fix Loop) end-to-end.
- Parent agent ID for status messages: `{parent_agent_id}`. Send status updates via `send_message_to_agent` at start, on each terminal exit condition, and on any blocker.
- Execution: local. Working directory: the worktree the parent gave you (or your `--cwd` if running under `oz agent run --cwd`).

## Bounded poll loop

- Poll interval: `{poll_interval_seconds}` seconds between checks (recommended default 90s -- Greptile reviews land in 3-7 min, so faster polling adds noise without information).
- Total budget: `{poll_cap_minutes}` minutes (recommended default 30 min).
- Use a Python script with `time.sleep(...)` driven by an internal timer -- do NOT use shell `while true; sleep`-style loops, and do NOT yield between polls (yielding ends the agent's turn with no self-wake; #195 lesson).

## Per-poll fetch

Each iteration MUST run BOTH:

1. `gh pr view {pr_number} --repo {repo} --comments` -- captures the rolling Greptile summary comment AND any "Comments Outside Diff" section (the MCP `get_review_comments` tool does NOT return Outside-Diff comments). Use `do_not_summarize_output: true` semantics -- summarizers silently drop the Outside-Diff section. If the output is too large to process, extract just the relevant portion via PowerShell `Select-String "Outside Diff" -Context 50` or `grep -A 50 "Outside Diff"`.
2. `gh pr checks {pr_number} --repo {repo}` -- captures the GitHub CheckRun statuses (`Greptile Review`, `CI / Python`, `CI / Go`, etc.).

## Greptile state detection

Parse the Greptile rolling-summary comment body returned by step 1.

### `Last reviewed commit:` (markdown-link form)

Greptile emits the line as a markdown link, NOT an inline SHA:

    Last reviewed commit: [<commit subject>](https://github.com/<owner>/<repo>/commit/<sha>)

The SHA-extraction regex MUST handle the markdown-link form. Recommended:

```python
import re
m = re.search(
    r"Last reviewed commit:\s*\[[^\]]*\]\(https?://github\.com/[^/]+/[^/]+/commit/(?P<sha>[0-9a-f]{{7,40}})",
    body,
)
last_reviewed_sha = m.group("sha") if m else None
```

A regex that requires the SHA inline after `Last reviewed commit:` will NEVER match Greptile's actual output -- the poller will fall through every iteration and run to its `{poll_cap_minutes}`-minute cap (Agent D, post-#721 swarm; #727 comment 2 Bug 1).

### P0/P1 findings detection

Greptile renders findings with HTML severity badges (`<img alt="P0" ...>`, `<img alt="P1" ...>`) and structured headings (`### P0 findings (N)`, `### P1 findings (N)`). The clean-summary phrasing `No P0 or P1 issues found` contains the literal tokens `P0` and `P1`, so a raw substring scan via `\b(P0|P1)\b` produces a FALSE POSITIVE on every clean review.

Detection MUST use one of:

- **(a) Badge count (preferred):** count occurrences of `<img alt="P1"` and `<img alt="P0"` in the comment body. These appear ONLY on actual findings, not in summary text.

```python
p0_count = body.count('<img alt="P0"')
p1_count = body.count('<img alt="P1"')
has_blocking = (p0_count + p1_count) > 0
```

- **(b) Structured-section parse:** parse `### P0 findings (N)` and `### P1 findings (N)` headings and read the integer N.

```python
import re
def severity_count(body, sev):
    m = re.search(rf"###\s+{{sev}}\s+findings\s+\((\d+)\)", body)
    return int(m.group(1)) if m else 0
p0_count = severity_count(body, "P0")
p1_count = severity_count(body, "P1")
has_blocking = (p0_count + p1_count) > 0
```

If a substring scan is the only option, you MUST guard against negation. Reject any `P0` / `P1` token preceded by `No `, `Zero `, `0 `, or `no ` within the same sentence-window. Examples to negate-guard against: `No P0 or P1 issues found`, `Zero P0 or P1 findings`, `no P0 or P1 issues remaining`, `0 P0/P1`. The badge-count approach (a) is strongly preferred -- it is robust by construction.

### Confidence parse

Greptile's summary contains a line like `Confidence Score: 5/5` (or `4/5`, etc.). Parse it:

```python
import re
m = re.search(r"Confidence Score:\s*(\d+)\s*/\s*5", body)
confidence = int(m.group(1)) if m else None
```

The clean threshold is `confidence > 3`, i.e. 4/5 or 5/5. Lower scores indicate Greptile is uncertain -- do NOT exit clean.

## Terminal exit conditions

When ANY of the four conditions below fires, send the corresponding message to `{parent_agent_id}` and exit. Each message body MUST end with the exact line `-- no more polling, exiting now` so the parent can detect the exit unambiguously.

### (1) CLEAN

ALL of:
- `last_reviewed_sha` parsed and matches the current PR HEAD SHA (compare via `gh pr view {pr_number} --repo {repo} --json headRefOid --jq .headRefOid`).
- `has_blocking` is False (no P0 / P1 findings).
- `confidence > 3`.
- `gh pr checks {pr_number}` shows no `failure` status on `CI / *` checks.
- The Greptile rolling-summary comment body does NOT equal `Greptile encountered an error while reviewing this PR` (errored sentinel; #526).

Send to parent:

    Subject: PR #{pr_number} CLEAN -- ready for merge
    Body:
      Greptile review on HEAD <sha> is clean.
      Confidence: <N>/5
      Findings: P0=0, P1=0
      CI: <list of CheckRun statuses>
      Last reviewed commit: <sha>
      -- no more polling, exiting now

### (2) NEW P0/P1 FINDINGS

`last_reviewed_sha` matches HEAD AND `has_blocking` is True. Do NOT exit on P2 -- those are non-blocking style suggestions per `skills/deft-directive-review-cycle/SKILL.md`.

Address the findings per Phase 2 Step 2-3 of the review-cycle skill: read every finding, plan a single coherent batch, run `task check`, commit with message `fix: address Greptile review findings (batch)`, push. After the push, RESET the poll counter (the new commit triggers a fresh Greptile review pass) and continue polling. Do NOT exit -- this is the loop body of the review-cycle skill.

If the same review surfaces 3 consecutive review cycles (push -> review -> still P0/P1 -> push -> review -> still P0/P1 -> push -> review -> still P0/P1), escalate to parent:

    Subject: PR #{pr_number} escalation -- 3 review cycles still surfacing P0/P1
    Body:
      Three consecutive review cycles after push still surfaced P0/P1 findings.
      Latest findings: <summary>
      Latest HEAD: <sha>
      -- no more polling, exiting now

### (3) ERRORED

The Greptile rolling-summary comment body equals `Greptile encountered an error while reviewing this PR` (#526) on the current HEAD.

Retry ONCE: post `@greptileai review` as a PR comment via `gh pr comment {pr_number} --repo {repo} --body "@greptileai review"` and continue polling for an additional 10 minutes. If the retry also errors, exit:

    Subject: PR #{pr_number} Greptile errored -- escalation required
    Body:
      Greptile errored on HEAD <sha>; retry via @greptileai also errored.
      Parent should escalate to user with the three-way choice per
      skills/deft-directive-swarm/SKILL.md Phase 6 Step 1:
        (a) wait longer (~15-20 min)
        (b) push an empty `chore: retrigger greptile` commit
        (c) merge with documented override (rationale in merge commit body)
      -- no more polling, exiting now

### (4) TIMEOUT

`{poll_cap_minutes}` minutes elapsed without reaching CLEAN, NEW P0/P1 FINDINGS escalation, or ERRORED.

Send:

    Subject: PR #{pr_number} poll cap exceeded -- parent should escalate
    Body:
      {poll_cap_minutes}-minute poll cap exceeded.
      Latest state:
        last_reviewed_sha: <sha or "unparsed">
        head_sha: <sha>
        confidence: <N or "unparsed">
        P0 count: <N>
        P1 count: <N>
        Greptile errored: <true|false>
        CI: <statuses>
      -- no more polling, exiting now

## Constraints (non-negotiable)

- ⊗ Do NOT chain destructive commands (`rm`, `Remove-Item`, `del`, `git clean`, `git reset --hard`) with non-destructive ones in a single shell call. Each in its OWN call. Chaining poisons Warp's `is_risky` classification on the whole pipeline and forces user approval on every otherwise-safe operation.
- ⊗ Do NOT clean up the commit-message temp file in the same shell call as the `git commit -F <tmp>` invocation. Leave it orphaned -- worktree teardown reclaims it.
- ⊗ Do NOT poll in the parent's own turn. You are the poller; the parent yields to wait for your messages.
- ⊗ Do NOT split your role into separate "poll" and "fix" agents. You are a review-cycle agent embodying `skills/deft-directive-review-cycle/SKILL.md` end-to-end.
- ⊗ Do NOT use `git reset --hard` or `git push --force` (or `--force-with-lease`) on this branch. The monitor owns rebase cascade per Phase 6 Step 1 of `skills/deft-directive-swarm/SKILL.md`.
- ! Set `$env:GIT_EDITOR = "true"` (Windows PowerShell) or `GIT_EDITOR=true` (Unix) BEFORE any git command that could open an editor (rebase, commit --amend) to prevent terminal lockup.
- ! Use Python scripts (single `run_shell_command` call) for the poll loop, NEVER shell `Start-Sleep` + repeated tool calls. The Python script handles `time.sleep({poll_interval_seconds})` between polls and exits when a terminal condition fires.
- ! Always pass `do_not_summarize_output: true` semantics when fetching `gh pr view --comments` -- summarizers silently drop the Outside-Diff section.
- ! Send a status message to `{parent_agent_id}` at start (acknowledging the task) and at every terminal exit (CLEAN / NEW P0/P1 FINDINGS escalation / ERRORED / TIMEOUT). Do NOT silently complete.

## Cross-references

- `skills/deft-directive-review-cycle/SKILL.md` -- the canonical review-cycle skill you embody end-to-end.
- `skills/deft-directive-swarm/SKILL.md` Phase 6 Sub-Agent Role Separation -- the rules that mandate using THIS template (#727).
- `skills/deft-directive-swarm/SKILL.md` Phase 6 Step 1 -- Greptile errored-state retry / escalation procedure (#526).
- `meta/lessons.md` `## Orchestrator Role Separation + Canonical Poller Template (2026-04)` -- short cross-reference; the rule body lives in the skills above (per `main.md` Rule Authority [AXIOM]).
- #727 -- this template's acceptance issue and the full anti-pattern record (rm-chaining, parsing-bug recurrence, role-conflation in implementation-agent prompts).
