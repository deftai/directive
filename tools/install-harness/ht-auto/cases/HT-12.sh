#!/usr/bin/env bash
# HT-12 — Non-TTY without --yes → exit 2
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"

ht_case_begin "HT-12" "${HT_TAG_OVERRIDE:-}"
ht_ensure_directive_on_path
ht_new_consumer "HT-12"

if [[ "$HT_DRY" == "1" ]]; then ht_finish_pass; fi

set +e
out="$(directive install --root "$CONSUMER" --target-version "$HT_VER" </dev/null 2>&1)"
rc=$?
set -e
printf '%s\n' "$out" >&2
ht_assert_exit "nontty_rc" "$rc" "2" || true
if echo "$out" | grep -Eiq -- '--yes|non-interactive|not a tty|TTY'; then
  HT_CASE_ASSERTIONS+=("pass|requires_yes|message mentions --yes/TTY")
else
  HT_CASE_ASSERTIONS+=("fail|requires_yes|message missing --yes guidance")
fi
ht_assert_no_path "no_package_json" "$CONSUMER/package.json" || true
ht_finish_pass
