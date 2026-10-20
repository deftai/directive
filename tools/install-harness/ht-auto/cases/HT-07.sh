#!/usr/bin/env bash
# HT-07 — Git repo install activates hooksPath
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"

ht_case_begin "HT-07" "${HT_TAG_OVERRIDE:-}"
ht_ensure_directive_on_path
ht_new_consumer "HT-07" --git

if [[ "$HT_DRY" == "1" ]]; then ht_finish_pass; fi

ht_capture directive install --root "$CONSUMER" --yes --target-version "$HT_VER"
ht_assert_exit "install_rc" "$HT_LAST_RC" "0" || true

hooks="$(git -C "$CONSUMER" config --get core.hooksPath || true)"
if [[ "$hooks" == ".githooks" || "$hooks" == */.githooks || -n "$hooks" ]]; then
  HT_CASE_ASSERTIONS+=("pass|hooksPath|hooksPath=$hooks")
else
  HT_CASE_ASSERTIONS+=("fail|hooksPath|empty hooksPath")
fi
ht_assert_file "pre_commit_hook" "$CONSUMER/.githooks/pre-commit" || \
  ht_assert_file "pre_commit_hook_alt" "$CONSUMER/$hooks/pre-commit" || true

ht_run_sanity "$CONSUMER" || true
ht_finish_pass
