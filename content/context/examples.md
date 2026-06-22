# Few-Shot & Behavioral Examples

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

Guidance on using examples to shape agent behavior.

---

## Core Insight

A few **diverse, canonical examples** are worth more than exhaustive edge-case rules. Examples are pictures worth a thousand words — they encode style, structure, and judgment simultaneously.

## Structuring Examples for Maximum Signal

- ~ **Show 2–4 diverse examples** that cover the main behavioral modes
- ~ Each example should demonstrate a **different dimension** (e.g., simple vs. complex, happy path vs. error)
- ~ Include **input → output pairs** so the pattern is unambiguous
- ~ Place examples **close to the instruction** they illustrate
- ? Use brief annotations to highlight what each example demonstrates

## What to Avoid

- ≉ **Stuffing prompts with every possible edge case** — this wastes context and dilutes signal
- ≉ Using only trivial examples that don't exercise real judgment
- ≉ Examples that contradict each other without explanation
- ~ When tempted to add a 10th example, instead write a concise rule and keep 3 good examples
