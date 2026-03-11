# Issue #28 — vBRIEF Schema Reference & Status Value Fix

## Problem

`vbrief/vbrief.md` describes file taxonomy and lifecycle rules but never defines the
actual JSON file format. Agents have no local schema to validate against.

Additionally, deft uses non-conforming status values (`todo`, `doing`, `done`, `skip`,
`deferred`) instead of the vBRIEF v0.5 spec values (`pending`, `running`, `completed`,
`cancelled`, `blocked`).

## Current State

- `vbrief/vbrief.md` — 129 lines, 5 sections: File Taxonomy, specification, plan,
  continue, playbook, plus Specification Flow, Tool Mappings, Anti-Patterns
- No `vbrief/schemas/` directory exists
- `REFERENCES.md` — 229 lines, has a "When Creating Specifications" section that
  already references `vbrief/vbrief.md` (line 117–120) but no schema entry
- Test suite: `test_structure.py`, `test_contracts.py`, `test_standards.py`,
  `test_shape.py` plus `known_failures.json` and `baseline.json` snapshots
- `LEGEND_DIRS` in `test_standards.py` does not include `vbrief/`

### Non-conforming status values in `vbrief.md`

Line 51: `todo` → `doing` → `done` / `blocked` / `skip` / `deferred`
Line 113: `mark_todo_as_done` → `status` → `done`
Line 68: `completed` (continue.vbrief.json — already correct)

---

## Proposed Changes

### 1. Import the JSON Schema

Copy `vbrief-core.schema.json` from the
[vBRIEF repo](https://github.com/visionik/vBRIEF) `schemas/` directory into
`vbrief/schemas/vbrief-core.schema.json`.

No modifications to the schema file — it is an exact copy of the canonical source.

### 2. Add a "File Format" section to `vbrief/vbrief.md`

Insert a new `## File Format` section between "File Taxonomy" (line 29) and
"specification.vbrief.json" (line 31). Contents:

- Link to canonical spec at https://vbrief.org
- Required top-level structure: `vBRIEFInfo` (with `version: "0.5"`) + `plan`
  (with `title`, `status`, `items`)
- Valid `Status` enum with RFC2119 rules:
  `draft | proposed | approved | pending | running | completed | blocked | cancelled`
- Minimal 4-field example (vBRIEFInfo + plan with one item)
- Structured example (with narratives, ids, tags)
- Reference to local schema: `./schemas/vbrief-core.schema.json`

### 3. Fix status values throughout `vbrief.md`

Update all non-conforming values in-place:

- Line 51 (`plan.vbrief.json` lifecycle):
  `todo` → `pending`, `doing` → `running`, `done` → `completed`,
  `skip` → `cancelled`, `deferred` → `blocked`
  New: `pending` → `running` → `completed` / `blocked` / `cancelled`
- Line 57: `deferred` status → `blocked` status (with narrative)
- Line 113 (Tool Mappings table): `done` → `completed`
- Line 115: `cancelled` (already correct — verify only)

### 4. Update `REFERENCES.md`

Add a new entry under the "When Creating Specifications" section (after line 120):

```
**[vbrief/schemas/vbrief-core.schema.json](./vbrief/schemas/vbrief-core.schema.json)** — vBRIEF JSON Schema
- Load: When creating, validating, or debugging `.vbrief.json` files
- Contains: JSON Schema (draft 2020-12) defining `vBRIEFInfo`, `Plan`, `PlanItem`, `Status` enum
- Source: https://github.com/visionik/vBRIEF
```

---

## Test Updates

### 5. `test_structure.py` — new directory and file checks

- Add `"vbrief/schemas"` awareness: the `vbrief` dir is already in `REQUIRED_DIRS`.
  No changes needed for directory checks.
- Consider whether to add `vbrief/schemas/vbrief-core.schema.json` to a required-files
  check. Currently there is no per-subdirectory file existence test, so this is
  optional. The `test_contracts.py` link-resolution tests will catch it if
  `REFERENCES.md` links to it and it doesn't exist.

**Verdict: no changes to `test_structure.py` needed.**

### 6. `test_contracts.py` — link resolution

The parametrized `test_references_md_links_resolve` auto-discovers internal links from
`REFERENCES.md`. After we add the schema link in step 4, it will automatically be
picked up and validated. No code changes needed.

The `test_see_also_links_resolve` will similarly pick up any new "See also" links in
the updated `vbrief.md`.

**Verdict: no code changes to `test_contracts.py` needed, but run to verify no new
broken links are introduced.**

### 7. `test_standards.py` — RFC2119 legend

`vbrief/` is NOT currently in `LEGEND_DIRS`. Since `vbrief.md` already has the
RFC2119 legend (line 5: `!=MUST, ~=SHOULD`), adding `"vbrief"` to `LEGEND_DIRS` would
be safe and enforces the standard going forward.

**Action: add `"vbrief"` to `LEGEND_DIRS` in `test_standards.py` (line 33–41).**

### 8. `test_shape.py` — optional vBRIEF shape

Currently `test_shape.py` covers languages, strategies, interfaces, and tools.
`vbrief/vbrief.md` is a singleton governance doc, not a category with multiple files
that need shape enforcement. No shape schema needed.

**Verdict: no changes to `test_shape.py` or `shapes.py`.**

### 9. `known_failures.json` — review for new entries

After all content changes:
- Run the full suite to check if any new failures appear
- The new `vbrief.md` content should not trigger deprecated-path or warping checks
- The new REFERENCES.md link should resolve (schema file exists)
- No new xfail entries expected — but verify

### 10. Regenerate `baseline.json`

After all edits, run:
```
uv run python tests/content/snapshots/capture.py
```

This will update the snapshot with:
- New headers in `vbrief/vbrief.md` (the "File Format" section)
- New internal links in `vbrief/vbrief.md` (schema reference)
- New link in `REFERENCES.md` (schema entry)

### 11. Run full test suite and `task check`

```
uv run pytest tests/
task check
```

Target: all existing tests pass (or remain documented xfail), no regressions.

---

## Dependency Order

```
1 (import schema) ──┐
                    ├── 3 (fix status values) ──┐
2 (file format)  ───┘                           ├── 5–9 (tests) ── 10 (baseline) ── 11 (full suite)
                    4 (REFERENCES.md) ──────────┘
```

Steps 1 and 2 can be done in parallel.
Step 3 depends on 2 (editing the same file).
Step 4 is independent but should follow 1 (so the linked file exists).
Steps 5–9 run after all content changes.
Step 10 after tests are stable. Step 11 is the final gate.

---

## Workflow Rules

- **No auto-commit.** Stop and wait for explicit commit instruction.
- **No auto-push.** Commit locally, then STOP. Push only on explicit instruction.
- **Author on all commits.** Scott Adams <msadams@msadams.com>

*Created 2026-03-11 — Issue #28 (feature-vbrief-schema branch)*
