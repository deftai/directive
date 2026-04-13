# Greptile Integration

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [deft-review-cycle skill](../skills/deft-review-cycle/SKILL.md) | [Greptile docs](https://greptile.com/docs)

**Scope:** Configuring the Greptile AI code review bot for use with deft projects.

## Overview

Greptile reviews pull requests with full codebase context. When used with deft, it integrates with the `deft-review-cycle` skill to enable automated review/fix loops.

## Recommended Dashboard Settings (org-wide)

! Configure these in the [Greptile dashboard](https://app.greptile.com/review/github) as organization defaults — they apply to all repos and avoid per-repo duplication.

### Review Triggers

- ! `triggerOnUpdates` ("Automatically trigger on new commits") → **on** — re-reviews on every push so the review-cycle loop can reach its exit condition
- ? `triggerOnDrafts` ("Review draft pull requests") → on if you want early feedback on draft PRs

### Status

- ! `statusCheck` ("Create a status check for each PR") → **on** — posts a `"Greptile Review"` check run that org rulesets can require
- ~ `statusCommentsEnabled` ("Enable status comments") → **on**

### Comments

- ~ `strictness` → **2** (balanced) — 1 is verbose, 3 is critical-only
- ~ `commentTypes` → **Syntax, Logic** enabled, **Style** disabled — deft has its own style conventions via RFC 2119 rules
- ~ `fixWithAI` ("Fix with AI Prompt") → **on** — helps agents understand suggested fixes

### PR Summary

- ! Confidence Score → **on** — the review-cycle skill uses this for its exit condition (must be >3)
- ~ PR Summary → **on**
- ~ Issues Table → **on**
- ? Diagram → optional (adds visual but increases review size)
- ~ Comments Outside Diff → **on** — the review-cycle skill fetches these explicitly

### Author Exclusions

- ~ Exclude `dependabot[bot]` and `renovate[bot]` — avoids noisy reviews on automated PRs

## Per-Repo Configuration (optional)

Dashboard settings cover most needs. Per-repo `.greptile/` folders are only needed for repo-specific overrides.

### When to use `.greptile/`

- ? `config.json` — override org defaults for a specific repo (e.g. different strictness for a high-risk service)
- ~ `rules.md` — repo-specific review rules in prose (additive with org rules). SHOULD be present in every repo to give Greptile project-specific context.
- ? `files.json` — point Greptile at repo-specific context docs (architecture docs, API specs, schemas)

### Starter `.greptile/rules.md` Template

~ Every repo using Greptile SHOULD include a `.greptile/rules.md` with at least the following sections. Adapt the content to your project.

```markdown
# Review Rules

## Project Context
- This project uses [brief tech stack description].
- Primary language(s): [languages].

## Conventions
- Commit messages follow Conventional Commits: type(scope): description.
- All files use UTF-8 without BOM.
- RFC2119 enforcement markers (!, ~, ⊗) are used for rules.

## Review Focus
- Flag any TODO/FIXME/HACK comments in new code.
- Verify error handling is present (no silent failures).
- Check that new public APIs have documentation.

## Ignore
- Do not flag style issues in generated files.
- Do not flag line length in markdown files.
```

### Configuration hierarchy (highest → lowest precedence)

1. Org enforced rules (dashboard — cannot be overridden)
2. `.greptile/` folder (per-repo, recommended format)
3. `greptile.json` in repo root (legacy format, still supported)
4. Dashboard settings (org defaults)

~ Use `.greptile/` over `greptile.json` — it supports cascading, per-directory overrides, structured rules with severity, and `rules.md` prose.

⊗ Duplicate behavioral settings (`triggerOnUpdates`, `statusCheck`, etc.) in per-repo configs when they match the org defaults — maintain them in one place.

## Check Runs vs. Commit Statuses

! Greptile posts **check runs** (GitHub Checks API), not **commit statuses** (Statuses API). This distinction matters when verifying or debugging the integration.

To verify Greptile posted a check run on a commit:

```
gh api repos/<owner>/<repo>/commits/<sha>/check-runs --jq '.check_runs[] | select(.name == "Greptile Review")'
```

⊗ Use `commits/<sha>/statuses` to look for Greptile — that endpoint will always be empty for Greptile.

The check run name is `"Greptile Review"` — this must match the context name in any org ruleset or branch protection rule that requires it.

## Troubleshooting

### Greptile reviews PRs but no check run appears

1. Verify `statusCheck` is enabled in the dashboard
2. Verify the repo is in the Enabled list on the Repositories tab
3. Check the GitHub App permissions — needs R/W for `checks` and `commit statuses`
4. Use the Checks API (not Statuses API) to verify: `gh api repos/<owner>/<repo>/commits/<sha>/check-runs`
5. If all settings are correct and check runs still don't appear, contact Greptile support — this may be a repo-specific issue on their end

### Greptile doesn't re-review after pushing fixes

1. Verify `triggerOnUpdates` is enabled in the dashboard
2. Re-reviews may have a delay (~3-5 minutes vs. near-instant for initial reviews)
3. As a fallback, comment `@greptileai` on the PR to manually trigger a re-review
4. Greptile edits its existing summary comment in place — check the `Last reviewed commit` field and `updated_at` timestamp

### Review-cycle loop never exits

1. Check the `deft-review-cycle` skill's Pre-Flight Check section
2. Verify `triggerOnUpdates` is enabled — without it, Greptile never produces a follow-up review
3. Verify the confidence score section is enabled in dashboard settings — the exit condition requires confidence >3

## Anti-Patterns

- ⊗ Maintain identical Greptile settings in per-repo configs across multiple repos — use dashboard org defaults
- ⊗ Use `commits/<sha>/statuses` to check for Greptile — use `commits/<sha>/check-runs`
- ⊗ Enter the review-cycle loop without verifying `triggerOnUpdates` is enabled
- ⊗ Assume Greptile re-reviews instantly — allow 3-5 minutes before falling back to `@greptileai`

## References

- Greptile docs: https://greptile.com/docs
- `.greptile/` config reference: https://greptile.com/docs/code-review/greptile-config-reference
- `greptile.json` reference: https://greptile.com/docs/code-review/greptile-json-reference
- PR trigger configuration: https://greptile.com/docs/code-review-bot/trigger-code-review
