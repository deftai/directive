---
name: deft-directive-feedback
description: >-
  Batched session-end gap escalation for directive consumers. Collects
  friction/gap reports, drafts deduped framework-gap issues against
  deftai/directive, and files upstream only after explicit operator
  confirmation. Gated on plan.policy.valueFeedback upstreamPrompt.
---

# Deft Directive Feedback -- gap escalation to upstream

Conversational batched flow for filing framework gaps discovered during consumer sessions. Mirrors the confirmation gate from `deft-directive-article-review` -- the agent drafts and dedups; the operator approves before any upstream issue is created.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## When to Use

- Session end when `friction:*` ledger signals or operator reports a directive shortfall
- Operator says "file this upstream", "report a framework gap", or "directive feedback"
- After enabling `plan.policy.valueFeedback.upstreamPrompt` during onboarding

## Preconditions

- ! Run only from a **consumer project** -- the filing path no-ops inside the directive maintainer repo
- ! `plan.policy.valueFeedback.upstreamPrompt` MUST be ON (`task policy:show --field=valueFeedback`)
- ⊗ File upstream issues without explicit operator confirmation
- ⊗ Invoke when `valueFeedback.enabled` is OFF

## Phase 1 -- Collect (batched)

- ! Gather concrete gap reports from the session: what was expected, what happened, and minimal reproduction context
- ! Batch multiple friction items into one upstream issue when they share a root cause; otherwise prepare separate drafts
- ~ Prefer attributed phrasing ("encoding gate blocked a valid file") over vague quality claims

## Phase 2 -- Draft + dedup

- ! For each candidate report, run a dry draft:

```bash
task feedback:file -- --summary "<one-line summary>" --context "<session context>" --expected "<expected>" --actual "<actual>" --notes "<optional>"
```

- ! Read the printed draft title/body with the operator before proceeding
- ! If the command reports a duplicate open issue, STOP and link the existing issue instead of filing again
- ⊗ Proceed past a duplicate-detection block without operator override

## Phase 3 -- Confirm + file

- ! Present the final draft and ask for explicit yes/no confirmation
- ! Only after approval, re-run with `--confirm`:

```bash
task feedback:file -- --summary "<one-line summary>" --context "<session context>" --expected "<expected>" --actual "<actual>" --confirm
```

- ! Print the filed issue URL to the operator
- ⊗ Use `Closes`/`Fixes`/`Resolves` in the upstream body -- use `Refs #1709` only

## Phase 4 -- Handoff

- ~ Record the upstream issue URL in the session handoff or continue checkpoint if the operator tracks follow-ups locally
- ~ Return to the prior workflow; gap escalation does not block story completion

## Anti-Patterns

- ⊗ Filing from the maintainer framework repo (consumer-only guard)
- ⊗ Skipping dedup review when the command reports an existing open issue
- ⊗ Treating `--confirm` as implicit from broad session approval -- require an explicit filing confirmation step
