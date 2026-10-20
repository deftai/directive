#!/usr/bin/env bash
# HT-04 — Dry-run + §C9 plan presentation (mutation + exit; polish feel is soft)
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"

ht_case_begin "HT-04" "${HT_TAG_OVERRIDE:-}"
ht_ensure_directive_on_path
ht_new_consumer "HT-04"

if [[ "$HT_DRY" == "1" ]]; then
  ht_note "dry-run harness flag: skip directive dry-run"
  ht_finish_pass
fi

ht_capture directive install --root "$CONSUMER" --dry-run --target-version "$HT_VER"
ht_assert_exit "dry_run_rc" "$HT_LAST_RC" "0" || true

# Only .npmrc (and empty dir) should exist — no package.json / node_modules / .deft
ht_assert_file "npmrc_only_base" "$CONSUMER/.npmrc" || true
ht_assert_no_path "no_package_json" "$CONSUMER/package.json" || true
ht_assert_no_path "no_node_modules" "$CONSUMER/node_modules" || true
ht_assert_no_path "no_deft" "$CONSUMER/.deft" || true

# Soft §C9 signals (not keyed debug dumps)
if echo "$HT_LAST_OUT" | grep -Eqi 'Set up|Project|Install command|Next|✓|Dry'; then
  HT_CASE_ASSERTIONS+=("pass|c9_ish_plan|human titles present")
else
  HT_CASE_ASSERTIONS+=("fail|c9_ish_plan|missing human plan titles")
fi
if echo "$HT_LAST_OUT" | grep -Eq 'operation:|created=\['; then
  HT_CASE_ASSERTIONS+=("fail|no_debug_dump|saw operation:/created=[] without -v")
else
  HT_CASE_ASSERTIONS+=("pass|no_debug_dump|default stdout not keyed dump")
fi

ht_finish_pass
