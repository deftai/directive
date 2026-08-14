# Tool Design for AI Consumption

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

Principles for designing tools that agents can use effectively.

**Load when:** authoring host tools, MCP/server tool schemas, skill-facing
task surfaces, or any agent-callable parameter shape. Also load when a
tool call fails in ways that look like "the model is dumb" but may be
dialect sampling cost.

**⚠️ See also**:
- [patterns/llm-app.md](../patterns/llm-app.md) `## Tool / function calling` — security, least privilege, validation (confused deputy)
- [patterns/tool-call-taxonomy.md](../patterns/tool-call-taxonomy.md) — explore / commit / verify activity buckets (orthogonal)
- [deterministic-split.md](./deterministic-split.md) — what must not be an LLM step at all

---

## Minimal, Non-Overlapping Tool Sets

- ~ Provide the **smallest set of tools** that covers required capabilities
- ≉ Offering multiple tools that do the same thing with slight variations
- ~ Each tool should have a **single, clear purpose**

## Tool-surface grammar (#3085)

A tool "call" is **dialect sampling** in the token stream. The model does
not decide to call a tool as a special act. It continues the completion
loop under a harness dialect (`function_calls` / `invoke` / JSON args /
provider-specific tags). Schema design is a first-order **reliability and
cost** surface, not cosmetics.

**Rule of thumb:** reliability degrades with
**nesting × heterogeneity × cleverness**.

Source framing (practitioner ablation, not product UI): Can Bölük
([@_can1357](https://x.com/_can1357/status/2084104053651317140), 2026-08-03).
The post's emoji / plaintext "control group" is **not** a product
recommendation. At roughly ten or more tools, native tool-calls win on
ergonomics; still design the **thinnest grammar** you can get away with.

### Prefer flat, homogeneous params

- ~ Prefer **flat scalar/string parameters** over nested objects and
  arrays-as-escaped-JSON inside a single parameter value
- ~ Prefer a **homogeneous** parameter set (similar types, predictable
  names) over mixed clever packing (object + freeform JSON string +
  parallel batch bag in one tool)
- ~ When the host owns the tools, prefer a **vector / flat** shape (one
  named field per logical input) over "batch JSON in a string" when that
  batch only exists to save parallel tool-call round-trips
- ≉ Nested argument bags that force the model to emit valid escaped JSON
  for complex objects when plain scalar parameters would suffice
- ≉ Heterogeneous mega-tools that pack unrelated concerns into one clever
  payload "for flexibility"
- ! Treat provider schema fields (`minimum`, `maximum`, `enum`, long
  descriptions) as **documentation the harness may show**. Validation is
  the application's job unless the harness (or provider) actually rejects
  invalid args — do not assume the model "must" obey schema mins/maxes
- ! Validate tool arguments in the harness before side effects
  (`patterns/llm-app.md` tool-call rules). A flat grammar still needs a
  validator and common dialect failure handling (leaked call text,
  truncated invoke blocks, wrong tool name tokens)

### Good vs bad shapes (sketch)

Bad — nested / heterogeneous / JSON-in-string:

```text
apply_batch({
  "ops": "[{\"path\":\"a.ts\",\"edits\":[{\"start\":1,\"end\":2,\"text\":\"...\"}]}]"
})
```

The model must sample valid escaped JSON for a nested array. One quote
or brace error fails the turn. High nesting × high cleverness.

Better — flat / homogeneous (host-owned tools):

```text
edit_file(path="a.ts", start_line=1, end_line=2, text="...")
```

Scalars and strings after named parameters. The dialect delimiter ends
the value; no JSON escape maze for the common case. Repeat the tool or
use parallel invokes when multiple edits are needed.

When composition is large (many steps, dynamic graphs), **do not** invent
deeper nested tool packs. Prefer fewer tools via code abstraction / Code
Mode / a host-side program (related: #1167, #2593; pattern:
[patterns/code-mode.md](../patterns/code-mode.md)) and multi-step token
breakpoints (#1170). Those reduce **how many** tools exist; this section
shapes **how each remaining tool looks** at the dialect layer.

### Authoring checklist (Directive + consumers)

Use for Directive-owned task/skill tool surfaces, documented host schemas,
and consumer MCP / product-agent schemas:

| Prefer | Avoid |
|--------|--------|
| Flat named scalars/strings | Nested object trees as required args |
| One clear purpose per tool | Mega-tools with optional clever branches |
| Homogeneous repeated fields | Mixed types + freeform JSON bags |
| Host validation + repair | Trusting provider schema as enforcement |
| Code / DSL for multi-step | Deeper nesting to "express workflows" |

- ~ Document constraints in parameter descriptions for human and model
  readers, then **enforce in code**
- ≉ Shipping emoji/plaintext tool channels as a product default (control
  group only in the source post)
- ≉ Migrating every existing tool in one pass — land the principle first;
  reshape high-failure surfaces when measured failure rates justify it
- ? Keep a short failure catalog of dialect errors for your harness
  (sibling track: #3086) so "won't fix" provider quirks become harness
  duties

### Complementarity

| Concern | Where it lives |
|---------|----------------|
| **How each tool's args sample** (this doc) | Flat grammar, low nesting tax |
| **How many tools** exist | [Code Mode](../patterns/code-mode.md) / DSL / abstraction (#1167, #2593) — compact `search`/`describe` + sandboxed `execute` |
| **When multi-step burns tokens** | Breakpoints / long-horizon (#1170) |
| **Security of tool use** | `patterns/llm-app.md` (schema validate, least privilege) |
| **Protocol / model-tier cost after shape** | Cost-envelope notes (e.g. #3078) |

---

## Token-Efficient Outputs

- ~ Support **filtering** — let the caller request only the fields they need
- ~ Support **pagination** — return bounded result sets with continuation tokens
- ? Offer a **summary mode** that returns counts/metadata instead of full payloads
- ≉ Tools that return **unbounded output** without truncation or pagination
- ~ Default to concise output; offer verbose mode only on request

## Clear Descriptions

- ! **Tool descriptions** should state what the tool does, when to use it, and what it returns
- ~ **Parameters** should be self-documenting — use descriptive names and include constraints in descriptions
- ≉ Relying on the agent to infer parameter semantics from names alone
- ~ Keep descriptions short enough to load on demand; put deep examples in
  linked docs, not in every tool definition (token tax — see also #865)

## Error Messages

- ! Return **actionable error messages** — state what went wrong and what to do about it
- ~ Include the specific invalid input in the error so the agent can self-correct
- ≉ Returning generic "operation failed" without remediation guidance
- ? Suggest alternative tool calls or parameter values when possible
