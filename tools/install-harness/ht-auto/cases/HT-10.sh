#!/usr/bin/env bash
# HT-10 — Configured install without --repair → exit 2
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"

ht_case_begin "HT-10" "${HT_TAG_OVERRIDE:-}"
ht_ensure_directive_on_path
ht_new_consumer "HT-10" --git

if [[ "$HT_DRY" == "1" ]]; then ht_finish_pass; fi

ht_capture directive install --root "$CONSUMER" --yes --target-version "$HT_VER"
ht_assert_exit "prepare_install_rc" "$HT_LAST_RC" "0" || true
pin1="$(ht_pin_version "$CONSUMER")"
ht_assert_eq "pin_prepared" "$pin1" "$HT_VER" || true

before="$(mktemp)"
find "$CONSUMER" -type f ! -path '*/node_modules/*' | sort | while read -r f; do cksum "$f"; done >"$before"

ht_capture directive install --root "$CONSUMER" --yes
ht_assert_exit "bare_install_yes_rc" "$HT_LAST_RC" "2" || true

if echo "$HT_LAST_OUT" | grep -Eq 'install --repair|--repair --yes|directive install --repair'; then
  HT_CASE_ASSERTIONS+=("pass|names_repair|message mentions --repair")
else
  HT_CASE_ASSERTIONS+=("fail|names_repair|message missing repair guidance")
fi

pin2="$(ht_pin_version "$CONSUMER")"
ht_assert_eq "pin_unchanged" "$pin2" "$pin1" || true

after="$(mktemp)"
find "$CONSUMER" -type f ! -path '*/node_modules/*' | sort | while read -r f; do cksum "$f"; done >"$after"
if diff -q "$before" "$after" >/dev/null; then
  HT_CASE_ASSERTIONS+=("pass|no_mutation|tree unchanged")
else
  diff_txt="$(diff -u "$before" "$after" | head -20 | tr '\n' ';' || true)"
  HT_CASE_ASSERTIONS+=("fail|no_mutation|$diff_txt")
fi
rm -f "$before" "$after"

ht_finish_pass
