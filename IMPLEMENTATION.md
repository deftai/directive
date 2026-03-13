# Implementation: Fix #36 — Reconcile Interview Strategy

**Issue**: [#36](https://github.com/visionik/deft/issues/36)
**Plan**: `history/plan-2026-03-13-fix-interview-strategy.md`
**Branch**: `beta`
**Status**: In Progress

**Standards**: All changes MUST follow deft framework best practices as defined in `deft/main.md`, `deft/coding/coding.md`, applicable language files in `deft/languages/`, and `deft/scm/git.md`. Use RFC 2119 notation in all `.md` files. Run `task check` before committing. MUST NOT push without explicit user approval.

---

## Phase 1: Canonical Strategy (interview.md)

### Task 1.1: Rewrite `strategies/interview.md`
- [ ] Add sizing gate section (Light vs Full) with criteria
- [ ] Define Light path: Interview → vbrief → SPECIFICATION (embedded FR/NFR)
- [ ] Define Full path: Interview → PRD → vbrief → SPECIFICATION (traceability)
- [ ] Shared interview rules (one question, options, recommended, "other")
- [ ] PROJECT.md `**Process**:` override mechanism
- [ ] Artifact summary table for both paths
- [ ] Mermaid diagram updated to show both paths

**Acceptance**: interview.md is self-contained and defines both paths completely.

---

## Phase 2: Template Alignment (make-spec.md)

### Task 2.1: Rewrite `templates/make-spec.md`
- [ ] Add reference to interview.md as authoritative source
- [ ] Add sizing gate instructions matching interview.md
- [ ] Light path: interview → vbrief → SPECIFICATION with embedded Requirements
- [ ] Full path: interview → PRD → vbrief → SPECIFICATION with FR/NFR IDs
- [ ] Add SPECIFICATION template with embedded Requirements section (Light)
- [ ] Add PRD template with structured sections (Full)
- [ ] Keep existing interview rules (already correct)

**Acceptance**: make-spec.md references interview.md and implements both paths.

---

## Phase 3: Agent Path (deft-setup)

### Task 3.1: Update `skills/deft-setup/SKILL.md` Phase 3
- [ ] Remove "No intermediate PRD.md needed" (line 269)
- [ ] Add sizing gate after initial project description
- [ ] Reference interview.md as authoritative for interview process
- [ ] Light: current behavior + embedded requirements
- [ ] Full: interview → PRD.md → user approval → vbrief → SPECIFICATION
- [ ] Update Available Strategies table (lines 66-73)

**Acceptance**: deft-setup Phase 3 follows interview.md for both Light and Full.

---

## Phase 4: CLI Path (run)

### Task 4.1: Update `cmd_spec` in `run`
- [ ] Add sizing question after features entered
- [ ] Read PROJECT.md for `**Process**:` override
- [ ] Light path: create instruction sheet (rename output to `INTERVIEW.md`)
- [ ] Full path: create real PRD template with structured sections
- [ ] Both paths: instruct AI to read `strategies/interview.md`

### Task 4.2: Update `cmd_project` template in `run`
- [ ] Add `**Process**:` field to generated PROJECT.md (default empty = AI decides)

**Acceptance**: `run spec` asks sizing question, produces correct output for each path.

---

## Phase 5: Sibling Strategy (yolo.md)

### Task 5.1: Update `strategies/yolo.md`
- [ ] Add sizing gate (Johnbot picks the size)
- [ ] Update Light/Full paths to match interview.md
- [ ] Keep Johnbot auto-answer behavior

**Acceptance**: yolo.md mirrors interview.md structure with auto-pilot behavior.

---

## Phase 6: Reference Updates

### Task 6.1: Update `strategies/README.md`
- [ ] Update interview.md row to reflect sizing gate
- [ ] Update yolo.md row similarly
- [ ] Note rapid.md → forced-Light, enterprise.md → forced-Full (future)

### Task 6.2: Update `vbrief/vbrief.md`
- [ ] Update spec flow diagram (lines 168-191) for both paths
- [ ] Change canonical reference from make-spec.md to interview.md (line 120)

### Task 6.3: Update `SKILL.md` (root)
- [ ] Update SDD description (lines 112-113) to reflect sizing gate
- [ ] Update `deft/run spec` description (line 145)

**Acceptance**: All cross-references are consistent and point to interview.md as source of truth.

---

## Phase 7: Verification

### Task 7.1: Content integrity
- [ ] Run `task check` (if available)
- [ ] Verify no broken internal links across changed files
- [ ] Confirm interview.md is referenced (not make-spec.md) as canonical source

### Task 7.2: Walkthrough
- [ ] Trace CLI path: `run project` → `run spec` (Light) → verify output
- [ ] Trace CLI path: `run project` → `run spec` (Full) → verify output
- [ ] Trace agent path: SKILL.md → deft-setup Phase 3 → verify instructions
- [ ] Confirm PROJECT.md `**Process**:` override works in cmd_spec

---

## Completion Checklist
- [ ] All phases complete
- [ ] Commit with `fix(strategies): reconcile interview strategy (#36)`
- [ ] Un-draft PR #35 (merging closes #36)
- [ ] Move this file to `history/implementation-2026-XX-XX-fix-interview-strategy.md`
