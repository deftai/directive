# Role as overlay (#816)

Architectural standard for how persona and role instructions are applied
to LLM calls in directive's skills, agents, and downstream consumers.
Role instructions MUST be implemented as **call-scoped system-prompt
overlays**, never injected into the persisted message history.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**Load when:** the project applies a persona, role, or stance to an LLM
call (skill-defined reviewer / builder / summarizer roles, agent-level
identities, per-call stance overrides) or designs a multi-turn agent
that persists message history across turns.

**Source material:** Flue SDK ([withastro/flue](https://github.com/withastro/flue))
README -- "Role instructions are applied as call-scoped system prompt
overlays, not injected into the persisted user message history."
Precedence: call role > session role > agent role.

**⚠️ See also**:
- [./llm-app.md](./llm-app.md) -- the trust-tier framework this pattern reinforces (the system prompt is the trust boundary; user-tier messages are untrusted)
- [../coding/security.md](../coding/security.md) -- `## Agent-Specific Threats` (prompt-injection isolation, internal-prompt non-exposure -- the security-side framing of the same boundary)
- [./multi-agent.md](./multi-agent.md) -- sub-agent dispatch envelope (the orchestration analogue: per-dispatch role overlay, never aggregated into shared history)

## The principle

When a skill or agent applies a persona to an LLM call ("you are a
security reviewer", "you are a senior engineer", "you are a concise
summarizer"), that instruction is **configuration**, not **content**.
It describes *how* to process the work, not *what* work happened.

- ! MUST apply persona / role instructions as system-prompt overlays at the call boundary -- never as `user` or `assistant` messages in the persisted history
- ! MUST treat the message history as the durable record of *what happened*: user turns, tool calls, tool results, assistant turns. Role instructions are not events; they are dispositions
- ⊗ MUST NOT prepend a `user` message of the form `"You are a security reviewer. ..."` to the conversation array as a way to apply a role -- this is the canonical anti-pattern this rule eliminates
- ⊗ MUST NOT prepend a synthetic `assistant` message of the form `"Understood, I am a security reviewer. ..."` either -- mirrored variant of the same anti-pattern
- ! MUST keep the overlay **ephemeral**: it applies for the duration of the call and disappears; the next call's overlay is computed fresh from the precedence chain
- ~ SHOULD render the effective system prompt (agent base + session overlay + call overlay) into a structured audit-log entry alongside the call, per [`patterns/llm-app.md`](./llm-app.md) `## LLM-specific observability` -- the overlay is a configuration artifact and is traced as one

## Why this matters

The failure mode is concrete and recurrent. An agent that injects role
instructions as messages accumulates them across turns:

```text path=null start=null
# Anti-pattern: role-as-message
messages = [
  {"role": "user", "content": "You are a security reviewer. Review this code."},
  {"role": "user", "content": "<the actual code>"},
  {"role": "assistant", "content": "<the review>"},
  {"role": "user", "content": "You are a security reviewer. Now check the tests."},
  {"role": "user", "content": "<the tests>"},
  ...
]
```

Versus the correct shape:

```text path=null start=null
# Correct: role-as-overlay
system  = "<agent base prompt> + <session role> + <call role: security reviewer>"
messages = [
  {"role": "user", "content": "Review this code."},
  {"role": "user", "content": "<the actual code>"},
  {"role": "assistant", "content": "<the review>"},
  {"role": "user", "content": "Now check the tests."},
  {"role": "user", "content": "<the tests>"},
  ...
]
```

Concrete consequences of the anti-pattern:

- **History pollution.** A resuming agent (or a human reading the
  transcript later) sees spurious `"you are a reviewer"` user turns
  interleaved with real work. The record is no longer a faithful
  description of the conversation -- it conflates *who said what* with
  *how the model was configured*. Forensic review on a faulty output
  cannot distinguish operator intent from runtime configuration.
- **Retrieval corruption.** If the message history feeds a downstream
  retrieval index (chat search, conversation summarization, vBRIEF
  ingestion, RAG re-use of prior turns), the role-injection turns
  become indexable content. A search for "security reviewer" then
  surfaces configuration noise instead of actual reviewer findings.
  This is the persistence-layer analogue of the RAG-poisoning failure
  the [`patterns/llm-app.md`](./llm-app.md) `## RAG and retrieval`
  section warns against.
- **Context rot acceleration.** Role-injection turns count against the
  context window every turn. Long sessions burn token budget on
  repeated `"you are a reviewer"` strings that contribute zero
  information beyond the first occurrence -- and the model's attention
  drifts under the accumulated repetition. This is a known structural
  cause of context degradation (#674).
- **False memory propagation.** When the polluted history is summarized
  or compacted, the summarizer treats role-injection turns as real
  content and may propagate the persona claim into the summary
  ("the user repeatedly emphasized that the model is a security
  reviewer"). The persona then enters a parallel persistence channel
  with no provenance back to the actual configuration source. This is
  the structural origin of #479 (false memory propagation in vBRIEF
  trust levels).
- **Resumption breakage.** A session resumed from polluted history
  re-applies the historical role-injection turns AND the fresh
  overlay, doubling the role assertion. Subtle behavioral drift
  follows: the model sees two `"you are a reviewer"` signals with
  potentially different framings and resolves the conflict
  unpredictably.

The overlay shape avoids all five failure modes by construction. The
history records work; the overlay records configuration; the two never
mix.

## Precedence

When multiple roles apply, resolve them in this order, highest to
lowest:

```text path=null start=null
call role        <- HIGHEST (per-invocation override, the most specific intent)
  |
session role     <- session-scoped default (e.g. "this whole review pass is a security audit")
  |
agent role       <- LOWEST (the agent's baseline identity, e.g. "you are a Deft Directive skill executor")
```

- ! MUST resolve role precedence call > session > agent at every LLM call. Lower-tier roles are defaults; higher-tier roles override without modifying the lower-tier's record
- ! MUST compose the effective system prompt as `agent_base + session_overlay + call_overlay`, in that exact order, so the call overlay is the last instruction the model reads
- ⊗ MUST NOT mutate the agent or session role from a call-level overlay -- the call overlay is ephemeral by definition; persisting it changes the precedence semantics into a "last call wins" model that is silently history-dependent
- ⊗ MUST NOT silently drop a higher-tier overlay because a lower-tier role disagrees -- the higher-tier value is authoritative; surface the conflict in the audit log if useful for debugging
- ~ SHOULD log the resolved precedence chain alongside each call: `(agent="deft-build", session=null, call="security-reviewer") -> effective="security-reviewer"`. This makes the overlay's effect on a given call queryable post-hoc

## Implementation contract for skills and agents

Directive's skills implicitly carry roles -- `deft-directive-review-cycle`
is a reviewer, `deft-directive-build` is a builder, `deft-directive-pre-pr`
is a quality-checker. Each skill's role MUST be applied as an overlay
when the skill dispatches an LLM call (or instructs a sub-agent to do
so), never as an injected message turn.

- ! Skills that apply a role to an LLM call MUST surface the role as a system-prompt overlay parameter (or the equivalent provider-supported field) at the call boundary
- ! Skills that dispatch sub-agents MUST pass the role through the dispatch envelope as a configuration field (e.g. `role: "security-reviewer"`), not as a prepended user message in the sub-agent's seed history
- ⊗ Skills MUST NOT generate role-injection prose into the work product (PR body, commit message, scope vBRIEF narrative, lessons.md entry) -- the role is internal configuration, not output content
- ! When a sub-agent receives a role via the dispatch envelope, it MUST treat the role as authoritative call-scoped configuration; it MUST NOT persist the role string into its own conversation history as a synthetic user turn
- ~ Skill authors SHOULD document the skill's default role (agent-tier) in the SKILL.md frontmatter or a dedicated `## Role` section so consumers can override it consciously at session or call tier
- ? Skills MAY accept a `--role` override at invocation time; if accepted, the override resolves at call tier per the precedence chain above

### Provider mapping

| Provider                  | System overlay surface                                                                |
|---------------------------|---------------------------------------------------------------------------------------|
| Anthropic Messages API    | `system` parameter on the request (string or content-block array)                     |
| OpenAI Chat Completions   | `messages[0]` with `role: "system"` -- one entry, never duplicated across the array   |
| OpenAI Responses API      | `instructions` parameter on the request                                               |
| Google Gemini             | `system_instruction` field on the request                                             |
| Local / open-source LLMs  | The provider-specific system prompt slot in the request schema                        |

- ! MUST use the provider's native system-prompt surface for the overlay -- do not fall back to a user-tier message because the provider's system surface "is harder to template"; the surface IS the trust boundary
- ⊗ MUST NOT emit more than one system-role entry in providers that expect a single system slot (e.g. OpenAI Chat Completions) -- compose the overlay into a single string before the call
- ~ When the provider supports structured system content (Anthropic content-block array), SHOULD render `agent_base` / `session_overlay` / `call_overlay` as separate blocks so the audit log can split them; the resulting effective prompt is still call-scoped and ephemeral

## Anti-patterns

- ⊗ Prepending a `user` turn `"You are a <role>. <task>"` instead of using the system overlay surface -- the canonical anti-pattern this rule eliminates
- ⊗ Prepending a synthetic `assistant` turn `"Understood, I am a <role>."` to acknowledge the role -- mirrored variant of the same anti-pattern
- ⊗ Embedding role instructions in the first real user turn (`"As a security reviewer, please review the following: ..."`) -- still pollutes the history; the model and any downstream consumer see the role as user-tier content
- ⊗ Persisting the call-tier overlay back into the agent or session role -- collapses the precedence chain into silent history-dependent behavior
- ⊗ Aggregating role instructions across turns ("you are a reviewer", "you are also concise", "you are also formal") via repeated user-turn injection -- compose the overlay at call time instead, so the model sees one coherent role specification per call
- ⊗ Leaking the overlay into the work product (PR body / commit message / scope vBRIEF narrative) -- the role is internal configuration; the work product describes outcomes, not the model's stance
- ⊗ Treating a sub-agent's seed history as a place to "configure its persona" -- pass the role through the dispatch envelope as configuration and let the sub-agent apply it as its own call-tier overlay

## Cross-references

- #674 -- context rot (role-injection-as-messages is a documented structural contributor)
- #479 -- false memory propagation (the persistence-layer analogue of role pollution when polluted history is summarized)
- #808 -- share state, isolate cognition (the orchestration cousin of this rule)
- #662 -- context degradation recovery
- [`patterns/llm-app.md`](./llm-app.md) `## Prompt construction` and `## Trust tiers` -- the system prompt is the trust boundary this overlay parameter writes to; user-tier messages are explicitly untrusted, so role-as-user-message inverts the trust contract
- [`coding/security.md`](../coding/security.md) `## Agent-Specific Threats` -- prompt-injection isolation and the rule against exposing internal system prompts to untrusted surfaces (the security-side framing of the same boundary)
- [`patterns/multi-agent.md`](./multi-agent.md) -- multi-agent dispatch envelope; role overlays travel as dispatch-time configuration, not as injected history
- Flue SDK README -- source attribution for the call > session > agent precedence model
