#!/usr/bin/env bash
# HT-09 — Equal-version upgrade spot (partial: equal no-op; migration half stub)
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"

ht_case_begin "HT-09" "${HT_TAG_OVERRIDE:-}"
ht_ensure_directive_on_path
ht_new_consumer "HT-09"

if [[ "$HT_DRY" == "1" ]]; then ht_finish_pass; fi

ht_capture directive install --root "$CONSUMER" --yes --target-version "$HT_VER"
ht_assert_exit "install_rc" "$HT_LAST_RC" "0" || true
pin1="$(ht_pin_version "$CONSUMER")"

ht_capture directive upgrade --root "$CONSUMER" --yes --target-version "$HT_VER"
ht_assert_exit "upgrade_equal_rc" "$HT_LAST_RC" "0" || true
pin2="$(ht_pin_version "$CONSUMER")"
ht_assert_eq "pin_unchanged" "$pin2" "$pin1" || true
ht_note "optional V→W migration half left as future work / SKIP without second tip version"
ht_finish_pass
