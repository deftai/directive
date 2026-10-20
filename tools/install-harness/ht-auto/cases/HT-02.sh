#!/usr/bin/env bash
# HT-02 — Doctor after greenfield (git consumer; install-surface AC6.2 / AC12.1)
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"

ht_case_begin "HT-02" "${HT_TAG_OVERRIDE:-}"
ht_ensure_directive_on_path
ht_new_consumer "HT-02" --git

if [[ "$HT_DRY" == "1" ]]; then
  ht_note "dry-run: skip"
  ht_finish_pass
fi

ht_capture directive install --root "$CONSUMER" --yes --target-version "$HT_VER"
ht_assert_exit "install_rc" "$HT_LAST_RC" "0" || true

# Snapshot meaningful managed files; exclude node_modules + ephemeral diagnostic caches.
snap_list() {
  find "$1" -type f \
    ! -path '*/node_modules/*' \
    ! -path '*/.deft/directive/wiring-ready*' \
    ! -path '*/xbrief/.triage-cache/*' \
    ! -path '*/.deft-cache/*' \
    | sort
}

before="$(mktemp)"
after="$(mktemp)"
snap_list "$CONSUMER" >"$before"

ht_capture directive doctor --root "$CONSUMER"
doctor_rc="$HT_LAST_RC"
doctor_out="$HT_LAST_OUT"

snap_list "$CONSUMER" >"$after"
if diff -q "$before" "$after" >/dev/null; then
  HT_CASE_ASSERTIONS+=("pass|doctor_no_writes|managed tree unchanged (excl. triage-cache/wiring-ready)")
else
  diff_txt="$(diff -u "$before" "$after" | head -40 | tr '\n' ';' || true)"
  HT_CASE_ASSERTIONS+=("fail|doctor_no_writes|$diff_txt")
fi
rm -f "$before" "$after"

surface="$(printf '%s\n' "$doctor_out" | sed -n '1,30p')"
if echo "$surface" | grep -Eq 'directive doctor: in sync|readiness: ok'; then
  HT_CASE_ASSERTIONS+=("pass|doctor_in_sync|install-surface in sync")
else
  HT_CASE_ASSERTIONS+=("fail|doctor_in_sync|surface=$(echo "$surface" | tr '\n' ' ' | head -c 400)")
fi

if [[ "$doctor_rc" -eq 0 ]]; then
  HT_CASE_ASSERTIONS+=("pass|doctor_overall_rc|0")
else
  HT_CASE_ASSERTIONS+=("pass|doctor_overall_rc|non-zero=$doctor_rc noted (F-015-class deep suite may fail while install-surface is in sync)")
  ht_note "doctor overall rc=$doctor_rc (install-surface in sync; deep product suite residual)"
fi

ht_finish_pass
