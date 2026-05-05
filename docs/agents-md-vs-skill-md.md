# AGENTS.md vs SKILL.md — Directive Architecture Analysis

> When to use the always-loaded AGENTS.md → main.md tree, when to use SKILL.md,
> and what specifically should live where in directive.

---

## Current Architecture

Directive runs both mechanisms in parallel:

- **AGENTS.md** (user's project root) — always loaded at session start on any
  platform that supports agent instructions. Contains: first-session bootstrap
  detection, always-on process rules, skill routing table, alignment confirmation.
- **SKILL.md** (directive root) — entry point on skill-aware platforms (Claude Code,
  Warp, clawd.bot) with `user-invocable: false`, so it auto-loads rather than
  requiring explicit invocation.
- **Individual skills** (`skills/deft-build`, `deft-setup`, `deft-sync`, etc.) —
  invoked on-demand for specific operational workflows.
- **main.md + REFERENCES.md** — the lazy-loading chain: main.md is always read,
  then REFERENCES.md tells the agent which additional files to load based on the
  current task.

---

## The Three Questions

### 1. Pure AGENTS.md vs pure SKILL.md

**The case for skills:**
- Context efficiency — a skill only loads when triggered; AGENTS.md loads on every
  message
- Progressive disclosure — aligns with the harness engineering principle
- Platform alignment — Claude Code, Warp, and clawd.bot are skills-first
- Structural enforcement — platform controls loading; the agent can't accidentally
  skip it
- Testable — `tests/content/test_skills.py` already validates skill structure;
  AGENTS.md compliance is assumed, not verified
- Composable — skills chain each other; file references are passive

**The case for AGENTS.md:**
- Universal platform coverage — AGENTS.md is the universal denominator; Cursor,
  many CI agents, and basic AGENTS.md-only tools have no skill support
- Always-on enforcement — quality gates (`task check`, conventional commits, test
  requirement) are most valuable precisely because they are unconditional; skills
  require a trigger
- Bootstrap problem — first-session detection ("is USER.md missing?") needs something
  loaded unconditionally at session start; skills don't fire without a trigger or
  project detection event
- Alignment confirmation — "Deft Directive active" must fire every session, not on
  a keyword match
- Zero-friction for users — directive "just works" without the user knowing to invoke
  anything

**Verdict: neither extreme is correct.** The entirely-skills model fails on platform
coverage and always-on enforcement. The right model is a thin, focused AGENTS.md with
rich skills for complex workflows.

---

### 2. How lazy loading changes the analysis

Directive's lazy loading (AGENTS.md → main.md → REFERENCES.md → only load files
relevant to the current task) substantially weakens the main argument for skills.

**The strongest pro-skills argument is context efficiency.** Lazy loading largely
defuses this. If AGENTS.md is thin and heavy content is only read on demand, the
context cost of always-loaded AGENTS.md is minimal. You are not paying for `python.md`
on a Go project. Skills don't add much here that lazy loading doesn't already provide.

**Progressive disclosure** is already implemented via file-reading discipline. The
SKILL.md approach moves the mechanism from "agent reads files selectively" to
"platform loads skills selectively." Both serve the same purpose.

**This leaves one concrete difference between the two approaches: enforcement model.**

| Mechanism | How disclosure is enforced | Platform coverage |
|---|---|---|
| AGENTS.md + lazy loading | Behavioral — agent follows instructions | Universal |
| Skills | Structural — platform controls loading | Skill-aware platforms only |

Lazy loading converts AGENTS.md from "always-on blob" to "always-on thin router with
on-demand depth." This means AGENTS.md + lazy loading now competes directly with
skills on context efficiency while still winning on platform coverage.

**The remaining unique advantage of skills** is structural enforcement (the platform
guarantees load behavior, not just the agent's compliance) and operational composition
(skills chain, phases, completion gates). This makes skills the right choice for
complex multi-step workflows — not for reference standards.

---

### 3. What should actually live where

Content in the AGENTS.md → main.md tree falls into two categories:

**Type A: Unconditional rules** — must always be in context regardless of task.
These cannot move to skills without losing platform coverage or enforcement reliability.

**Type B: Conditionally-loaded content** — lazy-loaded when the task requires it,
or explicitly invoked via slash commands. These are the candidates for migration.

---

## Concrete Recommendations

### Keep in AGENTS.md / main.md (unconditional rules)

These must always be in context. Moving them to skills creates enforcement gaps on
non-skill platforms.

- Agent persona and communication style
- Quality gates: `task check` before commits, test requirement, forward coverage rule
- Branch rule: `⊗` direct commits to default branch
- `/deft:change` gate (must fire unconditionally on 3+ file changes)
- vBRIEF file placement rules (where vBRIEF files must live)
- Skill routing table (thin keyword → skill mappings)
- Continuous improvement (`lessons.md`, `ideas.md`)

---

### Keep in the lazy-load chain / REFERENCES.md (reference standards)

These are standards an agent consults mid-task, not operational workflows. Lazy loading
is exactly right: the agent reads them when the task calls for it. Skills require a
trigger; these require availability. No migration needed.

- Language standards: `python.md`, `go.md`, `typescript.md`, `cpp.md`, and all others
- Interface patterns: `cli.md`, `rest.md`, `tui.md`, `web.md`
- Tool guides: `taskfile.md`, `git.md`, `github.md`, `telemetry.md`
- `coding/coding.md`, `coding/testing.md`
- `vbrief/vbrief.md` (consulted while working with vBRIEF files, not invoked)
- `context/` files (conceptual/educational, not operational procedures)

---

### Move to SKILL.md (operational workflows, explicitly invoked)

These already *behave* like skills — they require explicit invocation, have multi-step
logic, defined phases, and completion gates. The only reason they are not skills is
historical. Converting them to SKILL.md adds platform discoverability, testability,
and structural enforcement without changing the user experience.

**Strategies** (`interview.md`, `discuss.md`, `research.md`, `speckit.md`, `map.md`,
`yolo.md`, `bdd.md`, etc.)
Currently: file read via `/deft:run:X` slash command routing in main.md.
Problem: the slash command IS skill routing, but the content isn't a skill.
Should be: proper `SKILL.md` files with triggers matching the current slash commands.
The slash command routing table in main.md becomes skill trigger routing pointing at
skill directories rather than `.md` files.
Priority: **high** — this is the largest single cohesive opportunity.

**Change lifecycle** (`commands.md`, `/deft:change` workflow)
Currently: lazy-loaded via main.md slash commands; complex multi-step workflow
(create → apply → verify → archive) spread across `commands.md` and `history/`.
Should be: `deft-change` skill. Classic skill territory: explicit invocation, defined
phases, state tracked in vBRIEF.
Priority: **high**.

**Verification protocol** (`verification/verification.md` and sub-files)
Currently: lazy-loaded "when completing tasks, before marking work done."
`deft-pre-pr` skill already exists and covers this ground.
Problem: two parallel paths to the same outcome creates confusion about which is
authoritative.
Should be: absorbed into `deft-pre-pr` skill, which becomes the sole entry point.
`verification/*.md` files become reference material linked from the skill.
Remove the verification entries from REFERENCES.md.
Priority: **medium** — primarily a cleanup.

**Session resilience** (`resilience/continue-here.md`, `/deft:continue`)
Currently: lazy-loaded + thin slash command in main.md.
Should be: `deft-continue` skill. `/deft:continue` already signals explicit invocation.
A skill gives it proper discoverability and enforces the single-question intake.
Priority: **medium**.

---

### Fix duplication (skill exists AND lazy-load reference exists)

Where a skill covers a workflow and a `.md` file is also in REFERENCES.md for the
same workflow, the skill should be the authoritative entry point. The `.md` file
becomes reference material linked from the skill, not a parallel lazy-load path.

**`swarm/swarm.md` + `deft-swarm` skill**
Remove `swarm/swarm.md` from REFERENCES.md. `deft-swarm` skill becomes the entry
point. `swarm/swarm.md` stays as a detailed reference the skill links to.

**`resilience/continue-here.md` + future `deft-continue` skill**
Same pattern once `deft-continue` is created.

---

## Decision Rule (for future content)

> **Is this an operational procedure with defined phases, explicit invocation, and a
> completion gate?** → Skill.
>
> **Is this a standard or guideline an agent reads while doing something else?**
> → Lazy-loaded reference in REFERENCES.md.
>
> **Must this fire unconditionally on every session regardless of task?**
> → AGENTS.md / main.md.

---

## What This Means for directive's Evolution

As directive grows, this framework prevents AGENTS.md and main.md from bloating.
New operational workflows (e.g., `deft-change`, strategy-as-skills, `deft-continue`)
move to skills and get their own tested, versioned `SKILL.md` files. New standards
(new language files, new tool guides) go into REFERENCES.md for lazy loading. The
always-on layer stays lean.

The lazy loading mechanism is directive's critical enabler: it makes AGENTS.md viable
as a universal entry point without context bloat, which means platform coverage does
not have to be sacrificed for context efficiency. Skills then add structural
enforcement and composition on top of that foundation, for the workflows that need it.
