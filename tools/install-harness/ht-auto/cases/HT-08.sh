#!/usr/bin/env bash
# HT-08 — Fresh clone first activation (AC2.5 / AC8.6 / AC14.57)
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"

ht_case_begin "HT-08" "${HT_TAG_OVERRIDE:-}"
ht_ensure_directive_on_path
ht_new_consumer "HT-08" --git

if [[ "$HT_DRY" == "1" ]]; then ht_finish_pass; fi

# 1) Configured git consumer (pin + wiring + GENERATION; readiness written by install)
ht_capture directive install --root "$CONSUMER" --yes --target-version "$HT_VER"
ht_assert_exit "install_rc" "$HT_LAST_RC" "0" || true

READY_NAME="wiring-ready.${HT_VER}.json"
READY_REL=".deft/directive/${READY_NAME}"
ht_assert_file "src_ready_after_install" "$CONSUMER/$READY_REL" || true

# 2) Commit configured tree (.gitignore omits node_modules + wiring-ready)
git -C "$CONSUMER" add -A
git -C "$CONSUMER" commit -qm "ht-08 configured tip $HT_VER" || true

# 3) Simulate clone as sibling under ht-auto fixtures
stamp="$(date +%Y%m%d%H%M%S)-$$"
CLONE="${HT_AUTO_FIXTURES}/HT-08-clone-${stamp}"
git clone -q "$CONSUMER" "$CLONE"
# hybrid .npmrc for @deftai → Verdaccio
eval "$(ht-prep --reuse "$CLONE" --tag "$HT_TAG")"
HT_CASE_CONSUMER="$CLONE"
ht_log "CLONE=$CLONE"

ht_assert_no_path "clone_no_node_modules" "$CLONE/node_modules" || true
ht_assert_no_path "clone_no_ready" "$CLONE/$READY_REL" || true
ht_assert_file "clone_generation" "$CLONE/.deft/GENERATION.json" || true

# 4) PM install restores package content; readiness still absent
ht_capture bash -c "cd \"$CLONE\" && npm install --ignore-scripts --include=dev"
ht_assert_exit "npm_install_rc" "$HT_LAST_RC" "0" || true
ht_assert_no_path "ready_absent_after_pm" "$CLONE/$READY_REL" || true

# 5) Doctor alone must not write readiness (AC8.8 / AC14.57)
ht_capture directive doctor --root "$CLONE"
ht_assert_no_path "doctor_no_ready_write" "$CLONE/$READY_REL" || true

# 6) Eligible ordinary command completes local activation
ht_capture bash -c "cd \"$CLONE\" && directive version"
# version may exit 0 even if product prints; assert readiness + hooksPath
if [[ -f "$CLONE/$READY_REL" ]]; then
  HT_CASE_ASSERTIONS+=("pass|ready_after_eligible|$READY_REL")
  ht_log "PASS assert: ready_after_eligible"
else
  HT_CASE_ASSERTIONS+=("fail|ready_after_eligible|missing $CLONE/$READY_REL")
  ht_log "FAIL assert: ready_after_eligible"
fi

hooks="$(git -C "$CLONE" config --get core.hooksPath || true)"
if [[ "$hooks" == ".githooks" || "$hooks" == */.githooks || -n "$hooks" ]]; then
  HT_CASE_ASSERTIONS+=("pass|hooksPath_after_eligible|hooksPath=$hooks")
else
  HT_CASE_ASSERTIONS+=("fail|hooksPath_after_eligible|empty hooksPath")
fi

ht_run_sanity "$CLONE" || true
ht_finish_pass
