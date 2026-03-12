---
name: deft-setup
description: >
  Set up a new project with Deft framework standards. Use when the user wants
  to bootstrap user preferences, configure a project, or generate a project
  specification. Walks through setup conversationally — no separate CLI needed.
---

# Deft Setup

Agent-driven alternative to `deft/run bootstrap && deft/run project && deft/run spec`.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## When to Use

- User says "set up deft", "configure deft", or "bootstrap my project"
- User asks to create USER.md, PROJECT.md, or SPECIFICATION.md
- User clones a deft-enabled repo for the first time with no config

## Platform Detection

! Before resolving any config paths, detect the host OS from your environment context:

| Platform           | USER.md default path                                              |
|--------------------|-------------------------------------------------------------------|
| Windows            | `%APPDATA%\deft\USER.md` (e.g. `C:\Users\{user}\AppData\Roaming\deft\USER.md`) |
| Unix (macOS/Linux) | `~/.config/deft/USER.md`                                          |

- ! If `$DEFT_USER_PATH` is set, it takes precedence on any platform
- ! Create parent directories as needed when writing USER.md
- ~ `$DEFT_PROJECT_PATH` overrides the default project config path (`./PROJECT.md`) if set

## Agent Behavior

**Flow:**
- ! Start asking immediately — everything you need is in THIS file
- ⊗ Explore the codebase, read framework files, or gather context before asking
- ? Read `deft/main.md` or language files LATER when generating output

**Interaction:**
- ~ Use structured question tools when available (AskQuestion, question picker, multi-choice UI)
- ~ Fall back to numbered text options if no structured tool exists
- ⊗ Present choices as plain text when a structured tool is available

**Defaults:**
- ! Communicate that deft ships with best-in-class standards for 20+ languages
- ! Frame setup as "tell me your overrides" — not "configure everything"
- ~ "Deft has solid opinions on how code should be written and tested — I just need a few things about you and your project."

**Adapt to Technical Level:**
- ! First question gauges whether user is technical or non-technical
- ! Technical user: ask about languages, strategy, coverage directly — they'll have opinions
- ! Non-technical user: skip jargon, use sensible defaults, ask about what they're building not how
- ⊗ Ask non-technical users about coverage thresholds, strategies, or framework choices

## Available Languages

C, C++, C#, Dart, Delphi, Elixir, Go, Java, JavaScript, Julia, Kotlin,
Python, R, Rust, SQL, Swift, TypeScript, VHDL, Visual Basic, Zig, 6502-DASM

- ? Read `deft/languages/{name}.md` when generating output — not before asking

## Available Strategies

| Strategy     | Description                                                              |
|--------------|--------------------------------------------------------------------------|
| **default**  | Structured interview → PRD → SPECIFICATION (Recommended)                |
| **brownfield** | Analyze existing codebase before adding features                       |
| **discuss**  | Front-load decisions and alignment before planning                       |
| **research** | Investigate the domain before planning                                   |
| **speckit**  | Five-phase spec-driven workflow (GitHub spec-kit inspired)               |

---

## Phase 1 — User Preferences (USER.md)

**Goal:** Personal preferences file. Highest precedence in deft rule hierarchy.

- ~ Skip if USER.md exists at the platform-appropriate path (see Platform Detection) and user doesn't want to overwrite
- ⊗ Scan filesystem beyond checking that one path

### Opening Question

- ! Gauge technical level first:
  - **"I'm technical — ask me everything"**
  - **"I have some opinions but keep it simple"**
  - **"Just pick good defaults — I care about the product, not the tools"**
- ~ Use structured choice tool if available

### Technical Users — Ask Together

- ! Batch these in one message:
  1. **Name** — what to call them
  2. **Languages** — show list above
  3. **Strategy** — show table above, recommend "default"
  4. **Coverage threshold** — default 85%, ask if different
  5. **Custom rules** — optional overrides

### Non-Technical Users — Minimal

- ! Ask only:
  1. **Name**
  2. **What are you building?** — infer everything else
- ! Set defaults: strategy = "default", coverage = 85%
- ~ Pick languages based on project type (web → TypeScript, API → Python/Go, mobile → Swift/Kotlin)

### Output Path

Resolve using Platform Detection above. Write to the platform-appropriate path
(or `$DEFT_USER_PATH` if set). Create parent directories as needed.

### Template

```markdown
# User Preferences

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**Rule Precedence**: This file has HIGHEST precedence — overrides all other deft rules.
Only add items here that **override or extend** the defaults in `deft/main.md`.

## Name

Address the user as: **{name}**

## Overrides

**Primary Languages**:
- {language 1}
- {language 2}

**Default Strategy**: [{strategy name}](../strategies/{strategy-file}.md)

{If coverage != 85: "**Coverage**: ! ≥{N}% test coverage"}

## Custom Rules

{custom rules or "No custom rules defined yet."}

---

**Note**: Edit this file anytime to update your preferences.
**See**: [../main.md](../main.md) for framework defaults.
```

### Then

- ~ Ask if user wants to continue to Phase 2 (project configuration)

---

## Phase 2 — Project Configuration (PROJECT.md)

**Goal:** Project-specific configuration — tech stack, type, quality standards.

- ~ Skip if `./PROJECT.md` exists (or `$DEFT_PROJECT_PATH` if set) and user doesn't want to replace

### Inference

- ! NOW infer from codebase — look for `package.json`, `go.mod`, `requirements.txt`, `Cargo.toml`, `pyproject.toml`, `*.csproj`
- ! Present inferences and confirm — don't ask blind

### Technical Users — Present and Confirm

- ! Batch:
  1. **Project name** — infer from directory, confirm
  2. **Project type** — CLI, TUI, REST API, Web App, Library, other
  3. **Languages** — detected + confirm
  4. **Tech stack** — frameworks, libraries
  5. **Strategy** — default to Phase 1 choice
  6. **Coverage** — default 85%

### Non-Technical Users — Summarize and Confirm

- ! Detect and present summary: "Based on your project: {name} ({type}), built with {stack}. Look right?"
- ⊗ Ask about strategy or coverage — use Phase 1 defaults

### Output Path

`./PROJECT.md` (or `$DEFT_PROJECT_PATH` if set).

### Template

```markdown
# {Project Name} Project Guidelines

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

Only specify items here that **override or extend** the deft defaults.

**Reference**: `deft/main.md` | {language links}

## Project Configuration

**Tech Stack**: {project type} using {languages}{tech stack details}

## Strategy

Use [{strategy name}](deft/strategies/{strategy-file}.md) for this project.

## Workflow

```bash
task check         # Pre-commit gate
task test:coverage # Coverage target
task build         # Build project
task clean         # Clean artifacts
```

## Standards

**Quality:**
- ! Run `task check` before every commit
- ! Achieve ≥{coverage}% coverage overall + per-module
- ! Store secrets in `secrets/` dir
- ~ Provide `.example` templates for secrets

## Project-Specific Rules

{Any rules the user specified, or "(Add your custom rules here)"}

---

**Generated by**: deft-setup skill
**Date**: {YYYY-MM-DD}
```

### Then

- ~ Ask if user wants to continue to Phase 3 (specification)

---

## Phase 3 — Specification (SPECIFICATION.md)

**Goal:** Interview user about what to build, generate implementable spec.
No intermediate PRD.md needed — already in conversation.

- ~ Skip if user already has a SPECIFICATION.md they're happy with

### Interview Process

Per `deft/templates/make-spec.md`:

- ! Ask what to build and features first
- ! Ask **ONE** focused, non-trivial question per step
- ~ Provide numbered options with an "other" choice
- ! Mark which option is RECOMMENDED
- ⊗ Ask multiple questions at once
- ⊗ Make assumptions without clarifying
- ~ Use structured question tools for each interview question

**Question Areas:**
- ! Missing decisions (language, framework, deployment)
- ! Edge cases (errors, boundaries, failure modes)
- ! Implementation details (architecture, patterns, libraries)
- ! Requirements (performance, security, scalability)
- ! UX/constraints (users, timeline, compatibility)
- ! Tradeoffs (simplicity vs features, speed vs safety)

**Non-Technical Users:**
- ~ Adjust vocabulary: "How do you want to store data?" not "What database engine?"
- ~ "Will other apps talk to this?" not "REST or GraphQL?"

**Completion:**
- ! Continue until little ambiguity remains
- ! Spec must be comprehensive enough to implement

### Output

1. ! Write `./vbrief/specification.vbrief.json` with `status: draft`
2. ! Summarize decisions, ask user to review
3. ! On approval, update `status` to `approved`
4. ! Generate `./SPECIFICATION.md` (run `task spec:render` if available, else directly)

**Spec Structure:**
- ! Overview, Requirements, Architecture
- ! Implementation Plan: Phases → Subphases → Tasks
- ! Explicit dependency mapping between phases
- ~ Tasks designed for parallel work by multiple agents
- ! Testing Strategy and Deployment
- ⊗ Write code — specification only

### Handoff to deft-build

- ! Offer to start building: "Your spec is ready. Want me to start building it now?"
- ~ If platform supports skill invocation, invoke `/deft-build`
- ⊗ Leave user with a dead end — always offer the next step

## Anti-Patterns

- ⊗ Explore codebase before Phase 1 questions
- ⊗ Read framework files before first question
- ⊗ Drip-feed questions one at a time when they can be batched
- ⊗ Ask jargon-heavy questions to non-technical users
- ⊗ Ask about things inferable from codebase (Phase 2+)
- ⊗ Skip phases without asking
- ⊗ Generate files without confirming content
- ⊗ Present choices as plain text when structured tools exist
