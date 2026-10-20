#!/usr/bin/env bash
# HT-06 — Uninstall preserves xbrief + reinstall (stub→partial automatable)
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"

ht_case_begin "HT-06" "${HT_TAG_OVERRIDE:-}"
ht_ensure_directive_on_path
ht_new_consumer "HT-06"

if [[ "$HT_DRY" == "1" ]]; then ht_finish_pass; fi

ht_capture directive install --root "$CONSUMER" --yes --target-version "$HT_VER"
ht_assert_exit "install_rc" "$HT_LAST_RC" "0" || true

mkdir -p "$CONSUMER/xbrief"
printf '{"id":"ht06-seed","title":"seed"}\n' >"$CONSUMER/xbrief/ht06-seed.xbrief.json"
sha_before="$(find "$CONSUMER/xbrief" -type f | sort | xargs shasum)"

ht_capture directive uninstall --root "$CONSUMER" --yes
ht_assert_exit "uninstall_rc" "$HT_LAST_RC" "0" || true

sha_mid="$(find "$CONSUMER/xbrief" -type f | sort | xargs shasum)"
ht_assert_eq "xbrief_after_uninstall" "$sha_mid" "$sha_before" || true

ht_capture directive install --root "$CONSUMER" --yes --target-version "$HT_VER"
ht_assert_exit "reinstall_rc" "$HT_LAST_RC" "0" || true
sha_after="$(find "$CONSUMER/xbrief" -type f | sort | xargs shasum)"
ht_assert_eq "xbrief_after_reinstall" "$sha_after" "$sha_before" || true

# Global launcher still present
ht_assert_file "launcher_still_present" "$YOLO_5490/prefix/bin/directive" || true
ht_run_sanity "$CONSUMER" || true
ht_finish_pass
