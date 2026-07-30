# Intent ceiling — slash-command containment, hotfix classifier, human merge (#1193)

Wave 2 of the layered authorization stack (#2948). Complements human-origin grants (#2944) and runtimeAuthority (#2711 / #1394).

## R1 — Slash-command intent containment

When a session is originated by a slash command, that command is the **only** authorized verb for the session.

| Surface | Behavior |
|---------|----------|
| Env | `DEFT_SESSION_SLASH_VERB` (e.g. `/github-issue`, `/build`) |
| Preflight | `task xbrief:preflight` fails when the verb is non-implement |
| Hooks | PreToolUse denies implement/push/merge for non-implement verbs |
| Pure API | `evaluateIntentCeiling({ sessionVerb, requestedOp })` in `@deftai/directive-core/policy` |

**Implement verbs:** `/build`, `/ship`, `/ship-hotfix`, `/swarm`, `/implement` (plus free-text #810 action verbs when no slash provenance).

**Non-implement (contained):** `/github-issue`, `/triage`, `/refine`, `/discuss`, `/research`, and unknown stems (fail closed for lifecycle escalation).

## R2 — Hotfix classifier

Typed `plan.policy.hotfixCriteria` (`maxLines` default 10, `maxFiles` default 2, `forbiddenPathGlobs`).

Pure `evaluateHotfixEligibility(input)`:

- **Eligible → propose `hotfix-candidate` only** (agent never promotes to `hotfix`)
- Pure revert always qualifies
- Small fix within limits, restores green, no new deps/exports/schema
- **Never:** refactor, new handler/route, export surface change, forbidden paths (Dockerfile, fly.toml, `.github/workflows/**`, migrations, auth/secrets)

## R3 — Human merge gate

Typed `plan.policy.requireHumanMerge` (default **true** when `autoDeployOnMerge` is true).

| Surface | Behavior |
|---------|----------|
| Merge preflight | `task pr:wait-mergeable-and-merge` refuses agent merge when ON |
| `verify:branch` | Advisory note when ON |
| Branch protection | Setup docs: ≥1 human reviewer when ON |
| Session-start | Disclosure: `[deft policy] Human merge gate is ON …` |

**Override:** `task policy:allow-bot-merge -- --confirm` (capability-cost disclosure + audit log) or `DEFT_ALLOW_BOT_MERGE=1`.

Inspect: `task policy:show --field=requireHumanMerge` / `--field=hotfixCriteria`.
