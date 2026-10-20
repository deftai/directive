# ht-auto — HUMAN-TEST-PLAN automation harness

Maps `HUMAN-TEST-PLAN.md` (HT-00…HT-17) to runnable bash cases under the YOLO sterile field.

**Does not modify patient product** (`~/Projects/directive`). Fixtures live only under `~/yolo-5490/fixtures/ht-auto/`.

## Prerequisites

1. `source ~/yolo-5490/env.sh` and `PATH` includes `~/yolo-5490/bin` (has `ht-prep`).
2. Verdaccio at `http://127.0.0.1:4873`.
3. Tip tag published (harness **does not** publish):
   - Prefer `yolo-cp-wave4a` when present
   - Else `yolo-cp-wave3z` (current default)
4. Optional: `~/Projects/directive-install-sanity` for post-install sanity (`0 failed`).
5. Tip launcher on PATH via HT-00 /  
   `npm i -g @deftai/directive@$TAG --prefix ~/yolo-5490/prefix --registry http://127.0.0.1:4873`

## How to run

```bash
source ~/yolo-5490/env.sh
export PATH="$HOME/yolo-5490/bin:$PATH"

# all cases, default tip (wave4a if published else wave3z)
~/yolo-5490/ht-auto/run-all.sh

# explicit tip
~/yolo-5490/ht-auto/run-all.sh --tag yolo-cp-wave3z

# subset
~/yolo-5490/ht-auto/run-all.sh --tag yolo-cp-wave3z --only HT-01,HT-04,HT-11

# harness dry (cases skip mutating steps where supported)
~/yolo-5490/ht-auto/run-all.sh --tag yolo-cp-wave3z --dry --only HT-00
```

Single case:

```bash
export HT_TAG_OVERRIDE=yolo-cp-wave3z
~/yolo-5490/ht-auto/cases/HT-01.sh
```

## Layout

```
ht-auto/
  README.md
  run-all.sh
  lib/common.sh
  cases/HT-00.sh … HT-17.sh
  human-required.txt
  scorecard.template.md
```

Fixtures: `~/yolo-5490/fixtures/ht-auto/HT-xx-<stamp>/`  
Results: fixture `ht-auto.result.json` + aggregate `~/yolo-5490/logs/wave4/ht-auto/`

## Case exit codes

| Code | Meaning |
| --- | --- |
| 0 | `AUTO_PASS` |
| 2 | `FAIL` |
| 3 | `HUMAN_REQUIRED` / skip-to-human (does **not** tank automatable %) |

## Implementation status

See `~/yolo-5490/logs/wave4/HT-AUTO-SCAFFOLD.md`.

**Fully automated (Tier A focus):** HT-00, HT-01, HT-02, HT-04, HT-05, HT-10, HT-11  
**Also wired (beyond minimum):** HT-06, HT-07, HT-09, HT-12, HT-13, HT-14  
**HUMAN_REQUIRED / stub:** HT-03 (TTY + host UI feel), HT-08, HT-15, HT-16, HT-17  

Verified smoke on `yolo-cp-wave3z` / `0.0.0-yolo.cp-wave3z.1` (2026-10-16): Tier A listed above AUTO_PASS.  
Detail: `~/yolo-5490/logs/wave4/HT-AUTO-SCAFFOLD.md`

## Authority

- Plan: `/Users/polfer/Projects/directive-install-simplification-2/HUMAN-TEST-PLAN.md`
- Bootstrap: `~/yolo-5490/bin/ht-prep` (`eval "$(ht-prep …)"` pattern; harness uses `--reuse` into `fixtures/ht-auto/`)
