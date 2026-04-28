---
name: deft-write-skill
description: >
  Create new deft skills with proper structure, RFC2119 notation, triggers,
  and progressive disclosure. Use when user wants to create, write, or build
  a new deft skill.
triggers:
  - write a skill
  - create a skill
  - new skill
  - build a skill
---

# Deft Write Skill

Create new deft skills that follow directive's conventions: RFC2119 notation, YAML frontmatter with triggers, clear When-to-Use sections, and proper naming.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

> Inspired by [write-a-skill](https://github.com/mattpocock/skills/tree/main/write-a-skill) from [mattpocock/skills](https://github.com/mattpocock/skills). Adapted to deft's SKILL.md conventions, RFC2119 notation, and naming patterns.

## When to Use

- User wants to create a new skill for a workflow directive doesn't cover yet
- Formalizing an ad-hoc process that keeps repeating into a reusable skill
- Extending directive with project-specific or domain-specific skills

---

## Deft Skill Naming Conventions

| Skill type | Naming pattern | Example |
|---|---|---|
| Framework / meta | `deft-{verb}` | `deft-build`, `deft-setup` |
| GitHub-integrated | `deft-gh-{verb}` | `deft-gh-triage`, `deft-gh-slice` |
| Domain / project-specific | `{project}-{verb}` | `my-app-deploy` |

---

## Process

### Step 1: Gather requirements

Ask the user (one question at a time):

1. What task or domain does this skill cover?
2. What specific use cases should it handle?
3. Does it require external tools (e.g., `gh`, `docker`, database CLIs)?
4. Should it produce files, run commands, or guide a conversation?
5. Any reference material or existing workflows to model from?

### Step 2: Draft the skill

- ! Follow the deft SKILL.md template below
- ! Keep SKILL.md under 150 lines — split into `REFERENCE.md` if needed
- ! Write the `description` field as if it's the only thing the agent will see when deciding whether to invoke this skill
- ~ Use the trigger words the user would naturally say
- ! Use RFC2119 notation throughout (!=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY)
- ~ Include attribution blockquote if inspired by an external source

### Step 3: Review with user

Present the draft and ask:
- Does this cover your use cases?
- Anything missing or unclear?
- Should any section be more or less detailed?

Iterate until approved.

### Step 4: Create the skill

- ! Create the directory `skills/{skill-name}/`
- ! Write `skills/{skill-name}/SKILL.md`
- ~ Create `skills/{skill-name}/REFERENCE.md` if content exceeds 150 lines
- ~ Create `skills/{skill-name}/scripts/` for deterministic helper scripts

---

## Deft SKILL.md Template

```markdown
---
name: {skill-name}
description: >
  {What it does in 1–2 sentences}. Use when {specific triggers —
  what the user would say or what context activates this skill}.
triggers:
  - {trigger phrase 1}
  - {trigger phrase 2}
[metadata:
  clawdbot:
    requires:
      bins: ["gh"]   # only if external CLI is needed]
---

# {Skill Title}

{One-line description of what this skill does.}

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

[> Inspired by ... — optional attribution]

## When to Use

- {Use case 1}
- {Use case 2}

[## Prerequisites

- ! Verify {tool} is available — stop and report if not]

---

## Process

### Step 1: {Name}

- ! {mandatory action}
- ~ {recommended action}
- ⊗ {forbidden action}

### Step 2: {Name}

...

---

## Anti-Patterns

- ⊗ {what NOT to do}
- ⊗ {what NOT to do}
```

---

## Description Writing Rules

The description is **the only thing the agent sees** when deciding whether to load this skill. Write it to answer:
1. What capability does this provide?
2. When should it trigger? (use "Use when..." pattern)

- ! Max 1024 characters
- ! Include "Use when [specific triggers]" in the description
- ⊗ Vague descriptions ("helps with things") — the agent can't distinguish between skills
- ! First sentence: what it does. Second sentence: when to use it.

---

## Anti-Patterns

- ⊗ Omitting RFC2119 notation — deft skills use it consistently
- ⊗ Putting all content in SKILL.md when it exceeds 150 lines — split into REFERENCE.md
- ⊗ Vague trigger phrases — use phrases the user would actually type
- ⊗ Naming a GitHub-integrated skill without `gh` in the name
- ⊗ Writing the description without a "Use when..." clause
