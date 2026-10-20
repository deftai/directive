#!/usr/bin/env bash
# HT-03 — Interactive [y/N] live TTY (HUMAN_REQUIRED; best-effort PTY optional)
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"

ht_case_begin "HT-03" "${HT_TAG_OVERRIDE:-}"
ht_ensure_directive_on_path
ht_new_consumer "HT-03"

# Best-effort: if `script` exists, try cancel-via-Enter once; still mark HUMAN for feel/AC9.
if [[ "$HT_DRY" == "1" ]]; then
  ht_finish_human "dry-run: HT-03 remains HUMAN_REQUIRED (live TTY + host UI feel)"
fi

if command -v script >/dev/null 2>&1; then
  set +e
  # macOS script: script -q /tmp/out bash -c '...'
  outf="$(mktemp)"
  script -q "$outf" bash -c "cd '$CONSUMER' && printf '\n' | directive install --root '$CONSUMER' --target-version '$HT_VER'" >/dev/null 2>&1
  rc=$?
  set -e
  body="$(cat "$outf" 2>/dev/null || true)"
  rm -f "$outf"
  if echo "$body" | grep -Eiq 'Set up|\[y/N\]|Cancelled'; then
    ht_note "best-effort PTY saw prompt/cancel language (rc=$rc); live human TTY still required for AC5.2 feel"
  else
    ht_note "best-effort PTY inconclusive (rc=$rc); live human TTY required"
  fi
else
  ht_note "no script(1); skip PTY probe"
fi

ht_finish_human "HT-03 TTY prompt blocking + cancel/accept feel remain HUMAN_REQUIRED (see human-required.txt)"
