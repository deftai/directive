# migrate:vbrief reconciliation + routing fixtures

Synthetic fixtures used by `tests/cli/test_migrate_vbrief_fixtures.py` to exercise
every routing case from #496 and #499.

Each sub-directory is a minimal pre-cutover project that the migration script
can be pointed at. Directory layout per fixture:

```
<scenario-slug>/
  SPECIFICATION.md                    (optional)
  ROADMAP.md                           (required when scenario covers ROADMAP)
  vbrief/
    specification.vbrief.json         (required -- carries SPEC tasks + status)
    migration-overrides.yaml          (optional -- per #496 component 4)
  expected.json                       (assertion map consumed by the fixture test)
```

`expected.json` declares the assertion map for the scenario:
- `folder_counts`: number of scope vBRIEFs expected in each lifecycle folder
- `statuses`: mapping of `<folder>/<slug-or-title>` -> expected `plan.status`
- `reconciliation_md`: whether `vbrief/migration/RECONCILIATION.md` must exist
- `narratives`: expected narrative keys per scope (e.g. `SourceConflict`)

Fixtures are intentionally tiny so drift from the real production case is easy
to spot in review. **No slizard data** -- all content is synthetic and covers
only the reconciliation decision surface.

## Scenarios

- `clean/`            -- SPEC and ROADMAP agree on a single pending task. No
                         RECONCILIATION.md, single scope in pending/.
- `spec-stale/`       -- ROADMAP marks a task completed while SPEC still says
                         pending. ROADMAP wins; scope routes to completed/.
- `roadmap-stale/`    -- SPEC status=completed and ROADMAP silent. SPEC
                         tiebreaker routes the scope to completed/.
- `both-stale/`       -- SPEC says running, ROADMAP says completed. ROADMAP
                         wins; conflict recorded in RECONCILIATION.md.
- `orphan/`           -- ROADMAP has an item SPEC never heard of. Scope routes
                         to proposed/ with `narrative.SourceConflict`.
- `overrides/`        -- `migration-overrides.yaml` pins a status override and
                         a drop decision.
- `registry-mirror/`  -- Validates PROJECT-DEFINITION.vbrief.json
                         `plan.items[*].status` mirrors each scope's status
                         (#499-registry).
