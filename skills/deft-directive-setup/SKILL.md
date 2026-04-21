---
name: deft-directive-setup
description: >
  Set up a new project with Deft Directive framework standards. Use when the
  user wants to bootstrap user preferences, configure a project, or generate a
  project specification. Walks through setup conversationally — no separate CLI
  needed.
---

# Deft Directive Setup

Agent-driven alternative to `deft/run bootstrap && deft/run project && deft/run spec`.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## When to Use

- User says "set up deft", "configure deft", or "bootstrap my project"
- User asks to create USER.md, PROJECT-DEFINITION.vbrief.json, or a specification
- User clones a deft-enabled repo for the first time with no config

## Pre-Cutover Detection Guard

! Before proceeding with any setup phase, detect whether the project uses the pre-v0.20 document model and redirect to migration if so.

### Detection Criteria

A project is **pre-cutover** if ANY of the following are true:

1. `SPECIFICATION.md` exists and does NOT contain the `<!-- deft:deprecated-redirect -->` sentinel (real content, not a deprecation redirect)
2. `PROJECT.md` exists and does NOT contain the `<!-- deft:deprecated-redirect -->` sentinel (real content, not a deprecation redirect)
3. `vbrief/specification.vbrief.json` exists but the lifecycle folders (`vbrief/proposed/`, `vbrief/pending/`, `vbrief/active/`, `vbrief/completed/`, `vbrief/cancelled/`) do NOT exist

### Action on Detection

! If pre-cutover state is detected, **stop immediately** and display an actionable message:

> "This project uses the pre-v0.20 document model. Run `task migrate:vbrief` to upgrade to the vBRIEF-centric model."

! Include specific details about what was detected:

- Missing lifecycle folders: "Run `task migrate:vbrief` to create the lifecycle folder structure"
- `SPECIFICATION.md` with real content: "SPECIFICATION.md contains non-redirect content -- this file is deprecated; use scope vBRIEFs in `vbrief/` instead"
- `PROJECT.md` with real content: "PROJECT.md contains non-redirect content -- this file is deprecated; use `PROJECT-DEFINITION.vbrief.json` instead"
- Missing `PROJECT-DEFINITION.vbrief.json`: "Run `task project:render` to generate the project definition"

### Environment Preflight (before asking to run migration)

! Before asking the user "Would you like me to run `task migrate:vbrief` now?", run an environment preflight and report the results to the user. Do NOT ask the yes/no prompt until preflight results have been reported. Each failing check must be surfaced with a specific fix pointer so the user (or agent) can resolve the blocker before approving the run.

Run these three checks, in order:

1. **Task resolvability** -- check whether `task migrate:vbrief` is dispatchable from the project root:
   - Run `task --list` (or platform-equivalent) and grep the output for a line containing `migrate:vbrief`.
   - If present: the primary command works from the project root -- canonical invocation is `task migrate:vbrief`.
   - If absent: the consumer `Taskfile.yml` does not include `deft/Taskfile.yml`. Fall back to the explicit-taskfile invocation `task -t ./deft/Taskfile.yml migrate:vbrief` and tell the user: "`task migrate:vbrief` is not resolvable from the project root. I will use the fallback invocation `task -t ./deft/Taskfile.yml migrate:vbrief`, which reads the task directly from the framework Taskfile. To make the primary command work in future, add an include for `deft/Taskfile.yml` to your project `Taskfile.yml` — see `deft/main.md` § Publishing deft tasks in your project root."
2. **`uv` on PATH** -- the migrator runs `uv run python scripts/migrate_vbrief.py`. Check `uv --version` (or equivalent): if it fails, point the user at the uv install docs (`https://docs.astral.sh/uv/`) and stop; migration cannot run without `uv`.
3. **Migration script present** -- check `deft/scripts/migrate_vbrief.py` exists on disk. If absent, the `deft/` checkout is incomplete or came from a pre-v0.20 framework version; point the user at `deft/QUICK-START.md` (framework refresh guidance) and stop.

! Report each preflight check's result to the user (e.g. "✓ task migrate:vbrief resolvable", "✗ uv not on PATH — install from https://docs.astral.sh/uv/") BEFORE prompting for yes/no approval. If any check fails, do NOT offer to run migration until it is resolved.

⊗ Skip preflight and immediately ask "Would you like me to run `task migrate:vbrief` now?" -- preflight catches preventable errors (unresolvable task, missing `uv`, missing script) before the user commits to running migration.
⊗ Propose an install-step mutation that writes `migrate:vbrief` content into the consumer Taskfile. The supported publish mechanism is the `includes: deft: deft/Taskfile.yml` pattern documented in `deft/main.md` § Publishing deft tasks in your project root; inline Taskfile mutation is explicitly out of scope (per #506 D6).

### Prompt and Run

! After preflight results are reported (and all checks pass), ask the user: "Would you like me to run `task migrate:vbrief` now?"
- If yes: run the migration command (use the fallback invocation `task -t ./deft/Taskfile.yml migrate:vbrief` if the preflight resolvability check found the primary task unresolvable). Then re-run the pre-cutover detection guard to verify clean state before proceeding.
- If no: stop and let the user handle migration manually.

⊗ Proceed with setup phases when pre-cutover artifacts are detected -- always redirect to migration first.
⊗ Silently ignore pre-cutover artifacts -- the user must be informed with an actionable command to fix the state.
⊗ Display the migration diagnostic without offering to run it -- always ask the user if they want the agent to handle it (after preflight has passed).

### Greenfield Projects (No Migration Needed)

! For new projects (no existing `SPECIFICATION.md`, `PROJECT.md`, or `vbrief/specification.vbrief.json`), the guard passes silently and setup proceeds normally.

! Greenfield setup creates the full vBRIEF-centric structure from scratch:

1. `./vbrief/` directory with all 5 lifecycle subdirectories: `proposed/`, `pending/`, `active/`, `completed/`, `cancelled/`
2. `./vbrief/PROJECT-DEFINITION.vbrief.json` generated from Phase 2 interview results
3. First scope vBRIEF created in `proposed/` or `pending/` depending on Phase 3 interview outcome

~ This is already handled by Phase 2 Output Path (creates `./vbrief/` and lifecycle subfolders) and Phase 3 Output (creates scope vBRIEFs in lifecycle folders). The guard ensures migrating projects are redirected before reaching these phases.

### Migration safety flags

`task migrate:vbrief` is destructive by default (it replaces `SPECIFICATION.md` and `PROJECT.md` with redirect stubs and rewrites `vbrief/`), but it carries four always-on / on-demand safety affordances so operators can preview, recover, and undo (#497, #506 D7). Agents offering to run migration MUST mention these and pick the right one for the operator's situation.

- ! **Automatic `.premigrate.*` backups (always-on, no flag)**: before any destructive write the migrator copies every pre-cutover input to its `.premigrate` sibling -- `SPECIFICATION.md` -> `SPECIFICATION.premigrate.md`, `PROJECT.md` -> `PROJECT.premigrate.md`, `ROADMAP.md` -> `ROADMAP.premigrate.md`, `PRD.md` -> `PRD.premigrate.md` (only if present), and `vbrief/specification.vbrief.json` -> `vbrief/specification.premigrate.vbrief.json`. Each backup emits a `BACKUP <src> -> <dst> (<N> bytes)` line in the migration output. These files are `.gitignore`d by default so they do not leak into commits; operators who want them versioned can remove the patterns.
- ! **`task migrate:vbrief -- --dry-run` (preview)**: prints the complete migration plan (every proposed backup, lifecycle folder, narrative ingestion, scope vBRIEF, and deprecation-redirect replacement) prefixed `DRYRUN` without writing any file. Exits 0 on success. Use this before running migration for the first time on an unfamiliar project.
- ! **Dirty-tree guard (always-on)**: if `git status --porcelain` is non-empty the migrator refuses to run and points the operator at `--force`. Keeps migration output separable from in-progress edits. Bypass with `task migrate:vbrief -- --force` only after confirming the operator has accepted the risk.
- ! **`task migrate:vbrief -- --rollback`**: restores every pre-cutover input from its `.premigrate.*` backup and removes the scope vBRIEFs and migration-report files a prior run created. Reads `vbrief/migration/safety-manifest.json` (written by the migrator). Refuses if any redirect stub has been edited since migration -- re-run with `--force` to overwrite those edits on purpose, or commit them before rolling back. Prompts for a yes/no confirmation unless `--force` is passed.

! When a user declines an in-flight migration or reports an incorrect result, offer `task migrate:vbrief -- --rollback` before asking them to edit files by hand.

⊗ Offer `task migrate:vbrief` without also telling the user about `--dry-run` when they sound hesitant -- previewing is free and catches reconciliation surprises that would otherwise land in a commit.
⊗ Suggest `git reset --hard` or manual file deletion as a recovery path when `--rollback` would do the right thing more safely.

## Platform Detection

! Before resolving any config paths, detect the host OS from your environment context:

| Platform           | USER.md default path                                              |
|--------------------|-------------------------------------------------------------------|
| Windows            | `%APPDATA%\deft\USER.md` (e.g. `C:\Users\{user}\AppData\Roaming\deft\USER.md`) |
| Unix (macOS/Linux) | `~/.config/deft/USER.md`                                          |

- ! If `$DEFT_USER_PATH` is set, it takes precedence on any platform
- ! Create parent directories as needed when writing USER.md
- ~ `$DEFT_PROJECT_PATH` overrides the default project config path (`./vbrief/PROJECT-DEFINITION.vbrief.json`) if set

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
- **Defaults** — fallback values that PROJECT-DEFINITION.vbrief.json can override (strategy, coverage)

- ~ Skip if USER.md exists at the platform-appropriate path (see Platform Detection) and user doesn't want to overwrite
- ⊗ Scan filesystem beyond checking that one path

### USER.md Freshness Detection

! When an existing USER.md is found (returning user), check its `deft_version` field before skipping Phase 1:

1. ! If `deft_version` is **missing**: the USER.md predates versioning -- treat as stale
2. ! If `deft_version` is present but **differs from the current framework version** (0.20.0): check whether any expected fields are missing from the USER.md
3. ! If fields are missing: query the user for each missing field individually -- do NOT re-run the full Phase 1 interview
4. ! After completing any field queries (even if none were needed), write the current `deft_version` (0.20.0) to USER.md
5. ~ If `deft_version` matches the current version and all expected fields are present: no action needed (USER.md is fresh)

Expected USER.md fields: **Name**, **Custom Rules**, **Default Strategy**, and optionally **Coverage** and **Experimental Rules**.

⊗ Re-run the full Phase 1 interview when only individual fields are missing from a stale USER.md -- query missing fields individually instead.

### Interview Rules

! This phase follows the deterministic interview loop defined in `skills/deft-directive-interview/SKILL.md`. The core rules (one question per turn, numbered options with stated default, explicit "other" escape, depth gate, default acceptance, confirmation gate, structured handoff) apply here. Key points repeated for emphasis:

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
- Step 2: Ask what they're building (brief description — used for PROJECT-DEFINITION.vbrief.json later)
- Set defaults: strategy = "interview", coverage = 85%, all meta-guidelines included

### Output Path

Resolve using Platform Detection above. Write to the platform-appropriate path
(or `$DEFT_USER_PATH` if set). Create parent directories as needed.

### Template

```markdown
# User Preferences

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**deft_version**: 0.20.0

## Personal (always wins)

Settings in this section have HIGHEST precedence — override all other deft rules,
including PROJECT-DEFINITION.vbrief.json.

**Name**: Address the user as: **{name}**

**Custom Rules**:
{custom rules or "No custom rules defined yet."}

## Defaults (fallback)

Settings in this section are fallback defaults. PROJECT-DEFINITION.vbrief.json overrides these
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

- ! Emit a structured-tool question asking whether to continue to Phase 2 (project configuration). Options: Yes (continue), Not now (exit setup), Discuss, Back (revisit previous phase). Render per the host's rendering mode (click-commit vs plain-text typed) per `skills/deft-directive-interview/SKILL.md` Rule 2 Always-Structured Rendering.
- ⊗ Ask the phase-transition question as plain-text conversational prose -- it is a user-facing question with enumerable paths and MUST go through the structured tool (#478).

---

## Phase 2 — Project Configuration (PROJECT-DEFINITION.vbrief.json)

**Goal:** Project-specific configuration — tech stack, type, quality standards — written as a vBRIEF file at `./vbrief/PROJECT-DEFINITION.vbrief.json`.

! **Path Resolution Anchor**: Resolve ALL paths relative to the user's working directory (pwd) at skill entry -- never relative to the skill file location, AGENTS.md location, or any framework directory (e.g. `./deft/`). When deft is cloned as a subdirectory, the skill file lives inside the clone but all project artifacts (`./vbrief/PROJECT-DEFINITION.vbrief.json`, build files, etc.) must be resolved from the user's pwd.

- ~ Skip if `./vbrief/PROJECT-DEFINITION.vbrief.json` exists (or `$DEFT_PROJECT_PATH` if set) and user doesn't want to replace
- ⊗ Count `./deft/PROJECT-DEFINITION.vbrief.json` or `./deft/core/project.md` as the user's project config — those are framework-internal

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
apply here too. Do not combine questions. See `skills/deft-directive-interview/SKILL.md` for the canonical deterministic interview loop.

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
  If trunk-based: add `Allow direct commits to master: true` to the PROJECT-DEFINITION narratives

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

`./vbrief/PROJECT-DEFINITION.vbrief.json` (or `$DEFT_PROJECT_PATH` if set). Create `./vbrief/` directory and lifecycle subfolders (`proposed/`, `pending/`, `active/`, `completed/`, `cancelled/`) if they don't exist.

### Template

! The output MUST conform to the vBRIEF v0.5 schema (`vbrief/schemas/vbrief-core.schema.json`):

```json
{
  "vBRIEFInfo": {
    "version": "0.5",
    "author": "agent:deft-directive-setup",
    "description": "Project identity gestalt",
    "created": "{ISO-8601 timestamp}"
  },
  "plan": {
    "title": "{Project Name}",
    "status": "running",
    "narratives": {
      "Overview": "{Brief project description}",
      "TechStack": "{project type} using {languages} — {tech stack details}",
      "Strategy": "Use {strategy name} for this project",
      "Quality": "Run task check before every commit. Achieve >= {coverage}% coverage overall + per-module. Store secrets in secrets/ dir.",
      "ProjectRules": "{Any rules the user specified, or 'No project-specific rules defined.'}",
      "Branching": "{If trunk-based: 'Allow direct commits to master: true', else omit or 'Branch-based workflow (default)'}",
      "DeftVersion": "0.20.0"
    },
    "items": []
  }
}
```

- ! All `narratives` values MUST be plain strings — never objects or arrays
- ! `items` starts empty — populated as scope vBRIEFs are created in lifecycle folders

### Then

- ! Emit a structured-tool question asking whether to continue to Phase 3 (specification). Options: Yes (continue), Not now (exit setup), Discuss, Back (revisit previous phase). Render per the host's rendering mode (click-commit vs plain-text typed) per `skills/deft-directive-interview/SKILL.md` Rule 2 Always-Structured Rendering.
- ⊗ Ask the phase-transition question as plain-text conversational prose -- it is a user-facing question with enumerable paths and MUST go through the structured tool (#478).

---

## Phase 3 — Specification

**Goal:** Generate an implementable spec using the strategy chosen in Phase 2, producing a `specification.vbrief.json` draft for human approval before downstream generation.

! **Path Resolution Anchor**: Same rule as Phase 2 -- resolve ALL paths relative to the user's pwd at skill entry, never relative to the skill file, AGENTS.md, or any framework directory.

- ~ Skip if user already has scope vBRIEFs in `./vbrief/` they're happy with
- ! Check `./vbrief/specification.vbrief.json` or `./vbrief/proposed/` for existing scope vBRIEFs
- ⊗ Count ANY file inside `./deft/` as the project's spec — those are framework-internal
  (e.g. `deft/PROJECT.md`, `deft/specs/`, `deft/templates/`, `deft/core/project.md`
  are all part of the framework, NOT the user's project)

### Onboarding Question

! Before proceeding with the strategy gate, ask the onboarding question:

> "Are you adding a scope to this project or starting a new specification?"
> 1. Adding scope to existing project [default if `./vbrief/specification.vbrief.json` exists or scope vBRIEFs found in lifecycle folders]
> 2. Starting a new project specification [default if no specification or scope vBRIEFs exist]

- ! Default based on repo state: if specification.vbrief.json exists or any lifecycle folder has scope vBRIEFs, default to "Adding scope"; otherwise default to "Starting new"
- ! If adding scope: skip the full interview, create a new scope vBRIEF in `./vbrief/proposed/` with the user's description, then exit
- ! If starting new: proceed to the Strategy Gate below

### ⚠️ MANDATORY: Strategy Gate — Do This First

! **STOP.** You MUST determine the correct strategy before doing anything else.

1. ! Open `./vbrief/PROJECT-DEFINITION.vbrief.json` (the file written in Phase 2)
2. ! Find the `narratives.Strategy` value
3. ! Extract the strategy name from the narrative

**Dispatch:**

- **interview** (or default) → Continue to the Sizing Gate below ✅
- **anything else** (discuss, yolo, speckit, research, brownfield, map, etc.) →
  1. ! Read `deft/strategies/{strategy-name}.md` **right now, in this same turn**
  2. ! Begin the strategy's workflow immediately — ask its first question
  3. ! **STOP reading this section** — do NOT use the interview process below

- ⊗ Default to interview without reading PROJECT-DEFINITION.vbrief.json
- ⊗ Continue reading below when PROJECT-DEFINITION.vbrief.json specifies a non-interview strategy
- ⊗ Assume interview because the sections below describe the interview process
- ⊗ Fabricate justification for using interview when the user chose a different strategy
- ⊗ Announce the strategy choice and then stop — you must immediately read the file and start

---

*⬇️ Everything below applies ONLY to the interview strategy. If your strategy is anything else, STOP — follow your strategy file instead.*

### Sizing Gate (interview and yolo strategies only)

! After hearing what the user wants to build and their feature list, determine
project complexity per [strategies/interview.md](../../strategies/interview.md#sizing-gate).

- ! Check `PROJECT-DEFINITION.vbrief.json` narratives for `Light` or `Full` — if declared, use that path
- ! If not declared, propose a size and **ask the user to confirm in a dedicated message**
- ! **Wait for the user's response** before asking any interview questions
- ⊗ Combine the sizing proposal with the first interview question
- ⊗ Proceed to interview questions before the user has confirmed the path

**Light** (small/medium): Interview → `specification.vbrief.json` with slim narratives (Overview + Architecture) → scope vBRIEFs in `vbrief/proposed/`.
**Full** (large/complex): Interview → rich narratives in `specification.vbrief.json` (user approval) → scope vBRIEFs with traceability.

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

1. ! Write `./vbrief/specification.vbrief.json` with `status: draft` and slim narratives:
   - `Overview`: Brief project summary
   - `Architecture`: System design description
2. ! Create scope vBRIEFs in `./vbrief/proposed/` for each identified work item
   - Each scope vBRIEF follows the `YYYY-MM-DD-descriptive-slug.vbrief.json` filename convention
   - Each MUST include embedded Requirements (FR-N, NFR-N) in its `narrative`
   - Each task SHOULD reference which FR/NFR it implements via `narrative.Traces`
3. ! Summarize decisions, ask user to review the vBRIEF narratives
4. ! On approval, update `specification.vbrief.json` status to `approved`
- ⊗ Create a separate PRD.md on the Light path
- ⊗ Generate an authoritative PRD.md — if needed, users run `task prd:render`

! The vBRIEF files MUST conform to `vbrief/schemas/vbrief-core.schema.json`:

- ! All `narratives` and `narrative` values MUST be plain strings — never objects or arrays
- ! Nested children within a PlanItem MUST use `subItems` (not `items`)
- ⊗ Use `items` inside a PlanItem — only `plan.items` is valid; within items use `subItems`

### Output — Full Path

1. ! Write rich narratives to `./vbrief/specification.vbrief.json` `plan.narratives` with `status: draft` and these keys:
   - `ProblemStatement`: What problem this project solves
   - `Goals`: High-level project goals
   - `UserStories`: User stories in standard format
   - `Requirements`: Structured requirements (FR-N: ..., NFR-N: ...)
   - `SuccessMetrics`: Measurable success criteria
   - `Architecture`: System design and technical architecture
   - `Overview`: Brief project summary
2. ! **Human approval gate**: Present the vBRIEF draft narratives to the user for review — reviewing the `specification.vbrief.json` narratives IS the approval step (replaces the former PRD.md review). The user may request changes before approving.
3. ! On approval, update `status` to `approved` and proceed to downstream generation
4. ! Create scope vBRIEFs in `./vbrief/proposed/` with traceability to requirement IDs from the narratives
- ! Scope vBRIEFs MUST trace tasks back to requirement IDs (FR-1, NFR-1) from the `Requirements` narrative
- ⊗ Generate an authoritative PRD.md — if needed, users run `task prd:render`

**Spec Structure (both paths):**
- ! Overview, Architecture
- ! Implementation Plan: scope vBRIEFs in `vbrief/proposed/` with phases and dependencies
- ! Explicit dependency mapping between scopes (via vBRIEF `edges` or `references`)
- ~ Scopes designed for parallel work by multiple agents
- ! Testing Strategy and Deployment captured in narratives
- ⊗ Write code — specification only

### End-of-Phase-3 Export Prompt and Render Gate

! After the human approval gate on `specification.vbrief.json` narratives but BEFORE handing off to `deft-directive-build` (or advancing speckit Phase 3 → Phase 4), ask the user whether to generate human-readable exports. This replaces the invisible skip-if-absent behavior of `task check` (#398) and closes the greenfield gap (#433). This is also the Phase 3 → Phase 4 transition gate required by [strategies/speckit.md Post-Phase 3 Transition Gate](../../strategies/speckit.md#post-phase-3-transition-gate-render-for-review) (#432).

1. ! Prompt: "Your `specification.vbrief.json` is approved. Generate `SPECIFICATION.md` and/or `PRD.md` now? (recommended for stakeholder review)"
   1. Yes — render both
   2. `SPECIFICATION.md` only
   3. `PRD.md` only
   4. Skip — I’ll render later with `task spec:render` / `task prd:render`
2. ! Run the selected render command(s):
   - `task spec:render` → writes `SPECIFICATION.md`
   - `task prd:render` → writes `PRD.md`
3. ! If the user picked a speckit-strategy project: `task spec:render` is **mandatory** at this boundary — invoke it even if the user declined the prompt, because speckit Phase 3 → Phase 4 is gated on `SPECIFICATION.md` existing and matching the current vBRIEF hash.
4. ! Confirm to the user which files were written and remind them that direct edits to `SPECIFICATION.md` / `PRD.md` are overwritten on the next render — edit `specification.vbrief.json` instead.
5. ~ If the user skipped rendering and is NOT on a speckit strategy, no-op and continue.

⊗ Advance a speckit project to Phase 4 without running `task spec:render` at this gate — `SPECIFICATION.md` is required for the Phase 3 transition criterion.
⊗ Silently skip the prompt — greenfield users who never open a PR will miss the exports without it.

### Handoff to deft-directive-build

- ! Emit a structured-tool question asking whether to continue to the build phase. Options: Yes (continue), Not now (exit setup), Discuss, Back (revisit previous phase). Render per the host's rendering mode (click-commit vs plain-text typed) per `skills/deft-directive-interview/SKILL.md` Rule 2 Always-Structured Rendering.
- ~ If platform supports skill invocation and the user picks Yes, invoke `skills/deft-directive-build/SKILL.md`
- ⊗ Leave user with a dead end -- always offer the next step via the structured-tool phase-transition question
- ⊗ Ask the handoff-to-build question as plain-text conversational prose -- it is a user-facing question with enumerable paths and MUST go through the structured tool (#478).

## Warp Auto-Approve Warning

! **Recommended Warp setting**: Before running deft-directive-setup, ensure Warp's AI autonomy is set to **"Always ask"** in **AI -> Profile Settings**. When set to a higher autonomy level (e.g. "Auto-run"), Warp may silently self-answer interview questions without user input, producing garbage USER.md/PROJECT-DEFINITION.vbrief.json with no error or warning. The post-interview confirmation gate (below) is the last line of defense, but prevention is better than detection.

## Post-Interview Confirmation Gate

! After completing ALL interview questions for any phase (Phase 1, Phase 2, or Phase 3), but BEFORE writing any files:

1. ! Display a **summary of all captured values** in a clearly formatted list -- include every field that will be written to the output file (e.g. name, strategy, coverage, languages, project type, custom rules, etc.)
2. ! Ask the user for explicit confirmation: "These are the values I captured. Write files? (yes/no)"
3. ! Accept only explicit affirmative responses (`yes`, `confirmed`, `approve`) -- reject vague responses (`proceed`, `do it`, `go ahead`) the same way `/deft:change` does
4. ! If the user says `no`: re-display the values and ask which ones to correct, then re-confirm before writing
5. ! If any value appears to be auto-generated filler (e.g. repeated default text, placeholder strings, or values that echo the question prompt), warn the user explicitly: "Some values look like they may have been auto-filled rather than provided by you. Please review carefully."

⊗ Write USER.md, PROJECT-DEFINITION.vbrief.json, specification.vbrief.json, or any other deft-directive-setup artifact without first displaying captured values and receiving explicit user confirmation.
⊗ Treat a broad "proceed" or "continue" as confirmation to write files -- the user must explicitly confirm the displayed values.

? **Yolo strategy carve-out**: When the user's chosen strategy is `yolo` (auto-pilot), the confirmation gate still applies but the agent (Johnbot) may self-confirm on the user's behalf by displaying the summary and immediately proceeding -- the user has already opted into auto-pilot by selecting yolo. The summary must still be displayed so the user can interrupt if values look wrong.

## Anti-Patterns

- ! When deft-directive-setup generates or updates USER.md or PROJECT-DEFINITION.vbrief.json, the `deft_version` field MUST be set to the current framework version
- ⊗ Generate a USER.md or PROJECT-DEFINITION.vbrief.json without including the `deft_version` field
- ⊗ Explore codebase before Phase 1 questions
- ⊗ Read framework files before first question
- ⊗ Batch multiple questions into one message — ask one at a time, interview style
- ⊗ Ask jargon-heavy questions to non-technical users
- ⊗ Ask about things inferable from codebase (Phase 2+)
- ⊗ Skip phases without asking
- ⊗ Generate files without confirming content
- ⊗ Present choices as plain text when structured tools exist
- ⊗ Resolve paths relative to the skill file, AGENTS.md, or framework directory instead of the user's pwd at skill entry
- ⊗ Generate an authoritative PRD.md — PRD.md is a read-only export via `task prd:render`, never a source of truth
