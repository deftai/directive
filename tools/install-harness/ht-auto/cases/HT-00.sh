#!/usr/bin/env bash
# HT-00 — Load tip launcher globally
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"

ht_case_begin "HT-00" "${HT_TAG_OVERRIDE:-}"

ht_assert_eq "verdaccio_up" "$(curl -s -o /dev/null -w '%{http_code}' "$VERDACCIO_URL/")" "200" || true
ht_assert_eq "npm_view_tip" "$(npm view "@deftai/directive@$HT_TAG" version --registry "$VERDACCIO_URL")" "$HT_VER" || true

if [[ "$HT_DRY" == "1" ]]; then
  ht_note "dry-run: skip npm i -g"
  ht_finish_pass
fi

ht_capture npm i -g "@deftai/directive@$HT_TAG" --prefix "$YOLO_5490/prefix" --registry "$VERDACCIO_URL"
ht_assert_exit "npm_i_g" "$HT_LAST_RC" "0" || true

export PATH="$YOLO_5490/prefix/bin:$PATH"
local_which="$(command -v directive || true)"
case "$local_which" in
  "$YOLO_5490"/prefix/bin/*)
    HT_CASE_ASSERTIONS+=("pass|directive_under_prefix|$local_which")
    ;;
  *)
    HT_CASE_ASSERTIONS+=("fail|directive_under_prefix|got=$local_which")
    ;;
esac

ht_capture directive --version
ht_assert_exit "directive_version_rc" "$HT_LAST_RC" "0" || true
if echo "$HT_LAST_OUT" | grep -Fq "$HT_VER"; then
  HT_CASE_ASSERTIONS+=("pass|version_mentions_tip|$HT_VER")
else
  HT_CASE_ASSERTIONS+=("fail|version_mentions_tip|out=$HT_LAST_OUT want=$HT_VER")
fi

ht_finish_pass
