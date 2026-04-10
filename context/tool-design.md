# Tool Design for AI Consumption

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

Principles for designing tools that agents can use effectively.

---

## Minimal, Non-Overlapping Tool Sets

- ~ Provide the **smallest set of tools** that covers required capabilities
- ≉ Offering multiple tools that do the same thing with slight variations
- ~ Each tool should have a **single, clear purpose**

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

## Error Messages

- ! Return **actionable error messages** — state what went wrong and what to do about it
- ~ Include the specific invalid input in the error so the agent can self-correct
- ≉ Returning generic "operation failed" without remediation guidance
- ? Suggest alternative tool calls or parameter values when possible
