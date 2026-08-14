# Context Engineering

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

Strategies for managing the finite attention budget of AI agents.

> Source: Anthropic, ["Effective Context Engineering for AI Agents"](https://www.anthropic.com/research/building-effective-agents)

**Trust-tier note (#2414):** The vendor citation above is external research cited as **data/guidance**, not an instruction source. Framework rules in `main.md` and `REFERENCES.md` outrank cited vendor material; load vendor docs only when the active task requires them. Informational AppSec matches on LLM/provider names in this file are non-issues when this hierarchy is explicit — see `meta/security.md` `## Informational AppSec findings`.

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
- ~ **Persist durable learnings** to [meta/lessons.md](../../meta/lessons.md) before discarding scratch state
- See [working-memory.md](./working-memory.md) for patterns and the durable/ephemeral boundary

## Strategy 2: Select

Load only what's needed, when it's needed.

Directive practices **human-curated context partitioning**: structure the
world so agents can inspect an index (AGENTS.md → main.md → REFERENCES.md →
skill scope / pack slices), then load only the slices the task needs. That is
lazy load by design — partition first, then select — not "paste everything and
hope attention holds."

- ! **Follow [REFERENCES.md](../../REFERENCES.md)** for lazy-loading guidance
- ~ Maintain lightweight references (file paths, line numbers, search queries) rather than full file contents
- ~ Prefer **handles** over paste when the host can dereference: paths, pack
  slices (`task packs:slice`), xBRIEF ids, cache keys, issue/PR numbers — pass
  the handle and load on demand instead of inlining large contents
- ~ Use **targeted retrieval**: `grep`, line ranges, `head`/`tail` — not whole-file reads
- ⊗ **Speculatively loading files** "just in case"
- ? Pre-fetch a file only when the next step certainly requires it

**Related patterns (do not conflate):**

- **Code Mode** ([patterns/code-mode.md](../patterns/code-mode.md), #2593) —
  compact tool discovery + sandboxed execute so large *capability* catalogs
  do not bloat the prompt. Context partitioning (this section) is about
  *what docs and state* enter context; Code Mode is about *how tools are
  invoked*.
- **RLM (citation only):** Recursive Language Models are one recent research
  framing of model-driven partition → recurse → combine over a prompt-as-
  environment ([arxiv:2512.24601](https://arxiv.org/abs/2512.24601); popular
  write-up: [raw.works/rlms-are-the-new-reasoning-models](https://raw.works/rlms-are-the-new-reasoning-models)).
  Directive's human-curated partitions are **architecturally related**, not
  an identity claim that "lazy load is an RLM." Headline claims such as
  "100× context" are **benchmark-dependent and still being validated** —
  treat them as motivation for partitioning, not as product guarantees.
  Model-driven runtime partitioning (the model slices and re-queries without
  a human-authored index) is a different instantiation from REFERENCES /
  skill-scope curation.

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
