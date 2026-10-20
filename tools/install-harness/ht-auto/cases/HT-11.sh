#!/usr/bin/env bash
# HT-11 — Refuse $HOME / / as destination
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"

ht_case_begin "HT-11" "${HT_TAG_OVERRIDE:-}"
ht_ensure_directive_on_path
# No consumer project needed; still create a stamp dir for result JSON colocated optionally
ht_new_consumer "HT-11"

if [[ "$HT_DRY" == "1" ]]; then ht_finish_pass; fi

# Refuse HOME
ht_capture directive install --root "$HOME" --yes --target-version "$HT_VER"
home_rc="$HT_LAST_RC"
home_out="$HT_LAST_OUT"
if [[ "$home_rc" -ne 0 ]]; then
  HT_CASE_ASSERTIONS+=("pass|refuse_home_rc|rc=$home_rc")
else
  HT_CASE_ASSERTIONS+=("fail|refuse_home_rc|expected non-zero, got 0")
fi

# Refuse /
ht_capture directive install --root / --yes --target-version "$HT_VER"
root_rc="$HT_LAST_RC"
if [[ "$root_rc" -ne 0 ]]; then
  HT_CASE_ASSERTIONS+=("pass|refuse_root_rc|rc=$root_rc")
else
  HT_CASE_ASSERTIONS+=("fail|refuse_root_rc|expected non-zero, got 0")
fi

# --yes must not bypass: no package.json pin under HOME created by this run
if [[ -f "$HOME/package.json" ]] && grep -q '@deftai/directive-runtime' "$HOME/package.json" 2>/dev/null; then
  HT_CASE_ASSERTIONS+=("fail|home_not_polluted|HOME package.json gained directive-runtime pin")
else
  HT_CASE_ASSERTIONS+=("pass|home_not_polluted|no directive-runtime pin in HOME package.json")
fi
if [[ -d "$HOME/.deft" ]] && [[ -d "$HOME/node_modules/@deftai" ]]; then
  ht_note "HOME already had .deft/node_modules — cannot prove absence; rc-based refuse is primary"
fi

ht_note "home_out=$(echo "$home_out" | tr '\n' ' ' | head -c 300)"
ht_finish_pass
