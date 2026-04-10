# Context Engineering

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

Strategies for managing the finite attention budget of AI agents.

> Source: Anthropic, ["Effective Context Engineering for AI Agents"](https://www.anthropic.com/research/building-effective-agents)

---

## Core Principle

Context is **finite** with **diminishing returns** — more tokens ≠ better performance. The goal is the **smallest set of high-signal tokens** that enables correct action. Every token competes for attention; low-value tokens actively degrade performance.

---

## Strategy 1: Write

Externalize intermediate state so it doesn't consume context window.

- ~ **Externalize to scratchpad files** — write intermediate reasoning, partial results, and plans to working files rather than holding them in context
- ~ **Use [vBRIEF](https://vbrief.org)** for structured task plans, checkpoints, and scratchpads — token-efficient, graduated complexity, TRON encoding
- ~ Start minimal (tasks + statuses), add narratives and edges only as complexity warrants; see [vbrief/vbrief.md](../vbrief/vbrief.md) for the canonical file taxonomy
- ! **Clean up scratch files when done** — ad-hoc scratchpads are working memory, not artifacts
- ! **Do NOT delete vBRIEF plan/spec files** — `plan.vbrief.json`, `specification.vbrief.json`, and `playbook-*.vbrief.json` are durable; only `continue.vbrief.json` is ephemeral
- ~ **Persist durable learnings** to [meta/lessons.md](../meta/lessons.md) before discarding scratch state
- See [working-memory.md](./working-memory.md) for patterns and the durable/ephemeral boundary

## Strategy 2: Select

Load only what's needed, when it's needed.

- ! **Follow [REFERENCES.md](../REFERENCES.md)** for lazy-loading guidance
- ~ Maintain lightweight references (file paths, line numbers, search queries) rather than full file contents
- ~ Use **targeted retrieval**: `grep`, line ranges, `head`/`tail` — not whole-file reads
- ⊗ **Speculatively loading files** "just in case"
- ? Pre-fetch a file only when the next step certainly requires it

## Strategy 3: Compress

Reduce token count while preserving signal.

- ~ Use **RFC 2119 notation** (`MUST`, `SHOULD`, etc.) for scannable, unambiguous standards
- ~ **Summarize completed work** before moving to the next phase — carry forward decisions, not process
- ~ **Distill key decisions** from growing conversation history rather than re-reading everything
- ~ Prefer **structured data** (tables, lists, JSON) over prose for factual content
- ≉ Carrying full conversation history when a summary suffices

## Strategy 4: Isolate

Split work across agents to keep each context focused.

- ~ **Split independent tasks across agents** — see [swarm/swarm.md](../swarm/swarm.md)
- ~ Keep each agent's context **focused on one concern**
- ~ Use **file-based handoff** (scratchpad files, vBRIEF plans), not shared context
- ≉ Giving a single agent responsibility for unrelated subsystems
- See [long-horizon.md](./long-horizon.md) for multi-session patterns
