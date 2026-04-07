# Contract Hierarchy

Two lenses for reasoning about what to invest in — durability (what survives) and generation (what to write first).

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [contracts/boundary-maps.md](./boundary-maps.md) | [coding/coding.md](../coding/coding.md) | [meta/philosophy.md](../meta/philosophy.md) | [core/glossary.md](../core/glossary.md)

---

## Durability Axis — What Survives

Rank artifacts by how long they remain valid. Invest maintenance effort accordingly.

```
Standards  >  APIs  >  Specifications  >  Code
(decades)    (years)    (months)         (weeks)
```

- ! **Standards** — coding conventions, quality gates, testing policies. These outlive any single project and rarely change. Treat them as infrastructure.
- ! **APIs** — public interfaces, contracts, schemas. These outlive implementation cycles. Breaking changes are expensive; design them carefully.
- ~ **Specifications** — requirements, acceptance criteria, architectural decisions. These evolve per feature cycle but anchor the work.
- ~ **Code** — implementation. This is the most renewable layer. If the spec is clear, code can be regenerated.

### Implications

- ! When time is limited, invest in the higher layers first — a good spec with throwaway code beats polished code with no spec.
- ~ When refactoring, check whether the change belongs at a higher layer (API change? spec change?) before touching code.
- ⊗ Treat code as the primary intellectual property — specs and contracts are the real IP.

---

## Generative Axis — What to Write First

Rank artifacts by creation order. Each layer generates the next.

```
Specification  →  Contracts  →  Code
(what/why)       (boundaries)   (how)
```

- ! **Specification first** — define what to build and why before anything else. The spec is the source of truth for intent.
- ! **Contracts second** — define the interfaces, data shapes, and boundaries between components. Contracts are derived from the spec.
- ! **Code last** — implement to satisfy the contracts. Code is derived from contracts.

### Implications

- ! Writing code before the spec exists is building without a blueprint — the result is accidental architecture.
- ~ Writing contracts before the spec is premature optimization of boundaries — the interfaces will shift when requirements clarify.
- ⊗ Skip straight to implementation when requirements are unclear — write the spec first, even if it's rough.

---

## When Each Axis Applies

**Use the durability axis** when deciding where to invest maintenance effort, what to review most carefully, and what to protect from churn.

**Use the generative axis** when deciding what to write next in a development cycle — spec → contracts → code, in that order.

Both axes reinforce the same core principle: **contracts are your IP, code is renewable.**

---

## Examples

**Durability in practice:** A team spends 3 days on a REST API contract review but only 1 day reviewing the handler implementations. This is correct — the API outlives the handlers.

**Generative in practice:** Before implementing a new feature, the agent writes `specification.vbrief.json` (spec), then defines boundary maps between components (contracts), then writes tests and implementation (code). Each layer constrains the next.

---

## Anti-Patterns

- ⊗ Treating code as the deliverable and specs as paperwork — specs outlive code
- ⊗ Designing APIs after implementation — APIs should be designed from the spec, not reverse-engineered from code
- ⊗ Investing equally in all layers — the higher the durability, the more review it deserves
- ⊗ Skipping the generative order — writing code before contracts leads to implicit, undocumented boundaries
