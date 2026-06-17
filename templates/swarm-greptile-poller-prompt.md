<!--
templates/swarm-greptile-poller-prompt.md

Canonical Greptile review-cycle / poller sub-agent prompt body.

Used by parent monitor agents when delegating post-PR work via the platform
dispatch primitive per the parent's Phase 3 runtime capability detection
(`spawn_subagent` for "grok-build" / Grok Build TUI, `start_agent` for
Warp-orchestrated, or equivalent in other environments). See
`skills/deft-directive-swarm/SKILL.md` Phase 3 + #1342 slices 1-3 and the
review-cycle skill's updated Approach 1.

The parent reads this file and applies Python `str.format(...)` to substitute
five placeholders, then passes the formatted prompt via the chosen dispatch
primitive (spawn_subagent, start_agent, etc.):

    from pathlib import Path
    prompt = Path("templates/swarm-greptile-poller-prompt.md").read_text(encoding="utf-8").format(
        pr_number=N,
        repo="owner/repo",
        poll_interval_seconds=90,
        poll_cap_minutes=30,
        parent_agent_id="<parent-id>",
    )
    # Dispatch via the detected primitive (example for start_agent shown;
    # use spawn_subagent + the launch adapter for grok-build per #1342)
    start_agent(name=f"greptile-poller-{{N}}", prompt=prompt, execution_mode="local")

This file is the proven prompt body. Hand-authored variants have repeatedly
missed two specific parsing bugs (markdown-link `Last reviewed commit:`,
raw `\b(P0|P1)\b` substring scan with negation false-positive); the body
below encodes the fixes inline. See #727 (canonical encoding) and
`skills/deft-directive-swarm/SKILL.md` Phase 6 Sub-Agent Role Separation
(#1342 platform adapter unification: the platform adapter dispatches via
`spawn_subagent` on grok-build and `start_agent` on Warp-orchestrated, so
this template is platform-agnostic by construction) for the rules that
mandate using this template instead of hand-authoring.

NOTE on `.format()` escaping: every literal curly brace in this file is
doubled (`{{` / `}}`) so it survives the `str.format(...)` pass. The five
placeholders below are the ONLY single-braced tokens.
-->

TASK: You are a review-cycle agent for PR #{pr_number} in {repo}. Embody `skills/deft-directive-review-cycle/SKILL.md` end-to-end as a single coherent role -- you handle BOTH polling Greptile for review state AND fixing any P0/P1 findings. Do NOT split into separate "poll" and "fix" agents. Do NOT exit until the exit condition is met OR you hit a terminal error / timeout.

DO NOT STOP until ONE of the six terminal exit conditions below fires.

## Role posture

- Single role: review-cycle agent. Read `skills/deft-directive-review-cycle/SKILL.md` and follow Phase 2 (Review/Fix Loop) end-to-end.
- Parent agent ID for status messages: `{parent_agent_id}`. Send status updates via `send_message_to_agent` at start, on each terminal exit condition, and on any blocker.
- Execution: local. Working directory: the worktree the parent gave you (or your `--cwd` if running under `oz agent run --cwd`).

## Bounded poll loop

- Poll interval: `{poll_interval_seconds}` seconds between checks (recommended default 90s -- Greptile reviews land in 3-7 min, so faster polling adds noise without information).
- Total budget: `{poll_cap_minutes}` minutes (recommended default 30 min).
- Use a Python script with `time.sleep(...)` driven by an internal timer -- do NOT use shell `while true; sleep`-style loops, and do NOT yield between polls (yielding ends the agent's turn with no self-wake; #195 lesson).
- **Heartbeat write per iteration (#1365):** every poll iteration MUST also atomically write a heartbeat record to `.deft-scratch/subagent-status/<agent-id>.json` per the contract in `docs/subagent-heartbeat.md`. The record carries `agent_id`, `parent_id` (= `{parent_agent_id}`), `last_heartbeat_at` (ISO-8601 UTC with `Z`), `last_message`, `phase = "polling"` (or `"fixing"` when addressing P0/P1 findings), and `terminal_state = null`. The terminal exit conditions ((1) CLEAN / (2) NEW P0/P1 FINDINGS escalation / (3) ERRORED / (4) TIMEOUT / (5) STALL) MUST also write ONE final heartbeat with `phase = "terminal"` and `terminal_state` set to the canonical exit name BEFORE sending the parent message and exiting. The 90s poll cadence naturally satisfies the 2-3 min cadence floor in `docs/subagent-heartbeat.md`; the per-iteration heartbeat is what lets `scripts/subagent_monitor.py` detect a stalled poller within the threshold instead of waiting on the `{poll_cap_minutes}`-minute cap.

## Per-poll fetch

Each iteration MUST run BOTH:

1. `gh pr view {pr_number} --repo {repo} --comments` -- captures the rolling Greptile summary comment AND any "Comments Outside Diff" section (the MCP `get_review_comments` tool does NOT return Outside-Diff comments). Use `do_not_summarize_output: true` semantics -- summarizers silently drop the Outside-Diff section. If the output is too large to process, extract just the relevant portion via PowerShell `Select-String "Outside Diff" -Context 50` or `grep -A 50 "Outside Diff"`.
2. `gh pr checks {pr_number} --repo {repo}` -- captures the GitHub CheckRun statuses (`Greptile Review`, `CI / Python`, `CI / Go`, etc.).

## Greptile state detection

Parse the Greptile rolling-summary comment body returned by step 1.

### `Last reviewed commit:` (markdown-link form)

Greptile emits the line as a markdown link, NOT an inline SHA:

    Last reviewed commit: [<commit subject>](https://github.com/<owner>/<repo>/commit/<sha>)

The SHA-extraction regex MUST handle the markdown-link form. The link-text group MUST be NON-GREEDY (`.*?`), NOT a `[^\]]*` negated-bracket class: Greptile commit subjects routinely contain escaped brackets in the link text (e.g. `add \[Unreleased\] entry`), and a `[^\]]*` class stops at the FIRST `]` -- which is the escaped `\]` inside the subject, not the real `](` link boundary -- so the regex fails to match and `last_reviewed_sha` falls to `None` (false STALL / TIMEOUT on a clean review; #1326). The non-greedy `.*?` skips intermediate `]` characters and binds to the real `]( ... /commit/<sha>` boundary. Recommended:

```python
import re
m = re.search(
    r"Last reviewed commit:\s*\[.*?\]\(https?://github\.com/[^/]+/[^/]+/commit/(?P<sha>[0-9a-f]{{7,40}})",
    body,
)
last_reviewed_sha = m.group("sha") if m else None
```

A regex that requires the SHA inline after `Last reviewed commit:` will NEVER match Greptile's actual output -- the poller will fall through every iteration and run to its `{poll_cap_minutes}`-minute cap (Agent D, post-#721 swarm; #727 comment 2 Bug 1).

### P0/P1 findings detection (TRIPLE-TIER -- #910)

Greptile renders findings in at least THREE distinct surface forms across review passes on the same PR (recurrence record: v0.25.1 swarm session, 2026-05-04 -- #907 first review, #908 first review, #908 retrigger). A single-tier detector is structurally insufficient. The detector MUST evaluate ALL THREE tiers below and combine them via the final `has_blocking` formula. The clean-summary phrasing `No P0 or P1 issues found` contains the literal tokens `P0` and `P1`, so a raw `\b(P0|P1)\b` substring scan produces a FALSE POSITIVE on every clean review -- the negation-guard rules embedded in Tier 2 / Tier 3 below are non-negotiable.

```python
import re

# --- Code-fence strip BEFORE detection (detector self-reference, #1004) ----
# On PRs that touch the detector ITSELF (this template or its test file),
# Greptile quotes the detector's own tokens (`<img alt="P0"`, `Not safe to
# merge`, `Three P1 findings`, ...) verbatim inside code-fence regions when
# it describes the diff. Those quoted tokens are NOT real findings, but a
# raw scan over the full body counts them and trips a FALSE POSITIVE
# (recurrence record: PR #996 first review, 2026-05-08 -- detector reported
# P0=3/P1=3/tier3=True against an actual 1 P1 + 2 P2 because Greptile quoted
# agent2's own fixtures). Strip triple-backtick fenced blocks AND <code> /
# <pre> HTML regions FIRST so the Tier 1/2/3 scans below only see prose.
# Residual case (documented in `## Implementation Notes`): a REAL finding
# Greptile happens to render inside a fence is dropped -- rare and far less
# costly than the recurring self-reference false-positive.
_CODE_FENCE_RE = re.compile(r"`{{3}}.*?`{{3}}", re.DOTALL)
_HTML_CODE_RE = re.compile(r"<(code|pre)\b[^>]*>.*?</\1>", re.DOTALL | re.IGNORECASE)


def strip_code_fences(text):
    text = _CODE_FENCE_RE.sub(" ", text)
    text = _HTML_CODE_RE.sub(" ", text)
    return text


# All Tier 1/2/3 detection below runs against the fence-stripped body.
body = strip_code_fences(body)

# --- Tier 1: HTML badge count ---------------------------------------------
# Greptile renders per-finding severity badges as `<img alt="P0" ...>` /
# `<img alt="P1" ...>`. These markers appear ONLY on actual findings, never
# in clean-summary prose. Tier 1 is robust by construction but only fires
# when Greptile chose the badge-rendering surface for THIS review pass.
tier1_p0 = body.count('<img alt="P0"')
tier1_p1 = body.count('<img alt="P1"')

# --- Tier 2: markdown-bullet bold scan with negation-context guards -------
# Greptile sometimes renders findings as markdown bullets, e.g.
#     - **P1 -- wrong exception type for state validation in populate()**
#     * **P0: state.json schema mismatch**
# The bold-headed bullet is the structural signal; the leading list marker
# is optional. We scan line-by-line so the negation-context window is the
# physical line, not the whole document (a `No P1 findings` line elsewhere
# in the body MUST NOT cancel a real `**P1 -- ...**` bullet).
_TIER2_RE = re.compile(r"^[\s\-\*]*\*\*P([01])\b[^*]*\*\*", re.MULTILINE)
_TIER2_NEGATIONS = ("No ", "Zero ", "0 ", "no ")

def _line_for(body: str, pos: int) -> str:
    line_start = body.rfind("\n", 0, pos) + 1
    line_end = body.find("\n", pos)
    return body[line_start : line_end if line_end != -1 else len(body)]

tier2_p0 = 0
tier2_p1 = 0
for m in _TIER2_RE.finditer(body):
    line = _line_for(body, m.start())
    if any(neg in line for neg in _TIER2_NEGATIONS):
        continue  # negation context (e.g. `No **P1** findings`) -- skip
    if m.group(1) == "0":
        tier2_p0 += 1
    else:
        tier2_p1 += 1

# --- Tier 2.5: SLizard `### P[01] ·` heading form (#1035) ----------------
# SLizard renders findings as level-3 markdown headings prefixed with the
# severity tag and a separator glyph -- e.g. `### P1 ` followed by middot,
# bullet, hyphenation point, or ASCII hyphen, then the finding title:
#     ### P1 · Inaccurate description claim about ROADMAP.md
#     ### P0 • data-loss risk in cache eviction
# The Tier 2 markdown-bullet bold regex requires `**P[01] ... **` wrapping,
# so SLizard's heading form passes through invisible. Tier 2.5 closes that
# gap WITHOUT renumbering Tiers 1/2/3 (the existing detector citations in
# meta/lessons.md and the swarm-skill anti-patterns key on the 1/2/3 names).
# Recurrence record: PR #1034 (2026-05-11) live SLizard P1 missed by the
# triple-tier detector -- #1035 (this fix).
# Negation-context guard MUST apply the same line-scoped tokens as Tier 2.
_TIER25_RE = re.compile(
    r"^#{{1,6}}\s+P([01])\s*[\u00b7\u2027\u2022\-]\s", re.MULTILINE
)

tier25_p0 = 0
tier25_p1 = 0
for m in _TIER25_RE.finditer(body):
    line = _line_for(body, m.start())
    if any(neg in line for neg in _TIER2_NEGATIONS):
        continue  # negation context -- skip
    if m.group(1) == "0":
        tier25_p0 += 1
    else:
        tier25_p1 += 1

# --- Tier 3: inline-prose sentinels ---------------------------------------
# Greptile sometimes inlines the verdict as plain prose, e.g.
#     Three P1 findings (two from prior review, one new): wrong exception ...
#     Not safe to merge until the mocked-import test defect is resolved.
#     P1 -- wrong exception type for state validation in populate()
# Negation-context guard applies to the count-prose sentinel (`No P0 findings`,
# `Zero P1 findings` MUST NOT trigger). The `Not safe to merge` substring is
# Greptile's explicit human-readable verdict and is treated as a hard block.
_TIER3_COUNT_RE = re.compile(
    r"\b(?:One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|\d+)\s+P[01]\s+findings?\b",
    re.IGNORECASE,
)
_TIER3_LINE_RE = re.compile(r"^\s*P[01]\s+--\s", re.MULTILINE)
_TIER3_NEGATIONS = ("No ", "Zero ", "no ", "NO ")

def _has_tier3_sentinel(body: str) -> bool:
    if "Not safe to merge" in body:
        return True
    for m in _TIER3_COUNT_RE.finditer(body):
        line = _line_for(body, m.start())
        if any(neg in line for neg in _TIER3_NEGATIONS):
            continue
        # Reject a leading `0 ` count to avoid `0 P1 findings` false-positive.
        if re.match(r"\s*0\b", m.group(0)):
            continue
        return True
    for m in _TIER3_LINE_RE.finditer(body):
        line = _line_for(body, m.start())
        if any(neg in line for neg in _TIER3_NEGATIONS):
            continue
        return True
    return False

tier3_sentinel = _has_tier3_sentinel(body)

# --- Combined verdict -----------------------------------------------------
# Use max() per severity so a finding visible in MULTIPLE tiers is not
# double-counted; sum P0+P1 across the union; OR with the Tier 3 sentinel
# (which is severity-agnostic by construction). Tier 2.5 (#1035) joins the
# per-severity max() so SLizard `### P[01] · ...` heading-form findings
# count toward has_blocking regardless of whether Tier 1 or Tier 2 fired.
has_blocking = (
    (
        max(tier1_p0, tier2_p0, tier25_p0)
        + max(tier1_p1, tier2_p1, tier25_p1)
    )
    > 0
    or tier3_sentinel
)
p0_count = max(tier1_p0, tier2_p0, tier25_p0)
p1_count = max(tier1_p1, tier2_p1, tier25_p1)
```

**Optional structured-section fallback:** Greptile occasionally emits `### P0 findings (N)` / `### P1 findings (N)` headings. This surface is rare relative to the three tiers above and is provided as a diagnostic-only readout, NOT as a fourth tier in the `has_blocking` formula:

```python
import re
def severity_count(body, sev):
    m = re.search(rf"###\s+{{sev}}\s+findings\s+\((\d+)\)", body)
    return int(m.group(1)) if m else 0
```

**Anti-patterns:**

- ⊗ A badge-only detector (Tier 1 alone). The recurrence record is three false-negatives in a single swarm session because Greptile rendered findings as markdown bullets / inline prose with zero badges.
- ⊗ A `\b(P0|P1)\b` substring scan WITHOUT negation-context guards. The clean-summary phrase `No P0 or P1 issues found` triggers it on every clean review. The Tier 2 / Tier 3 implementations above embed the guards; do not strip them.
- ⊗ Treating `Not safe to merge` as a Tier 3 maybe-signal. Greptile uses that exact phrase as its explicit human-readable verdict; it is a hard block.

### Confidence parse

Greptile's summary contains a line like `Confidence Score: 5/5` (or `4/5`, etc.). The line is sometimes inline prose and sometimes rendered as a markdown heading (`## Confidence Score: 3/5` -- the rolling-summary header form Greptile uses on PR rolling comments). The inline regex `re.search` does match inline AND most heading forms because it is unanchored, but defence-in-depth requires an explicit heading-form fallback for the case where the heading line carries trailing markup or whitespace that the inline regex declines (#1035 surfacing event: PR #1034 rolling-summary header `## Confidence Score: 3/5` paired with verdict prose `Safe to merge once corrected` produced a missed parse and the poller fell through to TIMEOUT). Parse via the inline-or-line form first; on miss, attempt the strictly-anchored heading-form regex:

```python
import re
m = re.search(r"Confidence Score:\s*(\d+)\s*/\s*5", body)
if m is None:
    # Heading-form fallback (#1035): anchored ^...$ multiline so a stray `0`
    # outside the `/5` slash form cannot trip the gate. `0/5` is a valid
    # score and MUST parse; the slash form requirement is the structural
    # leading-`0` rejection guard.
    m = re.search(
        r"^#{{1,6}}\s*Confidence Score:\s*(\d+)\s*/\s*5\s*$",
        body,
        re.MULTILINE,
    )
confidence = int(m.group(1)) if m else None
```

The clean threshold is `confidence > 3`, i.e. 4/5 or 5/5. Lower scores indicate Greptile is uncertain -- do NOT exit clean.

### Informal-clean missing canonical fields (#1543)

Greptile sometimes posts a separate informal clean reply (`current diff is clean`, `prior issues are now resolved`, `no new issues`, `looks solid`) without the canonical rolling-summary fields `Last reviewed commit:` and `Confidence Score: X/5`. This is NOT "review still writing" and MUST NOT fall through to silent polling or generic `(5) STALL`.

```python
import re

_INFORMAL_CLEAN_SIGNAL_RE = re.compile(
    r"(?:"
    r"diff is clean|"
    r"(?:prior |previously flagged )?issues? (?:are )?now resolved|"
    r"all prior issues resolved|"
    r"no new issues(?: to flag)?|"
    r"looks solid|"
    r"good to proceed"
    r")",
    re.IGNORECASE,
)

def is_informal_clean_missing_canonical_fields(
    body: str,
    last_reviewed_sha,
    confidence,
    has_blocking: bool,
) -> bool:
    if last_reviewed_sha is not None or confidence is not None:
        return False
    if has_blocking:
        return False
    if body.strip().startswith("Greptile encountered an error while reviewing this PR"):
        return False
    return _INFORMAL_CLEAN_SIGNAL_RE.search(body) is not None
```

When `is_informal_clean_missing_canonical_fields(...)` is True on the current poll, exit immediately via `### (6) INFORMAL-CLEAN` below. Do NOT increment `stall_streak` toward `(5) STALL` -- the recovery path is retrigger / canonical evidence / documented override, not more polling.

## CLEAN gate evaluation, `clean_gate_holdout`, and per-poll instrumentation (#1039)

The (1) CLEAN terminal exit is an AND of the six conditions enumerated under `### (1) CLEAN` below. A parse failure in ANY of them (regex doesn't match Greptile's actual rendering / parse silently returns None / a `CI / *` check is `pending` rather than `completed` / the Greptile Review check-run is non-terminal) keeps both `has_blocking = False` AND `is_clean = False` simultaneously, dropping the poller into the fall-through path that polls until the `{poll_cap_minutes}`-minute cap (PR #1038 recurrence, 2026-05-11; #1039). The gate evaluator below names the FIRST failing condition (in (1)/(2)/(3)/(4)/(5)/(6) order) as `clean_gate_holdout` so the per-poll log AND the (4) TIMEOUT / (5) STALL exit messages surface WHICH of the six conditions held the gate -- the operator MUST NEVER have to ask "which condition failed?" (Tier 3 per-condition fail-loud, #1039).

Holdout names map to the six conditions verbatim: condition (1) -> `sha_match`, (2) -> `has_blocking`, (3) -> `confidence`, (4) -> `ci_failures`, (5) -> `errored`, (6) -> `terminal_check_run` (#1259). The function MUST evaluate in this exact order so the holdout names the first failure, not a downstream cascade:

```python
def evaluate_clean_gate(
    last_reviewed_sha,
    head_sha,
    has_blocking,
    confidence,
    ci_failures,
    errored,
    terminal_check_run,
):
    """Return (is_clean, clean_gate_holdout) per the (6)-condition AND gate.

    clean_gate_holdout names the FIRST failing condition (in 1/2/3/4/5/6
    order) or None when all six pass. The order is the operative
    contract -- callers MUST NOT reorder the checks or the holdout will
    name a downstream cascade rather than the root cause (#1039).

    Condition (6) `terminal_check_run` (#1259) fails the gate CLOSED unless
    the `Greptile Review` check-run on the current HEAD is terminal --
    `status == "completed"` AND `conclusion` in `{{success, neutral}}`. A
    non-terminal Greptile conclusion (`queued` / `in_progress` /
    `cancelled` / `timed_out` / `stale` / `action_required` / `failure`)
    is NOT clean even when the rolling summary already parses clean (SHA
    matches HEAD, confidence > 3, no P0/P1). This is the INCOMPLETE_BUT_RATED
    scenario from `skills/deft-directive-review-cycle/SKILL.md` Step 6:
    without (6), all five legacy conditions pass and the poller exits CLEAN
    prematurely. `ci_failures` (condition 4) is scoped to `CI / *` checks
    ONLY -- it does NOT cover the Greptile Review check-run -- so the
    terminal Greptile conclusion is a DISTINCT condition that `ci_failures`
    cannot stand in for. Mirrors the SKILL.md Step 6 fail-closed all-of's
    terminal-check-run field so the swarm-dispatched poller path enforces
    the same gate as the one-shot review-cycle entry.
    """
    if last_reviewed_sha is None or last_reviewed_sha != head_sha:
        return False, "sha_match"
    if has_blocking:
        return False, "has_blocking"
    if confidence is None or confidence <= 3:
        return False, "confidence"
    if ci_failures > 0:
        return False, "ci_failures"
    if errored:
        return False, "errored"
    if not terminal_check_run:
        return False, "terminal_check_run"
    return True, None
```

Each poll iteration MUST emit a Tier 1 diagnostic log line (#1039 AC-1) with the fields below in this exact order so a future operator can grep the poller's transcript for `is_clean=False` and see WHICH of the six conditions was the holdout. The fields appear verbatim in this order -- a future edit MUST NOT reorder, rename, or drop them; the `tests/content/test_swarm_poller_template.py` sync tests pin the field set:

Derive `greptile_terminal` from the `Greptile Review` check-run on the current HEAD (NOT from the `CI / *` checks `ci_failure_count` already covers). The check-run is terminal-clean only when `status == "completed"` AND `conclusion` in `{{success, neutral}}`; any other status (`queued` / `in_progress`) or conclusion (`cancelled` / `timed_out` / `stale` / `action_required` / `failure` / `None`) is non-terminal and MUST fail the gate closed (#1259):

```python
# From `gh api repos/{repo}/commits/<head_sha>/check-runs` (or the parsed
# `gh pr checks {pr_number}` output), find the `Greptile Review` check-run:
greptile_terminal = (
    greptile_run is not None
    and greptile_run.get("status") == "completed"
    and greptile_run.get("conclusion") in ("success", "neutral")
)
```

```python
is_clean, clean_gate_holdout = evaluate_clean_gate(
    last_reviewed_sha=last_reviewed_sha,
    head_sha=head_sha,
    has_blocking=has_blocking,
    confidence=confidence,
    ci_failures=ci_failure_count,
    errored=errored,
    terminal_check_run=greptile_terminal,
)
print(
    f"[poll {{i}}/{{cap}}] last_reviewed_sha={{last_reviewed_sha}} "
    f"head={{head_sha}} sha_match={{last_reviewed_sha == head_sha}} "
    f"confidence={{confidence}} has_blocking={{has_blocking}} "
    f"p0={{p0_count}} p1={{p1_count}} errored={{errored}} "
    f"ci_failures={{ci_failure_count}} is_clean={{is_clean}} "
    f"clean_gate_holdout={{clean_gate_holdout}}"
)
```

Also track a `stall_streak` counter across polls: increment when `has_blocking is False and is_clean is False` (the wedged signature -- no blocking signals detected, no CLEAN exit reachable); reset to 0 on any poll where either `has_blocking` becomes True (drops into (2) NEW P0/P1 FINDINGS) or `is_clean` becomes True (drops into (1) CLEAN). `stall_streak >= 3` is the (5) STALL trip condition below.

## Terminal exit conditions

When ANY of the six conditions below fires, send the corresponding message to `{parent_agent_id}` and exit. Each message body MUST end with the exact line `-- no more polling, exiting now` so the parent can detect the exit unambiguously.

### (1) CLEAN

ALL of:
- `last_reviewed_sha` parsed and matches the current PR HEAD SHA (compare via `gh pr view {pr_number} --repo {repo} --json headRefOid --jq .headRefOid`).
- `has_blocking` is False (no P0 / P1 findings).
- `confidence > 3` (i.e. 4/5 or 5/5 -- a `confidence == 3` parse is NOT clean; the gate names `clean_gate_holdout="confidence"` and you stay in the loop, you do NOT send the CLEAN message).
- `gh pr checks {pr_number}` shows no `failure` status on `CI / *` checks.
- The Greptile rolling-summary comment body does NOT equal `Greptile encountered an error while reviewing this PR` (errored sentinel; #526).
- `terminal_check_run` is True: the `Greptile Review` check-run on the current HEAD is terminal -- `status == "completed"` AND `conclusion` in `{{success, neutral}}` (#1259). A non-terminal Greptile conclusion (`queued` / `in_progress` / `cancelled` / `timed_out` / `stale` / `action_required` / `failure`) is NOT clean even when the rolling summary already parses clean (the INCOMPLETE_BUT_RATED scenario -- rolling summary posted, SHA matches, confidence > 3, no P0/P1, but the check-run has not terminally landed). This is DISTINCT from the `CI / *` `failure` bullet above: `ci_failures` is scoped to `CI / *` checks only and does NOT cover the Greptile Review check-run, so a non-terminal Greptile conclusion would otherwise slip through. The gate names `clean_gate_holdout="terminal_check_run"` and you stay in the loop.

Send to parent:

    Subject: PR #{pr_number} CLEAN -- ready for merge
    Body:
      Greptile review on HEAD <sha> is clean.
      Confidence: <N>/5
      Findings: P0=0, P1=0
      CI: <list of CheckRun statuses>
      Last reviewed commit: <sha>
      -- no more polling, exiting now

**Swarm-orchestrated terminal contract (#1364):** when this poller is dispatched as part of a swarm cohort (parent monitor is running `skills/deft-directive-swarm/SKILL.md` Phase 6), this exact subject line -- `PR #{pr_number} CLEAN -- ready for merge` -- with `confidence > 3` recorded on the **current HEAD** is the ONLY acceptable "review complete" signal the swarm monitor accepts toward the Phase 5 -> 6 merge-gate transition. The five other terminal exits below ((2) NEW P0/P1 FINDINGS escalation, (3) ERRORED, (4) TIMEOUT, (5) STALL, (6) INFORMAL-CLEAN) are NOT "review complete" signals for swarm purposes: each one MUST force either fresh poller re-dispatch on the same PR or explicit user escalation BEFORE the monitor surfaces the Phase 5 -> 6 gate. The monitor enforces this structurally via `task swarm:verify-review-clean` (#1364); see `skills/deft-directive-swarm/SKILL.md` Phase 5 Exit Condition for the cohort verifier mandate. A poller that has terminated lifecycle-clean (i.e. the sub-agent process exited normally) but with `clean_gate_holdout != None` HAS NOT "reported review-clean" for swarm-cycle purposes -- the verifier picks the gap up and the monitor re-dispatches.

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

`{poll_cap_minutes}` minutes elapsed without reaching CLEAN, NEW P0/P1 FINDINGS escalation, ERRORED, or (5) STALL.

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
        clean_gate_holdout: <which-of-the-five-conditions-failed>
      -- no more polling, exiting now

### (5) STALL

`has_blocking` is False (no blocking signals detected) AND `is_clean` is False (CLEAN gate not satisfied) for N consecutive polls (default N=3, ~4.5 min at the recommended 90s interval). This is the bounded fail-loud exit (#1039 AC-2) that surfaces a parse-gap or detector-coverage gap immediately, instead of letting the poller burn its `{poll_cap_minutes}`-minute cap polling stale state (PR #1038, 2026-05-11; the recurrence record). The exit message MUST surface `clean_gate_holdout` so the operator sees WHICH of the six CLEAN-gate conditions blocked progress (#1039 AC-3, extended to the (6) terminal_check_run condition per #1259).

Increment the `stall_streak` counter introduced under `## CLEAN gate evaluation, clean_gate_holdout, and per-poll instrumentation (#1039)` above; reset on any poll where `has_blocking` or `is_clean` flips True. When `stall_streak >= 3`, send:

    Subject: PR #{pr_number} poll loop wedged -- terminal-condition detection failure
    Body:
      Detector cannot reach CLEAN or NEW P0/P1 FINDINGS but no blocking signals
      are visible. Likely terminal-condition detection gap on this PR's review surface.
      Latest state:
        last_reviewed_sha: <sha or "unparsed">
        head_sha: <sha>
        confidence: <N or "unparsed">
        has_blocking: <True|False>
        ci_failures: <N>
        errored: <true|false>
        clean_gate_holdout: <which-of-the-five-conditions-failed>
      Parent should diagnose via Tier 1 instrumentation log.
      -- no more polling, exiting now

### (6) INFORMAL-CLEAN

`is_informal_clean_missing_canonical_fields(...)` is True on the current poll: Greptile posted informal clean prose but omitted BOTH canonical fields `Last reviewed commit:` and `Confidence Score: X/5`. This is the **`informal-clean missing-canonical-fields`** blocked recovery state (#1543). Do NOT keep polling.

Send:

    Subject: PR #{pr_number} informal-clean missing canonical fields -- recovery required
    Body:
      Greptile informal-clean missing-canonical-fields state (#1543).
      Latest Greptile comment says the diff is clean / prior issues resolved,
      but lacks canonical `Last reviewed commit:` and `Confidence Score: X/5`.
      Recovery options:
        (1) comment `@greptileai review` to retrigger a canonical rolling summary
        (2) wait for Greptile to edit its primary summary with both canonical fields
        (3) document an explicit operator override per swarm SKILL Phase 6 Step 1
      Latest state:
        last_reviewed_sha: unparsed
        head_sha: <sha>
        confidence: unparsed
        has_blocking: False
      -- no more polling, exiting now

**Swarm-orchestrated terminal contract (#1543):** like `(3) ERRORED`, `(4) TIMEOUT`, and `(5) STALL`, this exit is NOT a "review complete" signal for `task swarm:verify-review-clean`. The monitor MUST re-dispatch or escalate; do NOT surface the Phase 5 -> 6 merge gate until canonical evidence or a documented override resolves the state.

## Constraints (non-negotiable)

- ⊗ Do NOT chain destructive commands (`rm`, `Remove-Item`, `del`, `git clean`, `git reset --hard`) with non-destructive ones in a single shell call. Each in its OWN call. Chaining poisons Warp's `is_risky` classification on the whole pipeline and forces user approval on every otherwise-safe operation.
- ⊗ Do NOT clean up the commit-message temp file in the same shell call as the `git commit -F <tmp>` invocation. Leave it orphaned -- worktree teardown reclaims it.
- ⊗ Do NOT poll in the parent's own turn. You are the poller; the parent yields to wait for your messages.
- ⊗ Do NOT split your role into separate "poll" and "fix" agents. You are a review-cycle agent embodying `skills/deft-directive-review-cycle/SKILL.md` end-to-end.
- ⊗ Do NOT use `git reset --hard` or `git push --force` (or `--force-with-lease`) on this branch. The monitor owns rebase cascade per Phase 6 Step 1 of `skills/deft-directive-swarm/SKILL.md`.
- ! Set `$env:GIT_EDITOR = "true"` (Windows PowerShell) or `GIT_EDITOR=true` (Unix) BEFORE any git command that could open an editor (rebase, commit --amend) to prevent terminal lockup.
- ! Use Python scripts (single `run_shell_command` call) for the poll loop, NEVER shell `Start-Sleep` + repeated tool calls. The Python script handles `time.sleep({poll_interval_seconds})` between polls and exits when a terminal condition fires.
- ! Always pass `do_not_summarize_output: true` semantics when fetching `gh pr view --comments` -- summarizers silently drop the Outside-Diff section.
- ! Send a status message to `{parent_agent_id}` at start (acknowledging the task) and at every terminal exit (CLEAN / NEW P0/P1 FINDINGS escalation / ERRORED / TIMEOUT / STALL). Do NOT silently complete.

## Implementation Notes

Dogfood lessons captured during the #727 self-review cycle. The template body above already prescribes the correct behaviour; these notes record the specific micro-bugs prior poller scripts hit so future implementations can avoid them.

- **Do NOT window-slice the Greptile body before searching for `Confidence Score:` or `Last reviewed commit:`.** Greptile places the confidence header near the TOP of its summary, while the `Last reviewed commit:` anchor is near the BOTTOM (typically ~5KB lower in real PRs). A naive optimization like `body[idx-200:idx+4000]` around the SHA anchor will silently miss the confidence score. Always run `re.search(...)` against the FULL `gh pr view --comments` output. (Captured during the #727 dogfood self-review where this exact micro-optimization caused the prior agent's poll script to miss the confidence parse; the template's prescribed full-body search is correct.)
- **`Last reviewed commit:` regex is markdown-link aware AND non-greedy.** The recommended pattern is `r"Last reviewed commit:\s*\[.*?\]\(https?://github\.com/[^/]+/[^/]+/commit/(?P<sha>[0-9a-f]{{7,40}})"`. The naive inline-SHA form (`r"Last reviewed commit:\s*([0-9a-f]{{7,40}})"`) does NOT match Greptile's actual output -- Greptile emits `Last reviewed commit: [<subject>](<url>/commit/<sha>)` -- and is the bug Agent D's poll script hit (see #727 followup comments). The link-text group MUST be the non-greedy `.*?`, NOT a `[^\]]*` negated-bracket class: a commit subject containing escaped brackets (e.g. `add \[Unreleased\] entry`) makes `[^\]]*` stop at the first escaped `\]` rather than the real `](` boundary, so the regex fails to match and `last_reviewed_sha` falls to `None` -- a false STALL / TIMEOUT on an otherwise-clean review (#1326).
- **P0/P1 detection uses the triple-tier detector at `### P0/P1 findings detection` above (#910), extended with Tier 2.5 SLizard heading form (#1035).** The detector body in this template is the authoritative implementation -- combine Tier 1 (HTML badge count via `body.count('<img alt="P0"')` / `body.count('<img alt="P1"')`), Tier 2 (markdown-bullet bold scan with line-scoped negation guards), Tier 2.5 (SLizard `### P[01]` heading-form regex `^#{{1,6}}\s+P([01])\s*[\u00b7\u2027\u2022\-]\s` with the SAME line-scoped negation-context guard as Tier 2), and Tier 3 (inline-prose sentinels: `Not safe to merge` substring + count-prose regex + line-anchored `^P[01] -- ` regex) via `has_blocking = (max(tier1_p0, tier2_p0, tier25_p0) + max(tier1_p1, tier2_p1, tier25_p1)) > 0 or tier3_sentinel`. Tier 2.5 is numbered 2.5 (not renumbered as a new Tier 4) so existing detector citations in `meta/lessons.md` and the swarm-skill anti-patterns -- which key on the 1/2/3 names -- stay stable. The single-tier badge-only approach is INSUFFICIENT and was the recurrence cause of three false-negatives in the v0.25.1 swarm session (#907 first review, #908 first review, #908 retrigger); the triple-tier-without-Tier-2.5 detector missed SLizard's `### P1 · ...` heading form on PR #1034 (2026-05-11, #1035). A `\b(P0|P1)\b` raw substring scan false-positives on the clean-summary phrase `No P0 or P1 issues found` and is forbidden -- the Tier 2 / Tier 2.5 / Tier 3 implementations above embed the negation-context guards (`No `, `Zero `, `0 `, lowercase `no `) and MUST be used verbatim.
- **The detector strips code-fence regions before counting, but a residual self-reference false-positive remains (#1004).** On PRs that modify the detector itself (`templates/swarm-greptile-poller-prompt.md` or `tests/content/test_swarm_poller_template.py`), Greptile quotes the detector's own tokens (`<img alt="P0"`, `Not safe to merge`, `Three P1 findings`, ...) verbatim when describing the diff. The `strip_code_fences(body)` pre-process at the top of the `### P0/P1 findings detection` block removes triple-backtick fenced blocks and `<code>` / `<pre>` HTML regions before Tier 1/2/3 detection, so tokens Greptile quotes inside fences no longer count (option 1 from #1004). The RESIDUAL case: if Greptile quotes a detector token in UNFENCED prose (e.g. an inline summary sentence that names `Not safe to merge` while describing the change), or conversely renders a REAL finding inside a fence, the strip cannot disambiguate. When you are reviewing a PR that touches the detector and the poller reports `has_blocking=True`, manually confirm the flagged tokens are genuine findings and not Greptile quoting the detector's own source before escalating. Recurrence record: PR #996 first review (2026-05-08) reported `P0=3/P1=3/tier3=True` against an actual `1 P1 + 2 P2`; a careful poller logged the discrepancy and continued, but a less-careful poller would have looped on findings that do not exist (#1004, #910 follow-up).
- **CLEAN-gate detector failures fail LOUD via (5) STALL, not silent via 30-min TIMEOUT (#1039).** The pre-#1039 poller could not distinguish a parse-gap (regex doesn't match Greptile's actual rendering -> `last_reviewed_sha = None` -> condition (1) False) from "Greptile is still working" (no review posted yet -> same outcome), so the wedged signature kept both `has_blocking = False` AND `is_clean = False` and the poller burned its `{poll_cap_minutes}`-minute cap. The (5) STALL terminal exit above bounds the wedged-signature exit at ~4.5 min (N=3 consecutive polls at the recommended 90s interval) and the `clean_gate_holdout` field in BOTH (4) TIMEOUT and (5) STALL exit messages names the FIRST of the six conditions that blocked the gate -- the operator MUST NEVER have to ask "which condition failed?" Recurrence record: PR #1038 (2026-05-11) poller agent `5794b0e7-...` wedged 30 min on a textbook clean review; maintainer intervened out-of-band; #1039. The INCOMPLETE_BUT_RATED variant -- rolling summary parses clean but the Greptile check-run is non-terminal -- is held by condition (6) `terminal_check_run` and bounded by the same (5) STALL exit (#1259).

## Cross-references

- `skills/deft-directive-review-cycle/SKILL.md` -- the canonical review-cycle skill you embody end-to-end.
- `skills/deft-directive-swarm/SKILL.md` Phase 6 Sub-Agent Role Separation -- the rules that mandate using THIS template (#727).
- `skills/deft-directive-swarm/SKILL.md` Phase 6 Step 1 -- Greptile errored-state retry / escalation procedure (#526).
- `meta/lessons.md` `## Orchestrator Role Separation + Canonical Poller Template (2026-04)` -- short cross-reference; the rule body lives in the skills above (per `main.md` Rule Authority [AXIOM]).
- #727 -- this template's acceptance issue and the full anti-pattern record (rm-chaining, parsing-bug recurrence, role-conflation in implementation-agent prompts).
- #1039 -- (5) STALL terminal exit + Tier 1 instrumentation + Tier 3 per-condition fail-loud (`clean_gate_holdout`); the third recurrence in this template's detector-gap chain after #910 (triple-tier) and #1035 (Tier 2.5 + confidence-heading).
- #1364 -- cohort-level CLEAN verification gate (`task swarm:verify-review-clean`, `scripts/swarm_verify_review_clean.py`). The (1) CLEAN section's swarm-orchestrated terminal contract block declares that only the exact `PR #{pr_number} CLEAN -- ready for merge` subject with `confidence > 3` on current HEAD is an acceptable "review complete" signal for the swarm monitor's Phase 5 -> 6 transition; the cohort verifier picks up any other terminal exit ((2) NEW P0/P1 FINDINGS escalation, (3) ERRORED, (4) TIMEOUT, (5) STALL) and holds the merge gate until fresh poller re-dispatch or explicit user escalation resolves it. Recurrence record: #1166 swarm execution where multiple pollers exited with `clean_gate_holdout=confidence` (confidence == 3) and the monitor still raised the Phase 5 -> 6 gate because the trigger keyed on "all pollers have reported back" rather than "every PR in the cohort is objectively CLEAN".
