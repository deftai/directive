# Prompt assembly layer ordering (#836)

Architectural standard for agents that issue multi-turn LLM API calls
(OpenAI, Anthropic, Cohere, local models, etc.). It pins the contract
between the **cached system prefix** (assembled once at session start,
stable for the session) and the **ephemeral per-turn injections**
(rebuilt on every API call, never cached). Mixing these two layers
collapses prefix-cache effectiveness and silently multiplies token
cost by the number of turns.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**Load when:** the project assembles a system prompt from more than one
fragment, or relies on provider-side prompt caching (Anthropic prompt
caching, OpenAI cache hits via stable prefix, vLLM/Anthropic-compatible
local model caches, etc.), or operates an agent across more than one
user turn per session.

**Source material:** NousResearch Hermes agent architecture
(`prompt-assembly.md`); the same separation is documented by every
major provider's prompt-caching guidance. The rule below codifies it
as a deft-side standard so agents built with directive inherit the
discipline by default.

**⚠️ See also**:
- [./llm-app.md](./llm-app.md) -- LLM application standards (#481); the **Prompt construction** and **Trust tiers** sections of that file are the foundational rules this pattern extends. The trust-tier contract is orthogonal to the cache-tier contract -- a fragment can be system-trust and still be ephemeral (e.g. a per-turn safety overlay), and a fragment can be cached and still be lower-trust (e.g. a frozen RAG snippet); both axes MUST be tracked separately
- [../context/context.md](../context/context.md) -- the **Write** and **Compress** strategies operationalise the same insight (externalise stable content; reduce per-turn re-injection)

## The invariant

> If it changes per-turn, it is ephemeral. If it is stable for the
> session, it is cached.

- ! MUST classify every fragment that enters the prompt as either *cached prefix* or *ephemeral injection* at construction time -- a fragment that cannot be classified is ambiguous and ambiguity is itself a defect (the same posture `patterns/llm-app.md` `## Trust tiers` takes on tier classification)
- ⊗ MUST NOT place a fragment whose content varies per-turn into the cached prefix -- one variable byte invalidates the entire suffix of the cache and forces a cache miss on every turn, multiplying token cost by `N_turns`
- ⊗ MUST NOT place a fragment that is stable for the session into the ephemeral injection layer -- this re-pays the token cost on every turn for content the provider would otherwise serve from cache
- ! MUST surface the layer classification alongside the fragment in the assembled prompt log so a future reviewer can audit which fragments lived in which layer (see `## Observability` below)

## Cached prefix -- assembled once at session start

The cached prefix is the prompt's stable, session-scoped opening. It is
constructed exactly once per session, hashed, and sent verbatim on every
turn so the provider can serve cache hits against the prefix.

Canonical content for the cached prefix:

1. **Agent identity** -- persona / SOUL.md / system role declaration
2. **Tool-aware behaviour guidance** -- tool catalogue, calling conventions, refusal rules
3. **Frozen memory snapshot** -- the session-start memory excerpt (see #832); MUST NOT be edited mid-session
4. **Skills index** -- the discoverable skills surface (file names, one-line descriptions)
5. **Context files** -- AGENTS.md, project configuration, repository conventions
6. **Session timestamp** -- the single timestamp recorded at session start (NOT per-turn)

- ! MUST assemble the cached prefix exactly once at session start; every subsequent API call sends the byte-identical prefix
- ! MUST hash the assembled prefix and log the hash with the session start event so cache-miss debugging is grounded in a verifiable artefact
- ⊗ MUST NOT mutate the cached prefix mid-session -- a mutation invalidates the cache for every remaining turn in the session
- ⊗ MUST NOT inject per-turn metadata (current task, current timestamp, current user message echo, current tool call result) into the cached prefix -- these are ephemeral by definition
- ~ SHOULD treat the cached prefix as code: version-controlled, code-reviewed, and re-rendered into a queryable log line on every session-start so prefix drift between deploys is visible

### Why ordering within the cached prefix matters

Provider prefix caches are *byte-prefix* caches: the cache hit length is
the longest byte-identical prefix of the current request against the
cached entry. A byte that differs at position `k` invalidates the cache
for every byte from `k` onward. Therefore, within the cached prefix,
**fragments that change least frequently MUST come earliest**.

Canonical ordering, most-stable to least-stable:

```text
1. Agent identity              <- changes least (frozen until next deploy)
2. Tool-aware behaviour guidance
3. Frozen memory snapshot      <- changes only between sessions (#832)
4. Skills index                <- changes when skills are added/removed
5. Context files               <- changes per-project
6. Session timestamp           <- changes per-session (last in cached layer)
```

- ! MUST order cached-prefix fragments most-stable-first so the cacheable byte-prefix is maximised across deploys, sessions, and projects
- ⊗ MUST NOT place a per-session fragment (e.g. session timestamp) ahead of a per-project fragment (e.g. AGENTS.md) -- the per-session change would invalidate everything below it on every new session
- ⊗ MUST NOT place a per-project fragment ahead of a per-deploy fragment (e.g. agent identity) -- the same inversion penalty applies across the deploy axis
- ~ SHOULD measure cache hit rate per turn and per session as part of the LLM-specific observability surface (see `patterns/llm-app.md` `## LLM-specific observability`); a falling cache hit rate is the canonical drift signal that ordering or layering has regressed

## Ephemeral injection -- rebuilt on every API call

The ephemeral layer is everything the model needs *for this turn* that
the model did not need on prior turns. It is injected as part of the
per-turn user message (or as a turn-scoped system addendum where the
provider supports it) and is never cached.

Canonical content for the ephemeral layer:

- **Current-turn context overlays** -- task-scoped instructions, role overlays (see #816), per-turn safety reminders
- **Gateway-derived session context** -- request id, user id, locale, feature flags surfaced for this turn
- **Later-turn memory recall** -- memory snippets surfaced *after* session start (the frozen-snapshot rule from #832 forbids editing the cached prefix's memory; recalls go here)
- **Prefill messages** -- assistant-side prefills used to steer the next decode
- **Current user input** -- the user's turn, wrapped in the trust-tier envelope from `patterns/llm-app.md` `## Prompt construction`
- **Tool results from prior turns** -- `<tool_result>...</tool_result>` blocks injected as observations for the next decode

- ! MUST rebuild the ephemeral layer on every API call from authoritative per-turn state -- never reuse a stale serialisation across turns
- ! MUST inject later-turn memory recall into the **user message** (not the system prompt) -- writing recall into the system prompt forces a cache miss AND violates the frozen-snapshot rule from #832
- ⊗ MUST NOT splice ephemeral content into the cached prefix at construction time as an optimisation -- the optimisation reverses on the second turn and gets strictly worse from there
- ⊗ MUST NOT carry ephemeral fragments forward as cached state across turns -- a per-turn task instruction that becomes part of the prefix locks the agent into that instruction for the rest of the session
- ~ SHOULD wrap ephemeral fragments in explicit delimiters (`<turn_context>`, `<recall>`, `<tool_result>`) so the model can be instructed to treat them as turn-scoped rather than session-scoped

## Why this matters for directive

Directive-built agents typically assemble their system prompt from
multiple sources (AGENTS.md, USER.md, project-definition narratives,
skill bodies, vBRIEF excerpts, memory snippets). Without an explicit
layering contract:

- Agent-written context-file content gets mixed into system-prompt fragments, fragmenting cache hits
- Memory updates land in the system prompt mid-session, invalidating every cached byte after the insertion point
- Per-turn metadata (timestamps, current task name, current vBRIEF being worked) gets templated into the system prompt instead of the user message
- Token cost scales `O(N_turns × prompt_size)` instead of `O(prompt_size + N_turns × delta)` -- a 10x cost regression at 10 turns/session, 100x at 100

This pattern is the structural fix. The frozen-memory-snapshot rule
(#832) is the load-bearing consequence: memory that lives in the cached
prefix MUST be frozen at session start; subsequent recall happens in
the ephemeral layer.

## Observability

The cache-tier classification is invisible to standard request/response
tracing -- a cache miss looks like a normal request, just slower and
more expensive. The LLM-specific observability surface
(`patterns/llm-app.md` `## LLM-specific observability`) is the canonical
home for cache-tier telemetry; this pattern adds the cache-specific
fields.

- ! MUST log the cached-prefix hash on every session-start event so prefix drift between deploys, projects, or sessions is detectable post-hoc
- ! MUST log cache hit rate per turn (provider-reported where available; derived from token counts otherwise) so layering regressions surface as a falling metric, not as a silent cost increase
- ~ SHOULD log per-fragment layer classification (cached vs ephemeral) at construction time so post-hoc audits can see exactly which fragments lived in which layer
- ~ SHOULD alert on a sustained cache hit rate drop -- a cache hit rate that falls without a deploy is the canonical signal that an ephemeral fragment leaked into the cached prefix
- ⊗ MUST NOT log raw prompt bodies into general application logs (the `patterns/llm-app.md` audit-log-separation rule applies equally to cached-prefix bodies; the hash is queryable, the body lives in the audit log)

## Anti-patterns

- ⊗ Re-rendering the cached prefix on every API call (the canonical cache-miss footgun -- the prefix is supposed to be byte-identical across turns)
- ⊗ Injecting current timestamp, current task, or current user message echo into the cached prefix (per-turn variability in a session-scoped layer)
- ⊗ Editing the frozen memory snapshot mid-session (the #832 frozen-snapshot rule has the same root cause; this pattern names it)
- ⊗ Placing per-session fragments (session timestamp) ahead of per-deploy fragments (agent identity) in the cached prefix (ordering inversion that invalidates the deploy axis)
- ⊗ Storing ephemeral per-turn role overlays (#816) into the cached system prompt instead of the user message
- ⊗ Treating prompt caching as a provider-side optimisation the application can ignore (it is a first-class application-side contract; the application controls every byte that determines the cache hit length)
- ⊗ Reporting "the prompt fits the context window" as the success metric (the success metric is `cache_hit_rate × N_turns`, not `prompt_length < context_limit`)

## Cross-references

- `patterns/llm-app.md` -- the parent LLM application standards (#481); this file extends `## Prompt construction` and the `## LLM-specific observability` audit-log requirements with the cache-tier contract
- `context/context.md` -- the **Write** strategy externalises ephemeral state to scratchpad files; the **Compress** strategy reduces per-turn token cost; both are operationalised here for the LLM-call boundary
- #832 -- frozen-memory-snapshot rule (the load-bearing consequence of this pattern; memory in the cached prefix MUST be frozen at session start)
- #816 -- role-as-overlay (roles are ephemeral, not cached; they live in the per-turn injection layer)
- #788 -- token cost as design constraint (the parent framing this pattern enforces at the prompt-assembly layer)
