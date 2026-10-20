#!/usr/bin/env bash
# Shared helpers for ht-auto case scripts.
# Source from cases:  source "$(dirname "$0")/../lib/common.sh"

set -euo pipefail

HT_AUTO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$HT_AUTO_ROOT/../lib/env.sh"
HT_SANITY_DEFAULT="${HT_SANITY:-$HOME/Projects/directive-install-sanity}"
HT_AUTO_FIXTURES="${HT_AUTO_FIXTURES:-$IH_SCRATCH/fixtures/ht-auto}"
HT_AUTO_LOG_DIR="${HT_AUTO_LOG_DIR:-$IH_SCRATCH/results/ht-auto}"

# Exit codes for case scripts / run-all
readonly HT_RC_PASS=0
readonly HT_RC_FAIL=2
readonly HT_RC_HUMAN=3

# Per-case mutable state
HT_CASE_ID=""
HT_CASE_STATUS="" # AUTO_PASS | FAIL | HUMAN_REQUIRED
HT_CASE_NOTES=()
HT_CASE_ASSERTIONS=() # lines "pass|name|detail" or "fail|name|detail"
HT_CASE_CONSUMER=""
HT_CASE_LOG=""
HT_DRY="${HT_DRY:-0}"

ht_log() { printf '[%s] %s\n' "${HT_CASE_ID:-ht-auto}" "$*" >&2; }

ht_die() {
  ht_log "FATAL: $*"
  HT_CASE_STATUS="FAIL"
  ht_note "$*"
  ht_write_result
  exit "$HT_RC_FAIL"
}

ht_note() { HT_CASE_NOTES+=("$*"); }

ht_resolve_default_tag() {
  # Prefer env HT_TAG; else latest on public npm; else Verdaccio tip tags.
  if [[ -n "${HT_TAG:-}" ]]; then
    printf '%s\n' "$HT_TAG"
    return 0
  fi
  if [[ "${IH_REGISTRY}" == "npm" || "${IH_REGISTRY}" == "public" || "${IH_REGISTRY}" == "latest" ]]; then
    printf '%s\n' "latest"
    return 0
  fi
  if curl -sf -o /dev/null "$VERDACCIO_URL/"; then
    if ih_npm_view "@deftai/directive@yolo-cp-wave4i" version >/dev/null 2>&1; then
      printf '%s\n' "yolo-cp-wave4i"
      return 0
    fi
    if ih_npm_view "@deftai/directive@yolo-cp-wave4a" version >/dev/null 2>&1; then
      printf '%s\n' "yolo-cp-wave4a"
      return 0
    fi
  fi
  printf '%s\n' "yolo-cp-wave3z"
}

ht_require_tip() {
  # Fail clearly when tip/tag is missing from the active registry (do not publish).
  local tag="${1:-}"
  if [[ -z "$tag" ]]; then
    ht_die "ht_require_tip: empty tag"
  fi
  local reg
  reg="$(ih_registry_url)"
  if [[ "$reg" == "$VERDACCIO_URL" ]] && ! curl -sf -o /dev/null "$VERDACCIO_URL/"; then
    ht_die "Verdaccio not reachable at $VERDACCIO_URL — start registry, or set IH_REGISTRY=npm for public @latest"
  fi
  local ver
  if ! ver="$(ih_npm_view "@deftai/directive@$tag" version 2>/dev/null)"; then
    ht_die "Package @deftai/directive@$tag missing on $reg. Publish tip first (Verdaccio) or pass --tag latest with IH_REGISTRY=npm."
  fi
  export HT_TAG="$tag"
  export HT_VER="$ver"
  ht_log "tip @$HT_TAG -> $HT_VER (registry=$reg)"
}

ht_bootstrap_env() {
  # Refresh shared env via ht-prep (no new consumer).
  local tag="${1:-}"
  if [[ -z "$tag" ]]; then
    tag="$(ht_resolve_default_tag)"
  fi
  ht_require_tip "$tag"
  # shellcheck disable=SC1090
  eval "$(ht-prep --tag "$HT_TAG")"
  export HT_SANITY="${HT_SANITY:-$HT_SANITY_DEFAULT}"
  mkdir -p "$HT_AUTO_FIXTURES" "$HT_AUTO_LOG_DIR"
}

ht_new_consumer() {
  # Create ~/yolo-5490/fixtures/ht-auto/HT-xx-<stamp>/ then ht-prep --reuse.
  # Args: case_id [--git]
  local id="$1"
  shift || true
  local want_git=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --git) want_git=1; shift ;;
      *) ht_die "ht_new_consumer: unknown arg $1" ;;
    esac
  done
  mkdir -p "$HT_AUTO_FIXTURES"
  local stamp
  stamp="$(date +%Y%m%d%H%M%S)-$$"
  local dest="${HT_AUTO_FIXTURES}/${id}-${stamp}"
  mkdir -p "$dest"
  # shellcheck disable=SC1090
  eval "$(ht-prep --reuse "$dest" --tag "$HT_TAG")"
  if [[ "$want_git" -eq 1 ]]; then
    git -C "$CONSUMER" init -q
    git -C "$CONSUMER" config user.email "ht-auto@local"
    git -C "$CONSUMER" config user.name "ht-auto"
    git -C "$CONSUMER" config commit.gpgsign false
  fi
  HT_CASE_CONSUMER="$CONSUMER"
  ht_log "CONSUMER=$CONSUMER"
}

ht_case_begin() {
  HT_CASE_ID="$1"
  HT_CASE_STATUS=""
  HT_CASE_NOTES=()
  HT_CASE_ASSERTIONS=()
  HT_CASE_CONSUMER=""
  local tag="${2:-}"
  ht_bootstrap_env "$tag"
  HT_CASE_LOG="${HT_AUTO_LOG_DIR}/${HT_CASE_ID}-$(date +%Y%m%d%H%M%S).log"
  mkdir -p "$HT_AUTO_LOG_DIR"
  ht_log "begin tag=$HT_TAG ver=$HT_VER dry=$HT_DRY"
}

ht_assert() {
  # ht_assert <name> <shell-condition...>
  local name="$1"
  shift
  if "$@"; then
    HT_CASE_ASSERTIONS+=("pass|$name|ok")
    ht_log "PASS assert: $name"
    return 0
  fi
  HT_CASE_ASSERTIONS+=("fail|$name|condition failed: $*")
  ht_log "FAIL assert: $name"
  return 1
}

ht_assert_eq() {
  local name="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    HT_CASE_ASSERTIONS+=("pass|$name|got=$got")
    ht_log "PASS assert: $name (=$want)"
    return 0
  fi
  HT_CASE_ASSERTIONS+=("fail|$name|got='$got' want='$want'")
  ht_log "FAIL assert: $name got='$got' want='$want'"
  return 1
}

ht_assert_exit() {
  local name="$1" got="$2" want="$3"
  ht_assert_eq "$name" "$got" "$want"
}

ht_assert_file() {
  local name="$1" path="$2"
  if [[ -f "$path" ]]; then
    HT_CASE_ASSERTIONS+=("pass|$name|$path")
    ht_log "PASS assert: $name"
    return 0
  fi
  HT_CASE_ASSERTIONS+=("fail|$name|missing $path")
  ht_log "FAIL assert: $name missing $path"
  return 1
}

ht_assert_no_path() {
  local name="$1" path="$2"
  if [[ ! -e "$path" ]]; then
    HT_CASE_ASSERTIONS+=("pass|$name|absent $path")
    ht_log "PASS assert: $name"
    return 0
  fi
  HT_CASE_ASSERTIONS+=("fail|$name|unexpected path $path")
  ht_log "FAIL assert: $name unexpected $path"
  return 1
}

ht_assert_grep() {
  # ht_assert_grep <name> <pattern> <file-or-->
  local name="$1" pattern="$2" target="$3"
  if [[ "$target" == "-" ]]; then
    if grep -Eq "$pattern"; then
      HT_CASE_ASSERTIONS+=("pass|$name|/$pattern/")
      ht_log "PASS assert: $name"
      return 0
    fi
  else
    if grep -Eq "$pattern" "$target"; then
      HT_CASE_ASSERTIONS+=("pass|$name|/$pattern/ in $target")
      ht_log "PASS assert: $name"
      return 0
    fi
  fi
  HT_CASE_ASSERTIONS+=("fail|$name|pattern /$pattern/ not found")
  ht_log "FAIL assert: $name pattern /$pattern/"
  return 1
}

ht_pin_version() {
  local root="${1:-$HT_CASE_CONSUMER}"
  python3 - "$root" <<'PY'
import json, sys
p = sys.argv[1] + "/package.json"
try:
    d = json.load(open(p))
except Exception:
    print("")
    raise SystemExit(0)
deps = {}
deps.update(d.get("dependencies") or {})
deps.update(d.get("devDependencies") or {})
print(deps.get("@deftai/directive-runtime", ""))
PY
}

ht_run_sanity() {
  local root="${1:-$HT_CASE_CONSUMER}"
  local out rc
  if [[ ! -d "$HT_SANITY" ]]; then
    ht_note "HT_SANITY missing at $HT_SANITY — skip sanity"
    return 1
  fi
  set +e
  out="$(cd "$HT_SANITY" && npx tsx src/cli.ts --root "$root" 2>&1)"
  rc=$?
  set -e
  printf '%s\n' "$out" | tee -a "${HT_CASE_LOG:-/dev/null}" >&2 || true
  if [[ "$rc" -eq 0 ]] && echo "$out" | grep -Eqi '0 failed|Summary.*0 failed'; then
    HT_CASE_ASSERTIONS+=("pass|sanity|0 failed rc=$rc")
    ht_log "PASS sanity"
    return 0
  fi
  # Also accept Summary line with 0 failed even if wording differs
  if echo "$out" | grep -Eqi '[0-9]+ passed.*0 failed|0 failed'; then
    HT_CASE_ASSERTIONS+=("pass|sanity|0 failed (parsed) rc=$rc")
    ht_log "PASS sanity (parsed)"
    return 0
  fi
  HT_CASE_ASSERTIONS+=("fail|sanity|rc=$rc")
  ht_note "sanity failed rc=$rc"
  return 1
}

ht_capture() {
  # Run command; set HT_LAST_RC / HT_LAST_OUT. Does not abort on non-zero.
  # Usage: ht_capture -- cmd args...
  HT_LAST_OUT=""
  HT_LAST_RC=0
  set +e
  HT_LAST_OUT="$("$@" 2>&1)"
  HT_LAST_RC=$?
  set -e
  printf '%s\n' "$HT_LAST_OUT" | tee -a "${HT_CASE_LOG:-/dev/null}" >&2 || true
  return 0
}

ht_any_assert_failed() {
  local line
  for line in "${HT_CASE_ASSERTIONS[@]:-}"; do
    [[ "$line" == fail\|* ]] && return 0
  done
  return 1
}

ht_finish_pass() {
  if ht_any_assert_failed; then
    HT_CASE_STATUS="FAIL"
    ht_write_result
    exit "$HT_RC_FAIL"
  fi
  HT_CASE_STATUS="AUTO_PASS"
  ht_write_result
  exit "$HT_RC_PASS"
}

ht_finish_fail() {
  HT_CASE_STATUS="FAIL"
  [[ $# -gt 0 ]] && ht_note "$*"
  ht_write_result
  exit "$HT_RC_FAIL"
}

ht_finish_human() {
  HT_CASE_STATUS="HUMAN_REQUIRED"
  [[ $# -gt 0 ]] && ht_note "$*"
  ht_write_result
  exit "$HT_RC_HUMAN"
}

ht_write_result() {
  local status="${HT_CASE_STATUS:-FAIL}"
  local consumer="${HT_CASE_CONSUMER:-}"
  local out_dir="$HT_AUTO_LOG_DIR"
  mkdir -p "$out_dir"

  local assertions_json notes_json payload
  assertions_json="$(python3 - "${HT_CASE_ASSERTIONS[@]:-}" <<'PY'
import json, sys
out = []
for a in sys.argv[1:]:
    if not a:
        continue
    parts = a.split("|", 2)
    while len(parts) < 3:
        parts.append("")
    out.append({"ok": parts[0] == "pass", "name": parts[1], "detail": parts[2]})
print(json.dumps(out))
PY
)"
  notes_json="$(python3 - "${HT_CASE_NOTES[@]:-}" <<'PY'
import json, sys
print(json.dumps([a for a in sys.argv[1:] if a]))
PY
)"

  export HT_WR_ID="$HT_CASE_ID"
  export HT_WR_STATUS="$status"
  export HT_WR_TAG="${HT_TAG:-}"
  export HT_WR_VER="${HT_VER:-}"
  export HT_WR_CONS="$consumer"
  export HT_WR_ASSERTIONS_JSON="$assertions_json"
  export HT_WR_NOTES_JSON="$notes_json"
  payload="$(python3 <<'PY'
import json, os
print(json.dumps({
  "id": os.environ["HT_WR_ID"],
  "status": os.environ["HT_WR_STATUS"],
  "tag": os.environ.get("HT_WR_TAG", ""),
  "version": os.environ.get("HT_WR_VER", ""),
  "consumer": os.environ.get("HT_WR_CONS", ""),
  "assertions": json.loads(os.environ.get("HT_WR_ASSERTIONS_JSON") or "[]"),
  "notes": json.loads(os.environ.get("HT_WR_NOTES_JSON") or "[]"),
}, indent=2))
PY
)"

  local agg="${out_dir}/${HT_CASE_ID}.result.json"
  printf '%s\n' "$payload" >"$agg"
  if [[ -n "$consumer" && -d "$consumer" ]]; then
    printf '%s\n' "$payload" >"${consumer}/ht-auto.result.json"
  fi
  ht_log "result status=$status -> $agg"
}

ht_stub_not_implemented() {
  local id="$1"
  shift || true
  ht_case_begin "$id" "${HT_TAG_OVERRIDE:-}"
  ht_note "STUB: not fully automated yet. $*"
  ht_finish_human "stub — implement later; see HUMAN-TEST-PLAN.md § ${id}"
}

ht_ensure_directive_on_path() {
  if ! command -v directive >/dev/null 2>&1; then
    ht_die "directive not on PATH (expected under \$YOLO_5490/prefix/bin). Run HT-00 first."
  fi
  local which_d
  which_d="$(command -v directive)"
  case "$which_d" in
    "$YOLO_5490"/prefix/bin/*) ;;
    *)
      ht_note "warning: directive resolves to $which_d (expected under $YOLO_5490/prefix/bin)"
      ;;
  esac
}
