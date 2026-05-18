# triage:smoketest fixture (#1146 / N6)

Hermetic 20-issue fixture for `task triage:smoketest`. The fixture is
**committed** to the repo; the smoketest copies it into a temp working
directory at run time and never mutates the on-disk fixture.

## Layout

```
tests/fixtures/triage_smoketest/
  README.md                              # this file
  issues.json                            # 20-issue spec (compact, ASCII-only)
  PROJECT-DEFINITION.vbrief.json         # consumer rules (research label -> defer)
  vbrief/
    active/
      2026-05-18-referenced.vbrief.json  # pre-existing active vBRIEF referencing issue #20
    proposed/
      test-1.vbrief.json                 # scope vBRIEF used by the promote/demote stage
  last_run.json                          # GITIGNORED -- JSON-formatted assert log
```

The `.deft-cache/github-issue/<owner>/<repo>/<N>/{raw.json,meta.json,content.md}`
layout is **rendered at runtime** from `issues.json` by the smoketest
driver. Committing the rendered cache would mean 60 generated files
(3 per issue x 20 issues) that would need to be regenerated whenever
the `cache.py` meta-shape evolves. The spec-file approach keeps the
fixture under 10 committed files and forward-compatible with cache
schema bumps.

## Issue distribution (20 total)

| Bucket                                      | Count | Issue numbers              | Expected classification               |
|---------------------------------------------|-------|----------------------------|---------------------------------------|
| Normal (untagged, recent)                   | 12    | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 | untriaged (no universal/consumer rule matches) |
| Hold marker (`do not implement` / `BLOCKED` / `HOLDING`) | 3 | 100, 101, 102            | defer via `universal:hold-marker`     |
| Research labelled (`rfc` / `type:research`) | 2     | 200, 201                   | defer via consumer rule `research`    |
| Dormant >90d, thin body                     | 2     | 300, 301                   | defer via `universal:dormant-thin-body` |
| Already referenced from active vBRIEF       | 1     | 20                         | accept via `universal:vbrief-referenced` |

Total expected `candidates.jsonl` decisions after auto-classify:
`1 accept + 3 + 2 + 2 = 8 classified`, `12 untriaged`. Archive is 0
because no issue is `state=closed` in this fixture (per the issue body
note `1 archive (no -- none closed-never-triaged in this fixture)`).

## Refs

- N6 child issue: https://github.com/deftai/directive/issues/1146
- Umbrella: https://github.com/deftai/directive/issues/1119
- Auto-classify universal rules: https://github.com/deftai/directive/issues/1129 (D10)
