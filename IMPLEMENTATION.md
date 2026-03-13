# Implementation: Fix #36 — Reconcile Interview Strategy

**Issue**: [#36](https://github.com/visionik/deft/issues/36)
**Plan**: `history/plan-2026-03-13-fix-interview-strategy.md`
**Branch**: `beta`
**Status**: Complete

**Standards**: All changes MUST follow deft framework best practices as defined in `deft/main.md`, `deft/coding/coding.md`, applicable language files in `deft/languages/`, and `deft/scm/git.md`. Use RFC 2119 notation in all `.md` files. Run `task check` before committing. MUST NOT push without explicit user approval.

---

## Phase 1: Canonical Strategy (interview.md)

### Task 1.1: Rewrite `strategies/interview.md`
- [x] Add sizing gate section (Light vs Full) with criteria
- [x] Define Light path: Interview → vbrief → SPECIFICATION (embedded FR/NFR)
- [x] Define Full path: Interview → PRD → vbrief → SPECIFICATION (traceability)
- [x] Shared interview rules (one question, options, recommended, "other")
- [x] PROJECT.md `**Process**:` override mechanism
- [x] Artifact summary table for both paths
- [x] Mermaid diagram updated to show both paths

**Acceptance**: interview.md is self-contained and defines both paths completely.

---

## Phase 2: Template Alignment (make-spec.md)

### Task 2.1: Rewrite `templates/make-spec.md`
- [x] Add reference to interview.md as authoritative source
- [x] Add sizing gate instructions matching interview.md
- [x] Light path: interview → vbrief → SPECIFICATION with embedded Requirements
- [x] Full path: interview → PRD → vbrief → SPECIFICATION with FR/NFR IDs
- [x] Add SPECIFICATION template with embedded Requirements section (Light)
- [x] Add PRD template with structured sections (Full)
- [x] Keep existing interview rules (already correct)

**Acceptance**: make-spec.md references interview.md and implements both paths.

---

## Phase 3: Agent Path (deft-setup)

### Task 3.1: Update `skills/deft-setup/SKILL.md` Phase 3
- [x] Remove "No intermediate PRD.md needed" (line 269)
- [x] Add sizing gate after initial project description
- [x] Reference interview.md as authoritative for interview process
- [x] Light: current behavior + embedded requirements
- [x] Full: interview → PRD.md → user approval → vbrief → SPECIFICATION
- [x] Update Available Strategies table (lines 66-73)

**Acceptance**: deft-setup Phase 3 follows interview.md for both Light and Full.

---

## Phase 4: CLI Path (run)

### Task 4.1: Update `cmd_spec` in `run`
- [x] Add sizing question after features entered
- [x] Read PROJECT.md for `**Process**:` override
- [x] Light path: create instruction sheet (rename output to `INTERVIEW.md`)
- [x] Full path: create real PRD template with structured sections
- [x] Both paths: instruct AI to read `strategies/interview.md`

### Task 4.2: Update `cmd_project` template in `run`
- [x] Add `**Process**:` field to generated PROJECT.md (default empty = AI decides)

**Acceptance**: `run spec` asks sizing question, produces correct output for each path.

---

## Phase 5: Sibling Strategy (yolo.md)

### Task 5.1: Update `strategies/yolo.md`
- [x] Add sizing gate (Johnbot picks the size)
- [x] Update Light/Full paths to match interview.md
- [x] Keep Johnbot auto-answer behavior

**Acceptance**: yolo.md mirrors interview.md structure with auto-pilot behavior.

---

## Phase 6: Reference Updates

### Task 6.1: Update `strategies/README.md`
- [x] Update interview.md row to reflect sizing gate
- [x] Update yolo.md row similarly
- [x] Note rapid.md → forced-Light, enterprise.md → forced-Full (future)

### Task 6.2: Update `vbrief/vbrief.md`
- [x] Update spec flow diagram (lines 168-191) for both paths
- [x] Change canonical reference from make-spec.md to interview.md (line 120)

### Task 6.3: Update `SKILL.md` (root)
- [x] Update SDD description (lines 112-113) to reflect sizing gate
- [x] Update `deft/run spec` description (line 145)

### Task 6.4: Update `main.md`
- [x] Update slash command descriptions for interview and yolo strategies

**Acceptance**: All cross-references are consistent and point to interview.md as source of truth.

---

## Phase 7: Verification

### Task 7.1: Content integrity
- [x] Run `task check` (if available) — Python script parses cleanly
- [x] Verify no broken internal links across changed files
- [x] Confirm interview.md is referenced (not make-spec.md) as canonical source

### Task 7.2: Walkthrough
- [x] Trace CLI path: `run project` → `run spec` (Light) → verify output
- [x] Trace CLI path: `run project` → `run spec` (Full) → verify output
- [x] Trace agent path: SKILL.md → deft-setup Phase 3 → verify instructions
- [x] Confirm PROJECT.md `**Process**:` override works in cmd_spec

---

## Completion Checklist
- [x] All phases complete
- [ ] Commit with `fix(strategies): reconcile interview strategy (#36)`
- [ ] Un-draft PR #35 (merging closes #36)
- [ ] Move this file to `history/implementation-2026-XX-XX-fix-interview-strategy.md`
