#!/usr/bin/env bash
# ht-auto runner — HUMAN-TEST-PLAN automation harness
#
# Usage:
#   ./run-all.sh --tag <dist-tag> [--only HT-01,HT-02] [--dry]
#   ./run-all.sh                     # default tip: wave4a if published else wave3z
#
# Exit: 0 if no FAIL (HUMAN_REQUIRED allowed); 1 if any FAIL; 2 usage.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$ROOT/lib/common.sh"

TAG=""
ONLY=""
DRY=0

usage() {
  cat <<'EOF'
ht-auto/run-all.sh — run HUMAN-TEST-PLAN automation cases (in-repo)

  ./run-all.sh --tag <dist-tag> [--only HT-01,HT-02] [--dry]
  ./run-all.sh --registry npm --tag latest
  ./run-all.sh [--only HT-00]

Options:
  --tag <dist-tag>     Dist-tag or exact version (default: auto)
  --registry <name>    verdaccio (default) | npm  (public registry / @latest)
  --only <ids>         Comma-separated case ids (e.g. HT-01,HT-04,HT-11)
  --dry                Harness dry-run (cases skip mutating steps where supported)
  --help               This help

Tip prerequisite (not published by this harness):
  Verdaccio mode: tip tag must already be published.
  npm mode: uses public registry (IH_REGISTRY=npm); typical --tag latest.

Results (gitignored):
  <repo>/.deft-scratch/install-harness/results/ht-auto/<ID>.result.json
  <repo>/.deft-scratch/install-harness/fixtures/ht-auto/<ID>-<stamp>/

Case exit codes: 0 AUTO_PASS · 2 FAIL · 3 HUMAN_REQUIRED
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      TAG="${2:?--tag requires a dist-tag}"
      shift 2
      ;;
    --registry)
      export IH_REGISTRY="${2:?--registry requires verdaccio|npm}"
      shift 2
      ;;
    --only)
      ONLY="${2:?--only requires ids}"
      shift 2
      ;;
    --dry)
      DRY=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$TAG" ]]; then
  TAG="$(ht_resolve_default_tag)"
fi
export HT_TAG_OVERRIDE="$TAG"
export HT_TAG="$TAG"
export HT_DRY="$DRY"

mkdir -p "$HT_AUTO_LOG_DIR" "$HT_AUTO_FIXTURES"

ALL_CASES=(
  HT-00 HT-01 HT-02 HT-03 HT-04 HT-05 HT-06 HT-07
  HT-08 HT-09 HT-10 HT-11 HT-12 HT-13 HT-14 HT-15
  HT-16 HT-17
)

should_run() {
  local id="$1"
  if [[ -z "$ONLY" ]]; then
    return 0
  fi
  local IFS=,
  local x
  for x in $ONLY; do
    x="$(echo "$x" | tr -d ' ')"
    [[ "$x" == "$id" ]] && return 0
  done
  return 1
}

echo "=== ht-auto run-all $(date -u +%Y-%m-%dT%H:%M:%SZ) tag=$TAG dry=$DRY ==="
echo "fixtures: $HT_AUTO_FIXTURES"
echo "logs:     $HT_AUTO_LOG_DIR"

# Tip presence check (do not publish)
if ! curl -sf -o /dev/null "$VERDACCIO_URL/"; then
  echo "ERROR: Verdaccio not reachable at $VERDACCIO_URL" >&2
  exit 1
fi
if ! HT_VER="$(npm view "@deftai/directive@$TAG" version --registry "$VERDACCIO_URL" 2>/dev/null)"; then
  echo "ERROR: tip @$TAG missing on Verdaccio. Publish tip first; ht-auto will not publish." >&2
  echo "  Example: npm view @deftai/directive --registry $VERDACCIO_URL dist-tags" >&2
  exit 1
fi
export HT_VER
echo "tip @$TAG -> $HT_VER"

PASS_N=0
FAIL_N=0
HUMAN_N=0
SKIPPED_N=0
declare -a SCORE_LINES=()

run_case() {
  local id="$1"
  local script="$ROOT/cases/${id}.sh"
  if [[ ! -x "$script" ]]; then
    echo "MISSING $script" >&2
    FAIL_N=$((FAIL_N + 1))
    SCORE_LINES+=("| $id | FAIL | missing case script |")
    return 0
  fi
  echo ""
  echo "--- $id ---"
  local rc=0
  set +e
  HT_TAG_OVERRIDE="$TAG" HT_DRY="$DRY" "$script"
  rc=$?
  set -e
  local status
  case "$rc" in
    0)
      status="AUTO_PASS"
      PASS_N=$((PASS_N + 1))
      ;;
    3)
      status="HUMAN_REQUIRED"
      HUMAN_N=$((HUMAN_N + 1))
      ;;
    *)
      status="FAIL"
      FAIL_N=$((FAIL_N + 1))
      ;;
  esac
  echo "=== $id => $status (rc=$rc) ==="
  SCORE_LINES+=("| $id | $status | rc=$rc |")
}

for id in "${ALL_CASES[@]}"; do
  if should_run "$id"; then
    run_case "$id"
  else
    SKIPPED_N=$((SKIPPED_N + 1))
  fi
done

TOTAL_RUN=$((PASS_N + FAIL_N + HUMAN_N))
AUTO_DENOM=$((PASS_N + FAIL_N)) # HUMAN_REQUIRED excluded from automatable %
AUTO_PCT="n/a"
if [[ "$AUTO_DENOM" -gt 0 ]]; then
  AUTO_PCT="$(python3 -c "print(round(100.0 * $PASS_N / $AUTO_DENOM, 1))")"
fi

SCORECARD="$HT_AUTO_LOG_DIR/scorecard-$(date +%Y%m%d%H%M%S).md"
{
  echo "# ht-auto scorecard"
  echo
  echo "| Field | Value |"
  echo "| --- | --- |"
  echo "| When (UTC) | $(date -u +%Y-%m-%dT%H:%M:%SZ) |"
  echo "| Tip tag | \`$TAG\` |"
  echo "| Tip version | \`$HT_VER\` |"
  echo "| Dry | $DRY |"
  echo "| AUTO_PASS | $PASS_N |"
  echo "| FAIL | $FAIL_N |"
  echo "| HUMAN_REQUIRED | $HUMAN_N |"
  echo "| Skipped (--only) | $SKIPPED_N |"
  echo "| Automatable pass % | ${AUTO_PCT}% ($PASS_N / $AUTO_DENOM; HUMAN excluded) |"
  echo
  echo "| ID | Status | Notes |"
  echo "| --- | --- | --- |"
  for line in "${SCORE_LINES[@]}"; do
    echo "$line"
  done
  echo
  echo "HUMAN_REQUIRED does not fail the suite aggregate for automatable %."
  echo "See \`human-required.txt\` and per-case \`*.result.json\`."
} | tee "$SCORECARD"

echo ""
echo "SCORECARD $SCORECARD"
echo "SUMMARY AUTO_PASS=$PASS_N FAIL=$FAIL_N HUMAN_REQUIRED=$HUMAN_N automatable%=${AUTO_PCT}"

if [[ "$FAIL_N" -gt 0 ]]; then
  exit 1
fi
exit 0
