#!/usr/bin/env bash
# Independent sanity + non-mutating doctor for repo-upgrade harness.
#
_RU_LIB_DIR="$(CDPATH= cd -- "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=common.sh
source "$_RU_LIB_DIR/common.sh"

# Run directive-install-sanity if present.
# Writes stdout/stderr to $outdir/sanity.log and optional JSON to sanity.json.
# Returns sanity exit code (0 pass); 127 if tool missing (soft-skip unless RU_SANITY_REQUIRED=1).
ru_run_sanity() {
  local root="$1" outdir="$2"
  mkdir -p "$outdir"
  local log="$outdir/sanity.log"
  local json="$outdir/sanity.json"

  if [[ ! -d "$HT_SANITY" ]]; then
    echo "sanity tool missing at $HT_SANITY" | tee "$log" >&2
    if [[ "${RU_SANITY_REQUIRED:-0}" == "1" ]]; then
      return 1
    fi
    echo '{"skipped":true,"reason":"sanity tool missing"}' > "$json"
    return 127
  fi

  local rc=0
  set +e
  (
    cd "$HT_SANITY" && npx --yes tsx src/cli.ts --root "$root" --json
  ) > "$log" 2>&1
  rc=$?
  # Do not re-enable set -e here — it is process-global and would abort the caller
  # on a later `return $rc` when doctor/sanity are nonzero.

  # Extract trailing JSON object if present
  if grep -q '^{' "$log" 2>/dev/null; then
    awk 'BEGIN{p=0} /^\{/{p=1} p{print}' "$log" | tail -n +1 > "$json.tmp" || true
    if jq empty "$json.tmp" 2>/dev/null; then
      mv "$json.tmp" "$json"
    else
      rm -f "$json.tmp"
      jq -n --argjson rc "$rc" '{exit_code:$rc, raw_log:"see sanity.log"}' > "$json"
    fi
  else
    jq -n --argjson rc "$rc" '{exit_code:$rc, raw_log:"see sanity.log"}' > "$json"
  fi

  if [[ "$rc" -eq 0 ]]; then
    ru_pass "sanity exit 0"
  else
    ru_warn "sanity exit $rc (see $log)"
  fi
  return "$rc"
}

# Run directive doctor (expect non-mutating). Compares pre/post mini-manifest of key files.
# Writes doctor.log + doctor.json. Returns doctor exit code.
ru_run_doctor() {
  local root="$1" outdir="$2"
  mkdir -p "$outdir"
  local log="$outdir/doctor.log"
  local before="$outdir/doctor-before.paths"
  local after="$outdir/doctor-after.paths"

  # Snapshot path list for mutation guard. Ignore known ephemeral caches
  # (doctor may write xbrief triage cache without counting as product mutation).
  _ru_doctor_paths() {
    local root="$1"
    (
      cd "$root" && find . \
        \( -path './.git' -o -path './.git/*' \) -prune -o \
        \( -path './node_modules' -o -path './node_modules/*' \) -prune -o \
        \( -path './xbrief/.triage-cache' -o -path './xbrief/.triage-cache/*' \) -prune -o \
        \( -path './.deft/.cache' -o -path './.deft/.cache/*' \) -prune -o \
        -type f -print
    ) | LC_ALL=C sort
  }

  _ru_doctor_paths "$root" > "$before"

  local rc=0
  set +e
  directive doctor --root "$root" > "$log" 2>&1
  rc=$?
  # Leave errexit off (see ru_run_sanity); caller captures DOCTOR_RC.

  _ru_doctor_paths "$root" > "$after"

  local mutated=0
  if ! diff -q "$before" "$after" >/dev/null 2>&1; then
    mutated=1
    diff -u "$before" "$after" > "$outdir/doctor-mutation.diff" || true
    ru_warn "doctor appears to have mutated the tree (path list changed)"
  fi

  jq -n \
    --argjson exit_code "$rc" \
    --argjson mutated "$mutated" \
    '{exit_code:$exit_code, mutated:($mutated==1), expectation:"non-mutating"}' \
    > "$outdir/doctor.json"

  if [[ "$mutated" -eq 1 ]]; then
    return 2
  fi
  if [[ "$rc" -eq 0 ]]; then
    ru_pass "doctor exit 0 (non-mutating)"
  else
    ru_warn "doctor exit $rc (non-mutating path OK)"
  fi
  return "$rc"
}
