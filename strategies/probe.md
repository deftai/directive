# Probe Strategy

Stress-test a plan before committing to it — relentless interrogation until every branch of the decision tree is resolved.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [strategies/discuss.md](./discuss.md) | [strategies/interview.md](./interview.md) | [core/glossary.md](../core/glossary.md)

> Inspired by [grill-me](https://github.com/mattpocock/skills/tree/main/grill-me) from [mattpocock/skills](https://github.com/mattpocock/skills). Adapted to directive's preparatory strategy pattern.

---

## When to Use

- ~ Before committing to any significant design decision or architecture choice
- ~ When a plan has been drafted but not yet stress-tested
- ! When the user explicitly asks to be probed or challenged on their plan
- ? Skip when the path forward is unambiguous and small in scope

## Core Principle

The goal is not alignment — that's `discuss`. Probe is adversarial discovery. It assumes the plan has holes and sets out to find them. Every assumption is challenged, every edge case explored, every dependency branch walked until nothing is unresolved. Where `discuss` builds consensus, `probe` finds what's missing.

---

## Process

### Step 1: Establish the plan

- ! Read whatever plan, design, or spec exists in the conversation context
- ~ If no plan is in context, ask ONE question: "What's the plan you want me to probe?"
- ~ If codebase context is relevant, explore it to answer what you can before asking
- ⊗ Ask follow-up questions before reading available context

### Step 2: Interrogate relentlessly

Walk the decision tree depth-first. For each unresolved branch:

- ! Ask **ONE** focused question per message
- ! For each question, provide your recommended answer with brief reasoning
- ! If the codebase can answer a question, explore it instead of asking the user
- ~ Follow the thread — if an answer opens new branches, pursue them before moving on
- ⊗ Ask multiple questions at once
- ⊗ Accept vague answers — push back: "What does that mean concretely?"
- ⊗ Move to the next branch before the current one is fully resolved

### Question focus areas

- ! **Assumptions** — "This assumes X is guaranteed — is it?"
- ! **Edge cases** — "What happens when Y is empty / null / at the limit?"
- ! **Dependencies** — "This requires Z to exist — what if it doesn't?"
- ! **Failure modes** — "How does this fail? How is that surfaced to the user?"
- ! **Scaling** — "Does this hold at 10× the expected volume?"
- ~ **Security surface** — "Who can reach this? What's the blast radius if it's wrong?"
- ~ **Reversibility** — "Can this decision be changed later? What's the migration cost?"

### Transition criteria (probe complete)

- ! All major decision branches have been resolved
- ! No open assumptions remain
- ~ User has acknowledged the risks of any deliberately deferred decisions
- ~ No new branches are surfaced by the last 2–3 questions

---

## Output

- ! Produce `{scope}-probe.md` with three sections:
  - **Locked decisions** — what was resolved and why
  - **Surfaced risks** — concerns raised, even if not fully resolved
  - **Deferred decisions** — explicitly acknowledged items with justification
- ! Each entry includes: **question asked**, **answer given**, **status** (locked / deferred / risk-accepted)
- ~ Persist significant decisions as vBRIEF narratives on the relevant plan items

---

## Then: Chaining Gate

After the probe is complete and `{scope}-probe.md` is written, return to the
[chaining gate](./interview.md#chaining-gate).

- ! On completion, register artifacts in `./vbrief/plan.vbrief.json`:
  - Update `completedStrategies`: increment `runCount` for `"probe"`,
    append artifact path (`{scope}-probe.md`)
  - Append the path to the flat `artifacts` array
- ! Return to [interview.md Chaining Gate](./interview.md#chaining-gate)
- ! The locked decisions and surfaced risks from `{scope}-probe.md` MUST flow
  into subsequent strategies and spec generation:
  - Locked decisions become constraints in the specification
  - Surfaced risks become NFRs or explicit acceptance criteria
  - Deferred decisions appear as open questions in the spec
- ⊗ End the session after probe without returning to the chaining gate

---

## Anti-Patterns

- ⊗ Accepting "we'll figure it out later" without marking it as explicitly deferred
- ⊗ Asking generic checklist questions instead of following the decision tree
- ⊗ Letting vague answers pass without pushing for concrete specifics
- ⊗ Using codebase exploration as a substitute for asking the user about deliberate design choices
- ⊗ Stopping when the conversation feels comfortable — stop when no new branches emerge
- ⊗ Ending after probe without chaining back to the gate
