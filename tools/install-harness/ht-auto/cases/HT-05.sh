#!/usr/bin/env bash
# HT-05 — Repair idempotent on healthy tree
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"

ht_case_begin "HT-05" "${HT_TAG_OVERRIDE:-}"
ht_ensure_directive_on_path
ht_new_consumer "HT-05"

if [[ "$HT_DRY" == "1" ]]; then
  ht_finish_pass
fi

ht_capture directive install --root "$CONSUMER" --yes --target-version "$HT_VER"
ht_assert_exit "install_rc" "$HT_LAST_RC" "0" || true
pin1="$(ht_pin_version "$CONSUMER")"
ht_assert_eq "pin_after_install" "$pin1" "$HT_VER" || true

ht_capture directive install --root "$CONSUMER" --repair --yes
ht_assert_exit "repair1_rc" "$HT_LAST_RC" "0" || true
pin2="$(ht_pin_version "$CONSUMER")"
ht_assert_eq "pin_unchanged_repair1" "$pin2" "$HT_VER" || true

snap1="$(mktemp)"
find "$CONSUMER" -type f ! -path '*/node_modules/*' ! -path '*/.deft/directive/wiring-ready*' | sort | while read -r f; do
  cksum "$f"
done >"$snap1"

ht_capture directive install --root "$CONSUMER" --repair --yes
ht_assert_exit "repair2_rc" "$HT_LAST_RC" "0" || true
pin3="$(ht_pin_version "$CONSUMER")"
ht_assert_eq "pin_unchanged_repair2" "$pin3" "$HT_VER" || true

snap2="$(mktemp)"
find "$CONSUMER" -type f ! -path '*/node_modules/*' ! -path '*/.deft/directive/wiring-ready*' | sort | while read -r f; do
  cksum "$f"
done >"$snap2"

if diff -q "$snap1" "$snap2" >/dev/null; then
  HT_CASE_ASSERTIONS+=("pass|repair_idempotent|managed files unchanged")
else
  diff_txt="$(diff -u "$snap1" "$snap2" | head -30 | tr '\n' ';' || true)"
  HT_CASE_ASSERTIONS+=("fail|repair_idempotent|$diff_txt")
fi
rm -f "$snap1" "$snap2"

ht_run_sanity "$CONSUMER" || true
ht_finish_pass
