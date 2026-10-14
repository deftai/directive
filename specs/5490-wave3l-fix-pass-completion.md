# Human findings fix-pass completion (F-016 / WAVE3 tip)

| | |
| --- | --- |
| Base | `yolo/cp-wave3j` @ `081685c46…` |
| Tip | `yolo/cp-wave3l` (freeze below) |
| Date | 2026-10-14 |
| Plan | `specs/5490-yolo-cp-wave2s-findings/FIX-PASS-PLAN.md` |

## Results

| ID | Result | Evidence |
| --- | --- | --- |
| F-016 | **PASS** | Convert strategies no longer call `removeSoleAuthorHusks` (was deleting private+runtime-pin package.json after PM add). Post-setup pin verify fail-closed. `wave3k.sh` PASS. Uninstall F-013 husks still green. |

## Verdaccio

| Tag | Version |
| --- | --- |
| `yolo-cp-wave3k` | `0.0.0-yolo.cp-wave3k.1` |
| `yolo-cp-wave3l` | `0.0.0-yolo.cp-wave3l.1` (acceptance tip) |

## Human re-test

```bash
eval "$(ht-prep --tag yolo-cp-wave3l)"
# restore site-todo tarball to a fresh folder, then:
cd ~/Projects/site-todo-directive-retryN
directive upgrade --target-version 0.0.0-yolo.cp-wave3l.1
test -f package.json
grep directive-runtime package.json
directive doctor   # must NOT say "No Directive project"
```

New issues → `/yolo-cp-finding`.
