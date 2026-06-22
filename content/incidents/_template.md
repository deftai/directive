# YYYY-MM-DD: <one-line plain-English summary>

**Date:** YYYY-MM-DD
**Status:** <rules-in-place | rules-proposed | no-rule-yet>
**Source:** <https://example.com/canonical-link>

## What happened

One or two paragraphs in the actor's perspective. Name the system, the
operator action, the agent action, and the user-visible outcome. No
editorialising.

## Root cause

The structural gap, not the proximate trigger. "Agent ran a destructive
command" is a proximate trigger; "agent acted on a prompt-claimed
environment without verifying the trusted signal" is the structural gap.

## Which Deft rule(s) would have intervened

- `<coding/path.md>` `## <section heading>` (#<issue>) -- <one-line
  explanation of how the rule blocks the failure mode>
- (add as many bullets as there are intervening rules)

If no rule existed at incident time, name the rule(s) introduced by this
entry and link them.

## Eval / regression coverage

- `tests/content/test_<file>.py::<test_name>` -- pins the rule body
- `tests/cli/test_<file>.py::<test_name>` -- exercises the runtime
  behaviour (if applicable)

## References

- Source postmortem / news article
- Related GitHub issues
- Related incidents (other entries in this directory)
