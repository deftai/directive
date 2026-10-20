#!/usr/bin/env bash
# HT-01 — Empty folder clean install + sanity
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"

ht_case_begin "HT-01" "${HT_TAG_OVERRIDE:-}"
ht_ensure_directive_on_path
ht_new_consumer "HT-01"

if [[ "$HT_DRY" == "1" ]]; then
  ht_note "dry-run: skip install"
  ht_finish_pass
fi

ht_capture directive install --root "$CONSUMER" --yes --target-version "$HT_VER"
ht_assert_exit "install_rc" "$HT_LAST_RC" "0" || true

pin="$(ht_pin_version "$CONSUMER")"
ht_assert_eq "exact_pin" "$pin" "$HT_VER" || true
ht_assert_no_path "no_deft_core" "$CONSUMER/.deft/core" || true
ht_assert_file "agents_md" "$CONSUMER/AGENTS.md" || true
ht_assert_file "package_json" "$CONSUMER/package.json" || true

if [[ -d "$CONSUMER/node_modules/@deftai/directive-runtime" ]]; then
  HT_CASE_ASSERTIONS+=("pass|runtime_installed|node_modules/@deftai/directive-runtime")
else
  HT_CASE_ASSERTIONS+=("fail|runtime_installed|missing node_modules/@deftai/directive-runtime")
fi

ht_run_sanity "$CONSUMER" || true

ht_finish_pass
