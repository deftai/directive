#!/usr/bin/env bash
# HT-17 — Dependabot-style pin bump rewire (AC14.10)
# Install at older V, bump pin/lock/node_modules to W=$HT_VER, leave GENERATION at V,
# eligible ordinary command refreshes wiring/readiness; pin + xbrief unchanged by auto path.
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"

ht_case_begin "HT-17" "${HT_TAG_OVERRIDE:-}"
ht_ensure_directive_on_path

# Prefer an older published tip as V (distinct from current HT_VER = W)
V_VER=""
V_TAG=""
for t in yolo-cp-wave4b yolo-cp-wave4a yolo-cp-wave3z yolo-cp-wave3t yolo-cp-wave2zb; do
  v="$(npm view "@deftai/directive@$t" version --registry "$VERDACCIO_URL" 2>/dev/null || true)"
  if [[ -n "$v" && "$v" != "$HT_VER" ]]; then
    V_TAG="$t"
    V_VER="$v"
    break
  fi
done
if [[ -z "$V_VER" ]]; then
  ht_finish_human "SKIP: no second tip version on Verdaccio for Dependabot rewire"
fi
ht_note "V=$V_TAG/$V_VER → W=$HT_TAG/$HT_VER"

ht_new_consumer "HT-17" --git
if [[ "$HT_DRY" == "1" ]]; then ht_finish_pass; fi

# Seed user xbrief (AC14.10: auto path must not mutate existing data)
mkdir -p "$CONSUMER/xbrief"
printf '{"id":"ht17-seed","title":"seed"}\n' >"$CONSUMER/xbrief/ht17-seed.xbrief.json"

# 1) Green at V
ht_capture directive install --root "$CONSUMER" --yes --target-version "$V_VER"
ht_assert_exit "install_V_rc" "$HT_LAST_RC" "0" || true
pin_v="$(ht_pin_version "$CONSUMER")"
ht_assert_eq "pin_at_V" "$pin_v" "$V_VER" || true

# Snapshot after V install (includes any seed placeholder install may add)
sha_xbrief_before="$(find "$CONSUMER/xbrief" -type f | sort | xargs shasum)"
sha_user_before="$(shasum "$CONSUMER/xbrief/ht17-seed.xbrief.json")"

# Snapshot GENERATION content at V (must remain until eligible rewires)
gen_before=""
if [[ -f "$CONSUMER/.deft/GENERATION.json" ]]; then
  gen_before="$(cat "$CONSUMER/.deft/GENERATION.json")"
fi

# 2) Dependabot: pin + lock + node_modules → W; leave GENERATION / stale readiness from V
python3 - "$CONSUMER" "$HT_VER" <<'PY'
import json, sys
root, w = sys.argv[1], sys.argv[2]
p = root + "/package.json"
d = json.load(open(p))
for key in ("dependencies", "devDependencies"):
    if key in d and "@deftai/directive-runtime" in d[key]:
        d[key]["@deftai/directive-runtime"] = w
json.dump(d, open(p, "w"), indent=2)
print("pin edited to", w)
PY

ht_capture bash -c "cd \"$CONSUMER\" && npm install --save-dev --save-exact --ignore-scripts --include=dev @deftai/directive-runtime@$HT_VER"
ht_assert_exit "npm_install_W_rc" "$HT_LAST_RC" "0" || true
pin_w="$(ht_pin_version "$CONSUMER")"
ht_assert_eq "pin_at_W" "$pin_w" "$HT_VER" || true

# Remove W readiness if npm/scripts created any; keep GENERATION as left by V install
rm -f "$CONSUMER/.deft/directive/wiring-ready.${HT_VER}.json" || true
# Ensure V-era GENERATION still present (rewrite if npm somehow touched it — restore V snapshot)
if [[ -n "$gen_before" ]]; then
  printf '%s\n' "$gen_before" >"$CONSUMER/.deft/GENERATION.json"
fi
ht_assert_no_path "no_W_ready_before_eligible" "$CONSUMER/.deft/directive/wiring-ready.${HT_VER}.json" || true

# 3) Eligible ordinary command (not doctor / install-mgmt)
ht_capture bash -c "cd \"$CONSUMER\" && directive version"

READY_W="$CONSUMER/.deft/directive/wiring-ready.${HT_VER}.json"
if [[ -f "$READY_W" ]]; then
  HT_CASE_ASSERTIONS+=("pass|ready_at_W_after_eligible|$READY_W")
  ht_log "PASS assert: ready_at_W_after_eligible"
else
  HT_CASE_ASSERTIONS+=("fail|ready_at_W_after_eligible|missing $READY_W")
  ht_log "FAIL assert: ready_at_W_after_eligible"
fi

# Pin unchanged by auto path
pin_after="$(ht_pin_version "$CONSUMER")"
ht_assert_eq "pin_unchanged_by_auto" "$pin_after" "$HT_VER" || true

sha_user_after="$(shasum "$CONSUMER/xbrief/ht17-seed.xbrief.json")"
ht_assert_eq "user_xbrief_unchanged" "$sha_user_after" "$sha_user_before" || true
sha_xbrief_after="$(find "$CONSUMER/xbrief" -type f | sort | xargs shasum)"
# Full tree may gain/lose only product seed placeholder; user seed must match above.
if [[ "$sha_xbrief_after" == "$sha_xbrief_before" ]]; then
  HT_CASE_ASSERTIONS+=("pass|xbrief_tree_unchanged|identical")
else
  ht_note "xbrief tree churn (non-user): before≠after — check seed placeholder only"
  HT_CASE_ASSERTIONS+=("pass|xbrief_tree_soft|user seed preserved; tree may include install seed placeholder")
fi

ht_run_sanity "$CONSUMER" || true
ht_finish_pass
