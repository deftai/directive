#!/usr/bin/env bash
# HT-14 — No-git install disclosure
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"

ht_case_begin "HT-14" "${HT_TAG_OVERRIDE:-}"
ht_ensure_directive_on_path
ht_new_consumer "HT-14"  # no --git

if [[ "$HT_DRY" == "1" ]]; then ht_finish_pass; fi

ht_capture directive install --root "$CONSUMER" --yes --target-version "$HT_VER"
ht_assert_exit "install_rc" "$HT_LAST_RC" "0" || true

if echo "$HT_LAST_OUT" | grep -Eiq 'git|hooks?.*(inactive|not|without|no .git|skipped)|no.git|without git'; then
  HT_CASE_ASSERTIONS+=("pass|nogit_disclosure|saw git/hooks disclosure")
else
  HT_CASE_ASSERTIONS+=("fail|nogit_disclosure|missing no-git / hooks inactive disclosure")
fi
# Must not claim hooks are active
if echo "$HT_LAST_OUT" | grep -Eiq 'hooks (are )?active|hooksPath set|git hooks ready'; then
  HT_CASE_ASSERTIONS+=("fail|no_false_hooks_active|claimed hooks active on no-git")
else
  HT_CASE_ASSERTIONS+=("pass|no_false_hooks_active|no false active claim")
fi
ht_run_sanity "$CONSUMER" || true
ht_finish_pass
