# Yolo Strategy

Auto-pilot interview: the agent plays both sides, always picking the recommended
option. Same workflow as [interview.md](./interview.md) (including the sizing
gate) but the agent answers its own questions via "Johnbot."

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [strategies/interview.md](./interview.md) | [strategies/discuss.md](./discuss.md) | [core/glossary.md](../core/glossary.md)

---

## When to Use

- ~ Quick prototyping where speed matters more than precision
- ~ When the user trusts the agent's recommended defaults
- ? When exploring an idea before committing to a full interview
- ⊗ Production systems or compliance-heavy projects — use [interview.md](./interview.md) instead

## Chaining Gate

Johnbot auto-selects at the [chaining gate](./interview.md#chaining-gate) too.

- ! Johnbot MUST select **"Proceed to specification"** (option 1) — no preparatory detours
- ! Johnbot MUST select **"Accept"** at the [acceptance gate](./interview.md#acceptance-gate) — no revisions
- ⊗ Ask the real user to choose at either gate — Johnbot handles both automatically

## Sizing Gate

Johnbot picks the size too. The same sizing signals from
[interview.md](./interview.md#sizing-gate) apply, but Johnbot makes the call
without asking the user.

- ! Check `PROJECT.md` for `**Process**: Light` or `**Process**: Full` — if declared, use that path
- ! If not declared, Johnbot picks based on feature count and complexity signals
- ~ Default to Light for typical yolo projects (speed over ceremony)

## Workflow Overview

```mermaid
flowchart LR
    subgraph yolo ["Yolo Strategy"]
        G{"⚖️ Sizing Gate<br/><i>Johnbot picks</i>"}
        I_L["💬 Auto-Interview<br/><i>Light path</i>"]
        I_F["💬 Auto-Interview<br/><i>Full path</i>"]
        P["📄 PRD<br/><i>Auto-approved</i>"]
        S["📋 SPECIFICATION<br/><i>How to build it</i>"]
    end

    G -->|"Light"| I_L
    G -->|"Full"| I_F
    I_L -->|"Johnbot picks defaults"| S
    I_F -->|"Johnbot picks defaults"| P
    P -->|"Auto-approved"| S
    S -->|"Ready"| IMPL["🔨 Implementation"]

    style G fill:#f0abfc,stroke:#a21caf,color:#000
    style I_L fill:#c4b5fd,stroke:#7c3aed,color:#000
    style I_F fill:#c4b5fd,stroke:#7c3aed,color:#000
    style P fill:#fef08a,stroke:#ca8a04,color:#000
    style S fill:#6ee7b7,stroke:#059669,color:#000
    style IMPL fill:#7dd3fc,stroke:#0284c7,color:#000
```

---

## Interview Rules

Same as [interview.md](./interview.md#interview-rules-shared-by-both-paths),
with Johnbot additions:

- ~ Use Claude AskInterviewQuestion when available (emulate if not)
- ! Ask **ONE** focused, non-trivial question per step
- ⊗ Ask multiple questions at once or sneak in "also" questions
- ~ Provide numbered answer options when appropriate
- ! Include "other" option for custom/unknown responses
- ! Indicate which option is RECOMMENDED
- ! Pretend you are the user "Johnbot" too
- ~ Johnbot asks for details/clarifications on the questions when appropriate
- ! Johnbot ultimately goes with the RECOMMENDED option
- ⊗ Ask the real user to answer a question — keep working with Johnbot until you can build the specification

---

## Light Path

Same as [interview.md Light path](./interview.md#light-path-smallmedium-projects)
but Johnbot answers all questions and auto-approves.

---

## Full Path

Same as [interview.md Full path](./interview.md#full-path-largecomplex-projects)
but Johnbot answers all questions and auto-approves the PRD.

---

## SPECIFICATION Guidelines

Same as [interview.md](./interview.md#specification-guidelines-both-paths).

---

## Artifacts Summary

Same as [interview.md](./interview.md#artifacts-summary) — identical for both
Light and Full paths (PRD is auto-approved on Full path).

## Invoking This Strategy

```
/deft:run:yolo [project name]
```

Or explicitly:

```
Use the yolo strategy to plan [project].
```

After completion:

```
implement SPECIFICATION.md
```
