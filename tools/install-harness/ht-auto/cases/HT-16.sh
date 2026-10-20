#!/usr/bin/env bash
# HT-16 — Two projects, one launcher (AC3.11 / AC14.24)
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"

ht_case_begin "HT-16" "${HT_TAG_OVERRIDE:-}"
ht_ensure_directive_on_path

if [[ "$HT_DRY" == "1" ]]; then ht_finish_pass; fi

stamp="$(date +%Y%m%d%H%M%S)-$$"
A="${HT_AUTO_FIXTURES}/HT-16-A-${stamp}"
B="${HT_AUTO_FIXTURES}/HT-16-B-${stamp}"
mkdir -p "$A" "$B"

eval "$(ht-prep --reuse "$A" --tag "$HT_TAG")"
CONSUMER_A="$CONSUMER"
eval "$(ht-prep --reuse "$B" --tag "$HT_TAG")"
CONSUMER_B="$CONSUMER"
HT_CASE_CONSUMER="$CONSUMER_A"
ht_log "A=$CONSUMER_A B=$CONSUMER_B"

ht_capture directive install --root "$CONSUMER_A" --yes --target-version "$HT_VER"
ht_assert_exit "install_A_rc" "$HT_LAST_RC" "0" || true
ht_capture directive install --root "$CONSUMER_B" --yes --target-version "$HT_VER"
ht_assert_exit "install_B_rc" "$HT_LAST_RC" "0" || true

pin_b_before="$(ht_pin_version "$CONSUMER_B")"
ht_assert_eq "pin_B_prepared" "$pin_b_before" "$HT_VER" || true

# Snapshot B managed surface (exclude node_modules noise / triage-cache / readiness mtime)
snap_b() {
  find "$CONSUMER_B" -type f \
    ! -path '*/node_modules/*' \
    ! -path '*/.deft/directive/wiring-ready.*' \
    ! -path '*/.deft/triage-cache/*' \
    ! -name 'ht-auto.result.json' \
    -print0 | sort -z | xargs -0 shasum 2>/dev/null
}
sha_b_before="$(snap_b)"

# Mutate A only: repair (install-management that must not touch B)
ht_capture directive install --root "$CONSUMER_A" --repair --yes
ht_assert_exit "repair_A_rc" "$HT_LAST_RC" "0" || true

pin_b_after="$(ht_pin_version "$CONSUMER_B")"
ht_assert_eq "pin_B_unchanged" "$pin_b_after" "$pin_b_before" || true
sha_b_after="$(snap_b)"
ht_assert_eq "tree_B_unchanged" "$sha_b_after" "$sha_b_before" || true

# Per-project --version reports that project's pin
ht_capture bash -c "cd \"$CONSUMER_A\" && directive --version"
if echo "$HT_LAST_OUT" | grep -Fq "$HT_VER"; then
  HT_CASE_ASSERTIONS+=("pass|version_A_names_pin|out has $HT_VER")
else
  HT_CASE_ASSERTIONS+=("fail|version_A_names_pin|missing $HT_VER in: $HT_LAST_OUT")
fi
ht_capture bash -c "cd \"$CONSUMER_B\" && directive --version"
if echo "$HT_LAST_OUT" | grep -Fq "$HT_VER"; then
  HT_CASE_ASSERTIONS+=("pass|version_B_names_pin|out has $HT_VER")
else
  HT_CASE_ASSERTIONS+=("fail|version_B_names_pin|missing $HT_VER in: $HT_LAST_OUT")
fi

ht_run_sanity "$CONSUMER_B" || true
ht_finish_pass
