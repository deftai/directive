# ht-auto scorecard (template)

| Field | Value |
| --- | --- |
| When (UTC) | |
| Tip tag | |
| Tip version | |
| Dry | 0 |
| AUTO_PASS | |
| FAIL | |
| HUMAN_REQUIRED | |
| Skipped (--only) | |
| Automatable pass % | % (AUTO_PASS / (AUTO_PASS+FAIL); HUMAN excluded) |

| ID | Status | Notes |
| --- | --- | --- |
| HT-00 | | |
| HT-01 | | |
| HT-02 | | |
| HT-03 | HUMAN_REQUIRED | TTY + host UI feel |
| HT-04 | | |
| HT-05 | | |
| HT-06 | | |
| HT-07 | | |
| HT-08 | HUMAN_REQUIRED | stub |
| HT-09 | | |
| HT-10 | | |
| HT-11 | | |
| HT-12 | | |
| HT-13 | | |
| HT-14 | | |
| HT-15 | HUMAN_REQUIRED | legacy fixture |
| HT-16 | HUMAN_REQUIRED | stub |
| HT-17 | HUMAN_REQUIRED | second tip / stub |

HUMAN_REQUIRED does not fail suite automatable %. Per-case JSON: `~/yolo-5490/logs/wave4/ht-auto/<ID>.result.json`.
