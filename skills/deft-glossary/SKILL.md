---
name: deft-glossary
description: >
  Extract a DDD-style ubiquitous language glossary from the current
  conversation, flagging ambiguities and proposing canonical terms. Saves
  to UBIQUITOUS_LANGUAGE.md. Use when defining domain terms, building a
  glossary, hardening terminology, or when "domain model" or "DDD" is mentioned.
triggers:
  - domain model
  - ubiquitous language
  - glossary
  - DDD
  - define terms
---

# Deft Glossary

Extract and formalize domain terminology from the current conversation into a consistent glossary saved to `UBIQUITOUS_LANGUAGE.md`. When a `core/glossary.md` exists in the project, treat it as the starting baseline.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

> Inspired by [ubiquitous-language](https://github.com/mattpocock/skills/tree/main/ubiquitous-language) from [mattpocock/skills](https://github.com/mattpocock/skills). Adapted to deft's DDD framework and `core/glossary.md` conventions.

## When to Use

- Defining or hardening domain terminology before or during spec generation
- After a `probe` or `discuss` session surfaces ambiguous terms
- When different team members or agents use different words for the same concept
- At the start of a new domain area to lock vocabulary before implementation

## Process

### Step 1: Load existing glossary

- ~ If `core/glossary.md` exists, read it as the starting baseline
- ~ If `UBIQUITOUS_LANGUAGE.md` exists in the working directory, read it too
- ! Work from whatever is in the conversation context — do NOT ask the user to re-explain

### Step 2: Scan and identify problems

- ! Scan the conversation for domain-relevant nouns, verbs, and concepts
- ! Identify:
  - **Ambiguities** — same word used for different concepts
  - **Synonyms** — different words used for the same concept
  - **Vague terms** — overloaded or underspecified language
- ⊗ Include generic programming concepts (array, endpoint, function) unless they carry specific domain meaning

### Step 3: Propose canonical glossary

- ! Be opinionated — when multiple words exist for the same concept, pick the best one
- ! List rejected alternatives as "aliases to avoid"
- ! Group terms into tables by natural cluster (subdomain, lifecycle, actor) — don't force groupings if all terms belong to one cohesive domain
- ! Show relationships between terms using bold names and cardinality where obvious
- ! Write an example dialogue (3–5 exchanges) between a dev and domain expert demonstrating how the terms interact naturally
- ! Flag all conflicts explicitly in a "Flagged ambiguities" section

### Step 4: Write output

- ! Write `UBIQUITOUS_LANGUAGE.md` in the working directory using the format below
- ! Output an inline summary of terms added and ambiguities flagged
- ~ If `core/glossary.md` exists and new terms belong there permanently, propose additions — but ⊗ modify `core/glossary.md` without user confirmation

---

## Output Format

```markdown
# Ubiquitous Language

## {Domain / Subdomain Name}

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Order** | A customer's request to purchase one or more items | Purchase, transaction |
| **Invoice** | A request for payment sent after delivery | Bill, payment request |

## Relationships

- An **Invoice** belongs to exactly one **Order**
- An **Order** MAY produce multiple **Invoices** if items ship separately

## Example dialogue

> **Dev:** "When a **Customer** places an **Order**, do we create the **Invoice** immediately?"
> **Domain expert:** "No — an **Invoice** is only generated once a **Fulfillment** is confirmed."

## Flagged ambiguities

- "account" was used to mean both **Customer** (places orders) and **User** (authentication
  identity) — these are distinct concepts; use the specific term in all contexts.
```

---

## Re-running

When invoked again in the same session:

- ! Read the existing `UBIQUITOUS_LANGUAGE.md`
- ! Incorporate new terms from subsequent discussion
- ~ Update definitions if understanding has evolved
- ~ Re-flag any new ambiguities
- ~ Rewrite the example dialogue to incorporate new terms

---

## Anti-Patterns

- ⊗ Listing every class or module name — only terms with domain meaning
- ⊗ Vague definitions ("a thing that does stuff") — one tight sentence per term
- ⊗ Silently modifying `core/glossary.md` without user confirmation
- ⊗ Letting synonyms persist — pick one and enforce it
- ⊗ Skipping the example dialogue — it's the best test that terms actually compose correctly
