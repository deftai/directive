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

~ When presenting strategies to the user, always use this numbered list format (not a plain table).
~ Always include the chaining note below the list.
! Always show the FULL strategy list at every chaining gate — never remove a strategy because it was previously run.
~ If a strategy has been run already, indicate it with a note e.g. `(run 1x)` but keep it selectable.

1. **interview** ★ (recommended) — Structured interview with sizing gate: Light or Full path
2. **yolo** — Auto-pilot interview — Johnbot picks all recommended options
3. **map** — Analyze existing codebase conventions before adding features
4. **discuss** — Front-load decisions and alignment before planning
5. **research** — Investigate the domain before planning
6. **speckit** — Five-phase spec-driven workflow for large/complex projects

> 💡 Strategies can be chained — after one completes, you'll be asked if you want to run another.

---

## Phase 1 — User Preferences (USER.md)

**Goal:** Personal preferences file with two sections:
- **Personal** — always wins over everything (name, custom rules)
- **Defaults** — fallback values that PROJECT.md can override (strategy, coverage)

- ~ Skip if USER.md exists at the platform-appropriate path (see Platform Detection) and user doesn't want to overwrite
- ⊗ Scan filesystem beyond checking that one path

### USER.md Freshness Detection

! When an existing USER.md is found (returning user), check its `deft_version` field before skipping Phase 1:

1. ! If `deft_version` is **missing**: the USER.md predates versioning -- treat as stale
2. ! If `deft_version` is present but **differs from the current framework version** (0.15.0): check whether any expected fields are missing from the USER.md
3. ! If fields are missing: query the user for each missing field individually -- do NOT re-run the full Phase 1 interview
4. ! After completing any field queries (even if none were needed), write the current `deft_version` (0.15.0) to USER.md
5. ~ If `deft_version` matches the current version and all expected fields are present: no action needed (USER.md is fresh)

Expected USER.md fields: **Name**, **Custom Rules**, **Default Strategy**, and optionally **Coverage** and **Experimental Rules**.

⊗ Re-run the full Phase 1 interview when only individual fields are missing from a stale USER.md -- query missing fields individually instead.

### Interview Rules

! This phase follows the deterministic interview loop defined in `skills/deft-interview/SKILL.md`. The core rules (one question per turn, numbered options with stated default, explicit "other" escape, depth gate, default acceptance, confirmation gate, structured handoff) apply here. Key points repeated for emphasis:

! **Each message you send MUST contain exactly ONE question.** This is the most
important rule in this file. After the user answers, send the NEXT question in
a new message. Repeat until all questions for their track are answered.

- ⊗ Include two or more questions in the same message under any circumstances
- ⊗ List upcoming questions — only show the current one
- ~ Provide numbered answer options with an "other" choice where appropriate
- ! Mark which option is RECOMMENDED when showing choices
- ~ Use structured question tools when available (AskQuestion, question picker)

### Question Sequence

**Step 0 — Opening (all users):**
Ask: "How deep do you want to go?"
  1. I'm technical — ask me everything
  2. I have some opinions but keep it simple
  3. Just pick good defaults — I care about the product, not the tools

Wait for answer. Then follow the track below.

**Track 1 (technical) — 7 steps:**
- Step 1: Ask their name
- Step 2: Ask strategy preference (show Available Strategies numbered list from the Available Strategies section, with descriptions and recommended marker; fallback — projects can override)
- Step 3: Ask coverage threshold (default 85%; fallback — projects can override)
- Step 4: Ask for custom rules — if user has rules, collect them one per line (empty line to finish); if none, skip
- Step 5a: Present SOUL.md and ask whether to include it (default: yes):
  > **SOUL.md** — Results-first agent persona (inspired by Winston Wolf). Enforces assess-before-acting,
  > finish-what-you-start, right-tool-for-the-job, and play-the-long-game. Keeps the AI decisive and
  > concise. Includes a named persona ('Vinston') — drop if you prefer to define your own agent personality.
  > Include SOUL.md? (Y/n)
- Step 5b: Present morals.md and ask whether to include it (default: yes):
  > **morals.md** — Epistemic honesty rules. No presenting speculation as fact, label unverified claims,
  > self-correct when wrong. Foundational trust rules for any AI agent. Strongly recommended.
  > Include morals.md? (Y/n)
- Step 5c: Present code-field.md and ask whether to include it (default: yes):
  > **code-field.md** — Pre-code assumption protocol. Requires stating assumptions and naming failure modes
  > before writing a single line. Fights the 'it compiles, ship it' instinct. Based on NeoVertex1 context-field.
  > Include code-field.md? (Y/n)

**Track 2 (middle ground) — 2 steps:**
- Step 1: Ask their name
- Step 2: Ask for custom rules — if user has rules, collect them one per line (empty line to finish); if none, skip
- Set defaults without asking: strategy = "interview", coverage = 85%, all meta-guidelines included

**Track 3 (non-technical) — 2 steps:**
- Step 1: Ask their name
- Step 2: Ask what they're building (brief description — used for PROJECT.md later)
- Set defaults: strategy = "interview", coverage = 85%, all meta-guidelines included

### Output Path

Resolve using Platform Detection above. Write to the platform-appropriate path
(or `$DEFT_USER_PATH` if set). Create parent directories as needed.

### Template

```markdown
# User Preferences

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**deft_version**: 0.15.0

## Personal (always wins)

Settings in this section have HIGHEST precedence — override all other deft rules,
including PROJECT.md.

**Name**: Address the user as: **{name}**

**Custom Rules**:
{custom rules or "No custom rules defined yet."}

## Defaults (fallback)

Settings in this section are fallback defaults. PROJECT.md overrides these
for project-scoped settings (strategy, coverage).

**Default Strategy**: [{strategy name}](../strategies/{strategy-file}.md)

{If coverage != 85: "**Coverage**: ! ≥{N}% test coverage"}

{If any experimental rules selected:
"## Experimental Rules

{one line per selected rule, e.g.:
- ! Use meta/SOUL.md for strategic context and purpose-driven guidance
- ! Use meta/morals.md for ethical AI development principles
- ~ Use meta/code-field.md for advanced architecture patterns}"}

---

**Note**: Edit this file anytime to update your preferences.
**See**: [../main.md](../main.md) for framework defaults.
```

### Then

- ~ Ask if user wants to continue to Phase 2 (project configuration)

---

## Phase 2 — Project Configuration (PROJECT.md)

**Goal:** Project-specific configuration — tech stack, type, quality standards.

! **Path Resolution Anchor**: Resolve ALL paths relative to the user's working directory (pwd) at skill entry -- never relative to the skill file location, AGENTS.md location, or any framework directory (e.g. `./deft/`). When deft is cloned as a subdirectory, the skill file lives inside the clone but all project artifacts (`PROJECT.md`, build files, etc.) must be resolved from the user's pwd.

- ~ Skip if `./PROJECT.md` exists at the **project root** (or `$DEFT_PROJECT_PATH` if set) and user doesn't want to replace
- ⊗ Count `./deft/PROJECT.md` or `./deft/core/project.md` as the user's project config — those are framework-internal

### Inference

- ! Before asking, infer from codebase — look for `package.json`, `go.mod`, `requirements.txt`, `Cargo.toml`, `pyproject.toml`, `*.csproj`
- ! Use inferences to pre-fill answers and confirm — don't ask blind
- ⊗ Look inside `./deft/` for build files (`go.mod`, `package.json`, `pyproject.toml`, `Cargo.toml`, `*.csproj`, etc.) — those are framework-internal. Only inspect files at the project root and its non-`deft` subdirectories.
- ⊗ Run git commands inside `./deft/` to determine project identity — that directory is the framework repo, not the user's project.
- ~ If no build files are found at the project root, default the project name to the current directory name and ask for confirmation.

### Track Detection

! If Phase 1 was skipped (USER.md already existed), the user's track is unknown.
Before asking any Phase 2 questions, ask the depth question:

> "How deep do you want to go?"
> 1. I'm technical — ask me everything
> 2. I have some opinions but keep it simple
> 3. Just pick good defaults — I care about the product, not the tools

Wait for answer. Then follow the corresponding track in the Question Sequence below.

⊗ Assume Track 1 (technical) because USER.md exists or contains strategy/coverage fields.
⊗ Infer the track from USER.md content — always ask.

### Defaults in Agentic Mode

! When a question has a USER.md default, phrase it as:
> "{Field}: **{value}** from USER.md — keep this, or enter a different value?"

! Accept any affirmative response ("keep", "yes", "same", "default", ✓) as confirmation to use the default.
⊗ Phrase defaults as "press Enter to keep" — there is no Enter in conversational mode.

### Interview Rules (same as Phase 1)

! **Each message MUST contain exactly ONE question.** The Phase 1 interview rules
apply here too. Do not combine questions. See `skills/deft-interview/SKILL.md` for the canonical deterministic interview loop.

### Question Sequence

**Track 1 (technical) — 8 steps:**
- Step 1: Ask project name (infer from build files or directory name, confirm)
- Step 2: Ask project type (CLI, TUI, REST API, Web App, Library, other)
- Step 3: Ask deployment platform:
  1. Cross-platform (Linux / macOS / Windows)
  2. Windows-native
  3. macOS-native
  4. Linux / Unix
  5. Embedded / low-resource
  6. Web / Cloud
  7. Mobile (iOS / Android)
  8. Other / not sure
- Step 4: Ask languages — show a filtered shortlist (3–4 recommendations) based on project type + platform. If codebase markers exist (`go.mod`, `pyproject.toml`, etc.), skip and confirm: "Detected {lang} — correct?"
  - If user selects "Other": show remaining plausible languages for the type+platform context (Tier 2)
  - If still not found: free text input (Tier 3)
  - If entered language has no deft `languages/{lang}.md` standards file, warn: "deft doesn't have a standards file for {lang} yet — general defaults will be used. Continue?"
- Step 5: Ask tech stack (frameworks, libraries)
- Step 6: Ask strategy (default to USER.md Defaults; ask if this project needs different — show Available Strategies numbered list with descriptions and recommended marker)
- Step 7: Ask coverage (default to USER.md Defaults; ask if this project needs different)
- Step 8: Ask for project-specific rules (optional, same one-per-line format as Phase 1 custom rules)
- Step 9: Ask branching preference:
  > "Do you prefer branch-based workflow (create a feature branch for every change) or
  > trunk-based (commit directly to master)? Branch-based is the default and recommended
  > for teams; trunk-based is common for solo projects."
  > 1. Branch-based ★ (recommended — default)
  > 2. Trunk-based (direct commits to master)
  If trunk-based: add `Allow direct commits to master: true` under `## Branching` in PROJECT.md

**Track 2 (middle ground) — 4 steps:**
- Step 1: Ask project name (infer from build files or directory name, confirm)
- Step 2: Ask project type (CLI, TUI, REST API, Web App, Library, other)
- Step 3: Ask languages (show detected, confirm or adjust; if none detected, infer from type and ask)
- Step 4: Ask strategy (default to USER.md Defaults; ask if this project needs different — show Available Strategies numbered list with descriptions and recommended marker)
- Default coverage to USER.md Defaults without asking

**Track 3 (non-technical) — 1 step:**
- Step 1: Present summary of inferences: "Based on your project: {name} ({type}), built with {stack}. Look right?"
- ⊗ Ask about strategy or coverage — use Phase 1 defaults

### Output Path

`./PROJECT.md` (or `$DEFT_PROJECT_PATH` if set).

### Template

```markdown
# {Project Name} Project Guidelines

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**deft_version**: 0.15.0

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

## Branching

{If trunk-based chosen: "Allow direct commits to master: true"
 If branch-based (default): omit this section entirely}

---

**Generated by**: deft-setup skill
**Date**: {YYYY-MM-DD}
```

### Then

- ~ Ask if user wants to continue to Phase 3 (specification)

---

## Phase 3 — Specification (SPECIFICATION.md)

**Goal:** Generate an implementable spec using the strategy chosen in Phase 2.

! **Path Resolution Anchor**: Same rule as Phase 2 -- resolve ALL paths relative to the user's pwd at skill entry, never relative to the skill file, AGENTS.md, or any framework directory.

- ~ Skip if user already has a spec at the **project root** they're happy with
- ! Check `./SPECIFICATION.md` or `./specs/*/SPECIFICATION.md` (project root)
- ⊗ Count ANY file inside `./deft/` as the project's spec — those are framework-internal
  (e.g. `deft/PROJECT.md`, `deft/specs/`, `deft/templates/`, `deft/core/project.md`
  are all part of the framework, NOT the user's project)

### ⚠️ MANDATORY: Strategy Gate — Do This First

! **STOP.** You MUST determine the correct strategy before doing anything else.

1. ! Open `PROJECT.md` (the file written in Phase 2)
2. ! Find the `## Strategy` section
3. ! Read the strategy link: `Use [Name](deft/strategies/file.md)` → extract the strategy name

**Dispatch:**

- **interview** (or default) → Continue to the Sizing Gate below ✅
- **anything else** (discuss, yolo, speckit, research, brownfield, map, etc.) →
  1. ! Read `deft/strategies/{strategy-name}.md` **right now, in this same turn**
  2. ! Begin the strategy’s workflow immediately — ask its first question
  3. ! **STOP reading this section** — do NOT use the interview process below

- ⊗ Default to interview without reading PROJECT.md
- ⊗ Continue reading below when PROJECT.md specifies a non-interview strategy
- ⊗ Assume interview because the sections below describe the interview process
- ⊗ Fabricate justification for using interview when the user chose a different strategy
- ⊗ Announce the strategy choice and then stop — you must immediately read the file and start

---

*⬇️ Everything below applies ONLY to the interview strategy. If your strategy is anything else, STOP — follow your strategy file instead.*

### Sizing Gate (interview and yolo strategies only)

! After hearing what the user wants to build and their feature list, determine
project complexity per [strategies/interview.md](../../strategies/interview.md#sizing-gate).

- ! Check `PROJECT.md` for `**Process**: Light` or `**Process**: Full` — if declared, use that path
- ! If not declared, propose a size and **ask the user to confirm in a dedicated message**
- ! **Wait for the user's response** before asking any interview questions
- ⊗ Combine the sizing proposal with the first interview question
- ⊗ Proceed to interview questions before the user has confirmed the path

**Light** (small/medium): Interview → SPECIFICATION with embedded Requirements.
**Full** (large/complex): Interview → PRD.md (user approval) → SPECIFICATION with traceability.

### Interview Process (interview strategy)

Per [strategies/interview.md](../../strategies/interview.md#interview-rules-shared-by-both-paths):

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

### Output — Light Path

1. ! Write `./vbrief/specification.vbrief.json` with `status: draft`
2. ! Summarize decisions, ask user to review
3. ! On approval, update `status` to `approved`
4. ! Generate `./SPECIFICATION.md` (run `task spec:render` if available, else directly)
- ! SPECIFICATION.md MUST include an embedded Requirements section (FR-1, NFR-1)
- ! Each task SHOULD reference which FR/NFR it implements via `(traces: FR-N)`
- ⊗ Create a separate PRD.md on the Light path

! The vBRIEF file MUST conform to `vbrief/schemas/vbrief-core.schema.json`:

- ! All `narratives` and `narrative` values MUST be plain strings — never objects or arrays
- ! Nested children within a PlanItem MUST use `subItems` (not `items`)
- ⊗ Use `items` inside a PlanItem — only `plan.items` is valid; within items use `subItems`

```json
{
  "vBRIEFInfo": { "version": "0.5" },
  "plan": {
    "title": "Project Name SPECIFICATION",
    "status": "draft",
    "narratives": {
      "Overview": "Brief project summary as a plain string.",
      "Architecture": "System design description as a plain string."
    },
    "items": [
      {
        "id": "phase-1",
        "title": "Phase 1: Foundation",
        "status": "pending",
        "subItems": [
          {
            "id": "1.1",
            "title": "Subphase 1.1: Setup",
            "status": "pending",
            "subItems": [
              {
                "id": "1.1.1",
                "title": "Task description",
                "status": "pending",
                "narrative": { "Acceptance": "...", "Traces": "FR-1" }
              }
            ]
          }
        ]
      }
    ]
  }
}
```

### Output — Full Path

1. ! Generate `PRD.md` with structured requirements (Problem Statement, Goals, User Stories, FR/NFR, Success Metrics)
2. ! Ask user to review and approve PRD before proceeding
3. ! Write `./vbrief/specification.vbrief.json` with `status: draft` (same vBRIEF v0.5 structure as Light Path above)
4. ! Summarize decisions, ask user to review
5. ! On approval, update `status` to `approved`
6. ! Generate `./SPECIFICATION.md` (run `task spec:render` if available, else directly)
- ! SPECIFICATION.md MUST trace tasks back to PRD requirement IDs (FR-1, NFR-1)

**Spec Structure (both paths):**
- ! Overview, Requirements (Light) or link to PRD (Full), Architecture
- ! Implementation Plan: Phases → Subphases → Tasks
- ! Explicit dependency mapping between phases
- ~ Tasks designed for parallel work by multiple agents
- ! Testing Strategy and Deployment
- ⊗ Write code — specification only

### Handoff to deft-build

- ! Offer to start building: "Your spec is ready. Want me to start building it now?"
- ~ If platform supports skill invocation, invoke `/deft-build`
- ⊗ Leave user with a dead end — always offer the next step

## Warp Auto-Approve Warning

! **Recommended Warp setting**: Before running deft-setup, ensure Warp's AI autonomy is set to **"Always ask"** in **AI -> Profile Settings**. When set to a higher autonomy level (e.g. "Auto-run"), Warp may silently self-answer interview questions without user input, producing garbage USER.md/PROJECT.md with no error or warning. The post-interview confirmation gate (below) is the last line of defense, but prevention is better than detection.

## Post-Interview Confirmation Gate

! After completing ALL interview questions for any phase (Phase 1, Phase 2, or Phase 3), but BEFORE writing any files:

1. ! Display a **summary of all captured values** in a clearly formatted list -- include every field that will be written to the output file (e.g. name, strategy, coverage, languages, project type, custom rules, etc.)
2. ! Ask the user for explicit confirmation: "These are the values I captured. Write files? (yes/no)"
3. ! Accept only explicit affirmative responses (`yes`, `confirmed`, `approve`) -- reject vague responses (`proceed`, `do it`, `go ahead`) the same way `/deft:change` does
4. ! If the user says `no`: re-display the values and ask which ones to correct, then re-confirm before writing
5. ! If any value appears to be auto-generated filler (e.g. repeated default text, placeholder strings, or values that echo the question prompt), warn the user explicitly: "Some values look like they may have been auto-filled rather than provided by you. Please review carefully."

⊗ Write USER.md, PROJECT.md, SPECIFICATION.md, or any other deft-setup artifact without first displaying captured values and receiving explicit user confirmation.
⊗ Treat a broad "proceed" or "continue" as confirmation to write files -- the user must explicitly confirm the displayed values.

? **Yolo strategy carve-out**: When the user's chosen strategy is `yolo` (auto-pilot), the confirmation gate still applies but the agent (Johnbot) may self-confirm on the user's behalf by displaying the summary and immediately proceeding -- the user has already opted into auto-pilot by selecting yolo. The summary must still be displayed so the user can interrupt if values look wrong.

## Anti-Patterns

- ! When deft-setup generates or updates USER.md or PROJECT.md, the `deft_version` field MUST be set to the current framework version
- ⊗ Generate a USER.md or PROJECT.md without including the `deft_version` field
- ⊗ Explore codebase before Phase 1 questions
- ⊗ Read framework files before first question
- ⊗ Batch multiple questions into one message — ask one at a time, interview style
- ⊗ Ask jargon-heavy questions to non-technical users
- ⊗ Ask about things inferable from codebase (Phase 2+)
- ⊗ Skip phases without asking
- ⊗ Generate files without confirming content
- ⊗ Present choices as plain text when structured tools exist
- ⊗ Resolve paths relative to the skill file, AGENTS.md, or framework directory instead of the user's pwd at skill entry
