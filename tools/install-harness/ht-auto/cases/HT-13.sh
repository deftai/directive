#!/usr/bin/env bash
# HT-13 — Yarn project refused
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"

ht_case_begin "HT-13" "${HT_TAG_OVERRIDE:-}"
ht_ensure_directive_on_path
ht_new_consumer "HT-13"

if [[ "$HT_DRY" == "1" ]]; then ht_finish_pass; fi

printf '%s\n' '{"name":"ht13-yarn","version":"0.0.0","private":true}' >"$CONSUMER/package.json"
printf '%s\n' '# yarn lockfile v1' >"$CONSUMER/yarn.lock"

ht_capture directive install --root "$CONSUMER" --yes --target-version "$HT_VER"
if [[ "$HT_LAST_RC" -ne 0 ]]; then
  HT_CASE_ASSERTIONS+=("pass|yarn_refused_rc|rc=$HT_LAST_RC")
else
  HT_CASE_ASSERTIONS+=("fail|yarn_refused_rc|expected non-zero")
fi
if echo "$HT_LAST_OUT" | grep -Eiq 'yarn|not supported|unsupported'; then
  HT_CASE_ASSERTIONS+=("pass|yarn_message|clear not-supported")
else
  HT_CASE_ASSERTIONS+=("fail|yarn_message|missing yarn refuse language")
fi
# No npm lock / runtime pin added
if [[ -f "$CONSUMER/package-lock.json" ]]; then
  HT_CASE_ASSERTIONS+=("fail|no_npm_lock|package-lock.json appeared")
else
  HT_CASE_ASSERTIONS+=("pass|no_npm_lock|absent")
fi
pin="$(ht_pin_version "$CONSUMER")"
if [[ -z "$pin" ]]; then
  HT_CASE_ASSERTIONS+=("pass|no_runtime_pin|empty")
else
  HT_CASE_ASSERTIONS+=("fail|no_runtime_pin|pin=$pin")
fi
ht_finish_pass
