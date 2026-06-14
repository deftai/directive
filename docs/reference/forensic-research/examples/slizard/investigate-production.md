---
name: investigate-production
description: Pull SLizard production evidence from fly.io — check runs and persistent logs. Use for "pull production logs", "grep fly logs", "check check run status", "what does the log say". For causal WHY / root-cause questions ("why was review slow", "what caused the failure"), use forensic-research (.grok/skills/forensic-research/) instead — it supersedes this skill's hypothesis steps. Do NOT trigger on local test failures or vitest.
---

# Investigate SLizard Production

**Causal / root-cause questions:** stop — load `.grok/skills/forensic-research/SKILL.md` and follow that workflow. This skill supplies **evidence-gathering steps only** (check run, log grep) inside forensic-research Wave 2.

Evidence gathering for fly.io production. Read-only — do NOT modify source code.

## Critical Rule
**Do not edit any source files during investigation.** Your job is to gather evidence, form a hypothesis, and present it. The user decides whether and how to fix it. Premature code changes during diagnosis waste time and confuse the conversation.

## Step 1: Identify the target
Ask or infer from context:
- Which repo/PR is affected? (e.g. `deftai/statusreport#1`)
- What symptom was reported? (review didn't post, check run failed, wrong findings, crash)

## Step 2: Check the GitHub Check Run first
The check run is the user-visible surface. Start here — it tells you whether the review succeeded, failed, or is stuck.

```
gh api repos/{owner}/{repo}/commits/{branch}/check-runs --jq ".check_runs[] | select(.app.slug == \"deft-slizard\") | {name, status, conclusion, output_title: .output.title, output_summary: .output.summary[:500]}"
```

If the check run shows `conclusion: failure`, the `output_summary` usually contains the phase where it died and the SLizard version. This narrows the search.

## Step 3: Pull persistent logs (not fly logs)
The `fly logs` command only shows a ~2 minute rolling buffer. It is almost never sufficient for investigating a past failure.

Use SSH to read the persistent daily log files on the volume:

```
fly ssh console -a slizard -C "grep 'owner/repo#number' /data/slizard/logs/slizard-YYYY-MM-DD.log"
```

Logs are at `/data/slizard/logs/slizard-YYYY-MM-DD.log`, rotated daily.

If you don't know the exact date, list the files first:
```
fly ssh console -a slizard -C "ls -la /data/slizard/logs/"
```

Then grep across the relevant date range. Use the PR's created/updated dates to narrow which log files to search.

## Step 4: Read the log format
Logs are structured JSON (pino). Key fields:
- `level`: 30=info, 40=warn, 50=error
- `crId`: links to a change request — either an Evolution UUID or `owner/repo#number` for GitHub PRs
- `owner`, `repo`, `number`: GitHub PR coordinates (on webhook-originated entries)
- `msg`: human-readable description of the event

When searching, filter by `crId` to isolate all log entries for one review session.

## Step 5: Trace the active code path (forensic-research only)

**If forensic-research is active:** skip this step until Wave 1 traps pass and branch agents need code-fact citations. Use `references/code-facts.md` — never infer runtime flags from source alone.

**If this skill runs standalone (log pull only):** do not trace code to answer "why". Stop at evidence collection.

When code trace is justified: confirm paths from **log messages on anchor crId**, not from grep volume in `src/`. Production flags (`LLM_AGENTIC_CONTEXT`, `LLM_MULTI_EXTRACT_ENABLED`, etc.) require `fly secrets` or runtime env — see forensic-research `trap.agentic_assumed`.

## Step 6: Check machine health (if needed)
If you suspect a process crash, OOM, or restart:

```
fly status -a slizard
fly machine status {machine_id} -a slizard
```

The machine status shows event history (start/stop/OOM) and the health check output includes uptime and version.

## Step 7: Common failure patterns

**"OpenAI chat failed: 400"** (src/llm/llm-client.ts)
The LLM API rejected the request. Usually means the prompt exceeded the model's context window. Check the diff size — large greenfield PRs with 100+ files are the typical trigger. The two-phase pipeline has no diff truncation ceiling.

**"403 Forbidden ... tier 0 (unknown) is below the minimum required tier 3"**
Evolution API auth/tier mismatch. The org or CR doesn't have the required subscription tier. Non-fatal to the process but the review fails to post.

**"EACCES: permission denied, mkdir 'lessons/non-curated'"**
Relative path bug in the lessons shard cache. Non-fatal — the merged-PR handler catches it and continues. Does not affect reviews.

**"Repo not found in registry" → "Full index fallback failed"**
First-contact repo that hasn't been indexed yet. The full clone fallback retries once. If it fails twice, the review proceeds without codebase context (degraded mode).

**"GitHubReviewHandler: review session threw — marking Check Run failed"**
The review session hit an unhandled error. The preceding log entry (same `crId`, level 50) contains the actual error message. Always read the line before this one.

## Step 8: Present findings

**If forensic-research is active:** synthesizer writes `outcome.md` — do not present root cause here.

**If log-pull only:** present raw evidence (check run summary, relevant log lines with crId). ⊗ Root-cause narrative. ⊗ Config claims without `fly secrets` proof.
