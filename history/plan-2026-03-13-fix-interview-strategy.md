# Fix #36: Reconcile Interview Strategy

## Problem
`strategies/interview.md` defines a 3-phase flow (Interview → PRD → SPECIFICATION) that neither the CLI (`cmd_spec`) nor the agent (`deft-setup` Phase 3) actually follows. Both use `templates/make-spec.md` which has a simpler 2-phase flow. The strategy selected in `PROJECT.md` has no effect on the actual pipeline. This is the original design on master — not a regression.

## Current State
- `strategies/interview.md` — 3-phase with PRD, never invoked by anything
- `templates/make-spec.md` — 2-phase, the actual source of truth for both pipelines
- `skills/deft-setup/SKILL.md` Phase 3 — explicitly says "No intermediate PRD.md needed"
- `cmd_spec` in `run` — creates fake PRD.md (just make-spec template with a header)
- `yolo.md` — mirrors interview.md's 3-phase structure (also unused)
- `vbrief/vbrief.md` — references make-spec.md as spec source, shows 2-phase flow diagram
- `strategies/README.md` — lists interview as "Interview → PRD → SPECIFICATION" (inaccurate)

## Design: Sizing Gate
Add a complexity gate early in the interview that selects one of two paths:

**Light** (small/medium projects):
- Interview → `vbrief/specification.vbrief.json` → `SPECIFICATION.md`
- No separate PRD.md
- Requirements (FR-1, NFR-1) embedded as a section at the top of SPECIFICATION.md
- Traceability preserved without the extra file

**Full** (large/complex projects):
- Interview → `PRD.md` (approval gate) → `vbrief/specification.vbrief.json` → `SPECIFICATION.md`
- PRD.md has structured requirements: Problem Statement, Goals, User Stories, FR/NFR, Success Metrics
- User approves PRD before spec generation begins
- SPECIFICATION.md traces tasks back to PRD requirement IDs

**Sizing signals** (AI proposes, user confirms):
- Number of features (≤5 → Light, >5 → Full)
- Number of components/services (1-2 → Light, 3+ → Full)
- Expected duration (days → Light, weeks/months → Full)
- Team/agent count (solo → Light, multi-agent/swarm → Full)
- Integration complexity (standalone → Light, external APIs/auth/DB → Full)

**Override**: `PROJECT.md` can declare `**Process**: Light` or `**Process**: Full` to skip the gate.

## Changes

### 1. `strategies/interview.md` — Single source of truth
Rewrite to include:
- Sizing gate section with criteria and override mechanism
- Light path (2-phase): current make-spec behavior + embedded Requirements section
- Full path (3-phase): current interview.md behavior (PRD → SPECIFICATION)
- Both paths share the same interview rules (one question at a time, options, recommended, etc.)
- Both paths produce `vbrief/specification.vbrief.json`
- Full path also produces `vbrief/plan.vbrief.json` and `PRD.md`
- Artifact summary table updated for both paths

### 2. `templates/make-spec.md` — Align with interview.md
- Add reference: "This template implements `strategies/interview.md`. See that file for the full strategy."
- Add sizing gate instructions that match interview.md
- Light path: interview → vbrief → SPECIFICATION with embedded Requirements section
- Full path: interview → PRD → vbrief → SPECIFICATION with FR/NFR traceability
- Add SPECIFICATION template showing the embedded Requirements section (for Light path)
- Keep existing interview rules (one question, options, recommended) — they're already correct

### 3. `skills/deft-setup/SKILL.md` Phase 3
- Remove line 269 ("No intermediate PRD.md needed — already in conversation")
- Add sizing gate: after hearing what user wants to build, propose Light or Full
- Reference `strategies/interview.md` as authoritative for the interview process
- Light path: current behavior (interview → vbrief → SPECIFICATION) plus embedded requirements
- Full path: interview → write PRD.md → user approval → vbrief → SPECIFICATION
- Update the Available Strategies table (line 66-73): change "default" description from "Structured interview → PRD → SPECIFICATION" to reflect the sizing gate

### 4. `run` — `cmd_spec` function
- Add sizing question after features are entered: "Project complexity: 1. Light (recommended for ≤5 features) 2. Full (recommended for complex/multi-service projects)"
- Read `PROJECT.md` for `**Process**: Light/Full` override — skip the question if declared
- Light path: create instruction sheet referencing interview.md Light path (current behavior, improved)
- Full path: create a real PRD template with structured sections (Problem Statement, Goals, User Stories, FR/NFR, Success Metrics) plus interview instructions
- Both paths: tell user to give the output file to AI, and tell the AI to read `strategies/interview.md`
- Rename output from `PRD.md` to `INTERVIEW.md` for Light path (it's not a PRD), keep `PRD.md` for Full

### 5. `strategies/yolo.md` — Mirror interview.md updates
- Add sizing gate (Johnbot picks the size too)
- Update Light/Full paths to match interview.md
- Keep the Johnbot auto-answer behavior

### 6. `strategies/README.md`
- Update interview.md description: "Standard projects (default) — with sizing gate: Light (Interview → SPECIFICATION) or Full (Interview → PRD → SPECIFICATION)"
- Update yolo.md similarly
- Note that `rapid.md` (future) maps to forced-Light, `enterprise.md` (future) maps to forced-Full

### 7. `vbrief/vbrief.md` — Update specification flow
- Update the flow diagram (lines 168-191) to show both Light and Full paths
- Change reference from `make-spec.md` to `strategies/interview.md` as the canonical source (line 120)

### 8. `SKILL.md` (root) — Update SDD reference
- Line 112-113: update "Run `deft/run spec` to generate PRD.md via AI interview" to reflect sizing gate
- Line 145: `deft/run spec` description should mention Light/Full

### 9. `PROJECT.md` template in `cmd_project`
- Add `**Process**:` field to the generated template (default empty = AI decides)
- This gives users the override mechanism

## File Impact Summary
- `strategies/interview.md` — major rewrite
- `templates/make-spec.md` — moderate rewrite
- `skills/deft-setup/SKILL.md` — Phase 3 rewrite (~30 lines)
- `run` — `cmd_spec` changes (~50 lines), `cmd_project` template addition (~3 lines)
- `strategies/yolo.md` — mirror interview.md changes
- `strategies/README.md` — table update
- `vbrief/vbrief.md` — diagram and reference update
- `SKILL.md` — 2-3 line updates
- `main.md` — no changes needed (slash command descriptions are generic enough)

## Order of Operations
1. `strategies/interview.md` first — establishes the canonical design
2. `templates/make-spec.md` — aligns the template
3. `skills/deft-setup/SKILL.md` — aligns the agent path
4. `run` (`cmd_spec` + `cmd_project`) — aligns the CLI path
5. `strategies/yolo.md` — mirrors interview.md
6. `strategies/README.md`, `vbrief/vbrief.md`, `SKILL.md` — reference updates
7. Test: verify both paths work end-to-end

## Out of Scope
- `rapid.md` / `enterprise.md` (future strategies — just note alignment in README)
- Go installer changes (AGENTS.md content is already correct — it points to SKILL.md)
- `deft-build/SKILL.md` (no changes needed — it reads SPECIFICATION.md regardless of path)
- vbrief schema changes (existing schema supports both paths)
