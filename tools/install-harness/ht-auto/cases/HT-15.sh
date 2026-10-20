#!/usr/bin/env bash
# HT-15 — Latest legacy convert (SKIP without fixture)
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"

ht_case_begin "HT-15" "${HT_TAG_OVERRIDE:-}"
legacy="$(ls -d "$YOLO_5490"/fixtures/ht-15-legacy-* 2>/dev/null | head -1 || true)"
if [[ -z "$legacy" ]]; then
  ht_finish_human "SKIP: no supported legacy fixture under ~/yolo-5490/fixtures/ht-15-legacy-*"
fi
ht_note "legacy fixture found at $legacy — full convert automation not yet wired"
ht_finish_human "HT-15 fixture present but convert steps still HUMAN/stub"
