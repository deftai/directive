---
name: deft-directive-sync
description: >
  Session-start framework sync skill. Pulls latest deft submodule,
  validates vBRIEF lifecycle structure, checks folder/status consistency,
  detects stale origins (RFC D12), and summarizes changes.
triggers:
  - good morning
  - update deft
  - update vbrief
  - sync frameworks
---

# Deft Directive Sync

Session-start framework sync -- pull latest deft submodule updates, validate vBRIEF lifecycle structure, and detect stale origins.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Platform Requirements

! This skill requires **GitHub** as the SCM platform and the **GitHub CLI (`gh`)** to be installed and authenticated. Origin freshness checks (Phase 5) fetch issue data via `gh issue view`.

## When to Use

- User says "good morning", "update deft", "update vbrief", or "sync frameworks"
- Beginning of a new session where framework updates may be available
- After a known upstream deft release

## Pre-Cutover Detection Guard

! Before proceeding with sync, detect whether the project uses the pre-v0.20 document model and report model state.

### Detection Criteria

A project is **pre-cutover** if ANY of the following are true:

1. `SPECIFICATION.md` exists and does NOT contain the `<!-- deft:deprecated-redirect -->` sentinel (real content, not a deprecation redirect)
2. `PROJECT.md` exists and does NOT contain the `<!-- deft:deprecated-redirect -->` sentinel (real content, not a deprecation redirect)
3. `vbrief/specification.vbrief.json` exists but the lifecycle folders (`vbrief/proposed/`, `vbrief/pending/`, `vbrief/active/`, `vbrief/completed/`, `vbrief/cancelled/`) do NOT exist

### Action on Detection

! If pre-cutover state is detected, display the actionable migration message, then **skip Phases 1-6** and proceed directly to Phase 7 with the Document Model line set to "pre-v0.20 (legacy)":

> "This project uses the pre-v0.20 document model. Run `task migrate:vbrief` to upgrade to the vBRIEF-centric model."

! Include specific details about what was detected:

- Missing lifecycle folders: "Run `task migrate:vbrief` to create the lifecycle folder structure"
- `SPECIFICATION.md` with real content: "SPECIFICATION.md contains non-redirect content -- this file is deprecated; use scope vBRIEFs in `vbrief/` instead"
- `PROJECT.md` with real content: "PROJECT.md contains non-redirect content -- this file is deprecated; use `PROJECT-DEFINITION.vbrief.json` instead"
- Missing `PROJECT-DEFINITION.vbrief.json`: "Run `task project:render` to generate the project definition"
- Scope vBRIEF in wrong folder: "Status is '{status}' but file is in {folder}/ -- run `task scope:activate <file>` to fix"

### Model State in Sync Output

! Include a **Document Model** line in the Phase 7 summary:

- Pre-cutover detected: "**Document Model**: pre-v0.20 (legacy) -- run `task migrate:vbrief` to upgrade"
- Post-cutover (lifecycle folders present, no stale artifacts): "**Document Model**: v0.20+ (vBRIEF-centric) -- OK"
- Post-cutover with tampered placeholders: "**Document Model**: v0.20+ with warnings -- SPECIFICATION.md or PROJECT.md contains non-redirect content"

⊗ Skip model state detection during sync -- always report the document model state.
⊗ Silently ignore pre-cutover artifacts -- the user must be informed with an actionable command to fix the state.

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

## Phase 3 -- Structure Validation

! Validate the vBRIEF lifecycle folder structure and project files.

### 3a: Lifecycle Folder Structure

! Verify all required lifecycle folders exist:

1. ! Check that the following directories exist under `./vbrief/`:
   - `proposed/`
   - `pending/`
   - `active/`
   - `completed/`
   - `cancelled/`
2. ! Report any missing folders with a clear warning:
   - "WARNING: vbrief/{folder}/ does not exist -- lifecycle structure is incomplete"
3. ~ If folders are missing, suggest running `task migrate:vbrief` or creating them manually

### 3b: PROJECT-DEFINITION.vbrief.json Validation

! Validate the project identity gestalt file:

1. ! Check that `./vbrief/PROJECT-DEFINITION.vbrief.json` exists
   - If missing: "WARNING: PROJECT-DEFINITION.vbrief.json not found -- run `task project:render` to create"
2. ! If the file exists, validate it is well-formed:
   - Valid JSON (`python3 -m json.tool` or equivalent)
   - Top-level `vBRIEFInfo` envelope with `version` field equal to `"0.5"`
   - `plan` object with `title`, `status`, and `items` fields present
   - `plan.narratives` values are plain strings (not objects or arrays)
3. ! **Freshness check**: Compare `vBRIEFInfo.updated` (or `vBRIEFInfo.created` if no `updated`) against recent scope completions:
   - Scan `vbrief/completed/` for vBRIEFs with `vBRIEFInfo.updated` timestamps newer than the PROJECT-DEFINITION timestamp
   - If stale: "WARNING: PROJECT-DEFINITION.vbrief.json may be stale -- {N} scopes completed since last update. Run `task project:render` to refresh."

### 3c: Validate Root-Level vBRIEF Files

! Validate all `./vbrief/*.vbrief.json` files at the vbrief root:

1. ! Check each file is valid JSON
2. ! Verify structural conformance:
   - Top-level `vBRIEFInfo` envelope with `version` field present
   - `plan` object with `title`, `status`, and `items` fields present
   - `plan.status` values from valid enum: draft, proposed, approved, pending, running, completed, blocked, cancelled
3. ~ Use `task vbrief:validate` if available for deeper validation
4. ! Report any validation failures with file name and specific violation

⊗ Overwrite or modify project-level `./vbrief/*.vbrief.json` files -- those are project data, not framework files. Report issues and let the user decide how to fix them.

## Phase 4 -- Lifecycle Consistency Check

! Verify that each scope vBRIEF's `plan.status` matches its folder location.

1. ! Scan all scope vBRIEFs in lifecycle folders (`proposed/`, `pending/`, `active/`, `completed/`, `cancelled/`)
2. ! For each vBRIEF, check `plan.status` against the expected statuses for its folder:
   - `proposed/`: status should be `draft` or `proposed`
   - `pending/`: status should be `approved` or `pending`
   - `active/`: status should be `running` or `blocked`
   - `completed/`: status should be `completed`
   - `cancelled/`: status should be `cancelled`
3. ! Report any mismatches:
   - "MISMATCH: {filename} in {folder}/ has status '{status}' -- expected one of [{expected_statuses}]"
4. ~ Per vbrief.md convention, trust the status field and suggest correcting the folder location:
   - "Suggested fix: move {filename} to {correct_folder}/ (status '{status}' is authoritative)"

⊗ Auto-move vBRIEFs to fix folder/status mismatches -- report only; user decides during refinement or ad-hoc

## Phase 5 -- Origin Freshness (RFC D12)

! For vBRIEFs with external origin references, detect staleness and externally-closed origins.

### Step 1: Scan Origins

1. ! For each vBRIEF in `proposed/` and `pending/` with a `github-issue` reference in `plan.references` or top-level `references`:
   - Extract the issue number from the reference URL or `id` field
   - Fetch the issue: `gh issue view {N} --repo {owner/repo} --json updatedAt,state`
2. ! Compare the issue's `updatedAt` against the vBRIEF's `vBRIEFInfo.updated` (or `vBRIEFInfo.created` if no `updated` field)

### Step 2: Categorize and Report

1. ! **Stale origins** -- issue `updatedAt` is newer than vBRIEF `updated` timestamp:
   - "{N} vBRIEFs have origins updated since last sync"
   - List each: "{filename}: Issue #{N} updated {time_delta} ago"
2. ! **Externally closed origins** -- issue state is `CLOSED`:
   - "{N} vBRIEFs have origins that were closed externally"
   - List each: "{filename}: Issue #{N} is closed ({close_reason})"
3. ~ **Current origins** -- no changes detected (report count only)

### Step 3: Recommendation

- ! Report only -- never auto-update vBRIEFs based on origin changes
- ~ If stale or externally-closed vBRIEFs are found, suggest: "Run a refinement session (`skills/deft-directive-refinement/SKILL.md`) to reconcile stale origins with user approval."

⊗ Auto-update vBRIEFs based on origin freshness checks -- report only; user decides during refinement

## Phase 6 -- Framework Sync

After structure validation, sync framework-level assets.

### 6a: Check AGENTS.md freshness

~ Compare the project's `AGENTS.md` against the deft template (if a template exists in the updated `deft/` submodule):

1. ~ Diff the structure (section headings, key rules) rather than expecting byte-identical content
2. ~ Report any new sections or rules added upstream that are missing locally
3. ~ Do NOT auto-overwrite -- present differences and let the user decide

### 6b: List new skills

! Compare the `skills/` directory before and after the update:

1. ! List any new skill directories added in the update
2. ~ For each new skill, read its frontmatter `description` field and present a one-liner
3. ~ Mention if any existing skills were updated (changed files)

## Phase 7 -- Summary

! Present a consolidated summary to the user covering:

1. **DEFT version change**: old commit -> new commit (or "already up to date")
2. **Structure validation**: lifecycle folders status (all present / missing folders listed)
3. **PROJECT-DEFINITION status**: valid / missing / stale (with freshness details)
4. **vBRIEF validation results**: pass/fail per file, with details on any failures
5. **Lifecycle consistency**: all consistent / N mismatches found (with details)
6. **Origin freshness**: N stale / N externally-closed / N current (with details)
7. **Document Model**: pre-v0.20 (legacy) / v0.20+ (vBRIEF-centric) OK / v0.20+ with warnings (see Pre-Cutover Detection Guard)
8. **AGENTS.md status**: current / has upstream changes / needs review
9. **New skills**: list any newly added skills with descriptions

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
- ⊗ Auto-move vBRIEFs to fix folder/status mismatches -- report only; never auto-fix
- ⊗ Auto-update vBRIEFs based on origin freshness -- report only; user decides during refinement
