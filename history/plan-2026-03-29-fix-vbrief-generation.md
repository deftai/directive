# Fix #72: vBRIEF Generation Chain

## Problem
Freshly installed Directive produces invalid `specification.vbrief.json` files. The generated output is a flat bespoke JSON object (top-level `title`, `status`, `overview`, `requirements`, `architecture`, `tasks`) that shares no structural resemblance to the vBRIEF v0.5 schema (required: `vBRIEFInfo` envelope + `plan` wrapper with `items` array).

Root cause: five components in the generation chain are broken, not two. The spec tracks this as t1.2.1 and t1.2.2, but the validator, renderer, the repo's own spec file, and CONVENTIONS.md are also non-conformant.

## Current State
- `spec_validate.py` — only checks "is valid JSON?"; no schema validation at all
- `spec_render.py` — hardcoded to read the old flat format (`spec.get("status")`, `spec.get("tasks")`, task `do` field); would fail on correct vBRIEF
- `templates/make-spec.md` — says "Write `./vbrief/specification.vbrief.json`" but provides no structural example; agents invent their own format
- `skills/deft-setup/SKILL.md` Phase 3 — same gap: instruction without schema example
- `.planning/codebase/CONVENTIONS.md` lines 78-83 — documents the **wrong format** as the required structure: says `"vbrief": "0.5.0"` (should be `"vBRIEFInfo": {"version": "0.5"}`), says `"plan"` is a string (should be an object with `title`/`status`/`items`). This is likely the original source of drift — agents and developers following CONVENTIONS.md produce the wrong output faithfully.
- `vbrief/specification.vbrief.json` — the repo's own file uses `"vbrief": "0.5.0"` and `"plan": "string"` exactly as CONVENTIONS.md prescribes, which is wrong per the schema
- `vbrief/plan.vbrief.json` — same legacy flat format
- `test_vbrief_schema.py` — tests Status enum sync only; never validates actual `.vbrief.json` files against schema
- vBRIEF source repo references are inconsistent: `github.com/visionik/vBRIEF` (REFERENCES.md, vbrief.md) vs `github.com/deftai/vBRIEF` (STACK.md, CONVENTIONS.md) vs `vbrief.org`/`vbrief.dev` (vbrief.md, schema $id)

## Changes

### 1. `scripts/spec_validate.py` — Add real schema validation
Replace JSON-only check with jsonschema validation against `vbrief/schemas/vbrief-core.schema.json`. Validate: required top-level keys (`vBRIEFInfo`, `plan`), version string, plan has `title`/`status`/`items`, status values from enum. Keep current file-exists and JSON-parse checks as early exits. Add `jsonschema` to dev dependencies (or implement lightweight key/type checks if no new deps preferred).

### 2. `vbrief/specification.vbrief.json` — Migrate to valid vBRIEF v0.5
Convert from flat format to schema-conformant structure:
- Wrap in `{"vBRIEFInfo": {"version": "0.5"}, "plan": {...}}`
- `plan.title` = current `plan` string value
- `plan.status` = current `status`
- `plan.items` = current `tasks` array, with `do` → `title`, `acceptance`/`traces`/`phase`/`subphase`/`dependencies` moved to `narrative`/`metadata`/`tags` as appropriate
- Preserve `overview`, `architecture` as `plan.narratives.Overview` and `plan.narratives.Architecture`
- Preserve `prdRef` as `plan.references` or `plan.metadata`

Validate result passes `spec_validate.py`.

### 3. `vbrief/plan.vbrief.json` — Migrate to valid vBRIEF v0.5
Same envelope migration. Convert `completedStrategies`/`artifacts` to `plan.metadata`. Convert empty `tasks` to empty `items`.

### 4. `scripts/spec_render.py` — Read from vBRIEF v0.5 structure
Update field access:
- `spec["plan"]["status"]` instead of `spec.get("status")`
- `spec["plan"]["title"]` instead of `spec.get("plan") or spec.get("title")`
- `spec["plan"]["items"]` instead of `spec.get("tasks", [])`
- Item `title` instead of `do`
- Item `narrative` is now an object (extract values), not a string
- Dependencies from `plan.edges` or item `metadata`, not inline string

Verify by re-rendering SPECIFICATION.md from the migrated spec file and diffing against current.

### 5. `templates/make-spec.md` — Add concrete vBRIEF output example
In the "Specification Flow" section (line 99-107), add a minimal JSON example showing the required envelope:

```json
{
  "vBRIEFInfo": { "version": "0.5" },
  "plan": {
    "title": "Project Name SPECIFICATION",
    "status": "draft",
    "items": [
      {
        "id": "1.1.1",
        "title": "Task description",
        "status": "pending",
        "narrative": { "Acceptance": "...", "Traces": "FR-1" }
      }
    ]
  }
}
```

Add `! MUST use this exact top-level structure` rule. Add reference to `deft/vbrief/vbrief.md` for full schema docs.

### 6. `skills/deft-setup/SKILL.md` Phase 3 — Add concrete vBRIEF output example
In the Output sections (Light Path line 397, Full Path line 409), add the same minimal JSON example and schema reference. Add `! The vBRIEF file MUST conform to vbrief/schemas/vbrief-core.schema.json`.

### 7. `.planning/codebase/CONVENTIONS.md` — Fix vBRIEF section
Rewrite lines 78-83 to match the actual schema:
- `"vBRIEFInfo": {"version": "0.5"}` — not `"vbrief": "0.5.0"`
- `"plan"` is an object with `title`, `status`, `items` — not a string
- Add minimal example matching the schema
- Normalize vBRIEF repo URL to `github.com/deftai/vBRIEF` (current org)

### 8. `tests/content/test_vbrief_schema.py` — Add file validation tests
Add tests that:
- Load `vbrief/specification.vbrief.json` and validate against schema
- Load `vbrief/plan.vbrief.json` and validate against schema
- Assert required top-level keys `vBRIEFInfo` and `plan`
- Assert `plan` has `title`, `status`, `items`
- Assert no legacy fields at top level (`tasks`, `overview`, `architecture`)

### 9. Fix vBRIEF examples and status values in context docs
**`context/working-memory.md` lines 29-38** — Replace the example with valid vBRIEF v0.5:
- `"vbrief": "0.4.0"` → `"vBRIEFInfo": {"version": "0.5"}`
- `"plan": "string"` → `"plan": { "title": "...", "status": "...", "items": [...] }`
- `"tasks"` → `"items"`, `"do"` → `"title"`
- `"done"`/`"doing"`/`"todo"` → `"completed"`/`"running"`/`"pending"`

**`context/long-horizon.md` line 13** — Fix status lifecycle:
- `todo → doing → done / blocked / skip` → `pending → running → completed / blocked / cancelled`

### 10. Normalize vBRIEF repo references
Update all references to use `github.com/deftai/vBRIEF` consistently:
- `REFERENCES.md:125` — currently `visionik/vBRIEF`
- `vbrief/vbrief.md:113` — currently `visionik/vBRIEF`

### 11. CI schema sync check (future-proofing)
Keep the schema as a vendored copy (zero friction for consumers — just `git clone` and everything works). Add a CI job that fetches the latest `vbrief-core.schema.json` from `deftai/vBRIEF`, diffs against the vendored copy, and fails the build if they diverge. This ensures:
- Consumers never need to know about submodules or extra clone flags
- Schema drift is caught automatically on every CI run
- Schema updates are deliberate — developer reviews the upstream change before updating the vendored copy
- No silent failures — CI blocks until the vendored copy is updated

Alternatives considered: git submodule (auto-syncs on pull, but consumers who forget `--recurse-submodules` get silent missing-file failures — bad first experience for directive users).

## Order of Operations
1. `CONVENTIONS.md` — fix the documented format first (it's the root cause of drift)
2. `spec_validate.py` — establishes the gatekeeping tool
3. `specification.vbrief.json` + `plan.vbrief.json` migration — proves validator works
4. `spec_render.py` — reads from new structure; verify with `task spec:render`
5. `templates/make-spec.md` — template fix for CLI-generated instruction path
6. `skills/deft-setup/SKILL.md` — template fix for agent skill path
7. Context docs — fix working-memory.md example + long-horizon.md status lifecycle
8. Normalize vBRIEF repo references across REFERENCES.md, vbrief.md
9. `test_vbrief_schema.py` — lock it down with tests
10. `task check` — full pre-commit validation
11. CI schema sync check — follow-up PR, depends on CI infrastructure (#57)

## Deft Process
- Update CHANGELOG.md `[Unreleased]` with entries under Fixed
- After completion, mark t1.2.1 and t1.2.2 status → `completed` in specification.vbrief.json
- Run `task check` before committing
- Single batch commit per commit rules

## Out of Scope
- `cmd_spec` function in `run` — it generates instruction files, not the vBRIEF itself; no code changes needed there
- Migrating archived vBRIEF files in `history/archive/` — historical records stay as-is
- Adding `jsonschema` as a runtime dependency — validation stays in dev/test tooling only
- Changing the vBRIEF schema itself — the schema is correct; the consumers are wrong
- Git submodule — rejected; adds consumer friction (`--recurse-submodules` requirement) for a problem better solved by CI

## Spec Task Mapping
- **t1.2.1** (FR-6): Covered by changes 1, 4, 5 (validator, renderer, make-spec template)
- **t1.2.2** (FR-6): Covered by changes 6, 8 (SKILL.md, tests)
- Changes 2 and 3 (spec/plan migration) are incidental work required to make the fix self-consistent — the repo must eat its own dog food
- Change 7 (CONVENTIONS.md) fixes the root cause of drift — agents were following documented-but-wrong conventions
- Change 9 (repo reference normalization) is cleanup discovered during analysis

## File Impact Summary
- `.planning/codebase/CONVENTIONS.md` — rewrite vBRIEF section (~15 lines)
- `scripts/spec_validate.py` — moderate rewrite (~30 lines)
- `scripts/spec_render.py` — moderate rewrite (~20 lines)
- `vbrief/specification.vbrief.json` — structural migration (large file, mechanical transform)
- `vbrief/plan.vbrief.json` — structural migration (small file)
- `templates/make-spec.md` — add ~20 lines (example + rules)
- `skills/deft-setup/SKILL.md` — add ~20 lines (example + rules in two Output sections)
- `tests/content/test_vbrief_schema.py` — add ~40 lines (new test functions)
- `REFERENCES.md` — 1 line URL fix
- `vbrief/vbrief.md` — 1 line URL fix
- `CHANGELOG.md` — add entries under [Unreleased]
