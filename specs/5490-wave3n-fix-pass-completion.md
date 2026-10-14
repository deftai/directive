# Human findings fix-pass completion (F-017)

| | |
| --- | --- |
| Base | `yolo/cp-wave3l` |
| Tip | `yolo/cp-wave3n` / Verdaccio `yolo-cp-wave3n` |
| Date | 2026-10-14 |
| Plan | `specs/5490-yolo-cp-wave2s-findings/FIX-PASS-PLAN.md` |

## Results

| ID | Result | Notes |
| --- | --- | --- |
| F-017 | **PASS** | Tip migrates 0.5→0.6→0.8 (+ existing 0.6/0.7); S5/unparseable → `xbrief/archive/`; contract migrate on upgrade; doctor teaches `directive upgrade` |

## Schema dispositions

| Set | Disposition |
| --- | --- |
| 0.8 | no-op |
| 0.7 | migrate-through → 0.8 |
| 0.6 | → 0.8 |
| **0.5** | thin → 0.6 then → 0.8 |
| pre-0.5 / no info / unparseable | archive under `xbrief/archive/` |

## Human re-test

```bash
eval "$(ht-prep --tag yolo-cp-wave3n)"
# restore site-todo tarball to a fresh folder
cd ~/Projects/site-todo-directive-retryN
directive upgrade --target-version 0.0.0-yolo.cp-wave3n.1
# expect xbrief/**/*.xbrief.json @ 0.8; no stranded migratable vbrief JSON
directive doctor   # must name directive upgrade for data issues; not task migrate:vbrief
```

New issues → `/yolo-cp-finding`.
