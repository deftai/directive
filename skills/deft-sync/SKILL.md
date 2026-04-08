---
name: deft-sync
description: >
  Session-start framework sync skill. Use when user says good morning,
  update deft, update vbrief, or sync frameworks. Pulls latest deft
  submodule, validates project files, and summarizes changes.
triggers:
  - good morning
  - update deft
  - update vbrief
  - sync frameworks
---

# Deft Sync

Session-start framework sync -- pull latest deft submodule updates and validate project files.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## When to Use

- User says "good morning", "update deft", "update vbrief", or "sync frameworks"
- Beginning of a new session where framework updates may be available
- After a known upstream deft release

## Phase 1 -- Pre-flight

! Check that the deft/ submodule working tree is clean before attempting any update.

1. ! Run `git -C deft status --porcelain`
2. ! If output is non-empty (dirty working tree): **stop** and ask user whether to stash (`git -C deft stash`) or abort the sync entirely. Do NOT proceed with a dirty submodule.
3. ! Record the current DEFT commit for later comparison:
   ```
   git -C deft log --oneline -1
   ```
4. ! Present the current state to the user:
   - Current DEFT commit (hash + subject)
   - Clean/dirty status
   - Confirmation that pre-flight passed (or the blocker if dirty)

## Phase 2 -- Update DEFT Submodule

1. ! Run the submodule update:
   ```
   git submodule update --remote --merge deft
   ```
2. ! Show what changed by comparing before/after:
   ```
   git -C deft log --oneline <old-hash>..HEAD
   ```
3. ~ If no new commits, report "deft submodule already up to date" and proceed to Phase 3.

## Phase 3 -- Project Sync

After updating the submodule, validate project-level files against the updated framework.

### 3a: Validate vBRIEF files

! Validate all `./vbrief/*.vbrief.json` files against the vendored schema:

1. ! Check each file is valid JSON (`python3 -m json.tool` or equivalent)
2. ! Verify structural conformance:
   - Top-level `vBRIEFInfo` envelope with `version` field present
   - `plan` object with `title`, `status`, and `items` fields present
   - Task-level `status` values from valid enum: pending, running, completed, blocked, cancelled
3. ~ Use `scripts/spec_validate.py` if available for deeper validation
4. ! Report any validation failures with file name and specific violation

⊗ Overwrite or modify project-level `./vbrief/*.vbrief.json` files -- those are project data, not framework files. Report issues and let the user decide how to fix them.

### 3b: Check AGENTS.md freshness

~ Compare the project's `AGENTS.md` against the deft template (if a template exists in the updated `deft/` submodule):

1. ~ Diff the structure (section headings, key rules) rather than expecting byte-identical content
2. ~ Report any new sections or rules added upstream that are missing locally
3. ~ Do NOT auto-overwrite -- present differences and let the user decide

### 3c: List new skills

! Compare the `skills/` directory before and after the update:

1. ! List any new skill directories added in the update
2. ~ For each new skill, read its frontmatter `description` field and present a one-liner
3. ~ Mention if any existing skills were updated (changed files)

## Phase 4 -- Summary

! Present a consolidated summary to the user covering:

1. **DEFT version change**: old commit -> new commit (or "already up to date")
2. **vBRIEF validation results**: pass/fail per file, with details on any failures
3. **AGENTS.md status**: current / has upstream changes / needs review
4. **New skills**: list any newly added skills with descriptions

! Ask the user: "Shall I commit the submodule update?" -- do NOT auto-commit.

? If the user confirms, commit with message:
```
chore(deft): update deft submodule to <short-hash>
```

## Anti-Patterns

- ⊗ Auto-commit submodule changes without user approval
- ⊗ Overwrite project-level `./vbrief/*.vbrief.json` files -- those are project data
- ⊗ Skip the pre-flight dirty check -- a dirty submodule can cause merge conflicts or data loss
- ⊗ Include a separate fetch of the vBRIEF schema from upstream deftai/vBRIEF -- that is a CI concern (see #128), not a user sync task
