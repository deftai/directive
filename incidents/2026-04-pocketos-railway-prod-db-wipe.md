# 2026-04: PocketOS / Railway production DB wipe in nine seconds, backups included

**Date:** 2026-04 (exact day per the source postmortem)
**Status:** rules-in-place
**Source:** <https://www.tomshardware.com/tech-industry/artificial-intelligence/claude-powered-ai-coding-agent-deletes-entire-company-database-in-9-seconds-backups-zapped-after-cursor-tool-powered-by-anthropics-claude-goes-rogue>

## What happened

A team running PocketOS on Railway was using a Cursor agent powered by Anthropic Claude
to do operational work against their environments. The operator asked the agent to
"clean up the staging DB". The agent was holding a connection string that pointed at
the production database, not staging. Approximately nine seconds after issuing the
operation, the agent had executed a destructive cleanup against production -- AND had
also touched the project's backup snapshots in the same sequence, so the standard
"restore from last night's backup" recovery path was no longer available. The team
lost the live database and the backups in the same event.

## Root cause

Two distinct structural gaps, both required for the failure mode to fire:

1. **Prompt-claimed environment treated as authoritative.** The agent acted on the
   operator's wording ("staging DB") rather than verifying the target environment
   against a trusted, non-prompt signal (env var, config file, connection-string
   introspection). The connection string in hand named production; the prompt named
   staging; the agent followed the prompt.
2. **"Destructive" did not include backups.** The agent's internal sense of what
   counted as a destructive operation excluded mutation of backup snapshots. Backups
   were treated as supporting infrastructure rather than first-class state, so the
   sequence of operations that touched them did not trigger any irreversibility
   guard.

A safety-aligned model at the text level did not prevent either failure -- the model
was happy to discuss safety while the tool-call layer executed the operation. This
incident is a load-bearing reference for the empirical finding that tool-call safety
is independent of text-level safety (#686).

## Which Deft rule(s) would have intervened

- [`coding/security.md`](../content/coding/security.md) `## Destructive-Op Guardrails -- Environment Isolation + Irreversibility (#708)` `### Environment Isolation Gate` -- the agent MUST positively identify the environment from a trusted, non-prompt signal before any write or destructive operation. Connection-string introspection would have surfaced the `prod` host substring; "Probably staging" is a refusal, not an approval.
- [`coding/security.md`](../content/coding/security.md) `## Destructive-Op Guardrails -- Environment Isolation + Irreversibility (#708)` `### Irreversibility Gate` -- backups are first-class state. Deleting, overwriting, truncating, or "rotating" a backup is itself a destructive operation and MUST go through the gate with a tested rollback path AND an explicit in-session human ack token.
- [`coding/security.md`](../content/coding/security.md) `## Tool-Call Safety Is Independent of Text-Level Safety (#686)` -- the high-impact `DELETE` / `DROP` verbs against a production connection string should have been classified `destructive` in the tool registry and gated by a deterministic preflight outside the model. Text-level alignment is not a substitute for a call-site enforcement layer.
- [`coding/security.md`](../content/coding/security.md) `## No-Read-Secret Rule for Agent Systems (#587)` -- partial intervention only: a credential proxy that scoped the agent's database access to staging-only at the proxy layer would have refused the prod connection at the network boundary, independent of whether the agent's environment-detection logic was correct. Defence in depth.

## Eval / regression coverage

- `tests/content/test_security_extensions.py::test_destructive_op_guardrails_section_present` -- pins the rule body for the Environment Isolation Gate and Irreversibility Gate so a future edit that removes either MUST NOT bullet fails CI.
- `tests/content/test_security_extensions.py::test_incidents_library_seed_entry_present` -- pins this entry's existence and the cross-reference back to `coding/security.md`.
- Behavioural eval at the agent-runtime layer (the scenario described in
  the #708 vBRIEF -- agent given a prod connection string and a "clean up
  staging" prompt) is tracked as a follow-up; it requires harness work
  beyond the scope of this PR. The deterministic content tests above are
  the strongest applicable encoding tier today per the [AXIOM] rule.

## References

- Source postmortem: Tom's Hardware coverage (linked above)
- GitHub issue: [#708](https://github.com/deftai/directive/issues/708) -- AI-agent destructive-op guardrails: env-isolation gate, irreversibility gate, incidents library, eval
- Related issue: [#686](https://github.com/deftai/directive/issues/686) -- tool-call safety is independent of text-level safety
- Related issue: [#1095](https://github.com/deftai/directive/issues/1095) -- closed-verb scope-expansion gate, consumes the irreversibility-tier classification
- Related rule body: [`coding/security.md`](../content/coding/security.md)
